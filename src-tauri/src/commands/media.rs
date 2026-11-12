use serde::Serialize;
use tauri::{AppHandle, State};

use super::{blocking, CommandResult};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    ffmpeg_path: String,
    ffprobe_path: String,
    version: String,
}

/// Report whether FFmpeg and FFprobe can be found and run.
#[tauri::command]
pub async fn check_tools(app: AppHandle, state: State<'_, AppState>) -> CommandResult<ToolStatus> {
    let tools = state.tools(&app).map_err(|e| e.to_string())?;
    blocking(move || {
        Ok(ToolStatus {
            version: tools.ffmpeg_version()?,
            ffmpeg_path: tools.ffmpeg.to_string_lossy().into_owned(),
            ffprobe_path: tools.ffprobe.to_string_lossy().into_owned(),
        })
    })
    .await
}
