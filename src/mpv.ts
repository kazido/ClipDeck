// Thin wrapper around the mpv plugin: one shared player for the whole app.
//
// mpv draws into the app window *behind* the web page. The page is transparent
// only where the video should show, and `setVideoArea` tells mpv where that is.

import {
  command,
  getProperty,
  init,
  observeProperties,
  setProperty,
  setVideoMarginRatio,
  type MpvObservableProperty,
} from "tauri-plugin-libmpv-api";

const OBSERVED = [
  ["pause", "flag"],
  ["time-pos", "double", "none"],
  ["duration", "double", "none"],
  ["volume", "double"],
  ["mute", "flag"],
  ["aid", "string", "none"],
  ["track-list", "node", "none"],
  ["eof-reached", "flag", "none"],
] as const satisfies MpvObservableProperty[];

export interface AudioTrack {
  id: number;
  title: string | null;
  codec: string | null;
  channels: number | null;
}

export interface PlayerState {
  paused: boolean;
  time: number;
  duration: number;
  volume: number;
  muted: boolean;
  /** Selected audio track id, or null when none or several are playing. */
  audioId: number | null;
  audioTracks: AudioTrack[];
  ended: boolean;
}

export const INITIAL_STATE: PlayerState = {
  paused: true,
  time: 0,
  duration: 0,
  volume: 100,
  muted: false,
  audioId: null,
  audioTracks: [],
  ended: false,
};

let starting: Promise<void> | null = null;

/**
 * Make sure mpv is running. Safe to call as often as needed: the plugin does
 * nothing if mpv is already there. This matters because the plugin destroys
 * mpv whenever the window's close button is pressed (ClipDeck only hides the
 * window then), so mpv has to be started again the next time it is needed.
 * Rejects if the mpv libraries are missing or fail to load.
 */
export function startMpv(): Promise<void> {
  starting ??= init({
    initialOptions: {
      vo: "gpu-next",
      hwdec: "auto-safe",
      "keep-open": "yes", // pause on the last frame instead of closing the file
      "force-window": "yes",
      idle: "yes",
      "hr-seek": "yes", // seek to the exact frame, not the nearest keyframe
      osc: "no",
      "input-default-bindings": "no",
    },
    observedProperties: OBSERVED,
  })
    .then(() => undefined)
    .finally(() => (starting = null));
  return starting;
}

/** True when mpv is running but has no file open (for example, it was just restarted). */
export async function isIdle(): Promise<boolean> {
  return (await getProperty("idle-active", "flag")) === true;
}

/**
 * Subscribe to player changes. Resolves, once listening, to a function that
 * unsubscribes.
 *
 * mpv only reports a value when it changes, and it sent the starting values
 * before anyone was listening, so the current ones are fetched here too.
 */
export async function watchPlayer(
  onChange: (patch: Partial<PlayerState>) => void,
): Promise<() => void> {
  const unlisten = await observeProperties(OBSERVED, (event) => {
    switch (event.name) {
      case "pause":
        return onChange({ paused: event.data });
      case "time-pos":
        return event.data === null ? undefined : onChange({ time: event.data });
      case "duration":
        return onChange({ duration: event.data ?? 0 });
      case "volume":
        return onChange({ volume: event.data });
      case "mute":
        return onChange({ muted: event.data });
      case "aid":
        return onChange({ audioId: parseTrackId(event.data) });
      case "track-list":
        return onChange({ audioTracks: parseAudioTracks(event.data) });
      case "eof-reached":
        return onChange({ ended: event.data === true });
    }
  });

  const [paused, volume, muted] = await Promise.all([
    getProperty("pause", "flag"),
    getProperty("volume", "double"),
    getProperty("mute", "flag"),
  ]);
  onChange({
    paused: paused ?? false,
    volume: volume ?? 100,
    muted: muted ?? false,
  });

  return unlisten;
}

function parseTrackId(value: string | null): number | null {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function parseAudioTracks(node: unknown): AudioTrack[] {
  if (!Array.isArray(node)) return [];
  return node
    .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
    .filter((t) => t.type === "audio" && typeof t.id === "number")
    .map((t) => ({
      id: t.id as number,
      title: typeof t.title === "string" && t.title ? t.title : null,
      codec: typeof t.codec === "string" ? t.codec : null,
      channels: typeof t["demux-channel-count"] === "number" ? (t["demux-channel-count"] as number) : null,
    }));
}

export async function loadFile(path: string): Promise<void> {
  await setProperty("lavfi-complex", ""); // undo any "all tracks" mix from the last clip
  await command("loadfile", [path]);
  await setProperty("pause", false);
}

export const stop = () => command("stop");
export const setPaused = (paused: boolean) => setProperty("pause", paused);
/** Flip play/pause inside mpv itself, so it can never disagree with our copy of the state. */
export const togglePause = () => command("cycle", ["pause"]);
/**
 * Jump to a time. `fast` lands on the nearest keyframe instead of the exact
 * frame, which is much quicker and good enough while the pointer is moving.
 */
export const seekTo = (seconds: number, fast = false) =>
  command("seek", [seconds, fast ? "absolute+keyframes" : "absolute+exact"]);
export const seekBy = (seconds: number) => command("seek", [seconds, "relative"]);
export const seekToPercent = (percent: number) => command("seek", [percent, "absolute-percent"]);
export const stepFrame = (direction: 1 | -1) =>
  command(direction === 1 ? "frame-step" : "frame-back-step");
export const setVolume = (volume: number) => setProperty("volume", volume);
export const setMuted = (muted: boolean) => setProperty("mute", muted);

// Audio routing. mpv's plain track switch (`aid`) is refused in this embedded
// setup ("error accessing property"), so both cases go through mpv's audio
// filter graph instead, which names the tracks to play explicitly.

/** Play a single audio track. */
export function selectAudioTrack(id: number): Promise<void> {
  return setAudioGraph(`[aid${id}]anull[ao]`);
}

/** Play every audio track at once, mixed together. */
export function mixAllAudioTracks(tracks: AudioTrack[]): Promise<void> {
  const inputs = tracks.map((t) => `[aid${t.id}]`).join("");
  return setAudioGraph(`${inputs}amix=inputs=${tracks.length}:normalize=0[ao]`);
}

/**
 * Replace the audio graph. Going straight from one graph to another that
 * reuses a track leaves mpv silent, so the old graph is always cleared first
 * and mpv is given a moment to release its tracks.
 */
async function setAudioGraph(graph: string): Promise<void> {
  await setProperty("lavfi-complex", "");
  await new Promise((resolve) => setTimeout(resolve, 80));
  await setProperty("lavfi-complex", graph);
}

/** Tell mpv which part of the window the video may occupy. */
export function setVideoArea(rect: DOMRect): Promise<void> {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const ratio = (v: number) => Math.min(Math.max(v, 0), 1);
  return setVideoMarginRatio({
    left: ratio(rect.left / w),
    right: ratio((w - rect.right) / w),
    top: ratio(rect.top / h),
    bottom: ratio((h - rect.bottom) / h),
  });
}
