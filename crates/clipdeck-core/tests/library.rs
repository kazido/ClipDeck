//! Scan a real folder of generated clips and check the index.

use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use clipdeck_core::library::{ClipQuery, ClipStatus, Library, PopupSize, SortKey};
use clipdeck_core::sounds;
use clipdeck_core::media::Tools;
use clipdeck_core::scan::scan;

fn make_clip(path: &Path, seconds: u32, audio_tracks: usize) {
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-v", "error", "-y", "-f", "lavfi", "-i"])
        .arg(format!("testsrc2=size=640x360:rate=60:duration={seconds}"));
    for _ in 0..audio_tracks {
        cmd.args(["-f", "lavfi", "-i"])
            .arg(format!("sine=frequency=440:duration={seconds}"));
    }
    cmd.args(["-map", "0:v"]);
    for i in 0..audio_tracks {
        cmd.args(["-map", &format!("{}:a", i + 1)]);
    }
    cmd.args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
    assert!(cmd.arg(path).status().unwrap().success());
}

#[test]
fn scan_and_query() {
    let Ok(tools) = Tools::locate(&[]) else {
        eprintln!("ffmpeg not installed, skipping");
        return;
    };

    let root = std::env::temp_dir().join(format!("clipdeck-lib-{}", std::process::id()));
    let clips = root.join("clips");
    std::fs::create_dir_all(clips.join("sub")).unwrap();

    make_clip(&clips.join("Alpha win.mp4"), 2, 1);
    make_clip(&clips.join("beta 100%.mkv"), 4, 3);
    make_clip(&clips.join("sub").join("gamma.mp4"), 1, 0);
    std::fs::write(clips.join("broken.mp4"), b"not a video").unwrap();
    std::fs::write(clips.join("notes.txt"), b"ignore me").unwrap();

    let library = Library::open(&root.join("db").join("test.db"), &root.join("thumbs")).unwrap();
    assert_eq!(library.source_dir().unwrap(), None);
    library.set_source_dir(&clips).unwrap();
    assert_eq!(library.source_dir().unwrap().as_deref(), Some(clips.as_path()));

    // Hotkey and popups: defaults, then changes.
    assert_eq!(library.hotkey().unwrap(), "Alt+Z");
    library.set_hotkey(" Ctrl+Shift+C ").unwrap();
    assert_eq!(library.hotkey().unwrap(), "Ctrl+Shift+C");
    assert!(library.popups_enabled().unwrap());
    library.set_popups_enabled(false).unwrap();
    assert!(!library.popups_enabled().unwrap());

    // Popup options: defaults, then a clamped change.
    let mut popup = library.popup_options().unwrap();
    assert_eq!((popup.duration_ms, popup.size, popup.sound.as_str()), (3500, PopupSize::Medium, sounds::DEFAULT_SOUND));
    popup.duration_ms = 60_000;
    popup.size = PopupSize::Large;
    popup.sound = String::new();
    assert_eq!(popup.volume, 70);
    popup.volume = 250;
    assert_eq!(library.set_popup_options(&popup).unwrap().duration_ms, 15_000);
    assert_eq!(library.popup_options().unwrap().volume, 100);
    popup.duration_ms = 10;
    assert_eq!(library.set_popup_options(&popup).unwrap().duration_ms, 500);
    popup.duration_ms = 60_000;
    library.set_popup_options(&popup).unwrap();
    let stored = library.popup_options().unwrap();
    assert_eq!((stored.duration_ms, stored.size, stored.sound.as_str()), (15_000, PopupSize::Large, ""));

    // Sounds: built-ins are written once, custom files are listed, odd names are refused.
    let sound_dir = root.join("sounds");
    sounds::ensure_builtin(&sound_dir).unwrap();
    let mut expected: Vec<String> = ["Chime.wav", "Pop.wav"].iter().map(|s| s.to_string()).collect();
    expected.extend(sounds::shipped_names().iter().map(|s| s.to_string()));
    expected.sort_by_key(|n| n.to_lowercase());
    assert_eq!(sounds::list(&sound_dir), expected);
    for name in sounds::list(&sound_dir) {
        // ffprobe confirms each generated file is a real, non-empty WAV.
        let out = std::process::Command::new("ffprobe")
            .args(["-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels:format=duration", "-of", "csv=p=0"])
            .arg(sound_dir.join(&name))
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("pcm_s16le,44100,"), "{name}: {text}");
    }
    std::fs::write(sound_dir.join("Chime.wav"), b"mine").unwrap();
    std::fs::write(sound_dir.join("airhorn.WAV"), b"x").unwrap();
    std::fs::write(sound_dir.join("notes.txt"), b"x").unwrap();
    sounds::ensure_builtin(&sound_dir).unwrap();
    assert_eq!(std::fs::read(sound_dir.join("Chime.wav")).unwrap(), b"mine"); // not overwritten
    let mut with_custom = expected.clone();
    with_custom.push("airhorn.WAV".to_string());
    with_custom.sort_by_key(|n| n.to_lowercase());
    assert_eq!(sounds::list(&sound_dir), with_custom);
    assert_eq!(sounds::resolve(&sound_dir, "Pop.wav"), Some(sound_dir.join("Pop.wav")));
    assert_eq!(sounds::resolve(&sound_dir, ""), None);
    assert_eq!(sounds::resolve(&sound_dir, "gone.wav"), None);
    assert_eq!(sounds::resolve(&sound_dir, "../test.db"), None);

    // OBS settings: defaults, then a round trip.
    let mut obs = library.obs_settings().unwrap();
    assert_eq!((obs.port, obs.password.as_str(), obs.autostart), (4455, "", true));
    obs.port = 4460;
    obs.password = "hunter2".into();
    obs.autostart = false;
    library.set_obs_settings(&obs).unwrap();
    assert_eq!(library.obs_settings().unwrap(), obs);

    // First scan indexes the three real clips and reports the broken one.
    let calls = AtomicUsize::new(0);
    let progress = |_| {
        calls.fetch_add(1, Ordering::Relaxed);
    };
    let summary = scan(&library, &tools, &clips, &progress).unwrap();
    assert_eq!(summary.found, 4);
    assert_eq!(summary.indexed, 3);
    assert_eq!(summary.failed.len(), 1);
    assert!(summary.failed[0].path.ends_with("broken.mp4"));
    assert_eq!(calls.load(Ordering::Relaxed), 5); // one start + four files

    let all = library.list(&ClipQuery::default()).unwrap();
    assert_eq!(all.len(), 3);
    for clip in &all {
        assert_eq!(clip.status, ClipStatus::Ready);
        assert_eq!((clip.width, clip.height), (640, 360));
        let thumb = clip.thumb_path.as_ref().expect("thumbnail");
        assert!(Path::new(thumb).is_file());
    }

    // Sorting.
    let by = |sort, ascending| {
        let q = ClipQuery { sort, ascending, ..Default::default() };
        library.list(&q).unwrap().into_iter().map(|c| c.title).collect::<Vec<_>>()
    };
    assert_eq!(by(SortKey::Name, true), ["Alpha win", "beta 100%", "gamma"]);
    assert_eq!(by(SortKey::Duration, false), ["beta 100%", "Alpha win", "gamma"]);
    assert_eq!(by(SortKey::Duration, true), ["gamma", "Alpha win", "beta 100%"]);

    // Search is case-insensitive and treats % literally.
    let search = |text: &str| {
        let q = ClipQuery { search: Some(text.into()), ..Default::default() };
        library.list(&q).unwrap().into_iter().map(|c| c.title).collect::<Vec<_>>()
    };
    assert_eq!(search("ALPHA"), ["Alpha win"]);
    assert_eq!(search("100%"), ["beta 100%"]);
    assert_eq!(search("%").len(), 1);
    assert_eq!(search("  ").len(), 3);

    // Folders: the root shows its own clips and lists "sub" as a folder.
    let in_folder = |folder: &Path, recursive| {
        let q = ClipQuery {
            sort: SortKey::Name,
            ascending: true,
            folder: Some(folder.to_string_lossy().into_owned()),
            recursive,
            ..Default::default()
        };
        library.list(&q).unwrap().into_iter().map(|c| c.title).collect::<Vec<_>>()
    };
    assert_eq!(in_folder(&clips, false), ["Alpha win", "beta 100%"]);
    assert_eq!(in_folder(&clips, true), ["Alpha win", "beta 100%", "gamma"]);
    assert_eq!(in_folder(&clips.join("sub"), false), ["gamma"]);

    let folders = library.folders(&clips.to_string_lossy()).unwrap();
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0].name, "sub");
    assert_eq!(folders[0].clip_count, 1);
    assert_eq!(Path::new(&folders[0].path), clips.join("sub"));
    assert_eq!(folders[0].thumbs.len(), 1);
    assert!(library.folders(&clips.join("sub").to_string_lossy()).unwrap().is_empty());

    // Renaming clips and games.
    let first = library.list(&ClipQuery::default()).unwrap()[0].id;
    library.set_title(first, "  My clip ").unwrap();
    assert_eq!(library.get(first).unwrap().unwrap().title, "My clip");
    library.set_game(first, Some("Old")).unwrap();
    assert_eq!(library.games().unwrap(), ["Old"]);
    assert_eq!(library.rename_game("Old", "New").unwrap(), 1);
    assert_eq!(library.get(first).unwrap().unwrap().game.as_deref(), Some("New"));
    library.set_tags(first, &["Funny".into(), " funny ".into(), "clutch".into(), "".into()]).unwrap();
    assert_eq!(library.get(first).unwrap().unwrap().tags, ["clutch", "Funny"]);
    assert_eq!(library.tags().unwrap(), ["clutch", "Funny"]);
    let found = |text: &str| {
        library
            .list(&ClipQuery { search: Some(text.into()), ..Default::default() })
            .unwrap()
            .len()
    };
    assert_eq!(found("clutc"), 1);
    library.set_tags(first, &["clutch".into()]).unwrap();
    // A tag stays after the last clip loses it, until it is deleted
    assert_eq!(library.tags().unwrap(), ["clutch", "Funny"]);
    library.create_tag("  Solo ").unwrap();
    library.create_tag("solo").unwrap();
    assert_eq!(library.tags().unwrap(), ["clutch", "Funny", "Solo"]);
    library.delete_tag("Funny").unwrap();
    library.delete_tag("Solo").unwrap();
    assert_eq!(library.tags().unwrap(), ["clutch"]);
    let remaining = library.cleanup_remaining().unwrap();
    assert!(remaining >= 1);
    let batch = library.cleanup_batch(2).unwrap();
    assert!(!batch.is_empty() && batch.len() <= 2 && batch.iter().all(|c| !c.favorite && !c.reviewed));
    // A tagged clip has already been looked at, so cleanup leaves it out.
    assert!(batch.iter().all(|c| c.id != first));
    library.set_tags(first, &[]).unwrap();
    assert_eq!(library.cleanup_remaining().unwrap(), remaining + 1);
    library.set_reviewed(first, true).unwrap();
    assert!(library.get(first).unwrap().unwrap().reviewed);
    assert_eq!(library.cleanup_remaining().unwrap(), remaining);
    let visible = library.list(&ClipQuery::default()).unwrap().len();
    library.set_pending_delete(first, true).unwrap();
    assert_eq!(library.list(&ClipQuery::default()).unwrap().len(), visible - 1);
    assert_eq!(library.pending_deletes().unwrap().len(), 1);
    assert_eq!(library.cleanup_remaining().unwrap(), remaining);
    library.set_pending_delete(first, false).unwrap();
    assert_eq!(library.list(&ClipQuery::default()).unwrap().len(), visible);
    assert!(library.pending_deletes().unwrap().is_empty());
    library.set_notes(first, "  remember this  ").unwrap();
    assert_eq!(library.get(first).unwrap().unwrap().notes, "remember this");
    let found_note = library
        .list(&ClipQuery { search: Some("remember".into()), ..Default::default() })
        .unwrap();
    assert_eq!(found_note.len(), 1);
    library.set_game(first, None).unwrap();
    let suggestions = library.suggest_games(&clips).unwrap();
    let sub = suggestions.iter().find(|g| g.game == "sub").expect("the clip in the sub folder");
    assert_eq!((sub.reason.as_str(), sub.clip_ids.len()), ("folder", 1));
    assert_eq!(library.set_games(&sub.clip_ids, Some("Sub Game")).unwrap(), 1);
    assert!(library.suggest_games(&clips).unwrap().iter().all(|g| g.game != "sub"));
    let storage = library.storage_overview().unwrap();
    assert_eq!(storage.total_clips as usize, library.list(&ClipQuery::default()).unwrap().len());
    assert!(storage.total_bytes > 0 && !storage.by_game.is_empty() && !storage.by_month.is_empty());
    assert_eq!(storage.aged.len(), 4);
    let (pool, pool_bytes) = library.cleanup_pool(None).unwrap();
    assert_eq!(pool, library.cleanup_remaining().unwrap());
    assert!(pool_bytes > 0);
    assert_eq!(library.cleanup_pool(Some(36500)).unwrap().0, 0);
    assert_eq!(library.cleanup_remaining_older(Some(36500)).unwrap(), 0);
    assert!(library.cleanup_batch_older(2, Some(36500)).unwrap().is_empty());
    assert_eq!(library.game_for_app("RocketLeague.exe", Some("C:/Games/RocketLeague.exe")).unwrap().as_deref(), Some("Rocket League"));
    let programs = library.game_programs().unwrap();
    assert!(programs.iter().any(|p| p.exe == "rocketleague.exe" && p.path.as_deref() == Some("C:/Games/RocketLeague.exe")));
    library.link_program("My Game", "D:/Stuff/mygame.exe").unwrap();
    assert_eq!(library.game_for_exe("MyGame.exe").unwrap().as_deref(), Some("My Game"));
    library.reset_reviewed().unwrap();
    assert_eq!(library.cleanup_remaining().unwrap(), remaining + 1);
    // Tag colors, renaming (with merging) and deleting
    library.set_tags(first, &["Alpha".into(), "Beta".into()]).unwrap();
    library.set_tag_color("Alpha", Some("#ff6b6b")).unwrap();
    let infos = library.tag_infos().unwrap();
    assert_eq!(infos.iter().map(|t| (t.name.as_str(), t.clips)).collect::<Vec<_>>(), [("Alpha", 1), ("Beta", 1), ("clutch", 0)]);
    assert_eq!(infos[0].color.as_deref(), Some("#ff6b6b"));
    library.rename_tag("Beta", "Gamma").unwrap();
    assert_eq!(library.get(first).unwrap().unwrap().tags, ["Alpha", "Gamma"]);
    library.rename_tag("Gamma", "alpha").unwrap(); // merges into Alpha
    assert_eq!(library.get(first).unwrap().unwrap().tags, ["Alpha"]);
    library.delete_tag("Alpha").unwrap();
    assert!(library.get(first).unwrap().unwrap().tags.is_empty());
    library.set_notes(first, &"x".repeat(900)).unwrap();
    assert_eq!(library.get(first).unwrap().unwrap().notes.chars().count(), 500);
    library.set_notes(first, "").unwrap();
    library.set_favorite(first, true).unwrap();
    assert_eq!(library.cleanup_remaining().unwrap(), remaining);
    assert!(library.get(first).unwrap().unwrap().favorite);

    // Audio track counts survive.
    let tracks = |title: &str| all.iter().find(|c| c.title == title).unwrap().audio_tracks;
    assert_eq!((tracks("Alpha win"), tracks("beta 100%"), tracks("gamma")), (1, 3, 0));

    // A second scan does no work.
    let again = scan(&library, &tools, &clips, &|_| {}).unwrap();
    assert_eq!((again.indexed, again.failed.len()), (0, 1));

    // Deleting a file hides it; restoring it brings it back with the same id.
    let gamma = all.iter().find(|c| c.title == "gamma").unwrap();
    let gamma_path = Path::new(&gamma.path);
    let backup = root.join("gamma.bak");
    std::fs::rename(gamma_path, &backup).unwrap();
    let gone = scan(&library, &tools, &clips, &|_| {}).unwrap();
    assert_eq!(gone.missing, 1);
    assert_eq!(library.list(&ClipQuery::default()).unwrap().len(), 2);
    assert_eq!(library.get(gamma.id).unwrap().unwrap().status, ClipStatus::Missing);

    std::fs::rename(&backup, gamma_path).unwrap();
    let back = scan(&library, &tools, &clips, &|_| {}).unwrap();
    assert_eq!((back.indexed, back.missing), (1, 0));
    assert_eq!(library.get(gamma.id).unwrap().unwrap().status, ClipStatus::Ready);

    // Moving clips: into a new folder, with a name clash, and back up to the top.
    let folder = clipdeck_core::organize::create_folder(&clips, &clips, "Level: 1?").unwrap();
    assert!(folder.ends_with("Level 1"));
    let beta = all.iter().find(|c| c.title.starts_with("beta")).unwrap();
    let moved = clipdeck_core::organize::move_clips(&library, &clips, &[gamma.id, beta.id], &folder).unwrap();
    assert_eq!(moved.len(), 2);
    let now = library.get(gamma.id).unwrap().unwrap();
    assert_eq!(Path::new(&now.path), folder.join("My clip.mp4"));
    assert!(Path::new(&now.path).exists() && !gamma_path.exists());
    assert_eq!(library.folders(&clips.to_string_lossy()).unwrap().iter().filter(|f| f.name == "Level 1").count(), 1);
    std::fs::write(clips.join("My clip.mp4"), b"x").unwrap();
    let again = clipdeck_core::organize::move_clips(&library, &clips, &[gamma.id], &clips).unwrap();
    assert_eq!(again.len(), 1);
    assert_eq!(library.get(gamma.id).unwrap().unwrap().file_name, "My clip (2).mp4");
    assert!(clipdeck_core::organize::move_clips(&library, &clips, &[gamma.id], &root).is_err());
    // Climbing out of the clips folder with ".." is refused.
    let sneaky = clips.join("..").join("elsewhere");
    assert!(clipdeck_core::organize::move_clips(&library, &clips, &[gamma.id], &sneaky).is_err());
    assert!(clipdeck_core::organize::create_folder(&clips, &clips.join(".."), "x").is_err());
    assert!(clipdeck_core::organize::list_dirs(&clips).iter().any(|d| d.ends_with("Level 1")));
    std::fs::remove_file(clips.join("My clip.mp4")).unwrap();
    std::fs::rename(clips.join("My clip (2).mp4"), gamma_path).unwrap();
    library.set_path(gamma.id, &gamma.path, &gamma.file_name).unwrap();

    // Reopening the database keeps everything (and re-running migrations is a no-op).
    drop(library);
    let reopened = Library::open(&root.join("db").join("test.db"), &root.join("thumbs")).unwrap();
    assert_eq!(reopened.list(&ClipQuery::default()).unwrap().len(), 3);

    std::fs::remove_dir_all(&root).ok();
}
