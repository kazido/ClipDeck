//! Run the OBS client against a pretend OBS that speaks the same protocol.

use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::time::Duration;

use clipdeck_core::obs::{ObsClient, ObsConfig, ObsEvent, ObsStatus};
use serde_json::{json, Value};
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::CloseFrame;
use tungstenite::{Message, WebSocket};

const SALT: &str = "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=";
const CHALLENGE: &str = "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=";
/// Correct reply for the password "supersecretpassword" (from the protocol docs).
const GOOD_AUTH: &str = "1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=";

fn send(ws: &mut WebSocket<TcpStream>, value: Value) {
    ws.send(Message::text(value.to_string())).unwrap();
}

fn receive(ws: &mut WebSocket<TcpStream>) -> Value {
    loop {
        if let Message::Text(text) = ws.read().unwrap() {
            return serde_json::from_str(text.as_str()).unwrap();
        }
    }
}

/// Accept one client and do the Hello/Identify exchange. Returns None if the
/// password was wrong (after closing the way OBS does).
fn accept(listener: &TcpListener) -> Option<WebSocket<TcpStream>> {
    let (stream, _) = listener.accept().unwrap();
    let mut ws = tungstenite::accept(stream).unwrap();
    send(&mut ws, json!({"op": 0, "d": {
        "obsWebSocketVersion": "5.5.0", "rpcVersion": 1,
        "authentication": {"challenge": CHALLENGE, "salt": SALT}
    }}));
    let identify = receive(&mut ws);
    assert_eq!(identify["op"], 1);
    assert_eq!(identify["d"]["rpcVersion"], 1);
    if identify["d"]["authentication"] != GOOD_AUTH {
        let _ = ws.close(Some(CloseFrame {
            code: CloseCode::from(4009),
            reason: "Authentication failed.".into(),
        }));
        let _ = ws.flush();
        return None;
    }
    send(&mut ws, json!({"op": 2, "d": {"negotiatedRpcVersion": 1}}));
    Some(ws)
}

fn respond(ws: &mut WebSocket<TcpStream>, request: &Value, ok: bool, data: Value) {
    send(ws, json!({"op": 7, "d": {
        "requestType": request["d"]["requestType"],
        "requestId": request["d"]["requestId"],
        "requestStatus": {"result": ok, "code": if ok { 100 } else { 500 }},
        "responseData": data,
    }}));
}

fn config(port: u16, password: &str, ensure: bool) -> ObsConfig {
    ObsConfig {
        host: "127.0.0.1".into(),
        port,
        password: Some(password.into()),
        ensure_replay_buffer: ensure,
    }
}

fn next(rx: &mpsc::Receiver<ObsEvent>) -> ObsEvent {
    rx.recv_timeout(Duration::from_secs(10)).expect("an event from the client")
}

#[test]
fn full_conversation() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    let server = std::thread::spawn(move || {
        let mut ws = accept(&listener).expect("password accepted");

        // Client asks for the status; the buffer is off.
        let request = receive(&mut ws);
        assert_eq!(request["d"]["requestType"], "GetReplayBufferStatus");
        respond(&mut ws, &request, true, json!({"outputActive": false}));

        // `ensure_replay_buffer` makes it start the buffer unprompted.
        let request = receive(&mut ws);
        assert_eq!(request["d"]["requestType"], "StartReplayBuffer");
        respond(&mut ws, &request, true, json!(null));
        send(&mut ws, json!({"op": 5, "d": {"eventType": "ReplayBufferStateChanged", "eventIntent": 64,
            "eventData": {"outputActive": true, "outputState": "OBS_WEBSOCKET_OUTPUT_STARTED"}}}));

        // A replay gets saved.
        send(&mut ws, json!({"op": 5, "d": {"eventType": "ReplayBufferSaved", "eventIntent": 64,
            "eventData": {"savedReplayPath": "C:/Videos/Replay 1.mp4"}}}));

        // The user switches the buffer off from the app.
        let request = receive(&mut ws);
        assert_eq!(request["d"]["requestType"], "StopReplayBuffer");
        respond(&mut ws, &request, true, json!(null));
        send(&mut ws, json!({"op": 5, "d": {"eventType": "ReplayBufferStateChanged", "eventIntent": 64,
            "eventData": {"outputActive": false, "outputState": "OBS_WEBSOCKET_OUTPUT_STOPPED"}}}));

        // Turning it back on fails this time.
        let request = receive(&mut ws);
        assert_eq!(request["d"]["requestType"], "StartReplayBuffer");
        send(&mut ws, json!({"op": 7, "d": {"requestType": "StartReplayBuffer", "requestId": request["d"]["requestId"],
            "requestStatus": {"result": false, "code": 500, "comment": "Output is busy"}}}));

        // OBS quits.
        let _ = ws.close(None);
        let _ = ws.flush();
    });

    let (tx, rx) = mpsc::channel();
    let client = ObsClient::start(config(port, "supersecretpassword", true), move |event| {
        let _ = tx.send(event);
    });

    let connected = |active| ObsEvent::Status(ObsStatus::Connected { replay_buffer_active: active });
    assert_eq!(next(&rx), connected(false));
    assert_eq!(next(&rx), connected(true));
    assert_eq!(client.status(), ObsStatus::Connected { replay_buffer_active: true });
    assert_eq!(next(&rx), ObsEvent::ReplaySaved { path: "C:/Videos/Replay 1.mp4".into() });

    client.set_replay_buffer(false);
    assert_eq!(next(&rx), connected(false));

    client.set_replay_buffer(true);
    assert_eq!(next(&rx), ObsEvent::Problem { message: "OBS said: Output is busy".into() });

    assert!(matches!(next(&rx), ObsEvent::Status(ObsStatus::Disconnected { .. })));
    server.join().unwrap();
    drop(client); // must not hang
}

