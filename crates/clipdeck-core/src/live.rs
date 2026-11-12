//! Live ingest: notice new clips the moment they are saved, wait until they
//! are completely written, sort them by game, and add them to the library.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use notify::{EventKind, RecursiveMode, Watcher};
use serde::Serialize;

use crate::games::{self, ForegroundApp};
use crate::library::Library;
use crate::media::Tools;
use crate::scan::{index_one, is_video, FileStamp};
use crate::{Error, Result};

/// How often files that are still being written are re-checked.
const POLL: Duration = Duration::from_millis(400);
/// A file must stay the same size this long before it counts as finished.
const SETTLE: Duration = Duration::from_secs(2);
/// Stop retrying a file that still cannot be read after this long.
const GIVE_UP: Duration = Duration::from_secs(120);

/// Reports which program has focus. Swappable so tests can fake it.
pub type Detector = Arc<dyn Fn() -> Option<ForegroundApp> + Send + Sync>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum LiveEvent {
    /// A new clip was added to the library.
    Added { id: i64, path: String, game: Option<String> },
    /// A new file never became readable.
    Failed { path: String, reason: String },
}

/// Keeps watching for as long as it is alive. Drop it to stop.
pub struct LiveIngest {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    // Dropping the watcher stops the OS notifications.
    _watcher: notify::RecommendedWatcher,
}

impl LiveIngest {
    pub fn start(
        library: Arc<Library>,
        tools: Tools,
        dir: PathBuf,
        detect: Detector,
        on_event: impl Fn(LiveEvent) + Send + 'static,
    ) -> Result<Self> {
        if !dir.is_dir() {
            return Err(Error::NotADirectory(dir));
        }

        let (tx, rx) = mpsc::channel::<PathBuf>();
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            let Ok(event) = event else { return };
            if matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                for path in event.paths {
                    let _ = tx.send(path);
                }
            }
        })
        .map_err(watch_error)?;
        watcher.watch(&dir, RecursiveMode::Recursive).map_err(watch_error)?;

        let stop = Arc::new(AtomicBool::new(false));
        let worker = {
            let stop = stop.clone();
            std::thread::spawn(move || {
                let ingest = Ingest { library, tools, dir, detect };
                ingest.run(rx, &stop, &on_event);
            })
        };

        Ok(Self {
            stop,
            worker: Some(worker),
            _watcher: watcher,
        })
    }
}

// The app keeps this in shared state, so it must be movable between threads.
const _: fn() = || {
    fn assert_send<T: Send>() {}
    assert_send::<LiveIngest>();
};

impl Drop for LiveIngest {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn watch_error(e: notify::Error) -> Error {
    Error::Io(std::io::Error::other(e.to_string()))
}

/// A file we have seen appear and are waiting on.
struct Pending {
    /// What had focus when the file first appeared.
    app: Option<ForegroundApp>,
    first_seen: Instant,
    size: Option<u64>,
    unchanged_since: Instant,
}

struct Ingest {
    library: Arc<Library>,
    tools: Tools,
    dir: PathBuf,
    detect: Detector,
}

impl Ingest {
    fn run(&self, rx: mpsc::Receiver<PathBuf>, stop: &AtomicBool, on_event: &dyn Fn(LiveEvent)) {
        let mut pending: HashMap<PathBuf, Pending> = HashMap::new();

        while !stop.load(Ordering::SeqCst) {
            // Collect newly reported files, capturing the foreground program
            // right away: by the time the file is finished it may have changed.
            let first = match rx.recv_timeout(POLL) {
                Ok(path) => Some(path),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => break,
            };
            for path in first.into_iter().chain(rx.try_iter()) {
                if is_video(&path) && !pending.contains_key(&path) {
                    let now = Instant::now();
                    pending.insert(
                        path,
                        Pending {
                            app: (self.detect)(),
                            first_seen: now,
                            size: None,
                            unchanged_since: now,
                        },
                    );
                }
            }

            pending.retain(|path, file| self.check(path, file, on_event));
        }
    }

