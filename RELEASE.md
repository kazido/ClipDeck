# Releasing ClipDeck 1.0 — checklist

Tick these off before sending the installer to friends.

## Build the installer
- [ ] `npm run setup-ffmpeg` (once) so FFmpeg is inside the installer
- [ ] `npx tauri-plugin-libmpv-api setup-lib` (once) so the mpv DLLs are inside the installer
- [ ] Set the version in `src-tauri/tauri.conf.json` and `package.json` (now 0.1.0)
- [ ] `npm run tauri build`, then take the installer from `src-tauri\target\release\bundle\`

## Test the installed build (not just `npm run tauri dev`)
Production builds behave differently from dev builds, so go through these on the installed app:
- [ ] Videos play, thumbnails show, the scrub strip works (this checks the security policy added in this release)
- [ ] Settings → Start with Windows works
- [ ] Alt+Z shows/hides; popups appear and sounds play
- [ ] The Guide's "Set up OBS for me" works against your real OBS, with the replay buffer on and off
- [ ] A new clip saved from OBS is sorted into its game folder
- [ ] Uninstall and reinstall: your library and settings survive (they live in `%APPDATA%\com.bryson.clipdeck`)
- [ ] **Clean machine test:** a PC or Windows VM with no FFmpeg and no OBS. Install ClipDeck, follow the Guide from scratch
- [ ] Never run the dev build and installed build at once (they share the database and hotkey)

## Windows warnings
- [ ] An unsigned installer shows "Windows protected your PC". Friends click **More info → Run anyway**. Tell them in advance. Signing with a code-signing certificate removes this (about $100–400 a year, or Azure Trusted Signing) — worth it only if it goes beyond friends.

## Legal and names
- [ ] FFmpeg (the build from gyan.dev is GPL) and mpv ship inside the app. Include their licenses and a link to their source (an About/Licenses text file in the installer). The mpv build from `setup-lib` should be checked for GPL vs LGPL
- [~] Name check: no app called "ClipDeck" turned up in a web search, but "Clip Deck" exists as a text-snippet app on the Apple App Store and as a Stream Deck-style plugin for Adobe Premiere Pro. Do a free search at tmsearch.uspto.gov for "ClipDeck" before promoting it beyond friends. The identifier is `com.bryson.clipdeck`
- [x] App icon is now a 1024 px design (`src-tauri/icon-source.svg`). To change it, edit that file and run `npx tauri icon src-tauri/icon-source.svg -o src-tauri/icons`, then delete the `android` and `ios` folders it makes

## Security (done in this release)
- [x] No known vulnerabilities in the JavaScript packages (`npm audit`: 0)
- [x] File names with curly quotes (as in "Don’t") can no longer break out of the PowerShell commands that copy files or read icons
- [x] Moving or creating folders can't climb out of the clips folder with `..`
- [x] A Content Security Policy blocks the page from running scripts or loading anything from the internet
- [x] The app makes no network connections other than OBS on your own computer (port 4455); there is no telemetry and no account
- [x] Database queries use bound parameters, never text pasted into SQL
- [ ] Rust packages: run `cargo install cargo-audit` once, then `cargo audit` in the project, before each release
- Known and accepted: the OBS WebSocket password is stored in the local database in plain text. It only protects a connection that never leaves your PC

## Good to have
- [ ] Back up your own `clipdeck.db` before installing a new version (updates are safe, but this is cheap insurance)
- [ ] Tell friends: no automatic updates yet; to update, run the new installer over the old one
- [ ] Write a few lines on what ClipDeck is and a note that it needs OBS
