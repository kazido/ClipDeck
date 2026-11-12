//! The clip library: what is indexed, and how to query it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::media::ClipInfo;
use crate::{db, Result};

const SOURCE_DIR_KEY: &str = "source_dir";
const SORT_BY_GAME_KEY: &str = "sort_by_game";
const HOTKEY_KEY: &str = "toggle_hotkey";
const POPUPS_KEY: &str = "popups";
const STARTUP_SOUND_KEY: &str = "startup_sound";
const POPUP_OPTIONS_KEY: &str = "popup_options";

/// How the on-screen popups look and sound.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PopupOptions {
    /// How long a popup stays on screen.
    pub duration_ms: u32,
    pub size: PopupSize,
    /// File name of the sound for a saved clip. Empty means silent.
    pub sound: String,
    /// Sound for "ready to clip" (the replay buffer started).
    pub sound_ready: String,
    /// Sound for "not recording" (the replay buffer stopped or OBS closed).
    pub sound_stopped: String,
    /// Loudness of the sound, 0 to 100 percent.
    pub volume: u8,
}

/// Shortest and longest time a popup may stay up.
pub const POPUP_DURATION_RANGE_MS: (u32, u32) = (500, 15_000);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PopupSize {
    Small,
    Medium,
    Large,
    /// The biggest popup.
    Xlarge,
}

impl PopupSize {
    /// Width and height of the popup window, in logical pixels.
    pub fn dimensions(self) -> (f64, f64) {
        match self {
            Self::Small => (280.0, 64.0),
            Self::Medium => (340.0, 76.0),
            Self::Large => (440.0, 100.0),
            Self::Xlarge => (560.0, 132.0),
        }
    }
}

impl Default for PopupOptions {
    fn default() -> Self {
        Self {
            duration_ms: 3500,
            size: PopupSize::Medium,
            sound: crate::sounds::DEFAULT_SOUND.to_string(),
            sound_ready: crate::sounds::DEFAULT_READY_SOUND.to_string(),
            sound_stopped: crate::sounds::DEFAULT_STOPPED_SOUND.to_string(),
            volume: 70,
        }
    }
}
const OBS_PORT_KEY: &str = "obs_port";

/// The show/hide hotkey until the user picks another.
pub const DEFAULT_HOTKEY: &str = "Alt+Z";
const OBS_PASSWORD_KEY: &str = "obs_password";
const OBS_AUTOSTART_KEY: &str = "obs_autostart";

/// How ClipDeck reaches and manages OBS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsSettings {
    pub port: u16,
    /// OBS's WebSocket password. Empty when OBS has authentication off.
    pub password: String,
    /// Start OBS (if needed) and its replay buffer whenever ClipDeck starts.
    pub autostart: bool,
}

/// Owns the database connection. Safe to share between threads.
pub struct Library {
    conn: Mutex<Connection>,
    thumbs_dir: PathBuf,
}

/// One indexed clip, as sent to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: i64,
    pub path: String,
    pub file_name: String,
    pub title: String,
    pub size_bytes: u64,
    pub created_at_ms: i64,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub video_codec: String,
    pub container: String,
    pub bit_rate: Option<u64>,
    pub audio_tracks: u32,
    pub thumb_path: Option<String>,
    pub status: ClipStatus,
    /// The game this clip is from, when known.
    pub game: Option<String>,
    /// Starred by the user; favourites are shown first.
    pub favorite: bool,
    /// Labels the user added, sorted by name.
    pub tags: Vec<String>,
    /// Already looked at in a cleanup round (and kept).
    pub reviewed: bool,
    /// A free-text note.
    pub notes: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClipStatus {
    /// Indexed, thumbnail not made yet.
    Pending,
    Ready,
    /// The file was not on disk at the last scan.
    Missing,
}

impl ClipStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Ready => "ready",
            Self::Missing => "missing",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "ready" => Self::Ready,
            "missing" => Self::Missing,
            _ => Self::Pending,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortKey {
    #[default]
    Date,
    Name,
    Duration,
    Size,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipQuery {
    #[serde(default)]
    pub sort: SortKey,
    #[serde(default)]
    pub ascending: bool,
    #[serde(default)]
    pub search: Option<String>,
    /// Only clips inside this folder. None means the whole library.
    #[serde(default)]
    pub folder: Option<String>,
    /// With `folder`: also include clips in its subfolders.
    #[serde(default)]
    pub recursive: bool,
}

const MAX_FOLDER_THUMBS: usize = 4;

/// A subfolder that contains clips, as shown in the library.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub path: String,
    pub name: String,
    /// Clips inside, counting deeper subfolders too.
    pub clip_count: usize,
    /// Thumbnails of up to four newest clips inside, newest first.
    pub thumbs: Vec<String>,
}

