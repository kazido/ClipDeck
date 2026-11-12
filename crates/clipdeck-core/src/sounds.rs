//! Notification sounds.
//!
//! Sounds are plain .wav files in one folder. A few are generated the first
//! time the app runs; any .wav the user drops into the folder can be chosen
//! too.

use std::f32::consts::TAU;
use std::path::{Path, PathBuf};

use crate::Result;

const SAMPLE_RATE: u32 = 44_100;

/// The sound used until the user picks another.
pub const DEFAULT_SOUND: &str = "Bright Chirp.wav";
/// The sound for "ready to clip" until the user picks another.
pub const DEFAULT_READY_SOUND: &str = "Ascend.wav";
/// The sound for "not recording" until the user picks another.
pub const DEFAULT_STOPPED_SOUND: &str = "Pop.wav";

// The sounds that ship with ClipDeck: every .wav in `assets/sounds` (see build.rs).
include!(concat!(env!("OUT_DIR"), "/shipped_sounds.rs"));

/// File names of the sounds that ship with the app.
pub fn shipped_names() -> Vec<&'static str> {
    SHIPPED.iter().map(|(name, _)| *name).collect()
}

/// Names of the sounds already put in a person's sounds folder, kept so that one they
/// deleted or renamed is never put back.
const INSTALLED_MARKER: &str = ".installed";

/// The sound played when ClipDeck opens.
const STARTUP_WAV: &[u8] = include_bytes!("../assets/startup.wav");

/// Where the startup sound is kept on disk (it is not one of the choosable sounds).
pub fn startup_sound_path(cache: &Path) -> Option<PathBuf> {
    std::fs::create_dir_all(cache).ok()?;
    let path = cache.join("startup.wav");
    let current = std::fs::metadata(&path).is_ok_and(|m| m.len() == STARTUP_WAV.len() as u64);
    if !current {
        std::fs::write(&path, STARTUP_WAV).ok()?;
    }
    Some(path)
}

/// Create the folder and write any built-in sound that is missing.
/// A file the user has replaced with their own is left alone; only an
/// untouched first-version built-in (recognised by its exact size) is
/// upgraded to the current, smoother version.
pub fn ensure_builtin(folder: &Path) -> Result<()> {
    std::fs::create_dir_all(folder)?;
    let marker_path = folder.join(INSTALLED_MARKER);
    let mut installed: Vec<String> = std::fs::read_to_string(&marker_path)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect();
    let mut changed = false;

    // Each shipped sound is put in the folder once. If it is later renamed or deleted,
    // it stays gone.
    for (name, bytes) in SHIPPED {
        if !installed.iter().any(|n| n == name) {
            let path = folder.join(name);
            if !path.exists() {
                std::fs::write(path, bytes)?;
            }
            installed.push(name.to_string());
            changed = true;
        }
    }

    // (name, generator, size in bytes of the first version of this sound)
    let builtin: [(&str, fn() -> Vec<f32>, u64); 2] = [
        ("Chime.wav", chime, 53_846),
        ("Pop.wav", pop, 9_746),
    ];
    for (name, make, first_version_size) in builtin {
        let path = folder.join(name);
        let outdated = std::fs::metadata(&path).is_ok_and(|m| m.len() == first_version_size);
        let first_time = !installed.iter().any(|n| n == name);
        if (first_time && !path.exists()) || outdated {
            std::fs::write(&path, wav_bytes(&make()))?;
        }
        if first_time {
            installed.push(name.to_string());
            changed = true;
        }
    }
    if changed {
        std::fs::write(marker_path, installed.join("\n"))?;
    }
    Ok(())
}

/// Names of the .wav files in the folder, sorted.
pub fn list(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(folder)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.to_lowercase().ends_with(".wav"))
        .collect();
    names.sort_by_key(|name| name.to_lowercase());
    names
}

/// Longest sound kept when importing, so a whole song can't end up as a popup sound.
const MAX_IMPORT_SECONDS: &str = "8";

