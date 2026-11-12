use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use clipdeck_core::library::{Clip, ClipQuery, Folder};
use clipdeck_core::media::{probe, ClipInfo};
use clipdeck_core::scan::{scan, ScanProgress, ScanSummary};
use clipdeck_core::Error;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::{blocking, CommandResult};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    source_dir: Option<String>,
    scanning: bool,
    sort_by_game: bool,
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CommandResult<Settings> {
    let source_dir = state.library.source_dir().map_err(|e| e.to_string())?;
    Ok(Settings {
        source_dir: source_dir.map(|p| p.to_string_lossy().into_owned()),
        scanning: state.scanning.load(Ordering::SeqCst),
        sort_by_game: state.library.sort_by_game().map_err(|e| e.to_string())?,
    })
}

/// Turn moving new clips into per-game folders on or off.
#[tauri::command]
pub fn set_sort_by_game(state: State<'_, AppState>, enabled: bool) -> CommandResult<()> {
    state
        .library
        .set_sort_by_game(enabled)
        .map_err(|e| e.to_string())
}

/// Choose the folder OBS saves clips to, then scan it.
#[tauri::command]
pub fn set_source_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> CommandResult<()> {
    let dir = PathBuf::from(path);
    if !dir.is_dir() {
        return Err(Error::NotADirectory(dir).to_string());
    }
    state.library.set_source_dir(&dir).map_err(|e| e.to_string())?;
    app.asset_protocol_scope()
        .allow_directory(&dir, true)
        .map_err(|e| e.to_string())?;
    spawn_scan(app.clone());
    crate::live::start(&app);
    Ok(())
}

#[tauri::command]
pub fn start_scan(app: AppHandle) {
    spawn_scan(app);
}

#[tauri::command]
pub async fn list_clips(state: State<'_, AppState>, query: ClipQuery) -> CommandResult<Vec<Clip>> {
    let library = state.library.clone();
    blocking(move || library.list(&query)).await
}

/// Subfolders of `parent` that contain clips.
#[tauri::command]
pub async fn list_folders(state: State<'_, AppState>, parent: String) -> CommandResult<Vec<Folder>> {
    let library = state.library.clone();
    blocking(move || library.folders(&parent)).await
}

