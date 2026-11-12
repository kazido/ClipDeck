import { useEffect, useState } from "react";
import { UI_SCALES } from "./useUiScale";
import { FONTS, THEMES, THEME_GROUPS, type FxQuality, type ThemeName } from "./useTheme";
import { assignGames, pickProgramFile, suggestGames, type GameSuggestion } from "./api";
import { useGameIcons } from "./GameIcons";
import {
  errorMessage,
  getAppPrefs,
  getObsSettings,
  listGames,
  renameGame,
  importSound,
  openSoundsFolder,
  pickAudioFile,
  type SoundEvent,
  pauseHotkey,
  setHotkey,
  setObsSettings,
  setPopupOptions,
  setPopups,
  setStartWithWindows,
  setStartupSound,
  testPopup,
  type AppPrefs,
  type ObsSettings,
  type PopupOptions,
  type PopupSize,
} from "./api";
import type { ScanSummary, Settings, ToolStatus } from "./api";

interface Props {
  settings: Settings | null;
  tools: ToolStatus | null;
  toolError: string | null;
  lastScan: ScanSummary | null;
  scanning: boolean;
  onChooseFolder: () => void;
  onRescan: () => void;
  onSortByGameChange: (enabled: boolean) => void;
  onGamesChanged: () => void;
  page: SettingsPage;
  font: string;
  onFontChange: (key: string) => void;
  motion: boolean;
  onMotionChange: (on: boolean) => void;
  fxQuality: FxQuality;
  onFxQualityChange: (q: FxQuality) => void;
  theme: ThemeName;
  onThemeChange: (theme: ThemeName) => void;
  uiScale: number;
  onUiScaleChange: (scale: number) => void;
  layout: "folders" | "all";
  onLayoutChange: (layout: "folders" | "all") => void;
}

export type SettingsPage = "recording" | "app" | "games";
export const SETTINGS_PAGES: { key: SettingsPage; label: string }[] = [
  { key: "recording", label: "Recording" },
  { key: "app", label: "App" },
  { key: "games", label: "Games" },
];

const PAGE_SUBTITLES: Record<SettingsPage, string> = {
  recording: "Your clips folder, how new clips are handled, and how ClipDeck talks to OBS.",
  app: "How ClipDeck behaves, and how it looks.",
  games: "Give a game to clips that don't have one, and rename games.",
};

