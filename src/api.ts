// The only file that talks to the Rust backend. Types mirror the Rust structs.

import { convertFileSrc, invoke as rawInvoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

/**
 * Call a backend command. If the page loads a moment before the backend has
 * finished starting, the call is retried for a few seconds instead of failing.
 */
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rawInvoke<T>(command, args);
    } catch (e) {
      const starting = typeof e === "string" && e.includes("state not managed");
      if (!starting || attempt >= 50) throw e;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export interface ToolStatus {
  ffmpegPath: string;
  ffprobePath: string;
  version: string;
}

export interface Settings {
  sourceDir: string | null;
  scanning: boolean;
  sortByGame: boolean;
}

export type ClipStatus = "pending" | "ready" | "missing";

export interface Clip {
  id: number;
  path: string;
  fileName: string;
  title: string;
  sizeBytes: number;
  createdAtMs: number;
  durationMs: number;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  videoCodec: string;
  container: string;
  bitRate: number | null;
  audioTracks: number;
  thumbPath: string | null;
  status: ClipStatus;
  game: string | null;
  favorite: boolean;
  tags: string[];
  reviewed: boolean;
  notes: string;
}

export type SortKey = "date" | "name" | "duration" | "size";

export interface ClipQuery {
  sort: SortKey;
  ascending: boolean;
  search: string;
}

/** A subfolder of the clips folder that has clips in it. */
export interface Folder {
  path: string;
  name: string;
  clipCount: number;
  /** Up to four newest clip thumbnails, newest first. */
  thumbs: string[];
}

export interface AudioInfo {
  title: string | null;
  codec: string;
  channels: number | null;
  sampleRate: number | null;
}

/** Freshly probed details for one clip. */
export interface ClipInfo {
  path: string;
  container: string;
  video: { codec: string; profile: string | null; pixFmt: string | null };
  audio: AudioInfo[];
}

export interface ScanProgress {
  done: number;
  total: number;
}

export interface ScanSummary {
  found: number;
  indexed: number;
  missing: number;
  failed: { path: string; reason: string }[];
}

export interface ScanFinished {
  summary: ScanSummary | null;
  error: string | null;
}

export const checkTools = () => invoke<ToolStatus>("check_tools");
export const getSettings = () => invoke<Settings>("get_settings");
export const setSourceDir = (path: string) => invoke<void>("set_source_dir", { path });
export const setSortByGame = (enabled: boolean) => invoke<void>("set_sort_by_game", { enabled });
export const startScan = () => invoke<void>("start_scan");
/** Clips directly inside `folder`, or everything beneath it when `recursive`. */
export const listClips = (query: ClipQuery, folder: string | null, recursive: boolean) =>
  invoke<Clip[]>("list_clips", { query: { ...query, folder, recursive } });
export const listFolders = (parent: string) => invoke<Folder[]>("list_folders", { parent });
export const renameClip = (id: number, title: string) => invoke<Clip>("rename_clip", { id, title });
export const setClipGame = (id: number, game: string | null) => invoke<Clip>("set_clip_game", { id, game });
export const revealInFolder = (path: string) => invoke<void>("reveal_in_folder", { path });
export const setFavorite = (id: number, favorite: boolean) => invoke<Clip>("set_favorite", { id, favorite });
export interface AudioLevels {
  fps: number;
  bands: number;
  /** `bands` values from 0 to 255 for each row, row after row. */
  data: number[];
}
export const clipAudioLevels = (id: number) => invoke<AudioLevels>("clip_audio_levels", { id });
export const deleteClips = (ids: number[], permanent = false) =>
  invoke<number[]>("delete_clips", { ids, permanent });
export const setClipTags = (id: number, tags: string[]) => invoke<Clip>("set_clip_tags", { id, tags });
export interface TagInfo {
  name: string;
  color: string | null;
  clips: number;
}
export const listTagInfos = () => invoke<TagInfo[]>("list_tag_infos");
export const setTagColor = (name: string, color: string | null) => invoke<void>("set_tag_color", { name, color });
export const renameTag = (old: string, newName: string) => invoke<void>("rename_tag", { old, new: newName });
export const deleteTag = (name: string) => invoke<void>("delete_tag", { name });
export const listTags = () => invoke<string[]>("list_tags");
export interface Filmstrip {
  /** One picture per page, each holding `framesPerPage` tiny frames. */
  pagePaths: string[];
  columns: number;
  /** Rows in each page. */
  rows: number;
  frameWidth: number;
  frameHeight: number;
  /** Seconds between frames. */
  interval: number;
  frames: number;
  framesPerPage: number;
  pages: number;
}
export const clipFilmstrip = (id: number) => invoke<Filmstrip>("clip_filmstrip", { id });
export interface Shared {
  path: string;
  sizeBytes: number;
}
/** `audio` is "mix", "none", or the number of one track as text. */
export const shareClip = (id: number, start: number, end: number, limitMb: number, audio: string) =>
  invoke<Shared>("share_clip", { id, start, end, limitMb, audio });
export const markPendingDelete = (id: number, pending: boolean) =>
  invoke<void>("mark_pending_delete", { id, pending });
export const finishPendingDeletes = () => invoke<{ count: number; bytes: number }>("finish_pending_deletes");
export const setClipNotes = (id: number, notes: string) => invoke<Clip>("set_clip_notes", { id, notes });
export const copyClipFile = (id: number) => invoke<void>("copy_clip_file", { id });
export const copyClipFiles = (ids: number[]) => invoke<void>("copy_clip_files", { ids });

export interface Usage {
  name: string | null;
  clips: number;
  bytes: number;
}
export interface Storage {
  totalClips: number;
  totalBytes: number;
  byGame: Usage[];
  byMonth: Usage[];
  largest: Clip[];
  aged: { days: number; clips: number; bytes: number }[];
}
export const storageOverview = () => invoke<Storage>("storage_overview");

export interface GameSuggestion {
  game: string;
  /** "folder" or "name". */
  reason: string;
  clipIds: number[];
}
export const suggestGames = () => invoke<GameSuggestion[]>("suggest_games");
export const assignGames = (ids: number[], game: string) => invoke<number>("assign_games", { ids, game });
export const cleanupInfo = (olderThanDays: number | null = null) =>
  invoke<{ remaining: number; bytes: number }>("cleanup_info", { olderThanDays });
export const cleanupBatch = (count: number, olderThanDays: number | null = null) =>
  invoke<Clip[]>("cleanup_batch", { count, olderThanDays });
export const setReviewed = (id: number, reviewed: boolean) => invoke<Clip>("set_reviewed", { id, reviewed });
export const resetReviewed = () => invoke<void>("reset_reviewed");
export const clipKeyframes = (id: number) => invoke<number[]>("clip_keyframes", { id });
export const exportTrim = (id: number, start: number, end: number, precise: boolean, keepOriginal: boolean) =>
  invoke<Clip>("export_trim", { id, start, end, precise, keepOriginal });
export interface GameProgram {
  game: string;
  exe: string;
  iconPath: string | null;
}
export const listGamePrograms = () => invoke<GameProgram[]>("list_game_programs");
export const linkGameProgram = (game: string, path: string) => invoke<GameProgram[]>("link_game_program", { game, path });
export async function pickProgramFile(): Promise<string | null> {
  const picked = await open({ multiple: false, filters: [{ name: "Programs", extensions: ["exe"] }] });
  return typeof picked === "string" ? picked : null;
}
export const listGames = () => invoke<string[]>("list_games");
export const renameGame = (oldName: string, newName: string) =>
  invoke<number>("rename_game", { old: oldName, new: newName });
export const clipDetails = (id: number) => invoke<ClipInfo>("clip_details", { id });

export const onScanProgress = (handler: (p: ScanProgress) => void): Promise<UnlistenFn> =>
  listen<ScanProgress>("scan-progress", (e) => handler(e.payload));

export const onScanFinished = (handler: (f: ScanFinished) => void): Promise<UnlistenFn> =>
  listen<ScanFinished>("scan-finished", (e) => handler(e.payload));

// --- App preferences and popups ------------------------------------------------

export type PopupSize = "small" | "medium" | "large" | "xlarge";

export interface PopupOptions {
  durationMs: number;
  size: PopupSize;
  /** File names in the sounds folder, or "" for silent. */
  sound: string;
  soundReady: string;
  soundStopped: string;
  /** 0 to 100. */
  volume: number;
}

export interface AppPrefs {
  hotkey: string;
  popups: boolean;
  popupOptions: PopupOptions;
  /** File names of the sounds that can be chosen. */
  sounds: string[];
  /** The sounds used until a person picks others. */
  defaultSounds: PopupOptions;
  startWithWindows: boolean;
  startupSound: boolean;
}

export const getAppPrefs = () => invoke<AppPrefs>("get_app_prefs");
export const setHotkey = (hotkey: string) => invoke<void>("set_hotkey", { hotkey });
export const pauseHotkey = (paused: boolean) => invoke<void>("pause_hotkey", { paused });
export const setPopups = (enabled: boolean) => invoke<void>("set_popups", { enabled });
export const setPopupOptions = (options: PopupOptions) =>
  invoke<PopupOptions>("set_popup_options", { options });
export const openSoundsFolder = () => invoke<void>("open_sounds_folder");
export type SoundEvent = "saved" | "ready" | "stopped";
export const testPopup = (event: SoundEvent = "saved") => invoke<void>("test_popup", { event });
/** Convert an audio file (MP3 and others) into a sound ClipDeck can use. Resolves to its name. */
export const importSound = (path: string) => invoke<string>("import_sound", { path });
export async function pickAudioFile(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    filters: [{ name: "Audio", extensions: ["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus"] }],
  });
  return typeof picked === "string" ? picked : null;
}
export const setStartupSound = (enabled: boolean) => invoke<void>("set_startup_sound", { enabled });
export const setStartWithWindows = (enabled: boolean) =>
  invoke<void>("set_start_with_windows", { enabled });

