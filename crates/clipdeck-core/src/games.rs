//! Working out which game a clip belongs to.
//!
//! A replay is saved moments after something happens in a game, so whichever
//! program is in the foreground when the file appears is almost always it.

use std::path::Path;

/// The program that had focus at some moment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForegroundApp {
    /// Executable file name, e.g. "RocketLeague.exe".
    pub exe: String,
    pub window_title: String,
    /// Full path of the program, when Windows would tell us.
    pub path: String,
}

/// Programs that are never a game, so clips made while they have focus are
/// left unsorted. Compared in lower case.
const NOT_GAMES: &[&str] = &[
    "explorer.exe",
    "obs64.exe",
    "obs32.exe",
    "clipdeck.exe",
    "dwm.exe",
    "lockapp.exe",
    "searchhost.exe",
    "startmenuexperiencehost.exe",
    "shellexperiencehost.exe",
    "applicationframehost.exe",
    "taskmgr.exe",
    "windowsterminal.exe",
    "cmd.exe",
    "powershell.exe",
    "code.exe",
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "discord.exe",
    "spotify.exe",
    "steam.exe",
    "steamwebhelper.exe",
    "epicgameslauncher.exe",
    "battle.net.exe",
    "riotclientux.exe",
    "medal.exe",
    "claude.exe",
];

/// Proper names for games whose executable name is not a good title.
const KNOWN_GAMES: &[(&str, &str)] = &[
    ("rocketleague.exe", "Rocket League"),
    ("valorant-win64-shipping.exe", "VALORANT"),
    ("cs2.exe", "Counter-Strike 2"),
    ("fortniteclient-win64-shipping.exe", "Fortnite"),
    ("r5apex.exe", "Apex Legends"),
    ("r5apex_dx12.exe", "Apex Legends"),
    ("league of legends.exe", "League of Legends"),
    ("overwatch.exe", "Overwatch 2"),
    ("minecraft.windows.exe", "Minecraft"),
    ("javaw.exe", "Minecraft"),
    ("gta5.exe", "Grand Theft Auto V"),
    ("eldenring.exe", "Elden Ring"),
    ("albion-online.exe", "Albion Online"),
    ("destiny2.exe", "Destiny 2"),
    ("rainbowsix.exe", "Rainbow Six Siege"),
    ("dota2.exe", "Dota 2"),
    ("helldivers2.exe", "Helldivers 2"),
    ("marvel-win64-shipping.exe", "Marvel Rivals"),
    ("cod.exe", "Call of Duty"),
    ("tslgame.exe", "PUBG"),
    ("deadlock.exe", "Deadlock"),
    ("bg3.exe", "Baldur's Gate 3"),
    ("bg3_dx11.exe", "Baldur's Gate 3"),
];

/// Our best guess at a game name for an executable, or None if the program is
/// known not to be a game.
pub fn default_game_name(exe: &str) -> Option<String> {
    let lower = exe.to_lowercase();
    if NOT_GAMES.contains(&lower.as_str()) {
        return None;
    }
    if let Some((_, name)) = KNOWN_GAMES.iter().find(|(known, _)| *known == lower) {
        return Some((*name).to_string());
    }
    let name = prettify(exe);
    (!name.is_empty()).then_some(name)
}

