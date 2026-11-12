//! Bringing the index in line with what is actually in the source folder.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use serde::Serialize;

use crate::library::{system_time_ms, ClipStatus, Library};
use crate::media::{probe, thumbnail, Tools};
use crate::{Error, Result};

/// File extensions treated as video clips.
pub const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mkv", "mov", "webm", "flv", "ts", "m4v", "avi"];

/// How many clips are probed and thumbnailed at once.
const WORKERS: usize = 4;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    /// Video files found in the folder.
    pub found: usize,
    /// Files that were new or had changed, and were (re)indexed.
    pub indexed: usize,
    /// Indexed clips whose file is gone.
    pub missing: usize,
    pub failed: Vec<ScanFailure>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanFailure {
    pub path: String,
    pub reason: String,
}

/// Scan `dir` (including subfolders), index new or changed clips, make
/// thumbnails, and flag clips whose files have disappeared.
///
/// `on_progress` is called from worker threads after each clip is processed.
pub fn scan(
    library: &Library,
    tools: &Tools,
    dir: &Path,
    on_progress: &(dyn Fn(ScanProgress) + Sync),
) -> Result<ScanSummary> {
    if !dir.is_dir() {
        return Err(Error::NotADirectory(dir.to_path_buf()));
    }

    let mut files = Vec::new();
    collect_videos(dir, &mut files);
    let known = library.known_files()?;

    // Work out what needs (re)processing.
    let mut todo = Vec::new();
    let mut on_disk = HashSet::new();
    for path in files {
        let key = path.to_string_lossy().into_owned();
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let stamp = FileStamp::of(&meta);
        let unchanged = known.get(&key).is_some_and(|k| {
            k.status == ClipStatus::Ready
                // A clip whose thumbnail failed is tried again, for example after FFmpeg is updated.
                && k.has_thumb
                && k.size_bytes == stamp.size_bytes
                && k.file_mtime_ms == stamp.mtime_ms
        });
        if !unchanged {
            todo.push((path, stamp));
        }
        on_disk.insert(key);
    }

    let mut summary = ScanSummary {
        found: on_disk.len(),
        ..Default::default()
    };

    // Anything indexed that is no longer on disk (anywhere, not just in `dir`).
    for (path, file) in &known {
        if !on_disk.contains(path) && !Path::new(path).exists() {
            if file.status != ClipStatus::Missing {
                library.set_status(file.id, ClipStatus::Missing)?;
            }
            summary.missing += 1;
        }
    }

    let total = todo.len();
    on_progress(ScanProgress { done: 0, total });

    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let indexed = AtomicUsize::new(0);
    let failed = Mutex::new(Vec::new());

    std::thread::scope(|scope| {
        for _ in 0..WORKERS.min(total) {
            scope.spawn(|| loop {
                let Some((path, stamp)) = todo.get(next.fetch_add(1, Ordering::Relaxed)) else {
                    break;
                };
                match index_one(library, tools, path, stamp) {
                    Ok(_) => {
                        indexed.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(e) => failed.lock().unwrap().push(ScanFailure {
                        path: path.to_string_lossy().into_owned(),
                        reason: e.to_string(),
                    }),
                }
                let done = done.fetch_add(1, Ordering::Relaxed) + 1;
                on_progress(ScanProgress { done, total });
            });
        }
    });

    summary.indexed = indexed.into_inner();
    summary.failed = failed.into_inner().unwrap();
    Ok(summary)
}

/// Probe one file, store it, and make its thumbnail. Returns the clip's id.
pub(crate) fn index_one(
    library: &Library,
    tools: &Tools,
    path: &Path,
    stamp: &FileStamp,
) -> Result<i64> {
    let info = probe(tools, path)?;
    let id = library.upsert(&info, stamp.mtime_ms, stamp.created_ms)?;

    let thumb = library.thumb_path(id);
    let at = thumbnail::pick_timestamp_secs(info.duration_ms);
    let made = thumbnail::generate(tools, path, &thumb, at, thumbnail::DEFAULT_WIDTH);

    // A clip without a thumbnail is still a usable clip.
    library.mark_ready(id, made.is_ok().then_some(thumb.as_path()))?;
    Ok(id)
}

pub(crate) struct FileStamp {
    pub(crate) size_bytes: u64,
    pub(crate) mtime_ms: i64,
    pub(crate) created_ms: i64,
}

impl FileStamp {
    pub(crate) fn of(meta: &std::fs::Metadata) -> Self {
        let mtime_ms = meta.modified().map(system_time_ms).unwrap_or(0);
        Self {
            size_bytes: meta.len(),
            mtime_ms,
            // Creation time is not available on every filesystem.
            created_ms: meta.created().map(system_time_ms).unwrap_or(mtime_ms),
        }
    }
}

fn collect_videos(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return; // unreadable folder: skip it, keep scanning the rest
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            collect_videos(&path, out);
        } else if kind.is_file() && is_video(&path) {
            out.push(path);
        }
    }
}

