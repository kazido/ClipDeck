//! Grabbing a single frame from a clip as a JPEG.

use std::path::Path;

use super::tools::{command, run, Tools};
use crate::Result;

/// Default thumbnail width in pixels. Height follows the clip's aspect ratio.
pub const DEFAULT_WIDTH: u32 = 480;

/// Pick a timestamp that avoids black or loading frames at the very start.
pub fn pick_timestamp_secs(duration_ms: u64) -> f64 {
    let duration = duration_ms as f64 / 1000.0;
    (duration * 0.15).min(10.0)
}

/// Write one frame of `input`, taken at `at_secs`, to `output` as a JPEG.
pub fn generate(
    tools: &Tools,
    input: &Path,
    output: &Path,
    at_secs: f64,
    width: u32,
) -> Result<()> {
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }

    run(
        "ffmpeg",
        command(&tools.ffmpeg)
            .args(["-v", "error", "-y"])
            // -ss before -i seeks by keyframe first, so this stays fast on big files.
            .args(["-ss", &format!("{at_secs:.3}")])
            .arg("-i")
            .arg(input)
            .args(["-frames:v", "1"])
            .args(["-vf", &format!("scale={width}:-2")])
            .args(["-q:v", "3"])
            .arg(output),
    )?;

    Ok(())
}