#[test]
fn wrong_password_and_nothing_listening() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || assert!(accept(&listener).is_none()));

    let (tx, rx) = mpsc::channel();
    let client = ObsClient::start(config(port, "wrong", false), move |event| {
        let _ = tx.send(event);
    });
    let ObsEvent::Status(ObsStatus::Disconnected { reason }) = next(&rx) else { panic!() };
    assert!(reason.contains("rejected the password"), "{reason}");
    server.join().unwrap();
    drop(client);

    // The listener is gone now, so the same port refuses connections.
    let (tx, rx) = mpsc::channel();
    let client = ObsClient::start(config(port, "x", false), move |event| {
        let _ = tx.send(event);
    });
    let ObsEvent::Status(ObsStatus::Disconnected { reason }) = next(&rx) else { panic!() };
    assert!(reason.contains("not running"), "{reason}");
    drop(client);
}

#[test]
fn early_failures_while_obs_starts_are_not_problems() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    let server = std::thread::spawn(move || {
        let mut ws = accept(&listener).expect("password accepted");

        // OBS is still starting: the first status request is refused.
        let request = receive(&mut ws);
        assert_eq!(request["d"]["requestType"], "GetReplayBufferStatus");
        send(&mut ws, json!({"op": 7, "d": {"requestType": "GetReplayBufferStatus", "requestId": request["d"]["requestId"],
            "requestStatus": {"result": false, "code": 207, "comment": "Not ready"}}}));

        // The retry works, and the buffer is off, so the client starts it ...
        let request = receive(&mut ws);
        assert_eq!(request["d"]["requestType"], "GetReplayBufferStatus");
        respond(&mut ws, &request, true, json!({"outputActive": false}));
        let request = receive(&mut ws);
        assert_eq!(request["d"]["requestType"], "StartReplayBuffer");
        // ... but OBS was already starting it, so that request fails.
        send(&mut ws, json!({"op": 7, "d": {"requestType": "StartReplayBuffer", "requestId": request["d"]["requestId"],
            "requestStatus": {"result": false, "code": 500, "comment": "Already active"}}}));

        // The follow-up check finds the buffer running.
        let request = receive(&mut ws);
        assert_eq!(request["d"]["requestType"], "GetReplayBufferStatus");
        respond(&mut ws, &request, true, json!({"outputActive": true}));
        std::thread::sleep(Duration::from_millis(500));
        let _ = ws.close(None);
        let _ = ws.flush();
    });

    let (tx, rx) = mpsc::channel();
    let client = ObsClient::start(config(port, "supersecretpassword", true), move |event| {
        let _ = tx.send(event);
    });
    let connected = |active| ObsEvent::Status(ObsStatus::Connected { replay_buffer_active: active });
    assert_eq!(next(&rx), connected(false));
    assert_eq!(next(&rx), connected(true));
    // No problem is reported before OBS closes the connection.
    assert!(matches!(next(&rx), ObsEvent::Status(ObsStatus::Disconnected { .. })));
    server.join().unwrap();
    drop(client);
}
