//! End-to-end checks against a real FFmpeg. Skipped when FFmpeg is absent.

use std::path::{Path, PathBuf};
use std::process::Command;

use clipdeck_core::media::{probe, thumbnail, Tools};

fn make_sample(dir: &Path, name: &str, extra: &[&str]) -> PathBuf {
    let out = dir.join(name);
    let status = Command::new("ffmpeg")
        .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
        .arg("testsrc2=size=1280x720:rate=60000/1001:duration=3")
        .args(["-f", "lavfi", "-i", "sine=frequency=440:duration=3"])
        .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"])
        .args(extra)
        .arg(&out)
        .status()
        .expect("run ffmpeg");
    assert!(status.success());
    out
}

#[test]
fn probe_and_thumbnail() {
    let Ok(tools) = Tools::locate(&[]) else {
        eprintln!("ffmpeg not installed, skipping");
        return;
    };
    assert!(tools.ffmpeg_version().unwrap().starts_with("ffmpeg version"));

    let dir = std::env::temp_dir().join(format!("clipdeck-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    for name in ["sample.mp4", "sample.mkv", "name with spaces é.mp4"] {
        let clip = make_sample(&dir, name, &[]);
        let info = probe(&tools, &clip).unwrap();

        assert_eq!(info.file_name, name);
        assert_eq!(info.video.codec, "h264");
        assert_eq!((info.video.width, info.video.height), (1280, 720));
        // MKV stores timestamps in milliseconds, so its reported rate is only
        // approximately 59.94. Compare the decimal value, not the fraction.
        assert!((info.video.fps() - 59.94).abs() < 0.01, "{}", info.video.fps());
        assert!((2900..=3200).contains(&info.duration_ms), "{}", info.duration_ms);
        assert_eq!(info.audio.len(), 1);
        let levels = clipdeck_core::media::levels::analyze(&tools, &clip, 1).unwrap();
        assert!(levels.data.len() >= 80 * levels.bands, "{}", levels.data.len());

        // Trimming, lossless and precise.
        let keys = clipdeck_core::media::trim::keyframes(&tools, &clip).unwrap();
        assert!(!keys.is_empty() && keys[0] < 0.1, "{keys:?}");
        let cut_path = dir.join(format!("cut-{name}"));
        clipdeck_core::media::trim::cut(&tools, &clip, &cut_path, 0.5, 1.5, true).unwrap();
        let cut_info = probe(&tools, &cut_path).unwrap();
        assert!((900..=1150).contains(&cut_info.duration_ms), "precise {}", cut_info.duration_ms);
        assert_eq!(cut_info.audio.len(), 1);
        clipdeck_core::media::trim::cut(&tools, &clip, &cut_path, 0.0, 1.0, false).unwrap();
        let cut_info = probe(&tools, &cut_path).unwrap();
        assert!((800..=1300).contains(&cut_info.duration_ms), "lossless {}", cut_info.duration_ms);
        // A notification sound from an MP3.
        let mp3 = dir.join("My Sound!.mp3");
        let made = Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=12", "-c:a", "libmp3lame"])
            .arg(&mp3)
            .status()
            .unwrap();
        assert!(made.success());
        let sounds_dir = dir.join(format!("sounds-{name}"));
        let wav = clipdeck_core::sounds::import(&tools, &mp3, &sounds_dir).unwrap();
        assert_eq!(wav, "My Sound_.wav");
        let again = clipdeck_core::sounds::import(&tools, &mp3, &sounds_dir).unwrap();
        assert_eq!(again, "My Sound_ (2).wav");
        // Capped at 8 seconds of 44.1 kHz stereo 16-bit audio, plus the header.
        let size = std::fs::metadata(sounds_dir.join(&wav)).unwrap().len();
        assert!((1_400_000..=1_450_000).contains(&size), "{size}");

        // Sharing: a copy that fits under a small limit.
        use clipdeck_core::media::share::{encode, Audio, Source};
        let shared = dir.join(format!("shared-{name}.mp4"));
        let source = Source { input: &clip, start: 0.5, end: 2.5, width: 1280, height: 720, fps: 59.94, audio_tracks: 1 };
        for audio in [Audio::Mix, Audio::Track(0), Audio::None] {
            let size = encode(&tools, &source, &shared, 250_000, audio).unwrap();
            assert!(size <= 250_000 && size > 5_000, "{audio:?} {size}");
            let info = probe(&tools, &shared).unwrap();
            assert!((1800..=2300).contains(&info.duration_ms), "{}", info.duration_ms);
            assert_eq!(info.audio.len(), usize::from(audio != Audio::None), "{audio:?}");
        }
        let strip_base = dir.join(format!("strip-{name}.jpg"));
        let strip = clipdeck_core::media::strip::ensure(&tools, &clip, &strip_base, 3.0).unwrap();
        assert_eq!((strip.frames, strip.pages), (36, 1));
        let first = clipdeck_core::media::strip::page_path(&strip_base, 0);
        assert!(std::fs::metadata(&first).unwrap().len() > 1000);
        let part = dir.join(format!("{name}.trimming"));
        clipdeck_core::media::trim::cut(&tools, &clip, &part, 0.0, 1.0, false).unwrap();
        assert_eq!(probe(&tools, &part).unwrap().audio.len(), 1);
        let again = clipdeck_core::media::trim::unique_trim_path(&clip);
        assert!(again.to_string_lossy().contains("(trim)"));
        assert_eq!(info.audio[0].codec, "aac");
        assert!(info.size_bytes > 0);

        let thumb = dir.join("thumbs").join(format!("{name}.jpg"));
        let at = thumbnail::pick_timestamp_secs(info.duration_ms);
        thumbnail::generate(&tools, &clip, &thumb, at, thumbnail::DEFAULT_WIDTH).unwrap();
        let thumb_info = probe(&tools, &thumb).unwrap();
        assert_eq!(thumb_info.video.width, 480);
        assert_eq!(thumb_info.video.height, 270);
    }

    // Failure cases should be clean errors, not panics.
    assert!(probe(&tools, &dir.join("missing.mp4")).is_err());
    let junk = dir.join("junk.mp4");
    std::fs::write(&junk, b"not a video").unwrap();
    assert!(probe(&tools, &junk).is_err());

    std::fs::remove_dir_all(&dir).ok();
}