/// Full, freshly probed details for one clip, including every audio track.
#[tauri::command]
pub async fn clip_details(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> CommandResult<ClipInfo> {
    let tools = state.tools(&app).map_err(|e| e.to_string())?;
    let library = state.library.clone();
    blocking(move || {
        let clip = library
            .get(id)?
            .ok_or_else(|| Error::FileNotFound(PathBuf::from(format!("clip {id}"))))?;
        probe(&tools, Path::new(&clip.path))
    })
    .await
}

/// Band levels over time for a clip's audio, for the visualizer.
#[tauri::command]
pub async fn clip_audio_levels(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> CommandResult<clipdeck_core::media::levels::AudioLevels> {
    let tools = state.tools(&app).map_err(|e| e.to_string())?;
    let library = state.library.clone();
    blocking(move || {
        let clip = library
            .get(id)?
            .ok_or_else(|| Error::FileNotFound(PathBuf::from(format!("clip {id}"))))?;
        clipdeck_core::media::levels::analyze(&tools, Path::new(&clip.path), clip.audio_tracks as usize)
    })
    .await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanFinished {
    summary: Option<ScanSummary>,
    error: Option<String>,
}

/// Scan the source folder on a background thread. Does nothing if a scan is
/// already running. Emits `scan-progress` while working and `scan-finished`
/// at the end.
pub fn spawn_scan(app: AppHandle) {
    let already_running = app
        .state::<AppState>()
        .scanning
        .swap(true, Ordering::SeqCst);
    if already_running {
        return;
    }

    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let result = run_scan(&app, &state);
        state.scanning.store(false, Ordering::SeqCst);

        let payload = match result {
            Ok(summary) => ScanFinished {
                summary: Some(summary),
                error: None,
            },
            Err(e) => ScanFinished {
                summary: None,
                error: Some(e.to_string()),
            },
        };
        let _ = app.emit("scan-finished", payload);
    });
}

fn run_scan(app: &AppHandle, state: &AppState) -> clipdeck_core::Result<ScanSummary> {
    let Some(dir) = state.library.source_dir()? else {
        return Ok(ScanSummary::default());
    };
    let tools = state.tools(app)?;
    let on_progress = |progress: ScanProgress| {
        let _ = app.emit("scan-progress", progress);
    };
    scan(&state.library, &tools, &dir, &on_progress)
}

/// Rename a clip (its display name only; the file is untouched).
#[tauri::command]
pub fn rename_clip(state: State<'_, AppState>, id: i64, title: String) -> CommandResult<Clip> {
    let title = title.trim();
    if title.is_empty() {
        return Err("The name can't be empty.".into());
    }
    let e = |e: Error| e.to_string();
    state.library.set_title(id, title).map_err(e)?;
    state.library.get(id).map_err(e)?.ok_or_else(|| "Clip not found.".to_string())
}

/// Set or clear the game of a clip.
#[tauri::command]
pub fn set_clip_game(state: State<'_, AppState>, id: i64, game: Option<String>) -> CommandResult<Clip> {
    let game = game.map(|g| g.trim().to_string()).filter(|g| !g.is_empty());
    let e = |e: Error| e.to_string();
    state.library.set_game(id, game.as_deref()).map_err(e)?;
    state.library.get(id).map_err(e)?.ok_or_else(|| "Clip not found.".to_string())
}

#[tauri::command]
pub fn list_games(state: State<'_, AppState>) -> CommandResult<Vec<String>> {
    state.library.games().map_err(|e| e.to_string())
}

/// Rename a game everywhere. Returns how many clips changed.
#[tauri::command]
pub fn rename_game(state: State<'_, AppState>, old: String, new: String) -> CommandResult<usize> {
    let new = new.trim();
    if new.is_empty() {
        return Err("The name can't be empty.".into());
    }
    state.library.rename_game(&old, new).map_err(|e| e.to_string())
}

/// Star or unstar a clip.
#[tauri::command]
pub fn set_favorite(state: State<'_, AppState>, id: i64, favorite: bool) -> CommandResult<Clip> {
    let e = |e: Error| e.to_string();
    state.library.set_favorite(id, favorite).map_err(e)?;
    state.library.get(id).map_err(e)?.ok_or_else(|| "Clip not found.".to_string())
}

/// Wait for a file to stop being "in use" and run `attempt` on it. Large clips
/// can still be read by our own preview-making FFmpeg for a while, so after the
/// first failure those are stopped, and the attempt is repeated for several seconds.
fn when_free(path: &Path, attempt: impl Fn() -> Result<(), String>) -> clipdeck_core::Result<()> {
    let mut last = String::new();
    for round in 0..14 {
        match attempt() {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = e;
                if !last.contains("in use") {
                    break;
                }
            }
        }
        if round == 0 {
            clipdeck_core::media::tools::stop_helpers_using(path);
        }
        std::thread::sleep(std::time::Duration::from_millis(700));
    }
    let message = if last.contains("in use") {
        "Windows says another program still has this clip open (OBS, a media player or Explorer's preview pane, for example). Close it and try again.".to_string()
    } else {
        format!("{last}. Very large clips can be too big for the Recycle Bin. You can raise its size in its Properties, or delete the clip permanently.")
    };
    Err(Error::Io(std::io::Error::other(message)))
}

/// Move a file to the Recycle Bin.
pub fn move_to_bin(path: &Path) -> clipdeck_core::Result<()> {
    when_free(path, || trash::delete(path).map_err(|e| e.to_string()))
}

/// Delete a file for good, skipping the Recycle Bin.
fn delete_for_good(path: &Path) -> clipdeck_core::Result<()> {
    when_free(path, || std::fs::remove_file(path).map_err(|e| e.to_string()))
}

