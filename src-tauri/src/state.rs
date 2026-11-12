//! State shared between commands for the lifetime of the app.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use clipdeck_core::library::Library;
use clipdeck_core::live::LiveIngest;
use clipdeck_core::media::Tools;
use clipdeck_core::obs::ObsClient;
use tauri::{AppHandle, Manager};

pub struct AppState {
    pub library: Arc<Library>,
    /// Folder holding the notification sounds (.wav files).
    pub sounds_dir: PathBuf,
    /// Where quieter copies of sounds are kept (see `sounds::at_volume`).
    pub sound_cache_dir: PathBuf,
    /// True while a folder scan is running, so only one runs at a time.
    pub scanning: AtomicBool,
    /// The running folder watcher. Replaced when the clips folder changes.
    pub live: Mutex<Option<LiveIngest>>,
    /// The connection to OBS. Replaced when its settings change.
    pub obs: Mutex<Option<ObsClient>>,
    tools: Mutex<Option<Tools>>,
}

impl AppState {
    pub fn new(library: Library, sounds_dir: PathBuf, sound_cache_dir: PathBuf) -> Self {
        Self {
            library: Arc::new(library),
            sounds_dir,
            sound_cache_dir,
            scanning: AtomicBool::new(false),
            live: Mutex::new(None),
            obs: Mutex::new(None),
            tools: Mutex::new(None),
        }
    }

    /// Find FFmpeg once and remember where it is. A failed lookup is not
    /// cached, so installing FFmpeg and retrying works without a restart.
    pub fn tools(&self, app: &AppHandle) -> clipdeck_core::Result<Tools> {
        let mut cached = self.tools.lock().unwrap();
        if let Some(tools) = cached.as_ref() {
            return Ok(tools.clone());
        }
        let tools = Tools::locate(&bundled_tool_dirs(app))?;
        *cached = Some(tools.clone());
        Ok(tools)
    }
}

/// Places a copy of FFmpeg shipped with the app could live. Checked before PATH.
fn bundled_tool_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        dirs.push(resources.join("bin"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.join("bin"));
        }
    }
    dirs
}
