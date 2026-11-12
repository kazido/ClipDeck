//! Finding and launching the FFmpeg and FFprobe executables.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use crate::{Error, Result};

/// Resolved locations of the two executables we depend on.
#[derive(Debug, Clone)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

impl Tools {
    /// Look for the tools in `extra_dirs` first (for example a `bin` folder
    /// shipped with the app), then fall back to whatever is on the PATH.
    pub fn locate(extra_dirs: &[PathBuf]) -> Result<Self> {
        Ok(Self {
            ffmpeg: locate_one("ffmpeg", extra_dirs)?,
            ffprobe: locate_one("ffprobe", extra_dirs)?,
        })
    }

    /// First line of `ffmpeg -version`, e.g. "ffmpeg version 7.1 ...".
    pub fn ffmpeg_version(&self) -> Result<String> {
        let out = run("ffmpeg", command(&self.ffmpeg).arg("-version"))?;
        Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()
            .unwrap_or_default()
            .to_string())
    }
}

fn locate_one(name: &'static str, extra_dirs: &[PathBuf]) -> Result<PathBuf> {
    let file_name = format!("{name}{}", std::env::consts::EXE_SUFFIX);

    for dir in extra_dirs {
        let candidate = dir.join(&file_name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    // A bare name makes the OS search the PATH. Prove it actually runs.
    let on_path = PathBuf::from(&file_name);
    match command(&on_path).arg("-version").output() {
        Ok(out) if out.status.success() => Ok(on_path),
        _ => Err(Error::ToolNotFound { tool: name }),
    }
}

/// Make text safe to place inside a single-quoted PowerShell string. PowerShell treats the
/// curly quotes (as in "Don’t") like the plain one, so each of them must be doubled too, or a
/// file name could end the string early and run as a command.
pub fn ps_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        out.push(c);
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            out.push(c);
        }
    }
    out
}

/// Build a `Command` that never pops up a console window on Windows.
pub(crate) fn command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Run a command to completion and turn a non-zero exit into an error that
/// carries the tool's own error text.
pub(crate) fn run(tool: &'static str, cmd: &mut Command) -> Result<Output> {
    let out = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Error::ToolNotFound { tool }
        } else {
            Error::Io(e)
        }
    })?;

    if out.status.success() {
        Ok(out)
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let message = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("unknown error")
            .trim()
            .to_string();
        Err(Error::ToolFailed { tool, message })
    }
}

/// Stop any FFmpeg or FFprobe process that is working on `path`, such as a
/// preview strip still being made for a large clip. Returns after asking Windows
/// to end them. Other programs are never touched.
pub fn stop_helpers_using(path: &Path) {
    if !cfg!(windows) {
        return;
    }
    let quoted = ps_escape(&path.to_string_lossy());
    let script = format!(
        "Get-CimInstance Win32_Process | Where-Object {{ ($_.Name -eq 'ffmpeg.exe' -or $_.Name -eq 'ffprobe.exe') -and $_.CommandLine -and $_.CommandLine.Contains('{quoted}') }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"
    );
    let _ = command(Path::new("powershell"))
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output();
}

#[cfg(test)]
mod ps_tests {
    use super::ps_escape;

    #[test]
    fn every_kind_of_single_quote_is_doubled() {
        assert_eq!(ps_escape("it's"), "it''s");
        assert_eq!(ps_escape("Don\u{2019}t"), "Don\u{2019}\u{2019}t");
        assert_eq!(ps_escape("a\u{2018}b\u{201A}c\u{201B}d"), "a\u{2018}\u{2018}b\u{201A}\u{201A}c\u{201B}\u{201B}d");
        assert_eq!(ps_escape("plain"), "plain");
    }
}