/// Convert any audio file (MP3, OGG, M4A, FLAC, ...) into a .wav in the sounds
/// folder and return its file name. Only the first few seconds are kept.
pub fn import(tools: &crate::media::Tools, source: &Path, folder: &Path) -> Result<String> {
    std::fs::create_dir_all(folder)?;
    let stem = source.file_stem().unwrap_or_default().to_string_lossy();
    let stem: String = stem
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '(' | ')') { c } else { '_' })
        .collect();
    let stem = stem.trim();
    let stem = if stem.is_empty() { "Sound" } else { stem };
    let mut name = format!("{stem}.wav");
    let mut n = 2;
    while folder.join(&name).exists() {
        name = format!("{stem} ({n}).wav");
        n += 1;
    }
    let output = folder.join(&name);
    let made = crate::media::tools::run(
        "ffmpeg",
        crate::media::tools::command(&tools.ffmpeg)
            .args(["-v", "error", "-y", "-i"])
            .arg(source)
            .args(["-vn", "-t", MAX_IMPORT_SECONDS, "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le"])
            .arg(&output),
    );
    if let Err(e) = made {
        let _ = std::fs::remove_file(&output);
        return Err(e);
    }
    Ok(name)
}

/// The full path of a sound chosen by name. None for "no sound", for a file
/// that no longer exists, and for anything that is not a plain file name.
pub fn resolve(folder: &Path, name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.contains(['/', '\\']) || name.contains("..") {
        return None;
    }
    let path = folder.join(name);
    path.is_file().then_some(path)
}

/// Start playing a .wav file and return straight away. Does nothing off Windows.
#[cfg(not(windows))]
pub fn play(_path: &Path) {}

