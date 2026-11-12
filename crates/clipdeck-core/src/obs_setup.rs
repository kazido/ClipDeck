//! Giving OBS good settings for clipping: a replay buffer, a sensible picture size and
//! frame rate, and the clips folder as the place replays are saved.
//!
//! This talks to OBS over the same WebSocket connection as the rest of ClipDeck, using a
//! short connection of its own.

use std::net::TcpStream;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tungstenite::{Message, WebSocket};

use crate::obs::{open_socket, ObsConfig};

type Socket = WebSocket<TcpStream>;

/// What the person chose in the setup guide.
#[derive(Debug, Clone)]
pub struct Wanted {
    /// How many seconds the replay buffer keeps.
    pub replay_seconds: u32,
    /// Where OBS should save clips (ClipDeck's clips folder).
    pub folder: String,
}

/// What OBS is set to right now, for the guide to show.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Current {
    /// "Simple" or "Advanced".
    pub mode: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub replay_buffer: bool,
    pub replay_seconds: u32,
    pub format: String,
    pub folder: String,
}

/// What was changed, in plain words, and anything the person should still do.
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub changes: Vec<String>,
    pub notes: Vec<String>,
}

fn request(socket: &mut Socket, kind: &str, data: Value) -> Result<Value, String> {
    let id = format!("setup-{kind}");
    let message = json!({ "op": 6, "d": { "requestType": kind, "requestId": id, "requestData": data } });
    socket
        .send(Message::text(message.to_string()))
        .map_err(|_| "Lost the connection to OBS".to_string())?;
    let started = Instant::now();
    loop {
        if started.elapsed() > Duration::from_secs(8) {
            return Err("OBS took too long to answer".into());
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                let value: Value = serde_json::from_str(text.as_str()).unwrap_or(Value::Null);
                if value["op"] == 7 && value["d"]["requestId"] == id {
                    if value["d"]["requestStatus"]["result"].as_bool().unwrap_or(false) {
                        return Ok(value["d"]["responseData"].clone());
                    }
                    let why = value["d"]["requestStatus"]["comment"].as_str().unwrap_or("OBS refused");
                    return Err(format!("{kind}: {why}"));
                }
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(_) => return Err("Lost the connection to OBS".into()),
        }
    }
}

fn get_param(socket: &mut Socket, category: &str, name: &str) -> Option<String> {
    request(socket, "GetProfileParameter", json!({ "parameterCategory": category, "parameterName": name }))
        .ok()
        .and_then(|d| d["parameterValue"].as_str().map(str::to_string))
}

fn set_param(socket: &mut Socket, category: &str, name: &str, value: &str) -> Result<(), String> {
    request(
        socket,
        "SetProfileParameter",
        json!({ "parameterCategory": category, "parameterName": name, "parameterValue": value }),
    )
    .map(|_| ())
}

fn mode_of(socket: &mut Socket) -> (String, &'static str) {
    let mode = get_param(socket, "Output", "Mode").unwrap_or_else(|| "Simple".into());
    let category = if mode.eq_ignore_ascii_case("Advanced") { "AdvOut" } else { "SimpleOutput" };
    (mode, category)
}

fn video(socket: &mut Socket) -> Result<(u32, u32, u32, u32, u32), String> {
    let v = request(socket, "GetVideoSettings", json!({}))?;
    let n = |key: &str| v[key].as_u64().unwrap_or(0) as u32;
    let fps = if n("fpsDenominator") == 0 { 0 } else { (f64::from(n("fpsNumerator")) / f64::from(n("fpsDenominator"))).round() as u32 };
    Ok((n("baseWidth"), n("baseHeight"), n("outputWidth"), n("outputHeight"), fps))
}

fn folder_param(category: &str) -> &'static str {
    if category == "AdvOut" { "RecFilePath" } else { "FilePath" }
}

/// Read OBS's current settings.
pub fn read(config: &ObsConfig) -> Result<Current, String> {
    let mut socket = open_socket(config, 0)?;
    socket.get_ref().set_read_timeout(Some(Duration::from_secs(2))).ok();
    let (mode, category) = mode_of(&mut socket);
    let (_, _, width, height, fps) = video(&mut socket)?;
    let current = Current {
        mode,
        width,
        height,
        fps,
        replay_buffer: get_param(&mut socket, category, "RecRB").is_some_and(|v| v == "true"),
        replay_seconds: get_param(&mut socket, category, "RecRBTime").and_then(|v| v.parse().ok()).unwrap_or(0),
        format: get_param(&mut socket, category, "RecFormat2").unwrap_or_default(),
        folder: get_param(&mut socket, category, folder_param(category)).unwrap_or_default(),
    };
    let _ = socket.close(None);
    Ok(current)
}

