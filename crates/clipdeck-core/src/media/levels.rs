//! Loudness per frequency band over time, for the player's audio visualizer.
//!
//! The clip's audio (all tracks mixed) is decoded once by FFmpeg and cut into
//! short windows; each window becomes a row of band levels. The player then
//! draws the row that matches the playback time.

use std::path::Path;

use serde::Serialize;

use super::tools::{command, run, Tools};
use crate::Result;

const SAMPLE_RATE: usize = 22_050;
const WINDOW: usize = 1024;
/// Rows per second of audio.
pub const FPS: usize = 30;
/// Frequency bands per row, from low to high.
pub const BANDS: usize = 32;
const MAX_TRACKS: usize = 6;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLevels {
    pub fps: usize,
    pub bands: usize,
    /// `bands` values (0-255) per row, row after row.
    pub data: Vec<u8>,
}

/// Analyse the audio of `input`. `tracks` is how many audio tracks it has.
pub fn analyze(tools: &Tools, input: &Path, tracks: usize) -> Result<AudioLevels> {
    let tracks = tracks.min(MAX_TRACKS);
    let mut cmd = command(&tools.ffmpeg);
    cmd.args(["-v", "error"]).arg("-i").arg(input).arg("-vn");
    if tracks > 1 {
        let inputs: String = (0..tracks).map(|i| format!("[0:a:{i}]")).collect();
        cmd.args([
            "-filter_complex",
            &format!("{inputs}amix=inputs={tracks}:normalize=0[mix]"),
            "-map",
            "[mix]",
        ]);
    }
    cmd.args(["-ac", "1", "-ar", &SAMPLE_RATE.to_string(), "-f", "f32le", "-"]);

    let out = run("ffmpeg", &mut cmd)?;
    let samples: Vec<f32> = out
        .stdout
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    Ok(AudioLevels { fps: FPS, bands: BANDS, data: levels_from_samples(&samples) })
}

fn levels_from_samples(samples: &[f32]) -> Vec<u8> {
    let hop = SAMPLE_RATE / FPS;
    let hann: Vec<f32> = (0..WINDOW)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (WINDOW - 1) as f32).cos())
        .collect();
    let edges = band_edges();
    let rows = samples.len() / hop;
    let mut data = Vec::with_capacity(rows * BANDS);
    let mut re = vec![0f32; WINDOW];
    let mut im = vec![0f32; WINDOW];

    for row in 0..rows {
        let start = row * hop;
        for i in 0..WINDOW {
            re[i] = samples.get(start + i).copied().unwrap_or(0.0) * hann[i];
            im[i] = 0.0;
        }
        fft(&mut re, &mut im);
        for b in 0..BANDS {
            let (lo, hi) = (edges[b], edges[b + 1].max(edges[b] + 1));
            let power: f32 = (lo..hi).map(|k| re[k] * re[k] + im[k] * im[k]).sum::<f32>() / (hi - lo) as f32;
            // Magnitude relative to a full-scale tone, in decibels, mapped from -75..-10 dB to 0..255.
            let db = 20.0 * (power.sqrt() / (WINDOW as f32 / 4.0)).max(1e-9).log10();
            data.push((((db + 75.0) / 65.0).clamp(0.0, 1.0) * 255.0) as u8);
        }
    }
    data
}

/// FFT bin boundaries for `BANDS` bands spaced evenly on a log scale, 50 Hz to 10 kHz.
fn band_edges() -> Vec<usize> {
    let bin_hz = SAMPLE_RATE as f32 / WINDOW as f32;
    (0..=BANDS)
        .map(|b| {
            let hz = 50.0 * (10_000.0f32 / 50.0).powf(b as f32 / BANDS as f32);
            ((hz / bin_hz) as usize).clamp(1, WINDOW / 2 - 1)
        })
        .collect()
}

/// In-place radix-2 FFT. `re.len()` must be a power of two.
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let angle = -2.0 * std::f32::consts::PI / len as f32;
        let (wr, wi) = (angle.cos(), angle.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let next = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = next;
            }
        }
        len <<= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tone_lights_the_matching_band() {
        // One second of a 1 kHz tone.
        let samples: Vec<f32> = (0..SAMPLE_RATE)
            .map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / SAMPLE_RATE as f32).sin() * 0.8)
            .collect();
        let data = levels_from_samples(&samples);
        assert_eq!(data.len() % BANDS, 0);
        let row = &data[BANDS * 5..BANDS * 6];
        let loudest = row.iter().enumerate().max_by_key(|(_, v)| **v).unwrap().0;
        let edges = band_edges();
        let bin = (1000.0 / (SAMPLE_RATE as f32 / WINDOW as f32)) as usize;
        assert!(edges[loudest] <= bin && bin <= edges[loudest + 1].max(edges[loudest] + 1), "band {loudest}");
        assert!(row[loudest] > 150);
        assert!(row[0] < 40);
    }
}