pub fn is_video(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| VIDEO_EXTENSIONS.iter().any(|v| v.eq_ignore_ascii_case(e)))
}

/// Cut `start..end` seconds out of a clip and add the result to the library.
///
/// With `replace` set, the cut becomes the clip itself: the callback is asked
/// to get rid of the original file (the app sends it to the Recycle Bin), the
/// cut takes its place, and the clip keeps its id, name, game, tags and
/// favourite. Without it, the cut is saved as a separate clip next to the
/// original. Either way the result keeps the original recording date.
/// Returns the id of the resulting clip.
pub fn export_trim(
    library: &Library,
    tools: &Tools,
    id: i64,
    start: f64,
    end: f64,
    precise: bool,
    replace: Option<&dyn Fn(&Path) -> Result<()>>,
) -> Result<i64> {
    let original = library
        .get(id)?
        .ok_or_else(|| crate::Error::FileNotFound(PathBuf::from(format!("clip {id}"))))?;
    let input = Path::new(&original.path);

    // The cut is written under a name the folder watcher ignores, then moved into place.
    let output = match replace {
        Some(_) => {
            let mut name = input.as_os_str().to_owned();
            name.push(".trimming");
            PathBuf::from(name)
        }
        None => crate::media::trim::unique_trim_path(input),
    };
    if let Err(e) = crate::media::trim::cut(tools, input, &output, start, end, precise) {
        let _ = std::fs::remove_file(&output);
        return Err(e);
    }

    let final_path = match replace {
        Some(remove_original) => {
            if let Err(e) = remove_original(input).and_then(|_| Ok(std::fs::rename(&output, input)?)) {
                // Keep the original if it is still there; drop the unfinished cut.
                if input.exists() {
                    let _ = std::fs::remove_file(&output);
                }
                return Err(e);
            }
            input.to_path_buf()
        }
        None => output,
    };

    // The result belongs to the month the moment was recorded, not to today.
    let when = std::time::UNIX_EPOCH + std::time::Duration::from_millis(original.created_at_ms.max(0) as u64);
    if let Ok(file) = std::fs::OpenOptions::new().write(true).open(&final_path) {
        let times = std::fs::FileTimes::new().set_modified(when);
        #[cfg(windows)]
        let times = {
            use std::os::windows::fs::FileTimesExt;
            times.set_created(when)
        };
        let _ = file.set_times(times);
    }

    let stamp = FileStamp::of(&std::fs::metadata(&final_path)?);
    // Same path means the same clip row: its name, game, tags and favourite stay.
    let new_id = index_one(library, tools, &final_path, &stamp)?;
    if replace.is_none() {
        library.set_game(new_id, original.game.as_deref())?;
        if !original.tags.is_empty() {
            library.set_tags(new_id, &original.tags)?;
        }
    }
    Ok(new_id)
}
