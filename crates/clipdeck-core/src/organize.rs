//! Moving clips between folders, so the folders on the drive match what the app shows.

use std::path::{Component, Path, PathBuf};

use crate::games::safe_file_name;
use crate::library::Library;
use crate::{Error, Result};

/// True if `path` is `root` or inside it, with no ".." tricks to climb back out.
fn inside(root: &Path, path: &Path) -> bool {
    path.starts_with(root) && !path.components().any(|c| c == Component::ParentDir)
}

/// Every folder inside `root` (at any depth), sorted, with full paths.
pub fn list_dirs(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let hidden = entry.file_name().to_string_lossy().starts_with('.');
            if path.is_dir() && !hidden {
                out.push(path.to_string_lossy().into_owned());
                walk(&path, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, &mut out);
    out.sort_by_key(|p| p.to_lowercase());
    out
}

/// Make a folder called `name` inside `parent` (which must be `root` or inside it).
/// An existing folder of that name is fine. Returns its path.
pub fn create_folder(root: &Path, parent: &Path, name: &str) -> Result<PathBuf> {
    if !inside(root, parent) {
        return Err(Error::NotADirectory(parent.to_path_buf()));
    }
    let folder = parent.join(safe_file_name(name));
    std::fs::create_dir_all(&folder)?;
    Ok(folder)
}

/// Move clips into `dest` (which must be `root` or inside it), on the drive and in the
/// library. Each file is named after the clip's title. A clip never overwrites a file already there: it gets "(2)" and so on.
/// Returns the ids that were moved.
pub fn move_clips(library: &Library, root: &Path, ids: &[i64], dest: &Path) -> Result<Vec<i64>> {
    if !inside(root, dest) {
        return Err(Error::NotADirectory(dest.to_path_buf()));
    }
    std::fs::create_dir_all(dest)?;
    let mut moved = Vec::new();
    for &id in ids {
        let Some(clip) = library.get(id)? else { continue };
        let from = PathBuf::from(&clip.path);
        if from.parent() == Some(dest) || !from.exists() {
            continue;
        }
        // The file takes the name the user gave the clip in the editor.
        let stem = safe_file_name(&clip.title);
        let extension = from.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        let mut target = dest.join(format!("{stem}{extension}"));
        let mut copy = 2;
        while target.exists() {
            target = dest.join(format!("{stem} ({copy}){extension}"));
            copy += 1;
        }
        let new_name = target.file_name().unwrap_or_default().to_string_lossy().into_owned();
        // The library learns the new place first, so the folder watcher sees a clip it
        // already knows rather than a new one.
        library.set_path(id, &target.to_string_lossy(), &new_name)?;
        if let Err(e) = std::fs::rename(&from, &target) {
            library.set_path(id, &clip.path, &clip.file_name)?;
            return Err(e.into());
        }
        moved.push(id);
    }
    Ok(moved)
}
