//! Opening the SQLite database and keeping its schema up to date.

use std::path::Path;

use rusqlite::Connection;

use crate::Result;

/// Schema changes, oldest first. Never edit an entry that has shipped;
/// append a new one instead. `PRAGMA user_version` records how many ran.
const MIGRATIONS: &[&str] = &[
    // 1: clip index and key/value settings
    "CREATE TABLE clips (
        id             INTEGER PRIMARY KEY,
        path           TEXT NOT NULL UNIQUE,
        file_name      TEXT NOT NULL,
        title          TEXT NOT NULL,
        size_bytes     INTEGER NOT NULL,
        file_mtime_ms  INTEGER NOT NULL,
        created_at_ms  INTEGER NOT NULL,
        imported_at_ms INTEGER NOT NULL,
        duration_ms    INTEGER NOT NULL,
        width          INTEGER NOT NULL,
        height         INTEGER NOT NULL,
        fps_num        INTEGER NOT NULL,
        fps_den        INTEGER NOT NULL,
        video_codec    TEXT NOT NULL,
        container      TEXT NOT NULL,
        bit_rate       INTEGER,
        audio_tracks   INTEGER NOT NULL,
        thumb_path     TEXT,
        status         TEXT NOT NULL
    );
    CREATE INDEX clips_created ON clips(created_at_ms);
    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );",
    // 2: which game each clip is from, and the name to use for each program
    "ALTER TABLE clips ADD COLUMN game TEXT;
    CREATE INDEX clips_game ON clips(game);
    CREATE TABLE games (
        exe  TEXT PRIMARY KEY,
        name TEXT NOT NULL
    );",
    // 3: favourite clips
    "ALTER TABLE clips ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;",
    // 4: tags
    "CREATE TABLE tags (
        id   INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE
    );
    CREATE TABLE clip_tags (
        clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
        tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (clip_id, tag_id)
    );
    CREATE INDEX clip_tags_tag ON clip_tags(tag_id);",
    // 5: clips already looked at in a cleanup round
    "ALTER TABLE clips ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0;",
    // 6: clips marked for deletion in a cleanup round, removed when the round ends
    "ALTER TABLE clips ADD COLUMN pending_delete INTEGER NOT NULL DEFAULT 0;",
    // 7: a free-text note on each clip
    "ALTER TABLE clips ADD COLUMN notes TEXT NOT NULL DEFAULT '';",
    // 8: where each game's program lives, so its icon can be shown
    "ALTER TABLE games ADD COLUMN exe_path TEXT;",
    // 9: a color for each tag
    "ALTER TABLE tags ADD COLUMN color TEXT;",
];

pub fn open(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&mut conn)?;
    Ok(conn)
}

fn migrate(conn: &mut Connection) -> Result<()> {
    let done: usize = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(done) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", index + 1)?;
        tx.commit()?;
    }
    Ok(())
}
