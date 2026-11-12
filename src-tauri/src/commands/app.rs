//! App-level preferences: hotkey, popups, start with Windows.

use clipdeck_core::library::PopupOptions;
use clipdeck_core::sounds;
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

use super::CommandResult;
use crate::state::AppState;
use crate::toast;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPrefs {
    hotkey: String,
    popups: bool,
    popup_options: PopupOptions,
    /// File names of the sounds that can be chosen.
    sounds: Vec<String>,
    /// The sounds ClipDeck uses until a person picks others.
    default_sounds: PopupOptions,
    start_with_windows: bool,
    /// A sound plays when ClipDeck opens.
    startup_sound: bool,
}

#[tauri::command]
pub fn get_app_prefs(app: AppHandle, state: State<'_, AppState>) -> CommandResult<AppPrefs> {
    Ok(AppPrefs {
        hotkey: state.library.hotkey().map_err(|e| e.to_string())?,
        popups: state.library.popups_enabled().map_err(|e| e.to_string())?,
        popup_options: state.library.popup_options().map_err(|e| e.to_string())?,
        sounds: sounds::list(&state.sounds_dir),
        default_sounds: PopupOptions::default(),
        start_with_windows: app.autolaunch().is_enabled().unwrap_or(false),
        startup_sound: state.library.startup_sound().map_err(|e| e.to_string())?,
    })
}

/// Change the show/hide hotkey. Nothing is saved if the new one can't be registered.
#[tauri::command]
pub fn set_hotkey(app: AppHandle, state: State<'_, AppState>, hotkey: String) -> CommandResult<()> {
    if let Err(problem) = crate::hotkey::apply(&app, &hotkey) {
        // Put the previous hotkey back so the app is not left without one.
        if let Ok(previous) = state.library.hotkey() {
            let _ = crate::hotkey::apply(&app, &previous);
        }
        return Err(problem);
    }
    state.library.set_hotkey(&hotkey).map_err(|e| e.to_string())
}

/// Switch the hotkey off while the user is choosing a new one (so pressing
/// the current combination doesn't hide the window), then back on.
#[tauri::command]
pub fn pause_hotkey(app: AppHandle, state: State<'_, AppState>, paused: bool) -> CommandResult<()> {
    let hotkey = if paused {
        String::new()
    } else {
        state.library.hotkey().map_err(|e| e.to_string())?
    };
    crate::hotkey::apply(&app, &hotkey)
}

#[tauri::command]
pub fn set_popups(state: State<'_, AppState>, enabled: bool) -> CommandResult<()> {
    state
        .library
        .set_popups_enabled(enabled)
        .map_err(|e| e.to_string())
}

/// Save how popups look and sound. Returns what was stored.
#[tauri::command]
pub fn set_popup_options(
    state: State<'_, AppState>,
    options: PopupOptions,
) -> CommandResult<PopupOptions> {
    state
        .library
        .set_popup_options(&options)
        .map_err(|e| e.to_string())
}

/// Open the sounds folder in Explorer, so .wav files can be added.
#[tauri::command]
pub fn open_sounds_folder(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    app.opener()
        .open_path(state.sounds_dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Show a file selected in Explorer.
#[tauri::command]
pub fn reveal_in_folder(app: AppHandle, path: String) -> CommandResult<()> {
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

/// Show a sample popup, with the sound for `event` ("saved", "ready" or "stopped").
#[tauri::command]
pub fn test_popup(app: AppHandle, event: String) {
    use toast::{Kind, SoundEvent};
    match event.as_str() {
        "ready" => toast::show_always(&app, Kind::Good, SoundEvent::Ready, "Ready to clip", "This is a test popup"),
        "stopped" => toast::show_always(&app, Kind::Warning, SoundEvent::Stopped, "Not recording", "This is a test popup"),
        _ => toast::show_always(&app, Kind::Good, SoundEvent::Saved, "Clip saved", "This is a test popup"),
    }
}

/// Add a sound from any audio file (MP3 and others): it is converted to .wav
/// in the sounds folder. Returns the new sound's file name.
#[tauri::command]
pub async fn import_sound(app: AppHandle, state: State<'_, AppState>, path: String) -> CommandResult<String> {
    let tools = state.tools(&app).map_err(|e| e.to_string())?;
    let folder = state.sounds_dir.clone();
    super::blocking(move || sounds::import(&tools, std::path::Path::new(&path), &folder)).await
}

#[tauri::command]
pub fn set_startup_sound(state: State<'_, AppState>, enabled: bool) -> CommandResult<()> {
    state.library.set_startup_sound(enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_start_with_windows(app: AppHandle, enabled: bool) -> CommandResult<()> {
    let autolaunch = app.autolaunch();
    let result = if enabled {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };
    result.map_err(|e| e.to_string())
}
