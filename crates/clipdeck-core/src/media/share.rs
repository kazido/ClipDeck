//! Making a copy of a clip that fits under a file size limit (for sharing),
//! and putting a file on the Windows clipboard so it can be pasted into Discord.

use std::path::{Path, PathBuf};

use super::tools::{command, run, Tools};
use crate::{Error, Result};

/// Audio for the shared copy, at this bitrate per second.
const AUDIO_KBPS: f64 = 96.0;
/// Aim a little under the limit, since muxing adds some overhead.
const SAFETY: f64 = 0.94;
/// Picture heights to choose from, largest first.
const SIZES: [u32; 6] = [1080, 720, 540, 480, 360, 240];
/// How many bits each pixel of each frame gets, for a result that still looks clean.
const BITS_PER_PIXEL: f64 = 0.04;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Audio {
    None,
    /// One audio track, counting from 0.
    Track(usize),
    /// All the tracks played together.
    Mix,
}

pub struct Source<'a> {
    pub input: &'a Path,
    pub start: f64,
    pub end: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub audio_tracks: usize,
}

/// Encode `source` to `output`, smaller than `limit_bytes`. Returns the size.
///
/// The video bitrate is worked out from the limit and the length, and the
/// picture is made smaller when the bitrate is too low to keep it sharp.
/// If the result still lands over the limit, it is tried again lower.
pub fn encode(tools: &Tools, source: &Source<'_>, output: &Path, limit_bytes: u64, audio: Audio) -> Result<u64> {
    let length = (source.end - source.start).max(0.1);
    let audio_kbps = if matches!(audio, Audio::None) { 0.0 } else { AUDIO_KBPS };
    let mut scale = SAFETY;

    for _attempt in 0..3 {
        let total_kbps = limit_bytes as f64 * 8.0 * scale / length / 1000.0;
        let video_kbps = (total_kbps - audio_kbps).max(150.0);
        encode_once(tools, source, output, video_kbps, audio)?;
        let size = std::fs::metadata(output)?.len();
        if size <= limit_bytes {
            return Ok(size);
        }
        // Over: aim lower by the amount we overshot.
        scale *= limit_bytes as f64 / size as f64 * 0.97;
    }
    let size = std::fs::metadata(output)?.len();
    if size <= limit_bytes {
        Ok(size)
    } else {
        let _ = std::fs::remove_file(output);
        Err(Error::ToolFailed { tool: "ffmpeg", message: "the clip could not be made small enough".into() })
    }
}

