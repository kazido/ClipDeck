// Makes the sounds that ship with ClipDeck match the sounds folder you have been working in.
//
// Run:  npm run sync-sounds
// Then start the app again (or build it) so the new set is baked in.
//
// Every .wav in the app's sounds folder is copied into crates/clipdeck-core/assets/sounds, and
// files there that are no longer in your folder are removed. The two sounds ClipDeck makes by
// itself (Chime, Pop) are skipped, because they come from code.

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const appData = process.env.APPDATA;
if (!appData) {
  console.error("This only works on Windows (APPDATA is not set).");
  process.exit(1);
}
const from = join(appData, "com.bryson.clipdeck", "sounds");
const to = join(process.cwd(), "crates", "clipdeck-core", "assets", "sounds");
const generated = new Set(["chime.wav", "pop.wav"]);

if (!existsSync(from)) {
  console.error(`Could not find ${from}`);
  process.exit(1);
}
mkdirSync(to, { recursive: true });

const wavs = (dir) => readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".wav"));
const mine = wavs(from).filter((n) => !generated.has(n.toLowerCase()));
const shipped = wavs(to);

for (const name of shipped) {
  if (!mine.includes(name)) {
    rmSync(join(to, name));
    console.log(`removed  ${name}`);
  }
}
for (const name of mine) {
  copyFileSync(join(from, name), join(to, name));
  console.log(`${shipped.includes(name) ? "updated " : "added   "} ${name}`);
}
console.log(`\n${mine.length} sound(s) will ship with the app.`);