/// "RocketLeague.exe" -> "Rocket League", "Hades2-Win64-Shipping.exe" -> "Hades2".
fn prettify(exe: &str) -> String {
    let mut stem = Path::new(exe)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    // Build-flavour suffixes that say nothing about the game.
    const SUFFIXES: &[&str] = &[
        "-win64-shipping",
        "-wingdk-shipping",
        "-win64",
        "_x64",
        "-x64",
        "_dx11",
        "_dx12",
    ];
    loop {
        let lower = stem.to_lowercase();
        match SUFFIXES.iter().find(|s| lower.ends_with(**s)) {
            Some(suffix) => stem.truncate(stem.len() - suffix.len()),
            None => break,
        }
    }

    // Separators become spaces, and "RocketLeague" gains one at the case change.
    let mut out = String::with_capacity(stem.len() + 4);
    let mut previous: Option<char> = None;
    for c in stem.chars() {
        let c = if c == '_' || c == '-' { ' ' } else { c };
        if c.is_uppercase() && previous.is_some_and(|p| p.is_lowercase()) {
            out.push(' ');
        }
        out.push(c);
        previous = Some(c);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A game name made safe to use as a Windows folder or file name.
pub fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control() && !r#"<>:"/\|?*"#.contains(*c))
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.').trim();
    if cleaned.is_empty() {
        "Other".to_string()
    } else {
        cleaned.to_string()
    }
}

/// The file name a sorted clip gets: OBS's "Replay 2026-11-10 20-42-37.mp4"
/// becomes "Rocket League 2026-11-10 20-42-37.mp4". Other names just gain the
/// game as a prefix (unless they already have it).
pub fn sorted_file_name(game: &str, original: &str) -> String {
    let game = safe_file_name(game);
    if original.to_lowercase().starts_with(&game.to_lowercase()) {
        return original.to_string();
    }
    match original.strip_prefix("Replay ") {
        Some(rest) => format!("{game} {rest}"),
        None => format!("{game} {original}"),
    }
}

/// Save a program's icon as a small PNG. Windows only; an error elsewhere.
pub fn extract_icon(exe: &Path, out: &Path) -> crate::Result<()> {
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let quote = |p: &Path| crate::media::tools::ps_escape(&p.to_string_lossy());
    let script = format!(
        "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Drawing; \
         $i = [System.Drawing.Icon]::ExtractAssociatedIcon('{}'); \
         $b = $i.ToBitmap(); $b.Save('{}', [System.Drawing.Imaging.ImageFormat]::Png)",
        quote(exe),
        quote(out)
    );
    crate::media::tools::run(
        "powershell",
        crate::media::tools::command(Path::new("powershell")).args(["-NoProfile", "-NonInteractive", "-Command", &script]),
    )?;
    Ok(())
}

/// The program that has focus right now. Always None off Windows.
#[cfg(not(windows))]
pub fn foreground_app() -> Option<ForegroundApp> {
    None
}

/// The program that has focus right now.
#[cfg(windows)]
pub fn foreground_app() -> Option<ForegroundApp> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };

    // SAFETY: every call below is given valid pointers to buffers we own, with
    // their true lengths, and the process handle is closed before returning.
    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() {
            return None;
        }

        let mut process_id = 0u32;
        GetWindowThreadProcessId(window, &mut process_id);
        if process_id == 0 {
            return None;
        }

        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
        if process.is_null() {
            return None; // e.g. a program running as administrator
        }
        let mut path = [0u16; 1024];
        let mut path_len = path.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut path_len);
        CloseHandle(process);
        if ok == 0 {
            return None;
        }
        let full_path = String::from_utf16_lossy(&path[..path_len as usize]);
        let exe = Path::new(&full_path).file_name()?.to_string_lossy().into_owned();

        let mut title = [0u16; 512];
        let title_len = GetWindowTextW(window, title.as_mut_ptr(), title.len() as i32);
        let window_title = String::from_utf16_lossy(&title[..title_len.max(0) as usize]);

        Some(ForegroundApp { exe, window_title, path: full_path })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(default_game_name("RocketLeague.exe").as_deref(), Some("Rocket League"));
        assert_eq!(default_game_name("VALORANT-Win64-Shipping.exe").as_deref(), Some("VALORANT"));
        assert_eq!(default_game_name("Hades2-Win64-Shipping.exe").as_deref(), Some("Hades2"));
        assert_eq!(default_game_name("DeepRockGalactic_x64.exe").as_deref(), Some("Deep Rock Galactic"));
        assert_eq!(default_game_name("stardew_valley.exe").as_deref(), Some("stardew valley"));
        assert_eq!(default_game_name("explorer.exe"), None);
        assert_eq!(default_game_name("OBS64.exe"), None);
    }

    #[test]
    fn file_names() {
        assert_eq!(safe_file_name("Baldur's Gate 3"), "Baldur's Gate 3");
        assert_eq!(safe_file_name("What? A: Game."), "What A Game");
        assert_eq!(safe_file_name("???"), "Other");
        assert_eq!(
            sorted_file_name("Rocket League", "Replay 2026-11-10 20-42-37.mp4"),
            "Rocket League 2026-11-10 20-42-37.mp4"
        );
        assert_eq!(sorted_file_name("Rocket League", "clutch.mp4"), "Rocket League clutch.mp4");
        assert_eq!(
            sorted_file_name("Rocket League", "rocket league save.mp4"),
            "rocket league save.mp4"
        );
    }
}
