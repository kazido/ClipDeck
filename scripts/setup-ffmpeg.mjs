// Downloads FFmpeg and FFprobe into src-tauri/bin so the installer carries them.
//
// Run:  npm run setup-ffmpeg
// Source: the "full-shared" build from https://www.gyan.dev/ffmpeg/builds/ (about 60 MB to download,
// about 240 MB unpacked). The "full" build is used because it can read AV1 clips (NVIDIA's
// recorder makes them); the smaller "essentials" build cannot read some of them, so those clips
// would have no thumbnails. It is a GPL build, so if ClipDeck is released, keep the FFmpeg licence
// and a link to its source with the app.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full-shared.7z";
const bin = join(process.cwd(), "src-tauri", "bin");
const work = join(tmpdir(), "clipdeck-ffmpeg");

const hasShared = () => existsSync(join(bin, "ffmpeg.exe")) && existsSync(join(bin, "ffprobe.exe")) && readdirSync(bin).some((n) => /^avcodec-.*\.dll$/i.test(n));
if (hasShared()) {
  console.log("FFmpeg is already in src-tauri\\bin. Delete the files there (except README.txt) to download again.");
  process.exit(0);
}
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(bin, { recursive: true });
// An older download (a single large ffmpeg.exe without the .dll files) is replaced.
for (const name of readdirSync(bin)) {
  if (/\.(exe|dll)$/i.test(name)) rmSync(join(bin, name));
}

const archive = join(work, "ffmpeg.7z");
console.log("Downloading FFmpeg (about 60 MB)…");
const res = await fetch(url);
if (!res.ok) {
  console.error(`Download failed (${res.status}).`);
  process.exit(1);
}
writeFileSync(archive, Buffer.from(await res.arrayBuffer()));

console.log("Unpacking…");
// Windows 10 and 11 include a tar that can open .7z files.
execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", archive, "-C", work], { stdio: "inherit" });
const folder = readdirSync(work).find((n) => n.startsWith("ffmpeg-") && !n.endsWith(".7z"));
if (!folder) {
  console.error("Could not find the unpacked FFmpeg folder.");
  process.exit(1);
}
const from = join(work, folder, "bin");
// ffplay (a video player) is not needed.
for (const name of readdirSync(from)) {
  if (/^ffplay\.exe$/i.test(name)) continue;
  if (/\.(exe|dll)$/i.test(name)) copyFileSync(join(from, name), join(bin, name));
}
rmSync(work, { recursive: true, force: true });
console.log("Done. FFmpeg is in src-tauri\\bin.");
