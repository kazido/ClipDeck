//! Starts and restarts the folder watcher from `clipdeck-core`.

use std::sync::Arc;

use clipdeck_core::games;
use clipdeck_core::live::{Detector, LiveEvent, LiveIngest};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

/// (Re)start watching the clips folder. Every new clip, or failure, is sent
/// to the UI as a `live-event`.
pub fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut slot = state.live.lock().unwrap();
    *slot = None; // stop the previous watcher before starting another

    let Ok(Some(dir)) = state.library.source_dir() else {
        return;
    };
    let report = |reason: String| {
        let _ = app.emit(
            "live-event",
            LiveEvent::Failed {
                path: dir.to_string_lossy().into_owned(),
                reason,
            },
        );
    };

    let tools = match state.tools(app) {
        Ok(tools) => tools,
        Err(e) => return report(e.to_string()),
    };
    let detect: Detector = Arc::new(games::foreground_app);
    let emitter = app.clone();
    let started = LiveIngest::start(state.library.clone(), tools, dir.clone(), detect, move |event| {
        // With OBS connected, its own "replay saved" message already showed a
        // popup. Without it, this is the first we hear of the clip.
        if let LiveEvent::Added { path, .. } = &event {
            if !crate::obs::is_connected(&emitter) {
                let name = std::path::Path::new(path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                crate::toast::show(&emitter, crate::toast::Kind::Good, crate::toast::SoundEvent::Saved, "Clip saved", &name);
            }
        }
        let _ = emitter.emit("live-event", event);
    });
    match started {
        Ok(live) => *slot = Some(live),
        Err(e) => report(format!("could not watch the clips folder: {e}")),
    }
}
