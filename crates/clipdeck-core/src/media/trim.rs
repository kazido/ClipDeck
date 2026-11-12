//! Cutting a piece out of a clip into a new file. The original is never touched.

use std::path::Path;

use super::tools::{command, run, Tools};
use crate::Result;

/// Times (in seconds) of the video's keyframes, in order. A lossless cut can
/// only start on one of these.
pub fn keyframes(tools: &Tools, input: &Path) -> Result<Vec<f64>> {
    let out = run(
        "ffprobe",
        command(&tools.ffprobe)
            .args(["-v", "error", "-select_streams", "v:0"])
            .args(["-show_entries", "packet=pts_time,flags"])
            .args(["-of", "csv=print_section=0"])
            .arg(input),
    )?;
    let mut times: Vec<f64> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let (time, flags) = line.split_once(',')?;
            flags.contains('K').then(|| time.trim().parse().ok()).flatten()
        })
        .collect();
    times.sort_by(|a, b| a.total_cmp(b));
    times.dedup();
    Ok(times)
}

/// Write `start..end` (seconds) of `input` to `output`.
///
/// Lossless (`precise == false`) copies the streams without re-encoding: it is
/// instant and loses no quality, but the cut really begins at the keyframe
/// at or before `start`. Precise re-encodes the video so the cut is exact.
/// Every audio track is kept either way.
pub fn cut(tools: &Tools, input: &Path, output: &Path, start: f64, end: f64, precise: bool) -> Result<()> {
    let length = (end - start).max(0.01);
    let mut cmd = command(&tools.ffmpeg);
    cmd.args(["-v", "error", "-y"])
        // Before -i, so FFmpeg jumps straight to the right spot.
        .args(["-ss", &format!("{start:.3}")])
        .arg("-i")
        .arg(input)
        .args(["-t", &format!("{length:.3}")])
        .args(["-map", "0:v:0", "-map", "0:a?", "-map_metadata", "0"]);
    if precise {
        cmd.args(["-c:v", "libx264", "-preset", "fast", "-crf", "17", "-pix_fmt", "yuv420p"])
            .args(["-c:a", "aac", "-b:a", "192k"]);
    } else {
        cmd.args(["-c", "copy", "-avoid_negative_ts", "make_zero"]);
    }
    // The container follows the original, whatever the output file is called.
    let format = match input.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() {
        Some("mkv") => Some("matroska"),
        Some("mp4") | Some("m4v") => Some("mp4"),
        Some("mov") => Some("mov"),
        Some("webm") => Some("webm"),
        _ => None,
    };
    if let Some(format) = format {
        cmd.args(["-f", format]);
    }
    cmd.arg(output);
    run("ffmpeg", &mut cmd)?;
    Ok(())
}

/// `<name> (trim).<ext>` next to the original, or `(trim 2)`, `(trim 3)` ... if taken.
pub fn unique_trim_path(original: &Path) -> std::path::PathBuf {
    let stem = original.file_stem().unwrap_or_default().to_string_lossy();
    let extension = original
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let folder = original.parent().unwrap_or(Path::new("."));
    let mut target = folder.join(format!("{stem} (trim){extension}"));
    let mut n = 2;
    while target.exists() {
        target = folder.join(format!("{stem} (trim {n}){extension}"));
        n += 1;
    }
    target
}