export function SettingsView(props: Props) {
  const { settings, tools, toolError, lastScan, scanning } = props;
  return (
    <div className="settings">
      <h1>{SETTINGS_PAGES.find((p) => p.key === props.page)?.label}</h1>
      <p className="page-sub">{PAGE_SUBTITLES[props.page]}</p>

      <section hidden={props.page !== "recording"}>
        <Heading>Clips</Heading>

        <div className="group-label" data-hint="The folder OBS saves replays to. Subfolders are included.">
          Clips folder
        </div>
        <div className="setting-row">
          <code>{settings?.sourceDir ?? "Not set"}</code>
          <button data-hint="Pick a different folder. Nothing is moved or deleted." onClick={props.onChooseFolder}>
            Change…
          </button>
          <button
            data-hint="Look through the folder again for clips that were added, changed or removed."
            onClick={props.onRescan}
            disabled={scanning || !settings?.sourceDir}
          >
            {scanning ? "Scanning…" : "Rescan"}
          </button>
        </div>
        {lastScan && (
          <p className="muted">
            Last scan: {lastScan.found} video files found, {lastScan.indexed} newly indexed,{" "}
            {lastScan.missing} missing, {lastScan.failed.length} unreadable.
          </p>
        )}
        {lastScan && lastScan.failed.length > 0 && (
          <ul className="failed">
            {lastScan.failed.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code>
                <span className="muted"> {f.reason}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="group-label" data-hint="While ClipDeck is running (including in the system tray), clips OBS saves appear in the library automatically.">
          New clips
        </div>
        <label
          className="check"
          data-hint="Moves each new clip into a folder named after the game you were playing, and puts the game in its name."
        >
          <input
            type="checkbox"
            checked={settings?.sortByGame ?? true}
            onChange={(e) => props.onSortByGameChange(e.target.checked)}
          />
          <span>Sort new clips by game</span>
        </label>

        <div className="group-label" data-hint="The tool ClipDeck uses to read clips and make thumbnails.">
          Video tools
        </div>
        {tools && (
          <>
            <p className="good">{tools.version.split(" Copyright")[0]}</p>
            <p className="muted">
              <code>{tools.ffmpegPath}</code>
            </p>
          </>
        )}
        {toolError && <p className="bad">{toolError}</p>}
      </section>

      <section hidden={props.page !== "recording"}>
        <Heading hint={'ClipDeck talks to OBS through its WebSocket server. Turn it on once in OBS under Tools > WebSocket Server Settings, and copy the password from "Show Connect Info".'}>
          OBS
        </Heading>
        <ObsSettingsForm />
      </section>

      <section hidden={props.page !== "app"}>
        <Heading>General</Heading>
        <AppPrefsForm />
      </section>

      <section hidden={props.page !== "app"}>
        <Heading>Display</Heading>

        <div className="setting-line">
          <div className="line-text">
            <strong>Theme</strong>
            <span className="muted small">Colors for the whole app. Premium themes also have a special effect.</span>
          </div>
          <select value={props.theme} onChange={(e) => props.onThemeChange(e.target.value as ThemeName)}>
            {THEME_GROUPS.map((group) => (
              <optgroup key={group} label={group}>
                {THEMES.filter((t) => t.group === group).map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="setting-line">
          <div className="line-text">
            <strong>Font</strong>
            <span className="muted small">Use one font everywhere, or let each theme pick its own look for headings.</span>
          </div>
          <select value={props.font} onChange={(e) => props.onFontChange(e.target.value)}>
            {FONTS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </div>

        <div className="setting-line">
          <div className="line-text">
            <strong>Animations</strong>
            <span className="muted small">Fades, slides and hover shines. Turn off to keep everything still.</span>
          </div>
          <label className="switch">
            <input type="checkbox" checked={props.motion} onChange={(e) => props.onMotionChange(e.target.checked)} />
            <span>{props.motion ? "On" : "Off"}</span>
          </label>
        </div>

        <div className="setting-line">
          <div className="line-text">
            <strong data-hint="Premium themes draw a live effect behind the app. High is the smoothest and adds extra large, soft particles (drifting ash, mist, glowing orbs, big petals). Balanced keeps the standard particles at 30 fps. Light skips the particles and shows only soft moving colors, the easiest on your graphics card. Any of them drops to 30 fps while ClipDeck is in the background, and ClipDeck lowers the setting by itself if your computer struggles.">Effect quality</strong>
            <span className="muted small">For the premium themes' moving backgrounds.</span>
          </div>
          <select value={props.fxQuality} onChange={(e) => props.onFxQualityChange(e.target.value as FxQuality)}>
            <option value="high">High (60 fps, extra particles)</option>
            <option value="balanced">Balanced (30 fps, standard particles)</option>
            <option value="light">Light (soft gradients only)</option>
          </select>
        </div>

        <div className="setting-line">
          <div className="line-text">
            <strong>Interface size</strong>
            <span className="muted small">Or press Ctrl and + or -, or hold Ctrl and use the mouse wheel. Ctrl and 0 resets.</span>
          </div>
          <select value={props.uiScale} onChange={(e) => props.onUiScaleChange(Number(e.target.value))}>
            {UI_SCALES.map((v) => (
              <option key={v} value={v}>
                {Math.round(v * 100)}%{v === 1 ? " (normal)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="setting-line">
          <div className="line-text">
            <strong>Library view</strong>
            <span className="muted small">Folders matches your drive. All clips shows everything together.</span>
          </div>
          <select value={props.layout} onChange={(e) => props.onLayoutChange(e.target.value as "folders" | "all")}>
            <option value="folders">Folders, as on the drive</option>
            <option value="all">All clips together</option>
          </select>
        </div>
      </section>

      <section hidden={props.page !== "games"}>
        <Heading>Games</Heading>
        <div className="group-label" data-hint="Looks at clips that have no game. A clip whose file name starts with a game you already use gets that game; otherwise a clip inside a game's folder gets that folder's name. You choose what to apply.">
          Find games for clips
        </div>
        <AutoGames onChanged={props.onGamesChanged} />
        <div className="group-label" data-hint="Rename a game on all its clips. Future clips from the same program use the new name. Files are not renamed or moved.">
          Rename games
        </div>
        <GamesList onChanged={props.onGamesChanged} />
      </section>
    </div>
  );
}

function AutoGames({ onChanged }: { onChanged: () => void }) {
  const [found, setFound] = useState<GameSuggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function look() {
    setBusy(true);
    setProblem(null);
    setMessage(null);
    try {
      setFound(await suggestGames());
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function apply(items: GameSuggestion[]) {
    setBusy(true);
    setProblem(null);
    try {
      let n = 0;
      for (const item of items) n += await assignGames(item.clipIds, item.game);
      setMessage(`Gave a game to ${n} clip${n === 1 ? "" : "s"}.`);
      setFound((f) => (f ? f.filter((g) => !items.includes(g)) : f));
      onChanged();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="setting-row">
        <button onClick={look} disabled={busy}>
          {busy ? "Looking…" : found ? "Look again" : "Look for clips without a game"}
        </button>
        {found && found.length > 1 && (
          <button className="primary" onClick={() => apply(found)} disabled={busy}>
            Apply all
          </button>
        )}
      </div>
      {found && found.length === 0 && <p className="muted">Nothing to suggest. Every clip either has a game or gives no clue.</p>}
      {found?.map((g) => (
        <div className="setting-row" key={g.game}>
          <span>
            <strong>{g.game}</strong> <span className="muted">{g.clipIds.length} clip{g.clipIds.length === 1 ? "" : "s"}, from the {g.reason === "folder" ? "folder they're in" : "start of their file names"}</span>
          </span>
          <span className="spacer" />
          <button onClick={() => apply([g])} disabled={busy}>
            Apply
          </button>
        </div>
      ))}
      {message && <p className="good">{message}</p>}
      {problem && <p className="bad">{problem}</p>}
    </div>
  );
}

function GamesList({ onChanged }: { onChanged: () => void }) {
  const [games, setGames] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const icons = useGameIcons();

  const load = () => listGames().then(setGames).catch((e) => setProblem(errorMessage(e)));
  useEffect(() => {
    load();
  }, []);

  async function save(old: string) {
    try {
      if (name.trim() && name.trim() !== old) {
        await renameGame(old, name.trim());
        onChanged();
      }
      setEditing(null);
      load();
      icons.reload();
    } catch (e) {
      setProblem(errorMessage(e));
    }
  }

  if (games.length === 0) return <p className="muted">No clips have a game yet.</p>;
  return (
    <div className="games-list">
      {games.map((game) =>
        editing === game ? (
          <div className="setting-row" key={game}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save(game)}
              aria-label={`New name for ${game}`}
              autoFocus
            />
            <button onClick={() => save(game)}>Save</button>
            <button onClick={() => setEditing(null)}>Cancel</button>
          </div>
        ) : (
          <div className="setting-row game-row" key={game}>
            {icons.icon(game) ? (
              <img className="game-icon" src={icons.icon(game)} alt="" />
            ) : (
              <span className="game-icon placeholder" aria-hidden>
                {game.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="game-name">
              {game}
              {icons.program(game) && <span className="muted small"> {icons.program(game)}</span>}
            </span>
            <span className="spacer" />
            <button
              data-hint="Pick the game's program (.exe). ClipDeck then shows its icon, and clips made while it is in front are sorted into this game."
              onClick={async () => {
                try {
                  const file = await pickProgramFile();
                  if (file) await icons.link(game, file);
                } catch (e) {
                  setProblem(errorMessage(e));
                }
              }}
            >
              Link program…
            </button>
            <button
              onClick={() => {
                setEditing(game);
                setName(game);
              }}
            >
              Rename
            </button>
          </div>
        ),
      )}
      {problem && <p className="bad">{problem}</p>}
    </div>
  );
}

function ObsSettingsForm() {
  const [saved, setSaved] = useState<ObsSettings | null>(null);
  const [draft, setDraft] = useState<ObsSettings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    getObsSettings()
      .then((s) => {
        setSaved(s);
        setDraft(s);
      })
      .catch((e) => setProblem(String(e)));
  }, []);

  if (!draft || !saved) return problem ? <p className="bad">{problem}</p> : null;

  const validPort = Number.isInteger(draft.port) && draft.port >= 1 && draft.port <= 65535;
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);

  function save(next: ObsSettings) {
    setProblem(null);
    setObsSettings(next)
      .then(() => setSaved(next))
      .catch((e) => setProblem(String(e)));
  }

  return (
    <>
      <div className="setting-row">
        <label data-hint="The port shown in OBS's WebSocket Server Settings. 4455 unless you changed it.">
          Port{" "}
          <input
            className="narrow"
            inputMode="numeric"
            value={draft.port || ""}
            onChange={(e) => setDraft({ ...draft, port: Number(e.target.value.replace(/\D/g, "")) })}
          />
        </label>
        <label data-hint={'The server password from "Show Connect Info" in OBS. Leave empty if authentication is off.'}>
          Password{" "}
          <input
            type="password"
            value={draft.password}
            onChange={(e) => setDraft({ ...draft, password: e.target.value })}
            placeholder="Leave empty if OBS has none"
          />
        </label>
        <button onClick={() => save(draft)} disabled={!changed || !validPort}>
          Save and connect
        </button>
      </div>
      <label
        className="check"
        data-hint="When ClipDeck starts, opens OBS in the background if it isn't running and turns the replay buffer on."
      >
        <input
          type="checkbox"
          checked={draft.autostart}
          onChange={(e) => {
            // Applies immediately; it does not need the Save button.
            const next = { ...saved, autostart: e.target.checked };
            setDraft({ ...draft, autostart: e.target.checked });
            save(next);
          }}
        />
        <span>Keep OBS ready</span>
      </label>
      {problem && <p className="bad">{problem}</p>}
    </>
  );
}

const SOUND_SLOTS: { key: "sound" | "soundReady" | "soundStopped"; label: string; event: SoundEvent; hint: string }[] = [
  { key: "sound", label: "Clip saved", event: "saved", hint: "Played when a clip is saved. It plays even when a fullscreen game hides the popup." },
  { key: "soundReady", label: "Ready to clip", event: "ready", hint: "Played when the replay buffer starts, so you know OBS is ready." },
  { key: "soundStopped", label: "Not recording", event: "stopped", hint: "Played when the replay buffer stops or OBS closes, so you know clips won't be saved." },
];

function AppPrefsForm() {
  const [prefs, setPrefs] = useState<AppPrefs | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    getAppPrefs()
      .then(setPrefs)
      .catch((e) => setProblem(errorMessage(e)));
  }, []);

  if (!prefs) return problem ? <p className="bad">{problem}</p> : null;

  // Apply a change, and only show it as applied once the app has accepted it.
  function change(action: Promise<void>, applied: Partial<AppPrefs>) {
    setProblem(null);
    action
      .then(() => setPrefs((p) => p && { ...p, ...applied }))
      .catch((e) => setProblem(errorMessage(e)));
  }

  // Popup options save as soon as they are changed.
  function changePopup(patch: Partial<PopupOptions>) {
    if (!prefs) return;
    setProblem(null);
    setPopupOptions({ ...prefs.popupOptions, ...patch })
      .then((saved) => setPrefs((p) => p && { ...p, popupOptions: saved }))
      .catch((e) => setProblem(errorMessage(e)));
  }

  return (
    <>
      <div className="setting-row">
        <span
          className="muted"
          data-hint="Shows or hides ClipDeck from anywhere. Click the button, then press the keys you want, such as Alt+Z. Escape cancels; Backspace removes the hotkey."
        >
          Show / hide hotkey
        </span>
        <HotkeyRecorder
          hotkey={prefs.hotkey}
          onChange={(hotkey) => change(setHotkey(hotkey), { hotkey })}
          onProblem={setProblem}
        />
      </div>

      <label
        className="check"
        data-hint="A small note in the top right of the screen when a clip is saved, or recording starts or stops."
      >
        <input
          type="checkbox"
          checked={prefs.popups}
          onChange={(e) => change(setPopups(e.target.checked), { popups: e.target.checked })}
        />
        <span>Show popups</span>
      </label>
      <div className="option-group">
        <div className="setting-row">
          <label data-hint="How long each popup stays on screen, from 0.5 to 15 seconds.">
            Stay for{" "}
            <NumberBox
              value={prefs.popupOptions.durationMs / 1000}
              min={0.5}
              max={15}
              step={0.5}
              onCommit={(seconds) => changePopup({ durationMs: Math.round(seconds * 1000) })}
            />
            <span className="unit">seconds</span>
          </label>
          <label data-hint="How big the popup is.">
            Size{" "}
            <select
              value={prefs.popupOptions.size}
              onChange={(e) => changePopup({ size: e.target.value as PopupSize })}
            >
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
              <option value="xlarge">Extra large</option>
            </select>
          </label>
        </div>

        {SOUND_SLOTS.map(({ key, label, event, hint }) => (
          <div className="setting-row" key={key}>
            <label data-hint={hint}>
              {label}{" "}
              <select value={prefs.popupOptions[key]} onChange={(e) => changePopup({ [key]: e.target.value })}>
                <option value="">None</option>
                {prefs.sounds.map((name) => (
                  <option key={name} value={name}>
                    {name.replace(/\.wav$/i, "").replace(/_+$/, "")}
                    {prefs.defaultSounds[key] === name ? "  (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="frame-btn"
              data-hint="Plays this sound with a sample popup."
              aria-label={`Test the ${label} sound`}
              onClick={() => testPopup(event).catch((e) => setProblem(errorMessage(e)))}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7 4v16l13-8z" />
              </svg>
            </button>
          </div>
        ))}

        <div className="setting-row">
          <label data-hint="How loud the popup sounds are.">
            Volume{" "}
            <VolumeSlider
              value={prefs.popupOptions.volume}
              disabled={SOUND_SLOTS.every(({ key }) => prefs.popupOptions[key] === "")}
              onCommit={(volume) => changePopup({ volume })}
            />
          </label>
          <button
            data-hint="Pick an audio file (MP3, WAV, OGG and more). It is converted and added to the list, keeping the first 8 seconds."
            onClick={async () => {
              try {
                const file = await pickAudioFile();
                if (!file) return;
                await importSound(file);
                setPrefs(await getAppPrefs());
              } catch (e) {
                setProblem(errorMessage(e));
              }
            }}
          >
            Add sound…
          </button>
          <button
            data-hint="Opens the folder of sound files. Any .wav you put there can be chosen too."
            onClick={() => openSoundsFolder().catch((e) => setProblem(errorMessage(e)))}
          >
            Sounds folder
          </button>
        </div>
      </div>

      <label
        className="check"
        data-hint="Opens ClipDeck hidden in the system tray when you sign in. Only works from an installed copy, not the development build."
      >
        <input
          type="checkbox"
          checked={prefs.startWithWindows}
          onChange={(e) =>
            change(setStartWithWindows(e.target.checked), { startWithWindows: e.target.checked })
          }
        />
        <span>Start with Windows</span>
      </label>
      <label className="check" data-hint="Plays a short sound as ClipDeck opens, while the window fades in. It uses the popup volume.">
        <input
          type="checkbox"
          checked={prefs.startupSound}
          onChange={(e) => change(setStartupSound(e.target.checked), { startupSound: e.target.checked })}
        />
        <span>Play a sound when ClipDeck opens</span>
      </label>
      {problem && <p className="bad">{problem}</p>}
    </>
  );
}

/** A section title. Hover it (or its "?" mark) to read what the section is for. */
function Heading({ hint, children }: { hint?: string; children: React.ReactNode }) {
  return (
    <h2 data-hint={hint}>
      {children}
      {hint && <span className="hint-mark">?</span>}
    </h2>
  );
}

/** A number field that saves when you press Enter or click away, kept within its limits. */
function NumberBox(props: {
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(props.value)), [props.value]);

  function commit() {
    const typed = Number(text);
    if (text.trim() === "" || Number.isNaN(typed)) return setText(String(props.value));
    const value = Math.min(Math.max(typed, props.min), props.max);
    setText(String(value));
    if (value !== props.value) props.onCommit(value);
  }

  return (
    <input
      className="tiny"
      type="number"
      min={props.min}
      max={props.max}
      step={props.step}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

/** A 0-100 slider that saves when you let go, not on every step of the drag. */
function VolumeSlider(props: { value: number; disabled: boolean; onCommit: (value: number) => void }) {
  const [value, setValue] = useState(props.value);
  useEffect(() => setValue(props.value), [props.value]);
  const commit = () => value !== props.value && props.onCommit(value);

  return (
    <>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        disabled={props.disabled}
        onChange={(e) => setValue(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="unit">{value}%</span>
    </>
  );
}

const MODIFIER_KEYS = ["Control", "Alt", "Shift", "Meta"];

/** "Alt+KeyZ" -> "Alt + Z" for display. */
function prettyHotkey(hotkey: string): string {
  if (!hotkey) return "None";
  return hotkey
    .split("+")
    .map((part) => part.replace(/^Key|^Digit/, "").replace(/^Arrow/, "").replace("Super", "Win"))
    .join(" + ");
}

/**
 * A button that listens for a key combination, like the keybind boxes in
 * Discord. Needs at least one of Ctrl, Alt, Shift or Win plus another key
 * (function keys are fine by themselves).
 */
function HotkeyRecorder(props: {
  hotkey: string;
  onChange: (hotkey: string) => void;
  onProblem: (message: string | null) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState("");

  useEffect(() => {
    if (!recording) return;
    // The current hotkey is switched off while recording, so pressing it
    // again is recorded instead of hiding the window.
    pauseHotkey(true).catch(() => {});
    const stop = () => {
      setRecording(false);
      setHeld("");
    };

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const mods = [
        e.ctrlKey && "Ctrl",
        e.altKey && "Alt",
        e.shiftKey && "Shift",
        e.metaKey && "Super",
      ].filter(Boolean) as string[];

      if (MODIFIER_KEYS.includes(e.key)) return setHeld(mods.join(" + "));
      if (e.key === "Escape" && mods.length === 0) return stop();
      if ((e.key === "Backspace" || e.key === "Delete") && mods.length === 0) {
        props.onChange("");
        return stop();
      }
      const functionKey = /^F\d{1,2}$/.test(e.code);
      if (mods.length === 0 && !functionKey) {
        props.onProblem("Hold Ctrl, Alt, Shift or Win together with another key.");
        return;
      }
      props.onProblem(null);
      // e.code names the physical key ("KeyZ"), which is what the app's hotkey system expects.
      props.onChange([...mods, e.code].join("+"));
      stop();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", stop);
      pauseHotkey(false).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  return (
    <button
      className={recording ? "hotkey recording" : "hotkey"}
      onClick={() => setRecording((r) => !r)}
    >
      {recording ? (held ? `${held} + …` : "Press keys…") : prettyHotkey(props.hotkey)}
    </button>
  );
}
