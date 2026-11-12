//! Functions the UI can call. Each one validates input, calls into
//! `clipdeck-core`, and converts errors to a message the UI can show.

pub mod app;
pub mod library;
pub mod media;

/// Errors cross to the UI as plain strings for now.
pub type CommandResult<T> = Result<T, String>;

/// Run blocking work (such as waiting for FFmpeg) off the UI thread.
pub async fn blocking<T, F>(work: F) -> CommandResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> clipdeck_core::Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
