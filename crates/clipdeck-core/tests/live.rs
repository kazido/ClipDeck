//! Drop clips into a watched folder and check they are picked up and sorted.

use std::path::Path;
use std::process::Command;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use clipdeck_core::games::ForegroundApp;
use clipdeck_core::library::{ClipQuery, Library};
use clipdeck_core::live::{Detector, LiveEvent, LiveIngest};
use clipdeck_core::media::Tools;

fn make_clip(path: &Path) {
    let status = Command::new("ffmpeg")
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=1"])
        .args(["-c:v", "libx264", "-pix_fmt", "yuv420p"])
        .arg(path)
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
fn new_clips_are_sorted_and_indexed() {
    let Ok(tools) = Tools::locate(&[]) else {
        eprintln!("ffmpeg not installed, skipping");
        return;
    };

    let root = std::env::temp_dir().join(format!("clipdeck-live-{}", std::process::id()));
    let clips = root.join("clips");
    let staging = root.join("staging");
    std::fs::create_dir_all(clips.join("Manual")).unwrap();
    std::fs::create_dir_all(&staging).unwrap();
    let library = Arc::new(Library::open(&root.join("test.db"), &root.join("thumbs")).unwrap());

    // The fake "foreground program" the test controls.
    let focus: Arc<Mutex<Option<&'static str>>> = Arc::new(Mutex::new(None));
    let detect: Detector = {
        let focus = focus.clone();
        Arc::new(move || {
            focus.lock().unwrap().map(|exe| ForegroundApp {
                exe: exe.to_string(),
                window_title: String::new(),
                path: String::new(),
            })
        })
    };

    let (tx, rx) = mpsc::channel();
    let live = LiveIngest::start(library.clone(), tools, clips.clone(), detect, move |event| {
        let _ = tx.send(event);
    })
    .unwrap();

    // Build each clip elsewhere, then move it in, as a finished file would appear.
    let save = |exe: Option<&'static str>, target: &Path| -> LiveEvent {
        *focus.lock().unwrap() = exe;
        let temp = staging.join("temp.mp4");
        make_clip(&temp);
        std::fs::rename(&temp, target).unwrap();
        rx.recv_timeout(Duration::from_secs(20)).expect("clip should be picked up")
    };

    // 1. Saved while a game has focus: moved into the game's folder and renamed.
    let event = save(Some("RocketLeague.exe"), &clips.join("Replay 2026-11-10 20-42-37.mp4"));
    let LiveEvent::Added { id, path, game } = event else { panic!("{event:?}") };
    assert_eq!(game.as_deref(), Some("Rocket League"));
    let expected = clips.join("Rocket League").join("Rocket League 2026-11-10 20-42-37.mp4");
    assert_eq!(Path::new(&path), expected);
    assert!(expected.is_file());
    assert!(!clips.join("Replay 2026-11-10 20-42-37.mp4").exists());
    let clip = library.get(id).unwrap().unwrap();
    assert_eq!(clip.title, "Rocket League 2026-11-10 20-42-37");
    assert_eq!(clip.game.as_deref(), Some("Rocket League"));
    assert!(clip.thumb_path.is_some());

    // 2. Same name again: kept alongside, not overwritten.
    let event = save(Some("RocketLeague.exe"), &clips.join("Replay 2026-11-10 20-42-37.mp4"));
    let LiveEvent::Added { path, .. } = event else { panic!("{event:?}") };
    assert!(path.ends_with("Rocket League 2026-11-10 20-42-37 (2).mp4"), "{path}");

    // 3. Saved while a non-game has focus: left where it is.
    let event = save(Some("explorer.exe"), &clips.join("Replay desktop.mp4"));
    let LiveEvent::Added { path, game, .. } = event else { panic!("{event:?}") };
    assert_eq!(game, None);
    assert_eq!(Path::new(&path), clips.join("Replay desktop.mp4"));

    // 4. Put straight into a subfolder: indexed but never moved.
    let event = save(Some("RocketLeague.exe"), &clips.join("Manual").join("mine.mp4"));
    let LiveEvent::Added { path, game, .. } = event else { panic!("{event:?}") };
    assert_eq!(game, None);
    assert_eq!(Path::new(&path), clips.join("Manual").join("mine.mp4"));

    // 5. Sorting switched off: stays put even with a game in focus.
    library.set_sort_by_game(false).unwrap();
    let event = save(Some("RocketLeague.exe"), &clips.join("Replay unsorted.mp4"));
    let LiveEvent::Added { path, game, .. } = event else { panic!("{event:?}") };
    assert_eq!(game, None);
    assert_eq!(Path::new(&path), clips.join("Replay unsorted.mp4"));

    // Nothing was indexed twice (moving a file creates a second notification).
    std::thread::sleep(Duration::from_secs(4));
    assert!(rx.try_recv().is_err(), "unexpected extra event");
    assert_eq!(library.list(&ClipQuery::default()).unwrap().len(), 5);

    drop(live);
    std::fs::remove_dir_all(&root).ok();
}
