//! Apply the recommended OBS settings against a pretend OBS.

use std::net::{TcpListener, TcpStream};

use clipdeck_core::obs::ObsConfig;
use clipdeck_core::obs_setup::{apply, read, Wanted};
use serde_json::{json, Value};
use tungstenite::{Message, WebSocket};

fn send(ws: &mut WebSocket<TcpStream>, value: Value) {
    ws.send(Message::text(value.to_string())).unwrap();
}

fn receive(ws: &mut WebSocket<TcpStream>) -> Option<Value> {
    loop {
        match ws.read() {
            Ok(Message::Text(text)) => return Some(serde_json::from_str(text.as_str()).unwrap()),
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => {}
        }
    }
}

/// An OBS with no password, a 1440p 30 fps picture, and nothing recording.
fn pretend_obs(listener: TcpListener) -> Vec<(String, Value)> {
    let (stream, _) = listener.accept().unwrap();
    let mut ws = tungstenite::accept(stream).unwrap();
    send(&mut ws, json!({"op": 0, "d": {"obsWebSocketVersion": "5.5.0", "rpcVersion": 1}}));
    receive(&mut ws).expect("identify");
    send(&mut ws, json!({"op": 2, "d": {"negotiatedRpcVersion": 1}}));

    let mut set: Vec<(String, Value)> = Vec::new();
    while let Some(request) = receive(&mut ws) {
        let kind = request["d"]["requestType"].as_str().unwrap().to_string();
        let data = request["d"]["requestData"].clone();
        let response = match kind.as_str() {
            "GetRecordStatus" | "GetReplayBufferStatus" => json!({"outputActive": false}),
            "GetVideoSettings" => json!({
                "baseWidth": 2560, "baseHeight": 1440, "outputWidth": 2560, "outputHeight": 1440,
                "fpsNumerator": 30, "fpsDenominator": 1
            }),
            "GetProfileParameter" => match data["parameterName"].as_str().unwrap() {
                "Mode" => json!({"parameterValue": "Simple"}),
                _ => json!({"parameterValue": null}),
            },
            "SetProfileParameter" | "SetVideoSettings" => {
                set.push((kind.clone(), data));
                json!({})
            }
            _ => json!({}),
        };
        send(
            &mut ws,
            json!({"op": 7, "d": {
                "requestType": kind, "requestId": request["d"]["requestId"],
                "requestStatus": {"result": true, "code": 100}, "responseData": response
            }}),
        );
        if kind == "StartReplayBuffer" {
            set.push((kind, Value::Null));
        }
    }
    set
}

#[test]
fn recommended_settings_are_applied() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || pretend_obs(listener));

    let config = ObsConfig { host: "127.0.0.1".into(), port, password: None, ensure_replay_buffer: false };
    let wanted = Wanted { replay_seconds: 90, folder: "C:\\Clips".into() };
    let report = apply(&config, &wanted).unwrap();
    assert!(report.changes.iter().any(|c| c.contains("2560×1440 → 1920×1080")), "{report:?}");
    assert!(report.changes.iter().any(|c| c.contains("30 → 60 fps")), "{report:?}");
    assert!(report.notes.is_empty(), "{report:?}");

    let calls = server.join().unwrap();
    let video = calls.iter().find(|(k, _)| k == "SetVideoSettings").unwrap();
    assert_eq!(video.1["outputWidth"], 1920);
    assert_eq!(video.1["fpsNumerator"], 60);
    let param = |name: &str| {
        calls
            .iter()
            .find(|(k, d)| k == "SetProfileParameter" && d["parameterName"] == name)
            .map(|(_, d)| (d["parameterCategory"].as_str().unwrap().to_string(), d["parameterValue"].as_str().unwrap().to_string()))
    };
    assert_eq!(param("RecRB"), Some(("SimpleOutput".into(), "true".into())));
    assert_eq!(param("RecRBTime"), Some(("SimpleOutput".into(), "90".into())));
    assert_eq!(param("FilePath"), Some(("SimpleOutput".into(), "C:\\Clips".into())));
    assert_eq!(param("RecFormat2").unwrap().1, "mkv");
    assert!(calls.iter().any(|(k, _)| k == "StartReplayBuffer"));
}

#[test]
fn current_settings_can_be_read() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || pretend_obs(listener));
    let config = ObsConfig { host: "127.0.0.1".into(), port, password: None, ensure_replay_buffer: false };
    let current = read(&config).unwrap();
    assert_eq!((current.width, current.height, current.fps), (2560, 1440, 30));
    assert_eq!(current.mode, "Simple");
    assert!(!current.replay_buffer);
    server.join().unwrap();
}
