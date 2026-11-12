// Downloads FFmpeg and FFprobe into src-tauri/bin so the installer carries them.
//
// Run:  npm run setup-ffmpeg
// Source: the "essentials" build from https://www.gyan.dev/ffmpeg/builds/ (about 30 MB to
// download, about 200 MB unpacked). It is a GPL build, so if ClipDeck is released, keep the
// FFmpeg licence and a link to its source with the app.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const bin = join(process.cwd(), "src-tauri", "bin");
const work = join(tmpdir(), "clipdeck-ffmpeg");

if (existsSync(join(bin, "ffmpeg.exe")) && existsSync(join(bin, "ffprobe.exe"))) {
  console.log("FFmpeg is already in src-tauri\bin. Delete the two .exe files there to download again.");
  process.exit(0);
}
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(bin, { recursive: true });

const zip = join(work, "ffmpeg.zip");
console.log("Downloading FFmpeg…");
const res = await fetch(url);
if (!res.ok) {
  console.error(`Download failed (${res.status}).`);
  process.exit(1);
}
writeFileSync(zip, Buffer.from(await res.arrayBuffer()));

console.log("Unpacking…");
execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${work}' -Force`], { stdio: "inherit" });
const folder = readdirSync(work).find((n) => n.startsWith("ffmpeg-") && !n.endsWith(".zip"));
if (!folder) {
  console.error("Could not find the unpacked FFmpeg folder.");
  process.exit(1);
}
for (const name of ["ffmpeg.exe", "ffprobe.exe"]) copyFileSync(join(work, folder, "bin", name), join(bin, name));
rmSync(work, { recursive: true, force: true });
console.log("Done. ffmpeg.exe and ffprobe.exe are in src-tauri\bin.");