/// The longest a clip's note may be, in characters.
pub const MAX_NOTE_CHARS: usize = 500;

/// A tag, its color and how many clips use it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    pub color: Option<String>,
    pub clips: i64,
}

/// A program that is tied to a game.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameProgram {
    pub game: String,
    /// The program's file name in lower case, e.g. "rocketleague.exe".
    pub exe: String,
    /// Full path, when known.
    pub path: Option<String>,
}

/// A named share of the library's space.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// A game name or a month like "2026-11". Empty for clips without a game.
    pub name: Option<String>,
    pub clips: i64,
    pub bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgeBucket {
    pub days: u32,
    pub clips: i64,
    pub bytes: i64,
}

/// Where the space goes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Storage {
    pub total_clips: i64,
    pub total_bytes: i64,
    pub by_game: Vec<Usage>,
    pub by_month: Vec<Usage>,
    pub largest: Vec<Clip>,
    /// Clips (not starred) older than each number of days.
    pub aged: Vec<AgeBucket>,
}

/// Clips that could be given the same game, and why.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSuggestion {
    pub game: String,
    /// "folder" or "name".
    pub reason: String,
    pub clip_ids: Vec<i64>,
}

/// The time `days` days ago, in the same units as `created_at_ms`.
fn cutoff_ms(days: u32) -> i64 {
    now_ms() - i64::from(days) * 24 * 3600 * 1000
}

/// What the scanner needs to know about a file it has seen before.
#[derive(Debug, Clone)]
pub struct KnownFile {
    pub id: i64,
    pub size_bytes: u64,
    pub file_mtime_ms: i64,
    pub status: ClipStatus,
}

impl Library {
    pub fn open(db_path: &Path, thumbs_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(thumbs_dir)?;
        Ok(Self {
            conn: Mutex::new(db::open(db_path)?),
            thumbs_dir: thumbs_dir.to_path_buf(),
        })
    }

    pub fn thumbs_dir(&self) -> &Path {
        &self.thumbs_dir
    }