fn encode_once(tools: &Tools, source: &Source<'_>, output: &Path, video_kbps: f64, audio: Audio) -> Result<()> {
    // The frame rate is kept (up to 60); when the size limit is tight, the picture
    // gets smaller instead. Pick the largest standard height that leaves enough
    // bits per pixel for a clean-looking result.
    let fps = source.fps.clamp(1.0, 60.0);
    let aspect = source.width.max(1) as f64 / source.height.max(1) as f64;
    let bits_per_second = video_kbps * 1000.0;
    let mut height = *SIZES.last().unwrap();
    for candidate in SIZES {
        let width = candidate as f64 * aspect;
        if candidate <= source.height && width * candidate as f64 * fps * BITS_PER_PIXEL <= bits_per_second {
            height = candidate;
            break;
        }
    }
    height = height.min(source.height.max(2));
    // Only when even the smallest picture would be starved does the frame rate drop.
    let smallest_width = *SIZES.last().unwrap() as f64 * aspect;
    let fps = if fps > 30.0 && smallest_width * *SIZES.last().unwrap() as f64 * fps * BITS_PER_PIXEL > bits_per_second {
        30.0
    } else {
        fps
    };
    let video_filter = format!("scale=-2:{height},fps={fps:.3}");

    let log = std::env::temp_dir().join(format!("clipdeck-pass-{}-{}", std::process::id(), video_kbps as u64));
    let bitrate = format!("{video_kbps:.0}k");
    let bufsize = format!("{:.0}k", video_kbps * 2.0);
    let length = format!("{:.3}", (source.end - source.start).max(0.1));
    let start = format!("{:.3}", source.start);

    let build = |pass: u8| {
        // The first pass only studies the picture, so it needs no audio.
        let audio = if pass == 1 { Audio::None } else { audio };
        let mut cmd = command(&tools.ffmpeg);
        cmd.args(["-v", "error", "-y", "-ss", &start])
            .arg("-i")
            .arg(source.input)
            .args(["-t", &length]);
        match audio {
            Audio::None => {
                cmd.args(["-map", "0:v:0", "-an"]);
            }
            Audio::Track(n) => {
                cmd.args(["-map", "0:v:0", "-map", &format!("0:a:{n}?")]);
            }
            Audio::Mix if source.audio_tracks > 1 => {
                let inputs: String = (0..source.audio_tracks.min(6)).map(|i| format!("[0:a:{i}]")).collect();
                cmd.args([
                    "-filter_complex",
                    &format!(
                        "{inputs}amix=inputs={}:normalize=0,alimiter=limit=0.95[mix]",
                        source.audio_tracks.min(6)
                    ),
                    "-map",
                    "0:v:0",
                    "-map",
                    "[mix]",
                ]);
            }
            Audio::Mix => {
                cmd.args(["-map", "0:v:0", "-map", "0:a:0?"]);
            }
        }
        cmd.args(["-vf", &video_filter])
            .args(["-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p"])
            .args(["-b:v", &bitrate, "-maxrate", &bitrate, "-bufsize", &bufsize])
            .args(["-pass", &pass.to_string()])
            .arg("-passlogfile")
            .arg(&log);
        cmd
    };

    // First pass only studies the video.
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut first = build(1);
    first.args(["-f", "null"]).arg(null);
    let first_result = run("ffmpeg", &mut first);

    let result = first_result.and_then(|_| {
        let mut second = build(2);
        if !matches!(audio, Audio::None) {
            second.args(["-c:a", "aac", "-b:a", &format!("{AUDIO_KBPS:.0}k"), "-ac", "2"]);
        }
        second.args(["-movflags", "+faststart"]).arg(output);
        run("ffmpeg", &mut second).map(|_| ())
    });

    // Clean up the first pass's notes.
    if let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) {
        let prefix = log.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    result
}

/// A file name that is safe on Windows.
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.').to_string();
    if cleaned.is_empty() { "clip".into() } else { cleaned }
}

/// Delete shared copies older than a week from `folder`.
pub fn clean_old(folder: &Path) {
    let Ok(entries) = std::fs::read_dir(folder) else { return };
    let week = std::time::Duration::from_secs(7 * 24 * 3600);
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > week);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Put a file on the clipboard the way Explorer does, so pasting into Discord attaches it.
pub fn copy_file_to_clipboard(path: &Path) -> Result<()> {
    let quoted = super::tools::ps_escape(&path.to_string_lossy());
    run(
        "powershell",
        command(Path::new("powershell")).args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("Set-Clipboard -LiteralPath '{quoted}'"),
        ]),
    )?;
    Ok(())
}

/// Put several files on the clipboard at once.
pub fn copy_files_to_clipboard(paths: &[PathBuf]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let list = paths
        .iter()
        .map(|p| format!("'{}'", super::tools::ps_escape(&p.to_string_lossy())))
        .collect::<Vec<_>>()
        .join(",");
    run(
        "powershell",
        command(Path::new("powershell")).args(["-NoProfile", "-NonInteractive", "-Command", &format!("Set-Clipboard -LiteralPath {list}")]),
    )?;
    Ok(())
}

/// A free name in `folder` for `<stem> (discord).mp4`.
pub fn output_path(folder: &Path, title: &str) -> PathBuf {
    let stem = safe_name(title);
    let mut target = folder.join(format!("{stem} (discord).mp4"));
    let mut n = 2;
    while target.exists() {
        target = folder.join(format!("{stem} (discord {n}).mp4"));
        n += 1;
    }
    target
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_safe() {
        assert_eq!(safe_name("a:b/c?d."), "a_b_c_d");
        assert_eq!(safe_name("..."), "clip");
    }
}
