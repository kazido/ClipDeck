//! Keeps a connection to OBS open and exposes it to the UI.

use clipdeck_core::library::ObsSettings;
use clipdeck_core::obs::{self, ObsClient, ObsConfig, ObsEvent, ObsStatus};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::CommandResult;
use crate::state::AppState;
use crate::toast::{self, Kind, SoundEvent};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplaySaved {
    path: String,
}

/// (Re)connect to OBS using the saved settings. Changes are sent to the UI as
/// `obs-status`, `replay-saved` and `obs-problem` events.
pub fn connect(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut slot = state.obs.lock().unwrap();
    *slot = None; // close the previous connection first

    let Ok(settings) = state.library.obs_settings() else {
        return;
    };
    let config = ObsConfig {
        host: "127.0.0.1".into(),
        port: settings.port,
        password: Some(settings.password),
        ensure_replay_buffer: settings.autostart,
    };
    let emitter = app.clone();
    // Whether the last status we saw was "ready to clip", to spot changes.
    let was_ready = std::sync::Mutex::new(None::<bool>);
    *slot = Some(ObsClient::start(config, move |event| {
        let _ = match event {
            ObsEvent::Status(status) => {
                let ready = status == ObsStatus::Connected { replay_buffer_active: true };
                let before = was_ready.lock().unwrap().replace(ready);
                match (before, ready) {
                    (Some(true), true) | (None | Some(false), false) => {}
                    (_, true) => toast::show(&emitter, Kind::Good, SoundEvent::Ready, "Ready to clip", "Replay buffer is running"),
                    (Some(true), false) => {
                        let why = match &status {
                            ObsStatus::Connected { .. } => "Replay buffer was turned off",
                            ObsStatus::Disconnected { .. } => "OBS was closed",
                        };
                        toast::show(&emitter, Kind::Warning, SoundEvent::Stopped, "Not recording", why);
                    }
                }
                emitter.emit("obs-status", status)
            }
            ObsEvent::ReplaySaved { path } => {
                let name = std::path::Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                toast::show(&emitter, Kind::Good, SoundEvent::Saved, "Clip saved", &name);
                emitter.emit("replay-saved", ReplaySaved { path })
            }
            ObsEvent::Problem { message } => emitter.emit("obs-problem", message),
        };
    }));
}

/// At startup: if the user wants OBS managed for them and it is not open,
/// start it in the background with the replay buffer on.
pub fn autostart(app: &AppHandle) {
    let wanted = app
        .state::<AppState>()
        .library
        .obs_settings()
        .map(|s| s.autostart)
        .unwrap_or(false);
    if !wanted {
        return;
    }
    // Checking for the process and launching can take a moment.
    std::thread::spawn(|| {
        if !obs::obs_is_running() {
            if let Some(exe) = obs::find_obs(None) {
                let _ = obs::launch_obs(&exe);
            }
        }
    });
}

/// True when ClipDeck is connected to OBS (and so hears about saves directly).
pub fn is_connected(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let client = state.obs.lock().unwrap();
    matches!(client.as_ref().map(ObsClient::status), Some(ObsStatus::Connected { .. }))
}

#[tauri::command]
pub fn get_obs_status(state: State<'_, AppState>) -> ObsStatus {
    match state.obs.lock().unwrap().as_ref() {
        Some(client) => client.status(),
        None => ObsStatus::Disconnected {
            reason: "Not connected".into(),
        },
    }
}

#[tauri::command]
pub fn set_replay_buffer(state: State<'_, AppState>, on: bool) {
    if let Some(client) = state.obs.lock().unwrap().as_ref() {
        client.set_replay_buffer(on);
    }
}

#[tauri::command]
pub fn get_obs_settings(state: State<'_, AppState>) -> CommandResult<ObsSettings> {
    state.library.obs_settings().map_err(|e| e.to_string())
}

/// Save the OBS settings and reconnect with them.
#[tauri::command]
pub fn set_obs_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: ObsSettings,
) -> CommandResult<()> {
    state
        .library
        .set_obs_settings(&settings)
        .map_err(|e| e.to_string())?;
    connect(&app);
    Ok(())
}

/// Start OBS in the background with the replay buffer running.
#[tauri::command]
pub fn launch_obs() -> CommandResult<()> {
    if obs::obs_is_running() {
        return Err(
            "OBS is already running. If ClipDeck can't connect, turn on OBS's WebSocket server under Tools > WebSocket Server Settings."
                .into(),
        );
    }
    let exe = obs::find_obs(None).ok_or("Could not find OBS. Is it installed in the default location?")?;
    obs::launch_obs(&exe).map_err(|e| format!("Could not start OBS: {e}"))
}

fn setup_config(state: &AppState) -> Result<ObsConfig, String> {
    let settings = state.library.obs_settings().map_err(|e| e.to_string())?;
    Ok(ObsConfig {
        host: "127.0.0.1".into(),
        port: settings.port,
        password: Some(settings.password),
        ensure_replay_buffer: false,
    })
}

/// What OBS is set to right now (picture size, frame rate, replay buffer, save folder).
#[tauri::command]
pub async fn read_obs_setup(state: State<'_, AppState>) -> CommandResult<clipdeck_core::obs_setup::Current> {
    let config = setup_config(&state)?;
    tauri::async_runtime::spawn_blocking(move || clipdeck_core::obs_setup::read(&config))
        .await
        .map_err(|e| e.to_string())?
}

/// Give OBS good settings for clipping. `replay_seconds` is how long the replay buffer keeps.
#[tauri::command]
pub async fn apply_obs_setup(state: State<'_, AppState>, replay_seconds: u32) -> CommandResult<clipdeck_core::obs_setup::Report> {
    let config = setup_config(&state)?;
    let folder = state
        .library
        .source_dir()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Choose a clips folder in ClipDeck first.".to_string())?;
    let wanted = clipdeck_core::obs_setup::Wanted {
        replay_seconds: replay_seconds.clamp(10, 300),
        folder: folder.to_string_lossy().into_owned(),
    };
    tauri::async_runtime::spawn_blocking(move || clipdeck_core::obs_setup::apply(&config, &wanted))
        .await
        .map_err(|e| e.to_string())?
}