/// Start playing a .wav file and return straight away.
#[cfg(windows)]
pub fn play(path: &Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_NODEFAULT};

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` is a valid, null-terminated UTF-16 string. With
    // SND_FILENAME Windows opens the file itself, so nothing we own needs to
    // outlive this call even though playback continues afterwards.
    unsafe {
        PlaySoundW(wide.as_ptr(), std::ptr::null_mut(), SND_FILENAME | SND_ASYNC | SND_NODEFAULT);
    }
}

/// Until when a sound that must not be interrupted is still playing.
static BUSY_UNTIL: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

/// Play a sound that others should wait for (the one when the app opens). Windows can only
/// play one sound at a time, and a new one cuts the old one off.
pub fn play_tracked(path: &Path, length: std::time::Duration) {
    play(path);
    if let Ok(mut busy) = BUSY_UNTIL.lock() {
        *busy = Some(std::time::Instant::now() + length);
    }
}

/// Play a sound, but if a tracked one is still going, wait for it to finish first.
pub fn play_when_free(path: &Path) {
    let wait = BUSY_UNTIL
        .lock()
        .ok()
        .and_then(|busy| *busy)
        .map(|until| until.saturating_duration_since(std::time::Instant::now()))
        .unwrap_or_default();
    if wait.is_zero() {
        play(path);
    } else {
        let path = path.to_path_buf();
        std::thread::spawn(move || {
            std::thread::sleep(wait);
            play(&path);
        });
    }
}

/// How long the startup sound lasts.
pub fn startup_sound_length() -> std::time::Duration {
    // 44.1 kHz, stereo, 16-bit: 176,400 bytes a second
    std::time::Duration::from_secs_f64((STARTUP_WAV.len().saturating_sub(44)) as f64 / 176_400.0)
}

// --- Built-in sounds, made from sine waves ------------------------------------

/// A sine tone that swells in gently and dies away, ending in silence.
/// `decay` is how fast it fades.
fn tone(frequency: f32, seconds: f32, decay: f32, volume: f32) -> Vec<f32> {
    let count = (seconds * SAMPLE_RATE as f32) as usize;
    (0..count)
        .map(|i| {
            let t = i as f32 / SAMPLE_RATE as f32;
            (TAU * frequency * t).sin() * (-decay * t).exp() * edges(t, seconds) * volume
        })
        .collect()
}

/// 0 to 1 over the first 8 ms and back to 0 over the last 30 ms, as smooth
/// curves. Starting or stopping a wave abruptly is heard as a click.
fn edges(t: f32, seconds: f32) -> f32 {
    let smooth = |x: f32| {
        let x = x.clamp(0.0, 1.0);
        x * x * (3.0 - 2.0 * x)
    };
    smooth(t / 0.008) * smooth((seconds - t) / 0.03)
}

/// Add `sound` into `into`, starting `at_seconds` in.
fn mix(into: &mut Vec<f32>, sound: &[f32], at_seconds: f32) {
    let start = (at_seconds * SAMPLE_RATE as f32) as usize;
    if into.len() < start + sound.len() {
        into.resize(start + sound.len(), 0.0);
    }
    for (i, sample) in sound.iter().enumerate() {
        into[start + i] += sample;
    }
}

/// Two soft rising notes.
fn chime() -> Vec<f32> {
    let mut out = Vec::new();
    mix(&mut out, &tone(784.0, 0.5, 8.0, 0.3), 0.0);
    mix(&mut out, &tone(1174.7, 0.7, 6.0, 0.3), 0.12);
    out
}

/// A short, soft, falling blip.
fn pop() -> Vec<f32> {
    let seconds = 0.16;
    let count = (seconds * SAMPLE_RATE as f32) as usize;
    let mut phase = 0.0f32;
    (0..count)
        .map(|i| {
            let t = i as f32 / SAMPLE_RATE as f32;
            let frequency = 480.0 - 260.0 * (t / seconds);
            phase += TAU * frequency / SAMPLE_RATE as f32;
            phase.sin() * (-22.0 * t).exp() * edges(t, seconds) * 0.55
        })
        .collect()
}

// --- Volume --------------------------------------------------------------------

/// The file to play for `sound` at `volume` percent (0-100).
///
/// Windows' simple sound player has no volume control, so a quieter copy is
/// made in `cache` and reused until the original changes. At 100%, or when
/// the file is not a kind of WAV we can rewrite, the original is returned.
pub fn at_volume(sound: &Path, volume: u8, cache: &Path) -> PathBuf {
    if volume >= 100 {
        return sound.to_path_buf();
    }
    let name = sound.file_stem().unwrap_or_default().to_string_lossy();
    let copy = cache.join(format!("{name}-{volume}.wav"));

    let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let fresh = matches!((modified(&copy), modified(sound)), (Some(c), Some(s)) if c >= s);
    if fresh {
        return copy;
    }

    let made = std::fs::read(sound).ok().and_then(|bytes| scale_wav(&bytes, f32::from(volume) / 100.0));
    match made {
        Some(bytes) if std::fs::create_dir_all(cache).is_ok() && std::fs::write(&copy, &bytes).is_ok() => copy,
        _ => sound.to_path_buf(),
    }
}

/// A copy of a WAV file with every sample multiplied by `gain`. Handles
/// 16-bit, 24-bit and 32-bit whole-number samples and 32-bit decimals, which
/// covers what audio editors normally export. None for anything else.
fn scale_wav(bytes: &[u8], gain: f32) -> Option<Vec<u8>> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let u16_at = |i: usize| bytes.get(i..i + 2).map(|b| u16::from_le_bytes([b[0], b[1]]));
    let u32_at = |i: usize| bytes.get(i..i + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));

    // Walk the file's chunks to find the format description and the samples.
    let mut format: Option<(u16, u16)> = None; // (encoding, bits per sample)
    let mut data: Option<(usize, usize)> = None; // (start, length)
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let len = u32_at(at + 4)? as usize;
        let body = at + 8;
        if id == b"fmt " {
            let mut encoding = u16_at(body)?;
            let bits = u16_at(body + 14)?;
            // "Extensible" files keep the real encoding further in.
            if encoding == 0xFFFE {
                encoding = u16_at(body + 24)?;
            }
            format = Some((encoding, bits));
        } else if id == b"data" {
            data = Some((body, len.min(bytes.len().saturating_sub(body))));
            break;
        }
        at = body + len + (len & 1); // chunks are padded to an even length
    }
    let ((encoding, bits), (start, len)) = (format?, data?);

    let mut out = bytes.to_vec();
    let samples = &mut out[start..start + len];
    match (encoding, bits) {
        (1, 16) => {
            for s in samples.chunks_exact_mut(2) {
                let v = (f32::from(i16::from_le_bytes([s[0], s[1]])) * gain) as i16;
                s.copy_from_slice(&v.to_le_bytes());
            }
        }
        (1, 24) => {
            for s in samples.chunks_exact_mut(3) {
                let v = i32::from_le_bytes([0, s[0], s[1], s[2]]) >> 8; // sign-extend
                let v = (v as f32 * gain) as i32;
                s.copy_from_slice(&v.to_le_bytes()[0..3]);
            }
        }
        (1, 32) => {
            for s in samples.chunks_exact_mut(4) {
                let v = (i32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f64 * f64::from(gain)) as i32;
                s.copy_from_slice(&v.to_le_bytes());
            }
        }
        (3, 32) => {
            for s in samples.chunks_exact_mut(4) {
                let v = f32::from_le_bytes([s[0], s[1], s[2], s[3]]) * gain;
                s.copy_from_slice(&v.to_le_bytes());
            }
        }
        _ => return None,
    }
    Some(out)
}

/// Wrap samples (-1.0 to 1.0) as a 16-bit mono WAV file.
fn wav_bytes(samples: &[f32]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // size of the format block
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // bytes per second
    out.extend_from_slice(&2u16.to_le_bytes()); // bytes per sample
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn samples_of(wav: &[u8]) -> Vec<i16> {
        wav[44..].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect()
    }

    #[test]
    fn built_in_sounds_are_clean() {
        for (name, make) in [("chime", chime as fn() -> Vec<f32>), ("pop", pop)] {
            let sound = make();
            let peak = sound.iter().fold(0.0f32, |m, s| m.max(s.abs()));
            assert!(peak <= 0.9, "{name} would clip: peak {peak}");
            assert!(peak >= 0.2, "{name} is too quiet: peak {peak}");
            // Starts and ends at silence, so there is no click at either edge.
            assert!(sound[0].abs() < 0.001, "{name} starts at {}", sound[0]);
            assert!(sound[sound.len() - 1].abs() < 0.001, "{name} ends at {}", sound[sound.len() - 1]);
            // No sudden jumps anywhere (a jump is heard as a pop).
            let jump = sound.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
            assert!(jump < 0.2, "{name} has a jump of {jump}");
        }
    }

    #[test]
    fn volume_scaling() {
        let original = wav_bytes(&chime());
        let half = scale_wav(&original, 0.5).unwrap();
        assert_eq!(half.len(), original.len());
        assert_eq!(&half[..44], &original[..44]); // header untouched
        for (a, b) in samples_of(&original).iter().zip(samples_of(&half)) {
            assert!((i32::from(*a) / 2 - i32::from(b)).abs() <= 1);
        }
        assert!(samples_of(&scale_wav(&original, 0.0).unwrap()).iter().all(|s| *s == 0));
        assert!(scale_wav(b"not a wav file at all", 0.5).is_none());

        // 32-bit decimal samples, with an extra chunk before the data.
        let mut float_wav = Vec::new();
        float_wav.extend_from_slice(b"RIFF\0\0\0\0WAVEfmt ");
        float_wav.extend_from_slice(&16u32.to_le_bytes());
        float_wav.extend_from_slice(&3u16.to_le_bytes());
        float_wav.extend_from_slice(&1u16.to_le_bytes());
        float_wav.extend_from_slice(&44_100u32.to_le_bytes());
        float_wav.extend_from_slice(&176_400u32.to_le_bytes());
        float_wav.extend_from_slice(&4u16.to_le_bytes());
        float_wav.extend_from_slice(&32u16.to_le_bytes());
        float_wav.extend_from_slice(b"LIST");
        float_wav.extend_from_slice(&3u32.to_le_bytes());
        float_wav.extend_from_slice(b"abc\0"); // odd length, padded
        float_wav.extend_from_slice(b"data");
        float_wav.extend_from_slice(&8u32.to_le_bytes());
        float_wav.extend_from_slice(&0.8f32.to_le_bytes());
        float_wav.extend_from_slice(&(-0.4f32).to_le_bytes());
        let scaled = scale_wav(&float_wav, 0.25).unwrap();
        let n = scaled.len();
        assert_eq!(f32::from_le_bytes(scaled[n - 8..n - 4].try_into().unwrap()), 0.2);
        assert_eq!(f32::from_le_bytes(scaled[n - 4..].try_into().unwrap()), -0.1);
    }

    #[test]
    fn quieter_copies_are_cached() {
        let root = std::env::temp_dir().join(format!("clipdeck-sounds-{}", std::process::id()));
        let (folder, cache) = (root.join("sounds"), root.join("cache"));
        ensure_builtin(&folder).unwrap();
        let chime = folder.join("Chime.wav");

        assert_eq!(at_volume(&chime, 100, &cache), chime);
        let quiet = at_volume(&chime, 40, &cache);
        assert_eq!(quiet, cache.join("Chime-40.wav"));
        let first_written = std::fs::metadata(&quiet).unwrap().modified().unwrap();
        assert_eq!(at_volume(&chime, 40, &cache), quiet);
        assert_eq!(std::fs::metadata(&quiet).unwrap().modified().unwrap(), first_written);

        // A file we can't rewrite is played as it is.
        let odd = folder.join("odd.wav");
        std::fs::write(&odd, b"junk").unwrap();
        assert_eq!(at_volume(&odd, 40, &cache), odd);

        // A first-version built-in is upgraded; a user's own file is not.
        std::fs::write(folder.join("Pop.wav"), vec![0u8; 9_746]).unwrap();
        std::fs::write(folder.join("Chime.wav"), b"mine").unwrap();
        ensure_builtin(&folder).unwrap();
        assert_ne!(std::fs::metadata(folder.join("Pop.wav")).unwrap().len(), 9_746);
        assert_eq!(std::fs::read(folder.join("Chime.wav")).unwrap(), b"mine");

        std::fs::remove_dir_all(&root).ok();
    }
}

#[cfg(test)]
mod shipped_tests {
    use super::*;

    #[test]
    fn shipped_sounds_are_written_once() {
        let dir = std::env::temp_dir().join(format!("clipdeck-shipped-{}", std::process::id()));
        ensure_builtin(&dir).unwrap();
        let names = list(&dir);
        assert!(!SHIPPED.is_empty());
        for (name, _) in SHIPPED {
            assert!(names.iter().any(|n| n == name), "{name} in {names:?}");
        }
        assert!(names.iter().any(|n| n == "Chime.wav"));
        // A sound the user replaced is left alone
        let first = SHIPPED[0].0;
        std::fs::write(dir.join(first), b"mine").unwrap();
        ensure_builtin(&dir).unwrap();
        assert_eq!(std::fs::read(dir.join(first)).unwrap(), b"mine");
        // A sound the user deleted or renamed does not come back
        std::fs::rename(dir.join(first), dir.join("My Own.wav")).unwrap();
        std::fs::remove_file(dir.join("Chime.wav")).unwrap();
        ensure_builtin(&dir).unwrap();
        assert!(!dir.join(first).exists() && !dir.join("Chime.wav").exists());
        assert!(dir.join("My Own.wav").exists());
        let startup = startup_sound_path(&dir.join("cache")).unwrap();
        assert!(std::fs::metadata(startup).unwrap().len() > 100_000);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
