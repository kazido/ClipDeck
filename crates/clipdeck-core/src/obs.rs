//! Talking to OBS Studio: is the replay buffer running, turn it on or off,
//! hear about saved replays, and launch OBS itself.
//!
//! Uses OBS's built-in WebSocket server (protocol version 5), which the user
//! switches on once in OBS under Tools > WebSocket Server Settings.

use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tungstenite::{Message, WebSocket};

/// OBS's default WebSocket port.
pub const DEFAULT_PORT: u16 = 4455;

/// Pause between attempts to reach OBS while it is not answering.
const RETRY_EVERY: Duration = Duration::from_secs(3);
/// How long one read waits before we look for commands to send.
const READ_SLICE: Duration = Duration::from_millis(200);
/// Subscribe to "Outputs" events only (replay buffer state and saves).
const EVENT_SUBSCRIPTION_OUTPUTS: u32 = 1 << 6;
/// The close code OBS uses for a wrong or missing password.
const CLOSE_AUTH_FAILED: u16 = 4009;

#[derive(Debug, Clone)]
pub struct ObsConfig {
    pub host: String,
    pub port: u16,
    pub password: Option<String>,
    /// Turn the replay buffer on whenever we connect and find it off.
    pub ensure_replay_buffer: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum ObsStatus {
    /// Not connected. `reason` is a short explanation for the user.
    Disconnected { reason: String },
    #[serde(rename_all = "camelCase")]
    Connected { replay_buffer_active: bool },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObsEvent {
    Status(ObsStatus),
    /// OBS finished writing a replay to this path.
    ReplaySaved { path: String },
    /// OBS refused something we asked for.
    Problem { message: String },
}

enum Command {
    SetReplayBuffer(bool),
}

/// A background connection to OBS that reconnects by itself. Drop it to stop.
pub struct ObsClient {
    commands: Sender<Command>,
    status: Arc<Mutex<ObsStatus>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl ObsClient {
    pub fn start(config: ObsConfig, on_event: impl Fn(ObsEvent) + Send + 'static) -> Self {
        let (commands, rx) = mpsc::channel();
        let status = Arc::new(Mutex::new(ObsStatus::Disconnected {
            reason: "Connecting…".into(),
        }));
        let stop = Arc::new(AtomicBool::new(false));

        let worker = {
            let status = status.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                let connection = Connection { config, status, stop, on_event: Box::new(on_event) };
                connection.run(rx);
            })
        };

        Self { commands, status, stop, worker: Some(worker) }
    }

    pub fn status(&self) -> ObsStatus {
        self.status.lock().unwrap().clone()
    }

    /// Ask OBS to start or stop the replay buffer. The result arrives as a
    /// status event (or a `Problem` if OBS refuses).
    pub fn set_replay_buffer(&self, on: bool) {
        let _ = self.commands.send(Command::SetReplayBuffer(on));
    }
}

impl Drop for ObsClient {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct Connection {
    config: ObsConfig,
    status: Arc<Mutex<ObsStatus>>,
    stop: Arc<AtomicBool>,
    on_event: Box<dyn Fn(ObsEvent) + Send>,
}

impl Connection {
    fn run(&self, commands: Receiver<Command>) {
        while !self.stopped() {
            if let Err(reason) = self.session(&commands) {
                self.set_status(ObsStatus::Disconnected { reason });
            }
            // Wait before retrying, staying responsive to shutdown. Commands
            // sent while disconnected cannot be carried out, so drop them.
            let wait_until = Instant::now() + RETRY_EVERY;
            while Instant::now() < wait_until && !self.stopped() {
                while commands.try_recv().is_ok() {}
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    fn set_status(&self, status: ObsStatus) {
        let mut current = self.status.lock().unwrap();
        if *current != status {
            *current = status.clone();
            drop(current);
            (self.on_event)(ObsEvent::Status(status));
        }
    }

    /// One connection, from handshake until it ends. Ok means we were asked
    /// to stop; Err carries the reason to show the user.
    fn session(&self, commands: &Receiver<Command>) -> Result<(), String> {
        let mut socket = open_socket(&self.config, EVENT_SUBSCRIPTION_OUTPUTS)?;

        socket.get_ref().set_read_timeout(Some(READ_SLICE)).ok();
        send_request(&mut socket, "GetReplayBufferStatus", "status")?;
        let mut may_auto_start = self.config.ensure_replay_buffer;
        // OBS opens its WebSocket server before its outputs are ready, so right
        // after OBS starts a few early requests fail even though nothing is
        // wrong. Those are retried quietly instead of being shown as problems.
        let mut status_retries = 0u8;
        let mut status_again_at: Option<Instant> = None;
        let mut verify_at: Option<Instant> = None;
        let mut auto_problem: Option<String> = None;

        while !self.stopped() {
            for command in commands.try_iter() {
                let Command::SetReplayBuffer(on) = command;
                let request = if on { "StartReplayBuffer" } else { "StopReplayBuffer" };
                send_request(&mut socket, request, "set")?;
            }

            if status_again_at.is_some_and(|t| Instant::now() >= t) {
                status_again_at = None;
                send_request(&mut socket, "GetReplayBufferStatus", "status")?;
            }
            if verify_at.is_some_and(|t| Instant::now() >= t) {
                verify_at = None;
                send_request(&mut socket, "GetReplayBufferStatus", "verify")?;
            }

            let Some(message) = read_json(&mut socket)? else {
                continue; // nothing arrived in this slice
            };
            let data = &message["d"];
            match message["op"].as_u64() {
                // Event
                Some(5) => match data["eventType"].as_str() {
                    Some("ReplayBufferStateChanged") => {
                        let active = data["eventData"]["outputActive"].as_bool().unwrap_or(false);
                        self.set_status(ObsStatus::Connected { replay_buffer_active: active });
                    }
                    Some("ReplayBufferSaved") => {
                        if let Some(path) = data["eventData"]["savedReplayPath"].as_str() {
                            (self.on_event)(ObsEvent::ReplaySaved { path: path.to_string() });
                        }
                    }
                    _ => {}
                },
                // Response to one of our requests
                Some(7) => {
                    let ok = data["requestStatus"]["result"].as_bool().unwrap_or(false);
                    let id = data["requestId"].as_str().unwrap_or_default();
                    let comment = data["requestStatus"]["comment"].as_str();
                    match id {
                        "status" => {
                            if !ok && status_retries < 8 {
                                status_retries += 1;
                                status_again_at = Some(Instant::now() + Duration::from_secs(1));
                                continue;
                            }
                            let active = ok && data["responseData"]["outputActive"].as_bool().unwrap_or(false);
                            self.set_status(ObsStatus::Connected { replay_buffer_active: active });
                            if ok && !active && may_auto_start {
                                send_request(&mut socket, "StartReplayBuffer", "auto")?;
                            }
                            may_auto_start = false;
                            if !ok {
                                (self.on_event)(ObsEvent::Problem {
                                    message: "The replay buffer is not enabled in OBS. Turn it on under OBS Settings > Output > Replay Buffer".to_string(),
                                });
                            }
                        }
                        // OBS may already be starting the buffer itself, which makes our
                        // own start request fail. Check again before calling it a problem.
                        "auto" if !ok => {
                            auto_problem = Some(match comment {
                                Some(comment) => format!("OBS said: {comment}"),
                                None => "OBS could not change the replay buffer".to_string(),
                            });
                            verify_at = Some(Instant::now() + Duration::from_secs(2));
                        }
                        "verify" => {
                            let active = ok && data["responseData"]["outputActive"].as_bool().unwrap_or(false);
                            if active {
                                auto_problem = None;
                                self.set_status(ObsStatus::Connected { replay_buffer_active: true });
                            } else if let Some(message) = auto_problem.take() {
                                (self.on_event)(ObsEvent::Problem { message });
                            }
                        }
                        _ if !ok => {
                            let message = match comment {
                                Some(comment) => format!("OBS said: {comment}"),
                                None => "OBS could not change the replay buffer".to_string(),
                            };
                            (self.on_event)(ObsEvent::Problem { message });
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }

        let _ = socket.close(None);
        Ok(())
    }
}

/// Connect to OBS, log in and return the open socket. `subscriptions` picks which events
/// OBS will send (0 for none).
pub(crate) fn open_socket(config: &ObsConfig, subscriptions: u32) -> Result<WebSocket<TcpStream>, String> {
        const NOT_REACHABLE: &str =
            "OBS is not running, or its WebSocket server is turned off";

        let address = format!("{}:{}", config.host, config.port);
        let socket_address: SocketAddr = address.parse().map_err(|_| format!("bad address {address}"))?;
        let stream = TcpStream::connect_timeout(&socket_address, Duration::from_secs(1))
            .map_err(|_| NOT_REACHABLE.to_string())?;
        stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
        stream.set_nodelay(true).ok();

        let (mut socket, _) = tungstenite::client(format!("ws://{address}"), stream)
            .map_err(|_| NOT_REACHABLE.to_string())?;

        // Hello -> Identify -> Identified
        let hello = read_json(&mut socket)?.ok_or("OBS closed the connection")?;
        let mut identify = json!({
            "rpcVersion": 1,
            "eventSubscriptions": subscriptions,
        });
        if let Some(auth) = hello["d"].get("authentication") {
            let password = config.password.as_deref().filter(|p| !p.is_empty()).ok_or(
                "OBS asks for a password. Enter the WebSocket password in Settings",
            )?;
            let salt = auth["salt"].as_str().unwrap_or_default();
            let challenge = auth["challenge"].as_str().unwrap_or_default();
            identify["authentication"] = json!(auth_response(password, salt, challenge));
        }
        send_json(&mut socket, &json!({ "op": 1, "d": identify }))?;
        let identified = read_json(&mut socket)?.ok_or("OBS closed the connection")?;
        if identified["op"] != 2 {
            return Err("unexpected reply from OBS".into());
        }
    Ok(socket)
}

/// The reply OBS expects to its password challenge.
fn auth_response(password: &str, salt: &str, challenge: &str) -> String {
    let b64 = base64::engine::general_purpose::STANDARD;
    let secret = b64.encode(Sha256::digest(format!("{password}{salt}")));
    b64.encode(Sha256::digest(format!("{secret}{challenge}")))
}

fn send_request(socket: &mut WebSocket<TcpStream>, request: &str, id: &str) -> Result<(), String> {
    send_json(socket, &json!({ "op": 6, "d": { "requestType": request, "requestId": id } }))
}

fn send_json(socket: &mut WebSocket<TcpStream>, value: &Value) -> Result<(), String> {
    socket
        .send(Message::text(value.to_string()))
        .map_err(|_| "Lost the connection to OBS".to_string())
}

/// Read one JSON message. Ok(None) means nothing arrived before the read
/// timeout. A closed connection is an error with the reason.
fn read_json(socket: &mut WebSocket<TcpStream>) -> Result<Option<Value>, String> {
    use std::io::ErrorKind::{TimedOut, WouldBlock};
    match socket.read() {
        Ok(Message::Text(text)) => Ok(serde_json::from_str(text.as_str()).ok()),
        Ok(Message::Close(frame)) => Err(match frame {
            Some(f) if u16::from(f.code) == CLOSE_AUTH_FAILED => {
                "OBS rejected the password. Check the WebSocket password in Settings".to_string()
            }
            _ => "OBS closed the connection".to_string(),
        }),
        Ok(_) => Ok(None),
        Err(tungstenite::Error::Io(e)) if matches!(e.kind(), WouldBlock | TimedOut) => Ok(None),
        Err(_) => Err("Lost the connection to OBS".to_string()),
    }
}

// --- Launching OBS -----------------------------------------------------------

/// Where OBS is installed, checking `preferred` first and then the usual places.
pub fn find_obs(preferred: Option<&Path>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = preferred.map(Path::to_path_buf).into_iter().collect();
    for variable in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(variable) {
            candidates.push(Path::new(&root).join("obs-studio").join("bin").join("64bit").join("obs64.exe"));
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

/// Start OBS minimized, with the replay buffer running.
///
/// OBS is started minimized to the taskbar rather than with `--minimize-to-tray`:
/// hiding OBS's main window to the tray leaves any floating docks stranded on
/// the desktop, while a minimized main window takes its docks with it.
/// `--disable-shutdown-check` stops the "OBS crashed, start in safe mode?"
/// question from blocking an unattended start after a crash.
pub fn launch_obs(exe: &Path) -> std::io::Result<()> {
    let folder = exe.parent().unwrap_or(Path::new("."));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // `start /MIN` makes Windows show OBS's first window minimized, and
        // `/D` starts it in its own folder, which is where OBS finds its files.
        let mut command = crate::media::tools::command(Path::new("cmd"));
        command.raw_arg(format!(
            "/C start \"\" /MIN /D \"{}\" \"{}\" --startreplaybuffer --disable-shutdown-check",
            folder.display(),
            exe.display()
        ));
        command.spawn().map(|_| ())
    }
    #[cfg(not(windows))]
    {
        crate::media::tools::command(exe)
            .current_dir(folder)
            .args(["--startreplaybuffer", "--disable-shutdown-check"])
            .spawn()
            .map(|_| ())
    }
}

/// Whether an OBS process exists right now. Always false off Windows.
pub fn obs_is_running() -> bool {
    if !cfg!(windows) {
        return false;
    }
    crate::media::tools::command(Path::new("tasklist"))
        .args(["/FI", "IMAGENAME eq obs64.exe", "/NH", "/FO", "CSV"])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).to_lowercase().contains("obs64.exe"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_challenge() {
        // Worked example: every step done by hand with sha256sum and base64.
        let secret = base64::engine::general_purpose::STANDARD
            .encode(Sha256::digest("supersecretpasswordlM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI="));
        let expected = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(format!(
            "{secret}+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY="
        )));
        assert_eq!(
            auth_response(
                "supersecretpassword",
                "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=",
                "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY="
            ),
            expected
        );
        // The value given in the obs-websocket protocol documentation.
        assert_eq!(expected, "1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=");
    }
}