/// Move clips to the Recycle Bin and forget them. Returns the ids that were removed.
#[tauri::command]
pub async fn delete_clips(
    state: State<'_, AppState>,
    ids: Vec<i64>,
    permanent: Option<bool>,
) -> CommandResult<Vec<i64>> {
    let library = state.library.clone();
    blocking(move || {
        let mut done = Vec::new();
        for id in ids {
            let Some(clip) = library.get(id)? else { continue };
            if Path::new(&clip.path).exists() {
                if permanent == Some(true) {
                    delete_for_good(Path::new(&clip.path))?;
                } else {
                    move_to_bin(Path::new(&clip.path))?;
                }
            }
            if let Some(thumb) = &clip.thumb_path {
                let _ = std::fs::remove_file(thumb);
            }
            library.delete(id)?;
            done.push(id);
        }
        Ok(done)
    })
    .await
}

/// Replace a clip's tags.
#[tauri::command]
pub fn set_clip_tags(state: State<'_, AppState>, id: i64, tags: Vec<String>) -> CommandResult<Clip> {
    let e = |e: Error| e.to_string();
    state.library.set_tags(id, &tags).map_err(e)?;
    state.library.get(id).map_err(e)?.ok_or_else(|| "Clip not found.".to_string())
}

#[tauri::command]
pub fn list_tags(state: State<'_, AppState>) -> CommandResult<Vec<String>> {
    state.library.tags().map_err(|e| e.to_string())
}

/// Times of a clip's keyframes, for the trim bar.
#[tauri::command]
pub async fn clip_keyframes(app: AppHandle, state: State<'_, AppState>, id: i64) -> CommandResult<Vec<f64>> {
    let tools = state.tools(&app).map_err(|e| e.to_string())?;
    let library = state.library.clone();
    blocking(move || {
        let clip = library
            .get(id)?
            .ok_or_else(|| Error::FileNotFound(PathBuf::from(format!("clip {id}"))))?;
        clipdeck_core::media::trim::keyframes(&tools, Path::new(&clip.path))
    })
    .await
}

/// Save part of a clip: as the clip itself (the original goes to the Recycle Bin),
/// or as a new clip next to it when `keep_original` is set.
#[tauri::command]
pub async fn export_trim(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    start: f64,
    end: f64,
    precise: bool,
    keep_original: bool,
) -> CommandResult<Clip> {
    let tools = state.tools(&app).map_err(|e| e.to_string())?;
    let library = state.library.clone();
    blocking(move || {
        // Replacing: the original goes to the Recycle Bin, so it can still be restored.
        let to_bin = |path: &Path| -> clipdeck_core::Result<()> {
            move_to_bin(path)
        };
        let replace: Option<&dyn Fn(&Path) -> clipdeck_core::Result<()>> =
            if keep_original { None } else { Some(&to_bin) };
        let new_id = clipdeck_core::scan::export_trim(&library, &tools, id, start, end, precise, replace)?;
        library
            .get(new_id)?
            .ok_or_else(|| Error::FileNotFound(PathBuf::from(format!("clip {new_id}"))))
    })
    .await
}

/// Pictures of tiny frames spread along a clip, for previews while dragging.
/// Made the first time they are asked for and kept for next time.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Filmstrip {
    page_paths: Vec<String>,
    #[serde(flatten)]
    layout: clipdeck_core::media::strip::Layout,
}

