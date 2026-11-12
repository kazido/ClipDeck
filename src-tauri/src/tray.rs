//! System tray icon. Closing the window hides it here so the app can keep
//! watching for new clips; "Quit" in the tray menu really exits.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, Window, WindowEvent};

pub fn create(app: &App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open ClipDeck", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut tray = TrayIconBuilder::new()
        .tooltip("ClipDeck")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // Lets the UI stop any clip that is playing.
        let _ = window.emit("window-hidden", ());
        let _ = window.hide();
    }
}

/// Hide the window if it is in front; otherwise bring it to the front.
pub fn toggle_main_window(app: &AppHandle) {
    let in_front = app.get_webview_window("main").is_some_and(|window| {
        window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
    });
    if in_front {
        hide_main_window(app);
    } else {
        show_main_window(app);
    }
}

/// Turn "close" into "hide to tray".
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        if window.label() == "main" {
            hide_main_window(window.app_handle());
        }
    }
}