/// The picture size to record at: 1080p, but never bigger than the screen being captured.
pub fn output_size(base_width: u32, base_height: u32) -> (u32, u32) {
    if base_height == 0 || base_height <= 1080 {
        return (base_width, base_height);
    }
    let width = (f64::from(base_width) * 1080.0 / f64::from(base_height)).round() as u32;
    (width & !1, 1080)
}

/// How much memory the replay buffer may use, in MB, for a replay of this length.
pub fn buffer_megabytes(seconds: u32) -> u32 {
    (seconds * 10).max(512)
}

/// Apply the recommended settings. The replay buffer is stopped while OBS changes and
/// started again afterwards.
pub fn apply(config: &ObsConfig, wanted: &Wanted) -> Result<Report, String> {
    let mut socket = open_socket(config, 0)?;
    socket.get_ref().set_read_timeout(Some(Duration::from_secs(2))).ok();
    let mut report = Report::default();

    // OBS will not change the picture settings while it is recording or buffering.
    if request(&mut socket, "GetRecordStatus", json!({})).is_ok_and(|d| d["outputActive"] == true) {
        let _ = socket.close(None);
        return Err("OBS is recording right now. Stop the recording first, then try again.".into());
    }
    let was_buffering = request(&mut socket, "GetReplayBufferStatus", json!({})).is_ok_and(|d| d["outputActive"] == true);
    if was_buffering {
        request(&mut socket, "StopReplayBuffer", json!({}))?;
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(6) {
            if request(&mut socket, "GetReplayBufferStatus", json!({})).is_ok_and(|d| d["outputActive"] == false) {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    // Picture size and frame rate.
    let (base_w, base_h, out_w, out_h, fps) = video(&mut socket)?;
    let (want_w, want_h) = output_size(base_w, base_h);
    let want_fps = if fps >= 60 { fps } else { 60 };
    if (out_w, out_h) != (want_w, want_h) || fps != want_fps {
        request(
            &mut socket,
            "SetVideoSettings",
            json!({ "outputWidth": want_w, "outputHeight": want_h, "fpsNumerator": want_fps, "fpsDenominator": 1 }),
        )?;
        if (out_w, out_h) != (want_w, want_h) {
            report.changes.push(format!("Picture size: {out_w}×{out_h} → {want_w}×{want_h}"));
        }
        if fps != want_fps {
            report.changes.push(format!("Frame rate: {fps} → {want_fps} fps"));
        }
    }

    // Replay buffer and where clips go.
    let (mode, category) = mode_of(&mut socket);
    let mut wants: Vec<(&str, String, &str)> = vec![
        ("RecRB", "true".into(), "Replay buffer: turned on"),
        ("RecRBTime", wanted.replay_seconds.to_string(), "Replay length"),
        ("RecRBSize", buffer_megabytes(wanted.replay_seconds).to_string(), "Replay memory limit"),
        ("RecFormat2", "mkv".into(), "Clip format: MKV (safe if OBS ever crashes)"),
        (folder_param(category), wanted.folder.clone(), "Clips are saved to your ClipDeck folder"),
    ];
    if category == "SimpleOutput" {
        wants.push(("RecQuality", "HQ".into(), "Quality: high, medium file size"));
    }
    for (name, value, what) in wants {
        if get_param(&mut socket, category, name).as_deref() != Some(value.as_str()) {
            set_param(&mut socket, category, name, &value)?;
            report.changes.push(if name == "RecRBTime" { format!("{what}: {} seconds", wanted.replay_seconds) } else { what.to_string() });
        }
    }
    if mode.eq_ignore_ascii_case("Advanced") {
        report.notes.push("OBS is in Advanced output mode. Its encoder and audio tracks were left as you have them.".into());
    }

    // Start the buffer again (or for the first time).
    match request(&mut socket, "StartReplayBuffer", json!({})) {
        Ok(_) => {}
        Err(_) => report.notes.push(
            "OBS needs to be closed and opened again before the replay buffer can start. Use \"Open OBS\" in ClipDeck's Settings after closing it.".into(),
        ),
    }
    let _ = socket.close(None);
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picture_size_never_goes_above_1080p() {
        assert_eq!(output_size(2560, 1440), (1920, 1080));
        assert_eq!(output_size(3840, 2160), (1920, 1080));
        assert_eq!(output_size(3440, 1440), (2580, 1080));
        assert_eq!(output_size(1920, 1080), (1920, 1080));
        assert_eq!(output_size(1366, 768), (1366, 768));
    }

    #[test]
    fn buffer_memory_grows_with_replay_length() {
        assert_eq!(buffer_megabytes(30), 512);
        assert_eq!(buffer_megabytes(90), 900);
        assert_eq!(buffer_megabytes(120), 1200);
    }
}