    /// Where a clip's thumbnail is stored.
    pub fn thumb_path(&self, clip_id: i64) -> PathBuf {
        self.thumbs_dir.join(format!("{clip_id}.jpg"))
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        // A panic while holding the lock cannot leave SQLite half-written,
        // so a poisoned lock is safe to keep using.
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // --- settings -----------------------------------------------------------

    fn setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()?)
    }

    fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn source_dir(&self) -> Result<Option<PathBuf>> {
        Ok(self.setting(SOURCE_DIR_KEY)?.map(PathBuf::from))
    }

    pub fn set_source_dir(&self, dir: &Path) -> Result<()> {
        self.set_setting(SOURCE_DIR_KEY, &dir.to_string_lossy())
    }

    /// Whether new clips are moved into a folder named after the game. On by default.
    pub fn sort_by_game(&self) -> Result<bool> {
        Ok(self.setting(SORT_BY_GAME_KEY)?.as_deref() != Some("false"))
    }

    pub fn set_sort_by_game(&self, enabled: bool) -> Result<()> {
        self.set_setting(SORT_BY_GAME_KEY, if enabled { "true" } else { "false" })
    }

    /// The system-wide hotkey that shows or hides the window. Empty means none.
    pub fn hotkey(&self) -> Result<String> {
        Ok(self.setting(HOTKEY_KEY)?.unwrap_or_else(|| DEFAULT_HOTKEY.to_string()))
    }

    pub fn set_hotkey(&self, hotkey: &str) -> Result<()> {
        self.set_setting(HOTKEY_KEY, hotkey.trim())
    }

    /// Whether on-screen popups ("Clip saved" and so on) are shown. On by default.
    /// Whether a sound plays when ClipDeck opens. On by default.
    pub fn startup_sound(&self) -> Result<bool> {
        Ok(self.setting(STARTUP_SOUND_KEY)?.as_deref() != Some("false"))
    }

    pub fn set_startup_sound(&self, enabled: bool) -> Result<()> {
        self.set_setting(STARTUP_SOUND_KEY, if enabled { "true" } else { "false" })
    }

    pub fn popups_enabled(&self) -> Result<bool> {
        Ok(self.setting(POPUPS_KEY)?.as_deref() != Some("false"))
    }

    pub fn set_popups_enabled(&self, enabled: bool) -> Result<()> {
        self.set_setting(POPUPS_KEY, if enabled { "true" } else { "false" })
    }

    pub fn popup_options(&self) -> Result<PopupOptions> {
        Ok(self
            .setting(POPUP_OPTIONS_KEY)?
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default())
    }

    /// Save the popup options, keeping duration and volume within their limits.
    /// Returns what was stored.
    pub fn set_popup_options(&self, options: &PopupOptions) -> Result<PopupOptions> {
        let mut clean = options.clone();
        let (shortest, longest) = POPUP_DURATION_RANGE_MS;
        clean.duration_ms = clean.duration_ms.clamp(shortest, longest);
        clean.volume = clean.volume.min(100);
        let json = serde_json::to_string(&clean).expect("plain data is valid JSON");
        self.set_setting(POPUP_OPTIONS_KEY, &json)?;
        Ok(clean)
    }

    pub fn obs_settings(&self) -> Result<ObsSettings> {
        Ok(ObsSettings {
            port: self
                .setting(OBS_PORT_KEY)?
                .and_then(|p| p.parse().ok())
                .unwrap_or(crate::obs::DEFAULT_PORT),
            password: self.setting(OBS_PASSWORD_KEY)?.unwrap_or_default(),
            autostart: self.setting(OBS_AUTOSTART_KEY)?.as_deref() != Some("false"),
        })
    }

    pub fn set_obs_settings(&self, settings: &ObsSettings) -> Result<()> {
        self.set_setting(OBS_PORT_KEY, &settings.port.to_string())?;
        self.set_setting(OBS_PASSWORD_KEY, &settings.password)?;
        self.set_setting(OBS_AUTOSTART_KEY, if settings.autostart { "true" } else { "false" })
    }

    // --- queries ------------------------------------------------------------

    /// Clips matching `query`. Missing files are left out.
    pub fn list(&self, query: &ClipQuery) -> Result<Vec<Clip>> {
        let column = match query.sort {
            SortKey::Date => "created_at_ms",
            SortKey::Name => "title COLLATE NOCASE",
            SortKey::Duration => "duration_ms",
            SortKey::Size => "size_bytes",
        };
        let direction = if query.ascending { "ASC" } else { "DESC" };
        let pattern = query
            .search
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(like_pattern);

        let prefix = query.folder.as_deref().map(dir_prefix);

        // A clip is directly inside a folder when its path starts with the
        // folder and has no further separator after that.
        let sql = format!(
            "SELECT {CLIP_COLUMNS} FROM clips
             WHERE status != 'missing' AND pending_delete = 0
               AND (?1 IS NULL OR title LIKE ?1 ESCAPE '\\' OR file_name LIKE ?1 ESCAPE '\\'
                    OR notes LIKE ?1 ESCAPE '\\'
                    OR EXISTS (SELECT 1 FROM clip_tags ct JOIN tags t ON t.id = ct.tag_id
                               WHERE ct.clip_id = clips.id AND t.name LIKE ?1 ESCAPE '\\'))
               AND (?2 IS NULL OR (
                    substr(path, 1, length(?2)) = ?2
                    AND (?3 OR instr(substr(path, length(?2) + 1), ?4) = 0)))
             ORDER BY {column} {direction}, id DESC"
        );
        let conn = self.conn();
        let mut stmt = conn.prepare(&sql)?;
        let clips = stmt
            .query_map(
                params![pattern, prefix, query.recursive, SEPARATOR.to_string()],
                clip_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(clips)
    }

    /// The subfolders directly inside `parent` that contain clips (at any
    /// depth), sorted by name.
    pub fn folders(&self, parent: &str) -> Result<Vec<Folder>> {
        let prefix = dir_prefix(parent);
        let conn = self.conn();
        // Newest first, so the first clip seen in each folder supplies its cover.
        let mut stmt = conn.prepare(
            "SELECT path, thumb_path FROM clips
             WHERE status != 'missing' AND pending_delete = 0 AND substr(path, 1, length(?1)) = ?1
             ORDER BY created_at_ms DESC",
        )?;
        let rows = stmt.query_map([&prefix], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;

        let mut folders: Vec<Folder> = Vec::new();
        for row in rows {
            let (path, thumb_path) = row?;
            let rest = &path[prefix.len()..];
            let Some((name, _)) = rest.split_once(SEPARATOR) else {
                continue; // directly inside `parent`, not in a subfolder
            };
            match folders.iter_mut().find(|f| f.name == name) {
                Some(folder) => {
                    folder.clip_count += 1;
                    if folder.thumbs.len() < MAX_FOLDER_THUMBS {
                        folder.thumbs.extend(thumb_path);
                    }
                }
                None => folders.push(Folder {
                    path: format!("{prefix}{name}"),
                    name: name.to_string(),
                    clip_count: 1,
                    thumbs: thumb_path.into_iter().collect(),
                }),
            }
        }
        folders.sort_by_key(|f| f.name.to_lowercase());
        Ok(folders)
    }

    pub fn get(&self, id: i64) -> Result<Option<Clip>> {
        let sql = format!("SELECT {CLIP_COLUMNS} FROM clips WHERE id = ?1");
        Ok(self.conn().query_row(&sql, [id], clip_from_row).optional()?)
    }

    // --- games ---------------------------------------------------------------

    /// The game name for a program, or None if it is not a game. The first
    /// answer for each program is remembered, so a later rename sticks.
    pub fn game_for_exe(&self, exe: &str) -> Result<Option<String>> {
        self.game_for_app(exe, None)
    }

    /// Like `game_for_exe`, and also remembers where the program lives (so its icon can be shown).
    pub fn game_for_app(&self, exe: &str, path: Option<&str>) -> Result<Option<String>> {
        let key = exe.to_lowercase();
        let conn = self.conn();
        let stored: Option<String> = conn
            .query_row("SELECT name FROM games WHERE exe = ?1", [&key], |row| row.get(0))
            .optional()?;
        if stored.is_some() {
            if let Some(path) = path.filter(|p| !p.is_empty()) {
                conn.execute("UPDATE games SET exe_path = ?2 WHERE exe = ?1", params![key, path])?;
            }
            return Ok(stored);
        }
        let Some(name) = crate::games::default_game_name(exe) else {
            return Ok(None);
        };
        conn.execute(
            "INSERT INTO games (exe, name, exe_path) VALUES (?1, ?2, ?3)",
            params![key, name, path.filter(|p| !p.is_empty())],
        )?;
        Ok(Some(name))
    }

    /// Every program ClipDeck knows a game for, with where it lives when known.
    pub fn game_programs(&self) -> Result<Vec<GameProgram>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT name, exe, exe_path FROM games ORDER BY name COLLATE NOCASE")?;
        let rows = stmt
            .query_map([], |row| Ok(GameProgram { game: row.get(0)?, exe: row.get(1)?, path: row.get(2)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Tell ClipDeck that a program belongs to a game: new clips made while it is in
    /// front are sorted into that game, and its icon can be shown.
    pub fn link_program(&self, game: &str, path: &str) -> Result<()> {
        let exe = Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if exe.is_empty() {
            return Ok(());
        }
        self.conn().execute(
            "INSERT INTO games (exe, name, exe_path) VALUES (?1, ?2, ?3)
             ON CONFLICT(exe) DO UPDATE SET name = excluded.name, exe_path = excluded.exe_path",
            params![exe, game, path],
        )?;
        Ok(())
    }

    pub fn set_game(&self, id: i64, game: Option<&str>) -> Result<()> {
        self.conn()
            .execute("UPDATE clips SET game = ?2 WHERE id = ?1", params![id, game])?;
        Ok(())
    }

    /// Replace a clip's tags. Blank names are ignored and names are matched
    /// without regard to case.
    pub fn set_tags(&self, id: i64, tags: &[String]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM clip_tags WHERE clip_id = ?1", [id])?;
        for tag in tags.iter().map(|t| t.trim()).filter(|t| !t.is_empty()) {
            tx.execute("INSERT OR IGNORE INTO tags (name) VALUES (?1)", [tag])?;
            tx.execute(
                "INSERT OR IGNORE INTO clip_tags (clip_id, tag_id)
                 SELECT ?1, id FROM tags WHERE name = ?2",
                params![id, tag],
            )?;
        }
        // Tags nobody uses any more disappear from the lists.
        tx.execute("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM clip_tags)", [])?;
        tx.commit()?;
        Ok(())
    }

    /// Every tag in use, sorted.
    pub fn tags(&self) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT name FROM tags ORDER BY name COLLATE NOCASE")?;
        let tags = stmt.query_map([], |row| row.get(0))?.collect::<std::result::Result<Vec<String>, _>>()?;
        Ok(tags)
    }

    pub fn set_reviewed(&self, id: i64, reviewed: bool) -> Result<()> {
        self.conn()
            .execute("UPDATE clips SET reviewed = ?2 WHERE id = ?1", params![id, reviewed as i64])?;
        Ok(())
    }

    /// Mark every clip as not yet reviewed, so cleanup rounds can pick them again.
    pub fn reset_reviewed(&self) -> Result<()> {
        self.conn().execute("UPDATE clips SET reviewed = 0", [])?;
        Ok(())
    }

    /// How many clips a cleanup round can still pick from: not starred, not reviewed, no tags
    /// (a tagged clip has already been looked at).
    pub fn cleanup_remaining(&self) -> Result<usize> {
        self.cleanup_remaining_older(None)
    }

    /// Like `cleanup_remaining`, but only clips recorded more than `days` days ago.
    pub fn cleanup_remaining_older(&self, days: Option<u32>) -> Result<usize> {
        let n: i64 = self.conn().query_row(
            "SELECT COUNT(*) FROM clips
             WHERE status != 'missing' AND pending_delete = 0 AND favorite = 0 AND reviewed = 0
               AND NOT EXISTS (SELECT 1 FROM clip_tags WHERE clip_tags.clip_id = clips.id)
               AND (?1 IS NULL OR created_at_ms < ?1)",
            [days.map(cutoff_ms)],
            |row| row.get(0),
        )?;
        Ok(n as usize)
    }

    /// How many clips a cleanup round can pick from, and how many bytes they take up.
    pub fn cleanup_pool(&self, days: Option<u32>) -> Result<(usize, i64)> {
        let (n, bytes): (i64, i64) = self.conn().query_row(
            "SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM clips
             WHERE status != 'missing' AND pending_delete = 0 AND favorite = 0 AND reviewed = 0
               AND NOT EXISTS (SELECT 1 FROM clip_tags WHERE clip_tags.clip_id = clips.id)
               AND (?1 IS NULL OR created_at_ms < ?1)",
            [days.map(cutoff_ms)],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok((n as usize, bytes))
    }

    /// Up to `count` random clips for a cleanup round: not starred, not reviewed.
    pub fn cleanup_batch(&self, count: usize) -> Result<Vec<Clip>> {
        self.cleanup_batch_older(count, None)
    }

    /// Like `cleanup_batch`, but only clips recorded more than `days` days ago.
    pub fn cleanup_batch_older(&self, count: usize, days: Option<u32>) -> Result<Vec<Clip>> {
        let sql = format!(
            "SELECT {CLIP_COLUMNS} FROM clips
             WHERE status != 'missing' AND pending_delete = 0 AND favorite = 0 AND reviewed = 0
               AND NOT EXISTS (SELECT 1 FROM clip_tags WHERE clip_tags.clip_id = clips.id)
               AND (?2 IS NULL OR created_at_ms < ?2)
             ORDER BY RANDOM() LIMIT ?1"
        );
        let conn = self.conn();
        let mut stmt = conn.prepare(&sql)?;
        let clips = stmt
            .query_map(params![count as i64, days.map(cutoff_ms)], clip_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(clips)
    }

    pub fn set_notes(&self, id: i64, notes: &str) -> Result<()> {
        // A note stays short: anything past the limit is cut off.
        let notes: String = notes.trim().chars().take(MAX_NOTE_CHARS).collect();
        self.conn()
            .execute("UPDATE clips SET notes = ?2 WHERE id = ?1", params![id, notes])?;
        Ok(())
    }

    /// Every tag with its color and how many clips use it.
    pub fn tag_infos(&self) -> Result<Vec<TagInfo>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT t.name, t.color, COUNT(ct.clip_id) FROM tags t
             LEFT JOIN clip_tags ct ON ct.tag_id = t.id
             GROUP BY t.id ORDER BY t.name COLLATE NOCASE",
        )?;
        let rows = stmt
            .query_map([], |row| Ok(TagInfo { name: row.get(0)?, color: row.get(1)?, clips: row.get(2)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Give a tag a color (a "#rrggbb" value), or none.
    pub fn set_tag_color(&self, name: &str, color: Option<&str>) -> Result<()> {
        self.conn()
            .execute("UPDATE tags SET color = ?2 WHERE name = ?1", params![name, color])?;
        Ok(())
    }

    /// Rename a tag everywhere. If the new name already exists, the two tags are merged.
    pub fn rename_tag(&self, old: &str, new: &str) -> Result<()> {
        let new = new.trim();
        if new.is_empty() || new == old {
            return Ok(());
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let old_id: Option<i64> = tx.query_row("SELECT id FROM tags WHERE name = ?1", [old], |r| r.get(0)).optional()?;
        let Some(old_id) = old_id else { return Ok(()) };
        let existing: Option<i64> = tx
            .query_row("SELECT id FROM tags WHERE name = ?1 AND id != ?2", params![new, old_id], |r| r.get(0))
            .optional()?;
        match existing {
            Some(target) => {
                tx.execute(
                    "INSERT OR IGNORE INTO clip_tags (clip_id, tag_id) SELECT clip_id, ?1 FROM clip_tags WHERE tag_id = ?2",
                    params![target, old_id],
                )?;
                tx.execute("DELETE FROM tags WHERE id = ?1", [old_id])?;
            }
            None => {
                tx.execute("UPDATE tags SET name = ?2 WHERE id = ?1", params![old_id, new])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Delete a tag, taking it off every clip.
    pub fn delete_tag(&self, name: &str) -> Result<()> {
        self.conn().execute("DELETE FROM tags WHERE name = ?1", [name])?;
        Ok(())
    }

    /// How much space the library takes, broken down several ways.
    pub fn storage_overview(&self) -> Result<Storage> {
        let conn = self.conn();
        let live = "status != 'missing' AND pending_delete = 0";
        let (total_clips, total_bytes): (i64, i64) = conn.query_row(
            &format!("SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM clips WHERE {live}"),
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let by_game = conn
            .prepare(&format!(
                "SELECT game, COUNT(*), COALESCE(SUM(size_bytes), 0) FROM clips WHERE {live}
                 GROUP BY game ORDER BY SUM(size_bytes) DESC"
            ))?
            .query_map([], |row| Ok(Usage { name: row.get(0)?, clips: row.get(1)?, bytes: row.get(2)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let by_month = conn
            .prepare(&format!(
                "SELECT strftime('%Y-%m', created_at_ms / 1000, 'unixepoch', 'localtime') AS m,
                        COUNT(*), COALESCE(SUM(size_bytes), 0)
                 FROM clips WHERE {live} GROUP BY m ORDER BY m DESC"
            ))?
            .query_map([], |row| Ok(Usage { name: row.get(0)?, clips: row.get(1)?, bytes: row.get(2)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let largest = conn
            .prepare(&format!("SELECT {CLIP_COLUMNS} FROM clips WHERE {live} ORDER BY size_bytes DESC LIMIT 10"))?
            .query_map([], clip_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut aged = Vec::new();
        for days in [30u32, 90, 180, 365] {
            let (clips, bytes): (i64, i64) = conn.query_row(
                &format!(
                    "SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM clips
                     WHERE {live} AND favorite = 0 AND created_at_ms < ?1"
                ),
                [cutoff_ms(days)],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            aged.push(AgeBucket { days, clips, bytes });
        }
        Ok(Storage { total_clips, total_bytes, by_game, by_month, largest, aged })
    }

    /// Clips without a game that can be given one: their file name starts with a known
    /// game, or (failing that) the folder they sit in under `root` is a game folder.
    pub fn suggest_games(&self, root: &Path) -> Result<Vec<GameSuggestion>> {
        let known = self.games()?;
        let rows: Vec<(i64, String, String)> = {
            let conn = self.conn();
            let mut stmt = conn.prepare(
                "SELECT id, path, file_name FROM clips
                 WHERE status != 'missing' AND pending_delete = 0 AND (game IS NULL OR game = '')",
            )?;
            let found = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            found
        };
        let mut groups: Vec<GameSuggestion> = Vec::new();
        for (id, path, file_name) in rows {
            let folder = Path::new(&path)
                .strip_prefix(root)
                .ok()
                .and_then(|rest| rest.components().next())
                .filter(|_| Path::new(&path).parent() != Some(root))
                .map(|c| c.as_os_str().to_string_lossy().into_owned());
            let by_name = || {
                let lower = file_name.to_lowercase();
                known
                    .iter()
                    .filter(|g| {
                        let g = g.to_lowercase();
                        lower.starts_with(&g)
                            && lower[g.len()..].chars().next().is_none_or(|c| !c.is_alphanumeric())
                    })
                    .max_by_key(|g| g.len())
                    .cloned()
            };
            let (game, reason) = match (folder, by_name()) {
                (_, Some(name)) => (name, "name"),
                (Some(folder), None) => (folder, "folder"),
                (None, None) => continue,
            };
            match groups.iter_mut().find(|g| g.game.eq_ignore_ascii_case(&game)) {
                Some(group) => group.clip_ids.push(id),
                None => groups.push(GameSuggestion { game, reason: reason.to_string(), clip_ids: vec![id] }),
            }
        }
        groups.sort_by_key(|g| std::cmp::Reverse(g.clip_ids.len()));
        Ok(groups)
    }

    /// Give every clip in `ids` the same game (or none).
    pub fn set_games(&self, ids: &[i64], game: Option<&str>) -> Result<usize> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut changed = 0;
        for id in ids {
            changed += tx.execute("UPDATE clips SET game = ?2 WHERE id = ?1", params![id, game])?;
        }
        tx.commit()?;
        Ok(changed)
    }

    /// Hide a clip because it is waiting to be deleted (or bring it back).
    pub fn set_pending_delete(&self, id: i64, pending: bool) -> Result<()> {
        self.conn()
            .execute("UPDATE clips SET pending_delete = ?2 WHERE id = ?1", params![id, pending as i64])?;
        Ok(())
    }

    /// Clips waiting to be deleted.
    pub fn pending_deletes(&self) -> Result<Vec<Clip>> {
        let sql = format!("SELECT {CLIP_COLUMNS} FROM clips WHERE pending_delete = 1");
        let conn = self.conn();
        let mut stmt = conn.prepare(&sql)?;
        let clips = stmt.query_map([], clip_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(clips)
    }

    /// Forget a clip. The file itself is not touched.
    pub fn delete(&self, id: i64) -> Result<()> {
        self.conn().execute("DELETE FROM clips WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Change a clip's display name. The file on disk is never touched.
    pub fn set_title(&self, id: i64, title: &str) -> Result<()> {
        self.conn()
            .execute("UPDATE clips SET title = ?2 WHERE id = ?1", params![id, title.trim()])?;
        Ok(())
    }

    /// Record that a clip's file now lives at `path` (the file itself was moved elsewhere).
    pub fn set_path(&self, id: i64, path: &str, file_name: &str) -> Result<()> {
        self.conn()
            .execute("UPDATE clips SET path = ?2, file_name = ?3 WHERE id = ?1", params![id, path, file_name])?;
        Ok(())
    }

    pub fn set_favorite(&self, id: i64, favorite: bool) -> Result<()> {
        self.conn()
            .execute("UPDATE clips SET favorite = ?2 WHERE id = ?1", params![id, favorite as i64])?;
        Ok(())
    }

    /// Every game name used by at least one clip, sorted.
    pub fn games(&self) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT DISTINCT game FROM clips WHERE game IS NOT NULL AND game != '' ORDER BY game COLLATE NOCASE",
        )?;
        let games = stmt.query_map([], |row| row.get(0))?.collect::<std::result::Result<Vec<String>, _>>()?;
        Ok(games)
    }

    /// Rename a game on all its clips, and for future clips from its programs.
    /// Returns how many clips changed.
    pub fn rename_game(&self, old: &str, new: &str) -> Result<usize> {
        let conn = self.conn();
        conn.execute("UPDATE games SET name = ?2 WHERE name = ?1", params![old, new])?;
        Ok(conn.execute("UPDATE clips SET game = ?2 WHERE game = ?1", params![old, new])?)
    }

    /// True if this exact file (same path, size and modified time) is already
    /// fully indexed.
    pub fn is_indexed(&self, path: &str, size_bytes: u64, file_mtime_ms: i64) -> Result<bool> {
        let found: Option<i64> = self
            .conn()
            .query_row(
                "SELECT id FROM clips
                 WHERE path = ?1 AND size_bytes = ?2 AND file_mtime_ms = ?3 AND status = 'ready'",
                params![path, size_bytes, file_mtime_ms],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    // --- used by the scanner ------------------------------------------------

    /// Every indexed file, keyed by path.
    pub fn known_files(&self) -> Result<HashMap<String, KnownFile>> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare("SELECT path, id, size_bytes, file_mtime_ms, status FROM clips")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                KnownFile {
                    id: row.get(1)?,
                    size_bytes: row.get(2)?,
                    file_mtime_ms: row.get(3)?,
                    status: ClipStatus::parse(&row.get::<_, String>(4)?),
                },
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Insert a newly probed clip, or refresh one whose file changed.
    /// An existing title is kept. Returns the clip's id.
    pub fn upsert(&self, info: &ClipInfo, file_mtime_ms: i64, created_at_ms: i64) -> Result<i64> {
        let title = Path::new(&info.file_name)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| info.file_name.clone());

        let id = self.conn().query_row(
            "INSERT INTO clips (
                path, file_name, title, size_bytes, file_mtime_ms, created_at_ms,
                imported_at_ms, duration_ms, width, height, fps_num, fps_den,
                video_codec, container, bit_rate, audio_tracks, thumb_path, status
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                       NULL, 'pending')
             ON CONFLICT(path) DO UPDATE SET
                file_name = excluded.file_name,
                size_bytes = excluded.size_bytes,
                file_mtime_ms = excluded.file_mtime_ms,
                created_at_ms = excluded.created_at_ms,
                duration_ms = excluded.duration_ms,
                width = excluded.width,
                height = excluded.height,
                fps_num = excluded.fps_num,
                fps_den = excluded.fps_den,
                video_codec = excluded.video_codec,
                container = excluded.container,
                bit_rate = excluded.bit_rate,
                audio_tracks = excluded.audio_tracks,
                status = 'pending'
             RETURNING id",
            params![
                info.path,
                info.file_name,
                title,
                info.size_bytes,
                file_mtime_ms,
                created_at_ms,
                now_ms(),
                info.duration_ms,
                info.video.width,
                info.video.height,
                info.video.fps_num,
                info.video.fps_den,
                info.video.codec,
                info.container,
                info.bit_rate,
                info.audio.len() as u32,
            ],
            |row| row.get(0),
        )?;
        Ok(id)
    }

    /// Mark a clip as fully processed. `thumb` is None if the thumbnail failed.
    pub fn mark_ready(&self, id: i64, thumb: Option<&Path>) -> Result<()> {
        self.conn().execute(
            "UPDATE clips SET status = 'ready', thumb_path = ?2 WHERE id = ?1",
            params![id, thumb.map(|p| p.to_string_lossy().into_owned())],
        )?;
        Ok(())
    }

    pub fn set_status(&self, id: i64, status: ClipStatus) -> Result<()> {
        self.conn().execute(
            "UPDATE clips SET status = ?2 WHERE id = ?1",
            params![id, status.as_str()],
        )?;
        Ok(())
    }
}

const CLIP_COLUMNS: &str = "id, path, file_name, title, size_bytes, created_at_ms, duration_ms, \
     width, height, fps_num, fps_den, video_codec, container, bit_rate, audio_tracks, \
     thumb_path, status, game, favorite, \
     (SELECT group_concat(name, char(31)) FROM (
          SELECT t.name AS name FROM clip_tags ct JOIN tags t ON t.id = ct.tag_id
          WHERE ct.clip_id = clips.id ORDER BY t.name COLLATE NOCASE)), \
     reviewed, notes";

fn clip_from_row(row: &Row<'_>) -> rusqlite::Result<Clip> {
    Ok(Clip {
        id: row.get(0)?,
        path: row.get(1)?,
        file_name: row.get(2)?,
        title: row.get(3)?,
        size_bytes: row.get(4)?,
        created_at_ms: row.get(5)?,
        duration_ms: row.get(6)?,
        width: row.get(7)?,
        height: row.get(8)?,
        fps_num: row.get(9)?,
        fps_den: row.get(10)?,
        video_codec: row.get(11)?,
        container: row.get(12)?,
        bit_rate: row.get(13)?,
        audio_tracks: row.get(14)?,
        thumb_path: row.get(15)?,
        status: ClipStatus::parse(&row.get::<_, String>(16)?),
        game: row.get(17)?,
        favorite: row.get::<_, i64>(18)? != 0,
        tags: row
            .get::<_, Option<String>>(19)?
            .map(|joined| joined.split('\u{1f}').map(str::to_string).collect())
            .unwrap_or_default(),
        reviewed: row.get::<_, i64>(20)? != 0,
        notes: row.get(21)?,
    })
}

const SEPARATOR: char = std::path::MAIN_SEPARATOR;

/// A folder path that ends in exactly one separator, for prefix matching.
fn dir_prefix(dir: &str) -> String {
    format!("{}{SEPARATOR}", dir.trim_end_matches(SEPARATOR))
}

/// Turn user text into a "contains" LIKE pattern, treating % and _ literally.
fn like_pattern(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('%');
    for c in text.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

pub(crate) fn now_ms() -> i64 {
    system_time_ms(SystemTime::now())
}

pub(crate) fn system_time_ms(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