export interface Toast {
  kind: "good" | "warning";
  /** What happened. Only a saved clip gets the lively animation. */
  event: "saved" | "ready" | "stopped";
  title: string;
  body: string;
  size: PopupSize;
  durationMs: number;
}

export const onToast = (handler: (toast: Toast) => void): Promise<UnlistenFn> =>
  listen<Toast>("toast", (e) => handler(e.payload));

// --- OBS ---------------------------------------------------------------------

export type ObsStatus =
  | { state: "disconnected"; reason: string }
  | { state: "connected"; replayBufferActive: boolean };

export interface ObsSettings {
  port: number;
  password: string;
  autostart: boolean;
}

export const getObsStatus = () => invoke<ObsStatus>("get_obs_status");
export const setReplayBuffer = (on: boolean) => invoke<void>("set_replay_buffer", { on });
export const getObsSettings = () => invoke<ObsSettings>("get_obs_settings");
export const setObsSettings = (settings: ObsSettings) =>
  invoke<void>("set_obs_settings", { settings });
export const launchObs = () => invoke<void>("launch_obs");

export const onObsStatus = (handler: (s: ObsStatus) => void): Promise<UnlistenFn> =>
  listen<ObsStatus>("obs-status", (e) => handler(e.payload));
export const onObsProblem = (handler: (message: string) => void): Promise<UnlistenFn> =>
  listen<string>("obs-problem", (e) => handler(e.payload));

