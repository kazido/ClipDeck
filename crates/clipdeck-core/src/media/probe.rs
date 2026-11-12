//! Reading a clip's metadata with FFprobe.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::tools::{command, run, Tools};
use crate::{Error, Result};

/// What we know about a clip after probing it. Sent to the UI as JSON.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipInfo {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    /// FFprobe's container name, e.g. "mov,mp4,m4a,3gp,3g2,mj2" or "matroska,webm".
    pub container: String,
    pub duration_ms: u64,
    /// Overall bitrate in bits per second, when the container reports it.
    pub bit_rate: Option<u64>,
    pub video: VideoInfo,
    pub audio: Vec<AudioInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub codec: String,
    pub profile: Option<String>,
    pub width: u32,
    pub height: u32,
    /// Frame rate kept as a fraction so 60000/1001 (59.94) stays exact.
    pub fps_num: u32,
    pub fps_den: u32,
    pub pix_fmt: Option<String>,
    pub bit_rate: Option<u64>,
}

impl VideoInfo {
    pub fn fps(&self) -> f64 {
        if self.fps_den == 0 {
            0.0
        } else {
            f64::from(self.fps_num) / f64::from(self.fps_den)
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    /// Track name, when the recorder wrote one (OBS writes its track names).
    pub title: Option<String>,
    pub codec: String,
    pub channels: Option<u32>,
    pub sample_rate: Option<u32>,
}

/// Probe a video file. Fails if the file is missing, unreadable, incomplete,
/// or has no video stream.
pub fn probe(tools: &Tools, path: &Path) -> Result<ClipInfo> {
    if !path.is_file() {
        return Err(Error::FileNotFound(path.to_path_buf()));
    }

    let out = run(
        "ffprobe",
        command(&tools.ffprobe)
            .args(["-v", "error", "-print_format", "json"])
            .args(["-show_format", "-show_streams"])
            .arg(path),
    )?;

    let raw: RawProbe =
        serde_json::from_slice(&out.stdout).map_err(|e| Error::BadProbeOutput(e.to_string()))?;

    build_info(path, raw)
}

// --- FFprobe's JSON, as it actually arrives (most numbers are strings) ------

#[derive(Deserialize)]
struct RawProbe {
    #[serde(default)]
    streams: Vec<RawStream>,
    format: Option<RawFormat>,
}

#[derive(Deserialize)]
struct RawFormat {
    format_name: Option<String>,
    duration: Option<String>,
    size: Option<String>,
    bit_rate: Option<String>,
}

#[derive(Deserialize)]
struct RawStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    profile: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    pix_fmt: Option<String>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    bit_rate: Option<String>,
    duration: Option<String>,
    channels: Option<u32>,
    sample_rate: Option<String>,
    #[serde(default)]
    disposition: RawDisposition,
    #[serde(default)]
    tags: std::collections::HashMap<String, String>,
}

#[derive(Deserialize, Default)]
struct RawDisposition {
    #[serde(default)]
    attached_pic: u8,
}

fn build_info(path: &Path, raw: RawProbe) -> Result<ClipInfo> {
    let format = raw
        .format
        .ok_or_else(|| Error::BadProbeOutput("missing format section".into()))?;

    // Cover art shows up as a "video" stream; skip it.
    let v = raw
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video") && s.disposition.attached_pic == 0)
        .ok_or_else(|| Error::NoVideoStream(path.to_path_buf()))?;

    let (fps_num, fps_den) = v
        .avg_frame_rate
        .as_deref()
        .and_then(parse_fraction)
        .or_else(|| v.r_frame_rate.as_deref().and_then(parse_fraction))
        .unwrap_or((0, 1));

    let duration_secs = format
        .duration
        .as_deref()
        .and_then(parse_f64)
        .or_else(|| v.duration.as_deref().and_then(parse_f64))
        .unwrap_or(0.0);

    let size_bytes = match format.size.as_deref().and_then(|s| s.parse().ok()) {
        Some(n) => n,
        None => std::fs::metadata(path)?.len(),
    };

    let audio = raw
        .streams
        .iter()
        .filter(|s| s.codec_type.as_deref() == Some("audio"))
        .map(|s| AudioInfo {
            title: track_title(&s.tags),
            codec: s.codec_name.clone().unwrap_or_else(|| "unknown".into()),
            channels: s.channels,
            sample_rate: s.sample_rate.as_deref().and_then(|r| r.parse().ok()),
        })
        .collect();

    Ok(ClipInfo {
        path: path.to_string_lossy().into_owned(),
        file_name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        size_bytes,
        container: format.format_name.unwrap_or_else(|| "unknown".into()),
        duration_ms: (duration_secs * 1000.0).round().max(0.0) as u64,
        bit_rate: format.bit_rate.as_deref().and_then(|b| b.parse().ok()),
        video: VideoInfo {
            codec: v.codec_name.clone().unwrap_or_else(|| "unknown".into()),
            profile: v.profile.clone(),
            width: v.width.unwrap_or(0),
            height: v.height.unwrap_or(0),
            fps_num,
            fps_den,
            pix_fmt: v.pix_fmt.clone(),
            bit_rate: v.bit_rate.as_deref().and_then(|b| b.parse().ok()),
        },
        audio,
    })
}

/// A human-written track name, such as the ones set in OBS's audio settings.
/// Containers store it under different keys: MKV uses `title`, MP4 uses a
/// `name` entry or the track's `handler_name` (which is a generic placeholder
/// unless the recorder set it).
fn track_title(tags: &std::collections::HashMap<String, String>) -> Option<String> {
    const PLACEHOLDERS: &[&str] = &["SoundHandler", "Core Media Audio", "Apple Sound Media Handler"];
    let find = |key: &str| {
        tags.iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    find("title")
        .or_else(|| find("name"))
        .or_else(|| find("handler_name").filter(|h| !PLACEHOLDERS.contains(&h.as_str())))
}

/// Parse "60000/1001" into (60000, 1001). Rejects "0/0", which FFprobe uses
/// to mean "unknown".
fn parse_fraction(s: &str) -> Option<(u32, u32)> {
    let (num, den) = s.split_once('/')?;
    let num: u32 = num.trim().parse().ok()?;
    let den: u32 = den.trim().parse().ok()?;
    (num > 0 && den > 0).then_some((num, den))
}

fn parse_f64(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fractions() {
        assert_eq!(parse_fraction("60/1"), Some((60, 1)));
        assert_eq!(parse_fraction("60000/1001"), Some((60000, 1001)));
        assert_eq!(parse_fraction("0/0"), None);
        assert_eq!(parse_fraction("abc"), None);
    }

    #[test]
    fn track_titles() {
        let tags = |pairs: &[(&str, &str)]| {
            pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
        };
        assert_eq!(track_title(&tags(&[("title", "Game")])), Some("Game".into()));
        assert_eq!(track_title(&tags(&[("handler_name", "Discord")])), Some("Discord".into()));
        assert_eq!(track_title(&tags(&[("NAME", " Mic ")])), Some("Mic".into()));
        assert_eq!(track_title(&tags(&[("handler_name", "SoundHandler")])), None);
        assert_eq!(track_title(&tags(&[("language", "und")])), None);
    }
}
