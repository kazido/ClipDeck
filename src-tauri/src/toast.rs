//! Small popups in the top-right corner of the screen ("Clip saved").
//!
//! The popup is a second, borderless, always-on-top window that never takes
//! focus and lets clicks pass through, so it cannot interrupt a game.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use clipdeck_core::library::{PopupOptions, PopupSize};
use clipdeck_core::sounds;
use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition};

use crate::state::AppState;

const LABEL: &str = "toast";
/// Gap between the popup and the screen edges, in logical pixels.
const MARGIN: f64 = 16.0;
/// The window is hidden this long after the page has finished fading out.
const HIDE_GRACE: Duration = Duration::from_millis(150);

/// Counts popups, so an older one's timer does not hide a newer popup.
static LATEST: AtomicU64 = AtomicU64::new(0);

/// Which sound goes with a popup.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SoundEvent {
    /// A clip was saved.
    Saved,
    /// The replay buffer started: ready to clip.
    Ready,
    /// The replay buffer stopped or OBS closed.
    Stopped,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Something good happened (clip saved, ready to clip).
    Good,
    /// Recording stopped or something needs attention.
    Warning,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Toast<'a> {
    kind: Kind,
    /// What happened, so the page can match its mood (a save is lively, the rest are calm).
    event: SoundEvent,
    title: &'a str,
    body: &'a str,
    size: PopupSize,
    duration_ms: u32,
}

/// One-time setup: clicks pass straight through the popup window.
pub fn prepare(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.set_ignore_cursor_events(true);
    }
}

/// Show a popup, unless the user has turned popups off.
pub fn show(app: &AppHandle, kind: Kind, sound: SoundEvent, title: &str, body: &str) {
    let enabled = app
        .state::<AppState>()
        .library
        .popups_enabled()
        .unwrap_or(true);
    if enabled {
        show_always(app, kind, sound, title, body);
    }
}

/// Show a popup regardless of the setting (used by the "Test popup" button).
pub fn show_always(app: &AppHandle, kind: Kind, sound: SoundEvent, title: &str, body: &str) {
    let state = app.state::<AppState>();
    let options: PopupOptions = state.library.popup_options().unwrap_or_default();

    // The sound plays even where the popup can't be seen (exclusive fullscreen).
    if options.volume > 0 {
        let chosen = match sound {
            SoundEvent::Saved => &options.sound,
            SoundEvent::Ready => &options.sound_ready,
            SoundEvent::Stopped => &options.sound_stopped,
        };
        if let Some(path) = sounds::resolve(&state.sounds_dir, chosen) {
            // A popup never cuts off the opening sound; it waits its turn
            sounds::play_when_free(&sounds::at_volume(&path, options.volume, &state.sound_cache_dir));
        }
    }

    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let (width, height) = options.size.dimensions();
    let _ = window.set_size(LogicalSize::new(width, height));

    // Top-right corner of the main screen, clear of the taskbar.
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let margin = (MARGIN * scale).round() as i32;
        let width = (width * scale).round() as i32;
        let x = area.position.x + area.size.width as i32 - width - margin;
        let y = area.position.y + margin;
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }

    let toast = Toast {
        kind,
        event: sound,
        title,
        body,
        size: options.size,
        duration_ms: options.duration_ms,
    };
    let _ = app.emit_to(LABEL, "toast", toast);
    let _ = window.show();
    // Asking again each time lifts the popup above other always-on-top
    // windows, which is what most borderless games are.
    let _ = window.set_always_on_top(true);

    let this = LATEST.fetch_add(1, Ordering::SeqCst) + 1;
    let visible_for = Duration::from_millis(u64::from(options.duration_ms)) + HIDE_GRACE;
    std::thread::spawn(move || {
        std::thread::sleep(visible_for);
        if LATEST.load(Ordering::SeqCst) == this {
            let _ = window.hide();
        }
    });
}
