//! A "filmstrip": many tiny frames of a clip packed into a few pictures
//! ("pages"), so the player can show what is at any moment while you drag,
//! without decoding any video.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::tools::{command, run, Tools};
use crate::Result;

pub const FRAME_WIDTH: u32 = 256;
pub const FRAME_HEIGHT: u32 = 144;
const COLUMNS: u32 = 12;
/// Rows per page, so a page holds `COLUMNS * ROWS` frames.
const ROWS: u32 = 10;
const PER_PAGE: u32 = COLUMNS * ROWS;
/// A frame every twelfth of a second, which is enough to catch quick events,
/// but never more than this many frames in total (long clips get wider gaps).
const MIN_INTERVAL: f64 = 1.0 / 12.0;
const MAX_FRAMES: f64 = 1200.0;
/// The cache folder is trimmed to this size, oldest files first.
const MAX_CACHE_BYTES: u64 = 300 * 1024 * 1024;
/// Marks files of the current layout; anything else in the folder is leftover.
const MARK: &str = "-v3-p";

/// Where the frames are inside the pages.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub columns: u32,
    /// Rows in each page.
    pub rows: u32,
    pub frame_width: u32,
    pub frame_height: u32,
    /// Seconds between frames. Frame `n` shows the clip at `n * interval`.
    pub interval: f64,
    pub frames: u32,
    pub frames_per_page: u32,
    pub pages: u32,
}

pub fn layout(duration_secs: f64) -> Layout {
    let interval = (duration_secs / MAX_FRAMES).max(MIN_INTERVAL);
    let frames = ((duration_secs / interval).ceil() as u32).max(1);
    Layout {
        columns: COLUMNS,
        rows: ROWS,
        frame_width: FRAME_WIDTH,
        frame_height: FRAME_HEIGHT,
        interval,
        frames,
        frames_per_page: PER_PAGE,
        pages: frames.div_ceil(PER_PAGE),
    }
}

/// `<name>-v3-p000.jpg`, `<name>-v3-p001.jpg`, ... next to `base`.
pub fn page_path(base: &Path, page: u32) -> PathBuf {
    let stem = base.file_stem().unwrap_or_default().to_string_lossy();
    base.with_file_name(format!("{stem}{MARK}{page:03}.jpg"))
}

fn existing_pages(base: &Path) -> u32 {
    let mut n = 0;
    while page_path(base, n).is_file() {
        n += 1;
    }
    n
}

/// Make the filmstrip pages of `input` (named after `base`), unless they exist.
/// Returns the layout, whose `pages` is how many pages really exist.
pub fn ensure(tools: &Tools, input: &Path, base: &Path, duration_secs: f64) -> Result<Layout> {
    let mut layout = layout(duration_secs);
    let have = existing_pages(base);
    if have >= layout.pages {
        return Ok(layout);
    }
    if let Some(folder) = base.parent() {
        std::fs::create_dir_all(folder)?;
        prune(folder);
    }
    for page in 0..have.max(layout.pages) {
        let _ = std::fs::remove_file(page_path(base, page));
    }

    let filter = format!(
        "fps=1/{interval},scale={w}:{h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,tile={cols}x{rows}",
        interval = layout.interval,
        w = FRAME_WIDTH,
        h = FRAME_HEIGHT,
        cols = layout.columns,
        rows = layout.rows,
    );
    // Written under another name first, so a half-finished page is never used.
    let stem = base.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let pattern = base.with_file_name(format!("{stem}{MARK}%03d.part"));
    let made = run(
        "ffmpeg",
        command(&tools.ffmpeg)
            .args(["-v", "error", "-y"])
            .arg("-i")
            .arg(input)
            .args(["-an", "-vf", &filter])
            .args(["-c:v", "mjpeg", "-q:v", "8", "-f", "image2", "-start_number", "0"])
            .arg(&pattern),
    );

    let part = |page: u32| page_path(base, page).with_extension("part");
    if let Err(e) = made {
        for page in 0..layout.pages + 1 {
            let _ = std::fs::remove_file(part(page));
        }
        return Err(e);
    }
    let mut pages = 0;
    while part(pages).is_file() {
        std::fs::rename(part(pages), page_path(base, pages))?;
        pages += 1;
    }
    layout.pages = pages;
    layout.frames = layout.frames.min(pages * PER_PAGE);
    Ok(layout)
}

/// Delete leftovers of older layouts, then the oldest files while the folder is over the size limit.
fn prune(folder: &Path) {
    let Ok(entries) = std::fs::read_dir(folder) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        let stale = (name.ends_with(".jpg") && !name.contains(MARK)) || name.ends_with(".part");
        if stale {
            let _ = std::fs::remove_file(entry.path());
        } else if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                files.push((meta.modified().unwrap_or(std::time::UNIX_EPOCH), meta.len(), entry.path()));
            }
        }
    }
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.0);
    for (_, size, path) in files {
        if total <= MAX_CACHE_BYTES {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_follows_the_length() {
        let short = layout(10.0);
        assert_eq!((short.frames, short.pages), (120, 1));
        let minute = layout(58.4);
        assert_eq!((minute.frames, minute.pages), (701, 6));
        let long = layout(600.0);
        assert!(long.frames <= 1201 && long.interval >= 0.5, "{long:?}");
        assert_eq!(long.pages, long.frames.div_ceil(120));
    }

    #[test]
    fn page_names() {
        let base = Path::new("C:/x/150-99.jpg");
        assert_eq!(page_path(base, 2), Path::new("C:/x/150-99-v3-p002.jpg"));
    }
}