    /// Look at one waiting file. Returns false once it is dealt with.
    fn check(&self, path: &Path, file: &mut Pending, on_event: &dyn Fn(LiveEvent)) -> bool {
        let Ok(meta) = std::fs::metadata(path) else {
            // Gone again (renamed, deleted, or a temporary file).
            return file.first_seen.elapsed() < SETTLE;
        };

        if file.size != Some(meta.len()) {
            file.size = Some(meta.len());
            file.unchanged_since = Instant::now();
            return true;
        }
        if file.unchanged_since.elapsed() < SETTLE || !writer_has_finished(path) {
            return file.first_seen.elapsed() < GIVE_UP;
        }

        match self.add(path, file.app.as_ref()) {
            Ok(Some(event)) => on_event(event),
            Ok(None) => {}
            Err(e) if file.first_seen.elapsed() < GIVE_UP => {
                // Probably still being finalised; look again after a pause.
                let _ = e;
                file.unchanged_since = Instant::now();
                return true;
            }
            Err(e) => on_event(LiveEvent::Failed {
                path: path.to_string_lossy().into_owned(),
                reason: e.to_string(),
            }),
        }
        false
    }

    /// Sort (if wanted) and index a finished file. None if it was already indexed.
    fn add(&self, path: &Path, app: Option<&ForegroundApp>) -> Result<Option<LiveEvent>> {
        let stamp = FileStamp::of(&std::fs::metadata(path)?);
        let key = path.to_string_lossy();
        if self.library.is_indexed(&key, stamp.size_bytes, stamp.mtime_ms)? {
            return Ok(None); // e.g. the file we ourselves just moved into a game folder
        }

        // Only clips saved straight into the clips folder get sorted; anything
        // already inside a subfolder was put there on purpose.
        let game = match app {
            Some(app) if path.parent() == Some(self.dir.as_path()) && self.library.sort_by_game()? => {
                self.library.game_for_app(&app.exe, Some(&app.path))?
            }
            _ => None,
        };

        let final_path = match &game {
            Some(game) => move_into_game_folder(&self.dir, path, game).unwrap_or_else(|_| path.to_path_buf()),
            None => path.to_path_buf(),
        };

        // Moving a file keeps its size and times, so the stamp is still right.
        let id = index_one(&self.library, &self.tools, &final_path, &stamp)?;
        if game.is_some() {
            self.library.set_game(id, game.as_deref())?;
        }
        Ok(Some(LiveEvent::Added {
            id,
            path: final_path.to_string_lossy().into_owned(),
            game,
        }))
    }
}

/// Move a clip to `<clips folder>/<game>/<game> <rest of name>`, never
/// overwriting an existing file. Returns the new path.
fn move_into_game_folder(root: &Path, clip: &Path, game: &str) -> std::io::Result<PathBuf> {
    let folder = root.join(games::safe_file_name(game));
    std::fs::create_dir_all(&folder)?;

    let original = clip.file_name().unwrap_or_default().to_string_lossy();
    let wanted = games::sorted_file_name(game, &original);
    let wanted = Path::new(&wanted);
    let stem = wanted.file_stem().unwrap_or_default().to_string_lossy();
    let extension = wanted.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();

    let mut target = folder.join(wanted);
    let mut copy = 2;
    while target.exists() {
        target = folder.join(format!("{stem} ({copy}){extension}"));
        copy += 1;
    }
    std::fs::rename(clip, &target)?;
    Ok(target)
}

/// True once no other program still has the file open for writing.
#[cfg(windows)]
fn writer_has_finished(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    // Asking for the file with no sharing fails while OBS still holds it.
    std::fs::OpenOptions::new().read(true).share_mode(0).open(path).is_ok()
}

#[cfg(not(windows))]
fn writer_has_finished(path: &Path) -> bool {
    std::fs::File::open(path).is_ok()
}
