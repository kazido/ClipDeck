//! The system-wide hotkey that shows or hides the ClipDeck window.

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// The plugin, set up so that any registered hotkey toggles the window.
pub fn plugin() -> TauriPlugin<Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if matches!(event.state, ShortcutState::Pressed) {
                crate::tray::toggle_main_window(app);
            }
        })
        .build()
}

/// Make `hotkey` (for example "Alt+Z") the one active hotkey. An empty string
/// means no hotkey. Fails if the text is not a valid key combination or
/// another program already owns it.
pub fn apply(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    let shortcuts = app.global_shortcut();
    shortcuts.unregister_all().map_err(|e| e.to_string())?;
    if hotkey.trim().is_empty() {
        return Ok(());
    }
    shortcuts.register(hotkey.trim()).map_err(|e| {
        format!("Could not use {hotkey} as the hotkey ({e}). Another program may already be using it.")
    })
}