/** A clip detected live by the folder watcher, or a file it gave up on. */
export type LiveEvent =
  | { kind: "added"; id: number; path: string; game: string | null }
  | { kind: "failed"; path: string; reason: string };

export const onLiveEvent = (handler: (e: LiveEvent) => void): Promise<UnlistenFn> =>
  listen<LiveEvent>("live-event", (e) => handler(e.payload));

/** The window was closed to the system tray. */
export const onWindowHidden = (handler: () => void): Promise<UnlistenFn> =>
  listen("window-hidden", handler);

/** Show the system folder picker. Resolves to null if the user cancels. */
export async function pickFolder(startIn?: string): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, defaultPath: startIn });
  return typeof picked === "string" ? picked : null;
}

/** Turn a local file path into a URL the webview is allowed to load. */
export function fileUrl(path: string): string {
  return convertFileSrc(path);
}

/** Tauri rejects with a plain string; normalise anything to a message. */
export function errorMessage(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

/** Every folder inside the clips folder. */
export const listDirs = () => invoke<string[]>("list_dirs");
/** Make a folder inside `parent`; resolves to its path. */
export const createFolder = (parent: string, name: string) => invoke<string>("create_folder", { parent, name });
/** Move clips into a folder, on the drive as well. Resolves to the ids that moved. */
export const moveClips = (ids: number[], dest: string) => invoke<number[]>("move_clips", { ids, dest });

/** One clip as it is now (for example after it was moved). */
export const getClip = (id: number) => invoke<Clip>("get_clip", { id });

/** What OBS is set to right now. */
export interface ObsSetup {
  mode: string;
  width: number;
  height: number;
  fps: number;
  replayBuffer: boolean;
  replaySeconds: number;
  format: string;
  folder: string;
}
export interface ObsSetupReport {
  changes: string[];
  notes: string[];
}
export const readObsSetup = () => invoke<ObsSetup>("read_obs_setup");
/** Give OBS good settings for clipping. */
export const applyObsSetup = (replaySeconds: number) => invoke<ObsSetupReport>("apply_obs_setup", { replaySeconds });