#[tauri::command]
pub async fn clip_filmstrip(app: AppHandle, state: State<'_, AppState>, id: i64) -> CommandResult<Filmstrip> {
    let tools = state.tools(&app).map_err(|e| e.to_string())?;
    let library = state.library.clone();
    blocking(move || {
        let clip = library
            .get(id)?
            .ok_or_else(|| Error::FileNotFound(PathBuf::from(format!("clip {id}"))))?;
        let folder = library
            .thumbs_dir()
            .parent()
            .map(|p| p.join("previews"))
            .unwrap_or_else(|| PathBuf::from("previews"));
        let base = folder.join(format!("{}-{}.jpg", clip.id, clip.size_bytes));
        let layout = clipdeck_core::media::strip::ensure(
            &tools,
            Path::new(&clip.path),
            &base,
            clip.duration_ms as f64 / 1000.0,
        )?;
        let page_paths = (0..layout.pages)
            .map(|page| clipdeck_core::media::strip::page_path(&base, page).to_string_lossy().into_owned())
            .collect();
        Ok(Filmstrip { page_paths, layout })
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shared {
    path: String,
    size_bytes: u64,
}

/// Make a copy of a clip (or part of it) that fits under a size limit, and put
/// the file on the clipboard so it can be pasted into Discord.
/// `audio` is "mix", "none" or the number of one track.
#[tauri::command]
pub async fn share_clip(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    start: f64,
    end: f64,
    limit_mb: f64,
    audio: String,
) -> CommandResult<Shared> {
    use clipdeck_core::media::share::{self, Audio, Source};
    let tools = state.tools(&app).map_err(|e| e.to_string())?;
    let library = state.library.clone();
    blocking(move || {
        let clip = library
            .get(id)?
            .ok_or_else(|| Error::FileNotFound(PathBuf::from(format!("clip {id}"))))?;
        let folder = library
            .thumbs_dir()
            .parent()
            .map(|p| p.join("share"))
            .unwrap_or_else(|| PathBuf::from("share"));
        std::fs::create_dir_all(&folder)?;
        share::clean_old(&folder);
        let output = share::output_path(&folder, &clip.title);

        let audio = match audio.as_str() {
            "none" => Audio::None,
            "mix" => Audio::Mix,
            n => Audio::Track(n.parse().unwrap_or(0)),
        };
        let duration = clip.duration_ms as f64 / 1000.0;
        let source = Source {
            input: Path::new(&clip.path),
            start: start.clamp(0.0, duration),
            end: end.clamp(0.0, duration),
            width: clip.width as u32,
            height: clip.height as u32,
            fps: if clip.fps_den > 0 { clip.fps_num as f64 / clip.fps_den as f64 } else { 30.0 },
            audio_tracks: clip.audio_tracks as usize,
        };
        let limit = (limit_mb.max(1.0) * 1_000_000.0) as u64;
        let size_bytes = share::encode(&tools, &source, &output, limit, audio)?;
        share::copy_file_to_clipboard(&output)?;
        Ok(Shared { path: output.to_string_lossy().into_owned(), size_bytes })
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupInfo {
    remaining: usize,
    /// Bytes taken up by those clips.
    bytes: i64,
}

/// How many clips a cleanup round can still pick from.
#[tauri::command]
pub fn cleanup_info(state: State<'_, AppState>, older_than_days: Option<u32>) -> CommandResult<CleanupInfo> {
    let (remaining, bytes) = state
        .library
        .cleanup_pool(older_than_days)
        .map_err(|e| e.to_string())?;
    Ok(CleanupInfo { remaining, bytes })
}

/// Random clips (not starred, not already reviewed) for a cleanup round.
#[tauri::command]
pub fn cleanup_batch(
    state: State<'_, AppState>,
    count: usize,
    older_than_days: Option<u32>,
) -> CommandResult<Vec<Clip>> {
    state
        .library
        .cleanup_batch_older(count.clamp(1, 100), older_than_days)
        .map_err(|e| e.to_string())
}

/// Mark a clip as reviewed (kept), so cleanup rounds leave it alone.
#[tauri::command]
pub fn set_reviewed(state: State<'_, AppState>, id: i64, reviewed: bool) -> CommandResult<Clip> {
    let e = |e: Error| e.to_string();
    state.library.set_reviewed(id, reviewed).map_err(e)?;
    state.library.get(id).map_err(e)?.ok_or_else(|| "Clip not found.".to_string())
}

/// Let every clip come up in cleanup rounds again.
#[tauri::command]
pub fn reset_reviewed(state: State<'_, AppState>) -> CommandResult<()> {
    state.library.reset_reviewed().map_err(|e| e.to_string())
}

/// Move every clip marked for deletion to the Recycle Bin and forget it.
/// Returns how many were removed and how many bytes that freed.
pub fn apply_pending_deletes(library: &clipdeck_core::library::Library) -> clipdeck_core::Result<(usize, u64)> {
    let mut count = 0;
    let mut bytes = 0;
    for clip in library.pending_deletes()? {
        if Path::new(&clip.path).exists() {
            move_to_bin(Path::new(&clip.path))?;
        }
        if let Some(thumb) = &clip.thumb_path {
            let _ = std::fs::remove_file(thumb);
        }
        library.delete(clip.id)?;
        count += 1;
        bytes += clip.size_bytes;
    }
    Ok((count, bytes))
}

/// Mark a clip as waiting to be deleted (hidden everywhere), or bring it back.
#[tauri::command]
pub fn mark_pending_delete(state: State<'_, AppState>, id: i64, pending: bool) -> CommandResult<()> {
    state.library.set_pending_delete(id, pending).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deleted {
    count: usize,
    bytes: u64,
}

/// Carry out the deletions marked during a cleanup round.
#[tauri::command]
pub async fn finish_pending_deletes(state: State<'_, AppState>) -> CommandResult<Deleted> {
    let library = state.library.clone();
    blocking(move || apply_pending_deletes(&library).map(|(count, bytes)| Deleted { count, bytes })).await
}

/// Save a clip's note.
#[tauri::command]
pub fn set_clip_notes(state: State<'_, AppState>, id: i64, notes: String) -> CommandResult<Clip> {
    let e = |e: Error| e.to_string();
    state.library.set_notes(id, &notes).map_err(e)?;
    state.library.get(id).map_err(e)?.ok_or_else(|| "Clip not found.".to_string())
}

/// How the library's space is used.
#[tauri::command]
pub async fn storage_overview(state: State<'_, AppState>) -> CommandResult<clipdeck_core::library::Storage> {
    let library = state.library.clone();
    blocking(move || library.storage_overview()).await
}

/// Games that could be assigned to clips that have none.
#[tauri::command]
pub async fn suggest_games(state: State<'_, AppState>) -> CommandResult<Vec<clipdeck_core::library::GameSuggestion>> {
    let library = state.library.clone();
    blocking(move || match library.source_dir()? {
        Some(root) => library.suggest_games(&root),
        None => Ok(Vec::new()),
    })
    .await
}

/// Give all of the listed clips the same game. Returns how many changed.
#[tauri::command]
pub fn assign_games(state: State<'_, AppState>, ids: Vec<i64>, game: String) -> CommandResult<usize> {
    let game = game.trim();
    if game.is_empty() {
        return Err("The game name can't be empty.".into());
    }
    state.library.set_games(&ids, Some(game)).map_err(|e| e.to_string())
}

/// Copy several clips' files to the clipboard at once.
#[tauri::command]
pub async fn copy_clip_files(state: State<'_, AppState>, ids: Vec<i64>) -> CommandResult<()> {
    let library = state.library.clone();
    blocking(move || {
        let mut paths = Vec::new();
        for id in ids {
            if let Some(clip) = library.get(id)? {
                paths.push(PathBuf::from(clip.path));
            }
        }
        clipdeck_core::media::share::copy_files_to_clipboard(&paths)
    })
    .await
}

/// Copy a clip's file to the clipboard, so it can be pasted into Discord, Explorer and so on.
#[tauri::command]
pub async fn copy_clip_file(state: State<'_, AppState>, id: i64) -> CommandResult<()> {
    let library = state.library.clone();
    blocking(move || {
        let clip = library
            .get(id)?
            .ok_or_else(|| Error::FileNotFound(PathBuf::from(format!("clip {id}"))))?;
        clipdeck_core::media::share::copy_file_to_clipboard(Path::new(&clip.path))
    })
    .await
}

/// A program tied to a game, with its icon when one could be made.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramInfo {
    game: String,
    exe: String,
    icon_path: Option<String>,
}

fn program_infos(library: &clipdeck_core::library::Library) -> clipdeck_core::Result<Vec<ProgramInfo>> {
    let folder = library
        .thumbs_dir()
        .parent()
        .map(|p| p.join("game-icons"))
        .unwrap_or_else(|| PathBuf::from("game-icons"));
    let mut out = Vec::new();
    for program in library.game_programs()? {
        let mut icon_path = None;
        if let Some(path) = program.path.as_deref().filter(|p| Path::new(p).is_file()) {
            let file = folder.join(format!("{}.png", program.exe.replace(|c: char| !c.is_alphanumeric(), "_")));
            let stale = std::fs::metadata(&file)
                .and_then(|m| m.modified())
                .ok()
                .zip(std::fs::metadata(path).and_then(|m| m.modified()).ok())
                .is_none_or(|(icon, exe)| icon < exe);
            if stale {
                let _ = clipdeck_core::games::extract_icon(Path::new(path), &file);
            }
            if file.is_file() {
                icon_path = Some(file.to_string_lossy().into_owned());
            }
        }
        out.push(ProgramInfo { game: program.game, exe: program.exe, icon_path });
    }
    Ok(out)
}

/// The programs ClipDeck knows for each game, with their icons.
#[tauri::command]
pub async fn list_game_programs(state: State<'_, AppState>) -> CommandResult<Vec<ProgramInfo>> {
    let library = state.library.clone();
    blocking(move || program_infos(&library)).await
}

/// Tie a program (an .exe the person picked) to a game.
#[tauri::command]
pub async fn link_game_program(state: State<'_, AppState>, game: String, path: String) -> CommandResult<Vec<ProgramInfo>> {
    let library = state.library.clone();
    blocking(move || {
        library.link_program(game.trim(), &path)?;
        program_infos(&library)
    })
    .await
}

/// Every tag with its color and how many clips use it.
#[tauri::command]
pub fn list_tag_infos(state: State<'_, AppState>) -> CommandResult<Vec<clipdeck_core::library::TagInfo>> {
    state.library.tag_infos().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_tag_color(state: State<'_, AppState>, name: String, color: Option<String>) -> CommandResult<()> {
    state.library.set_tag_color(&name, color.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_tag(state: State<'_, AppState>, old: String, new: String) -> CommandResult<()> {
    state.library.rename_tag(&old, &new).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_tag(state: State<'_, AppState>, name: String) -> CommandResult<()> {
    state.library.delete_tag(&name).map_err(|e| e.to_string())
}

/// The clips folder, or an explanation of why there is none yet.
fn clips_root(state: &AppState) -> Result<PathBuf, String> {
    state
        .library
        .source_dir()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Choose a clips folder first.".to_string())
}

/// Every folder inside the clips folder, for the "move to" picker.
#[tauri::command]
pub async fn list_dirs(state: State<'_, AppState>) -> CommandResult<Vec<String>> {
    let root = clips_root(&state)?;
    blocking(move || Ok(clipdeck_core::organize::list_dirs(&root))).await
}

/// Make a folder inside `parent`. Returns its path.
#[tauri::command]
pub async fn create_folder(state: State<'_, AppState>, parent: String, name: String) -> CommandResult<String> {
    let root = clips_root(&state)?;
    blocking(move || {
        let path = clipdeck_core::organize::create_folder(&root, Path::new(&parent), &name)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
}

/// Move clips into a folder (on the drive too). Returns the ids that were moved.
#[tauri::command]
pub async fn move_clips(state: State<'_, AppState>, ids: Vec<i64>, dest: String) -> CommandResult<Vec<i64>> {
    let root = clips_root(&state)?;
    let library = state.library.clone();
    blocking(move || clipdeck_core::organize::move_clips(&library, &root, &ids, Path::new(&dest))).await
}

/// One clip as it is now (for example after it was moved).
#[tauri::command]
pub fn get_clip(state: State<'_, AppState>, id: i64) -> CommandResult<Clip> {
    let e = |e: Error| e.to_string();
    state.library.get(id).map_err(e)?.ok_or_else(|| "Clip not found.".to_string())
}
