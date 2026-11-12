import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkTools,
  errorMessage,
  getSettings,
  listClips,
  listFolders,
  onLiveEvent,
  onScanFinished,
  onScanProgress,
  onWindowHidden,
  pickFolder,
  setSortByGame,
  setSourceDir,
  startScan,
  type Clip,
  type ClipQuery,
  type Folder,
  type ScanProgress,
  type ScanSummary,
  type Settings,
  type ToolStatus,
} from "./api";
import { Library } from "./Library";
import { ObsStatusPanel } from "./ObsStatusPanel";
import { ClipPreview } from "./Player";
import { DEFAULT_FILTERS, type Filters } from "./Library";
import { MenuProvider } from "./ContextMenu";
import { GameIconProvider } from "./GameIcons";
import { TagColorProvider } from "./TagColors";
import { NoticeProvider } from "./Notice";
import { StorageView } from "./StorageView";
import { CleanupView } from "./CleanupView";
import { PlayerView } from "./PlayerView";
import { TitleBar } from "./TitleBar";
import { useUiScale } from "./useUiScale";
import { useFont, useFxQuality, useMotion, useTheme } from "./useTheme";
import { GuideView } from "./GuideView";
import { Tour } from "./Tour";
import { ThemeFX } from "./ThemeFX";
import { SettingsView, SETTINGS_PAGES, type SettingsPage } from "./SettingsView";
import { HOME, useNavigation } from "./navigation";

/** How often the grid refreshes while a scan is adding clips. */
const REFRESH_DURING_SCAN_MS = 800;

export default function App() {
  const { place, go, up, reset } = useNavigation();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [toolError, setToolError] = useState<string | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [query, setQuery] = useState<ClipQuery>({ sort: "date", ascending: false, search: "" });
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [lastScan, setLastScan] = useState<ScanSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set when the mpv player failed to start; the basic player is used instead.
  const [mpvProblem, setMpvProblem] = useState<string | null>(null);

  // Library view preferences, remembered between runs.
  function usePref<T>(key: string, fallback: T): [T, (v: T) => void] {
    const [value, setValue] = useState<T>(() => {
      try {
        const stored = localStorage.getItem(key);
        return stored === null ? fallback : { ...fallback, ...JSON.parse(stored) };
      } catch {
        return fallback;
      }
    });
    return [
      value,
      (v: T) => {
        setValue(v);
        try {
          localStorage.setItem(key, JSON.stringify(v));
        } catch {
          /* not saved */
        }
      },
    ];
  }
  const [layoutPref, setLayoutPref] = usePref<{ v: "folders" | "all" }>("layout2", { v: "folders" });
  const layout = layoutPref.v;
  const setLayout = (v: "folders" | "all") => setLayoutPref({ v });
  const [filters, setFilters] = usePref<Filters>("filters2", DEFAULT_FILTERS);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("recording");
  const [uiScale, setUiScale] = useUiScale();
  const [theme, setTheme] = useTheme();
  const [motion, setMotion] = useMotion();
  const [fxQuality, setFxQuality] = useFxQuality();
  const [font, setFont] = useFont();
  const [cleanupPlaying, setCleanupPlaying] = useState(false);
  const shownOrder = useRef<Clip[]>([]);
  const updateClip = (updated: Clip) => {
    seenClips.current.set(updated.id, updated);
    setClips((all) => all.map((c) => (c.id === updated.id ? updated : c)));
  };

  // The clip before or after the open one, in the order the library shows them.
  const neighbour = (step: number) => {
    const list = shownOrder.current;
    const at = openClip ? list.findIndex((c) => c.id === openClip.id) : -1;
    const next = at >= 0 ? list[at + step] : undefined;
    return next ? () => showClip(next) : undefined;
  };

  const view = place.view;
  const rootDir = settings?.sourceDir ?? null;
  const currentDir = place.folder ?? rootDir;

  // History steps only carry a clip's id; this remembers the clips themselves.
  const seenClips = useRef(new Map<number, Clip>());
  const [tourOn, setTourOn] = useState(false);

  // The last clip watched, so the library can find it again when you come back.
  const lastViewed = useRef<number | null>(null);
  if (place.clipId !== null) lastViewed.current = place.clipId;
  const openClip = place.clipId !== null ? (seenClips.current.get(place.clipId) ?? null) : null;

  const showClip = (clip: Clip) => {
    seenClips.current.set(clip.id, clip);
    go({ ...place, clipId: clip.id });
  };

  // "Up one level": close the clip, leave the page, or go to the parent folder.
  const rootDirRef = useRef(rootDir);
  rootDirRef.current = rootDir;
  const goUp = useCallback(() => up(rootDirRef.current), [up]);

  // Escape goes up a level from anywhere, until the top of the library.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const focused = document.activeElement;
      // First press in a text box or menu just leaves it.
      if (focused instanceof HTMLInputElement || focused instanceof HTMLSelectElement) {
        focused.blur();
        return;
      }
      goUp();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goUp]);

  // Always fetch with the newest query and folder, and ignore out-of-date responses.
  const filtering = filters.games.length > 0 || filters.tags.length > 0 || filters.favoritesOnly;
  const wanted = { query, currentDir, layout, filtering };
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  const requestId = useRef(0);

  const refresh = useCallback(() => {
    const { query, currentDir, layout, filtering } = wantedRef.current;
    if (currentDir === null) return;
    const id = ++requestId.current;
    // Searching and filtering look through subfolders as well; browsing shows one folder at a time.
    const searching = query.search.trim() !== "";
    const all = layout === "all";
    Promise.all([listClips(query, currentDir, searching || filtering || all), all ? Promise.resolve([]) : listFolders(currentDir)])
      .then(([clips, folders]) => {
        if (id !== requestId.current) return;
        setClips(clips);
        setFolders(folders);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  // Tags renamed or deleted in the tag manager change what clips show.
  useEffect(() => {
    const onTags = () => refresh();
    window.addEventListener("tags-changed", onTags);
    return () => window.removeEventListener("tags-changed", onTags);
  }, [refresh]);

  // Startup: settings, FFmpeg check, first page of clips.
  useEffect(() => {
    getSettings()
      .then((s) => {
        setSettings(s);
        if (s.scanning) setProgress({ done: 0, total: 0 });
      })
      .catch((e) => setError(errorMessage(e)));
    checkTools()
      .then(setTools)
      .catch((e) => setToolError(errorMessage(e)));
  }, []);

  // Re-query shortly after the search box, sort, direction or folder changes.
  useEffect(() => {
    const timer = setTimeout(refresh, 150);
    return () => clearTimeout(timer);
  }, [query, currentDir, layout, filtering, refresh]);

  // The first time ClipDeck opens with a clips folder chosen, show the guide.
  useEffect(() => {
    if (!settings || settings.sourceDir === null) return;
    try {
      if (localStorage.getItem("guideSeen")) return;
      localStorage.setItem("guideSeen", "1");
    } catch {
      return;
    }
    go({ view: "guide", folder: null, clipId: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.sourceDir]);

  // Coming back to the library (from cleanup, say) shows what is really there now.
  useEffect(() => {
    if (view === "library") refresh();
  }, [view, refresh]);

  // Follow background scans.
  useEffect(() => {
    let lastRefresh = 0;
    const unlistenProgress = onScanProgress((p) => {
      setProgress(p);
      const now = Date.now();
      if (now - lastRefresh > REFRESH_DURING_SCAN_MS) {
        lastRefresh = now;
        refresh();
      }
    });
    const unlistenFinished = onScanFinished((finished) => {
      setProgress(null);
      if (finished.summary) setLastScan(finished.summary);
      if (finished.error) setError(finished.error);
      refresh();
    });
    // New clips picked up while the app is running.
    const unlistenLive = onLiveEvent((event) => {
      if (event.kind === "added") refresh();
      else setError(`${event.path}: ${event.reason}`);
    });
    return () => {
      unlistenProgress.then((off) => off());
      unlistenFinished.then((off) => off());
      unlistenLive.then((off) => off());
    };
  }, [refresh]);

  // Closing the window only hides it; make sure nothing keeps playing.
  useEffect(() => {
    const unlisten = onWindowHidden(() => {
      if (window.history.state?.place?.clipId != null) goUp();
    });
    return () => void unlisten.then((off) => off());
  }, [goUp]);

  async function chooseFolder() {
    const dir = await pickFolder();
    if (!dir) return;
    try {
      setError(null);
      await setSourceDir(dir);
      setSettings((s) => s && { ...s, sourceDir: dir, scanning: true });
      setProgress({ done: 0, total: 0 });
      reset(HOME);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function saveSortByGame(enabled: boolean) {
    try {
      await setSortByGame(enabled);
      setSettings((s) => s && { ...s, sortByGame: enabled });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function rescan() {
    setProgress({ done: 0, total: 0 });
    startScan().catch((e) => setError(errorMessage(e)));
  }

  const scanning = progress !== null;
  const needsFolder = settings !== null && settings.sourceDir === null;
  // The basic player is only a stop-gap for one failure; try mpv again for the next clip.
  const openClipId = openClip?.id ?? null;
  useEffect(() => setMpvProblem(null), [openClipId]);

  const inPlayer = openClip !== null && mpvProblem === null;

  return (
    <GameIconProvider>
    <TagColorProvider>
    <NoticeProvider>
    <ThemeFX theme={theme} motion={motion} paused={inPlayer || cleanupPlaying} quality={fxQuality} onSlow={setFxQuality} />
    <MenuProvider>
    {tourOn && <Tour onClose={() => setTourOn(false)} onGoTo={(v) => { if (view !== v) go(v === "library" ? HOME : { view: v, folder: place.folder, clipId: null }); }} />}
    <div className="shell">
    <TitleBar />
    <div className="app">
      <nav className="sidebar">
        <button data-tour="nav-library" className={view === "library" ? "nav active" : "nav"} onClick={() => go(HOME)}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          Library
        </button>
        <button data-tour="nav-cleanup" className={view === "cleanup" ? "nav active" : "nav"} onClick={() => go({ view: "cleanup", folder: place.folder, clipId: null })}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6" />
          </svg>
          Cleanup
        </button>
        <button data-tour="nav-storage" className={view === "storage" ? "nav active" : "nav"} onClick={() => go({ view: "storage", folder: place.folder, clipId: null })}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <ellipse cx="12" cy="6" rx="8" ry="3" />
            <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
          </svg>
          Storage
        </button>
        <button data-tour="nav-guide" className={view === "guide" ? "nav active" : "nav"} onClick={() => go({ view: "guide", folder: place.folder, clipId: null })}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1.1-1.5 2.2M12 17h0" />
          </svg>
          Guide
        </button>
        <button data-tour="nav-settings" className={view === "settings" ? "nav active" : "nav"} onClick={() => go({ view: "settings", folder: place.folder, clipId: null })}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="18" cy="18" r="2" />
          </svg>
          Settings
          <svg className={view === "settings" ? "chev open" : "chev"} viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <div className={view === "settings" ? "settings-sub-wrap open" : "settings-sub-wrap"}>
          <div className="settings-sub">
            {SETTINGS_PAGES.map((p) => (
              <button key={p.key} className={p.key === settingsPage ? "active" : ""} onClick={() => setSettingsPage(p.key)} tabIndex={view === "settings" ? 0 : -1}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="sidebar-foot">
          <ObsStatusPanel onError={setError} />
          {scanning && (
            <div className="scan">
              <div>
                Scanning{progress.total > 0 ? ` ${progress.done} / ${progress.total}` : "…"}
              </div>
              <progress value={progress.done} max={Math.max(progress.total, 1)} />
            </div>
          )}
          {toolError && <div className="bad small">FFmpeg not found</div>}
        </div>
      </nav>

      <main className={inPlayer || (view === "cleanup" && cleanupPlaying && mpvProblem === null) ? "content player-open" : "content"}>
        {error && (
          <div className="banner">
            <span>{error}</span>
            <button onClick={() => setError(null)}>Dismiss</button>
          </div>
        )}

        {inPlayer && (
          <PlayerView
            clip={openClip}
            onChange={updateClip}
            onExported={(made) => {
              seenClips.current.set(made.id, made);
              refresh();
            }}
            onOpenClip={showClip}
            onDeleted={(gone) => {
              // Carry on with the next clip in the list, or the previous one, or go back to the library.
              const list = shownOrder.current;
              const at = list.findIndex((c) => c.id === gone.id);
              const next = list[at + 1] ?? list[at - 1];
              seenClips.current.delete(gone.id);
              refresh();
              if (next && next.id !== gone.id) showClip(next);
              else goUp();
            }}
            onPrev={neighbour(-1)}
            onNext={neighbour(1)}
            onClose={goUp}
            onUnavailable={setMpvProblem}
          />
        )}

        {!inPlayer && view === "library" && needsFolder && (
          <div className="empty">
            <h1>Choose your clips folder</h1>
            <p>Pick the folder OBS saves replays to. Nothing is moved, copied or changed.</p>
            <button className="primary" onClick={chooseFolder}>
              Choose folder
            </button>
          </div>
        )}

        {!inPlayer && view === "library" && !needsFolder && (
          <Library
            clips={clips}
            folders={folders}
            rootDir={rootDir ?? ""}
            currentDir={currentDir ?? ""}
            query={query}
            onQueryChange={setQuery}
            onOpen={showClip}
            onClipChange={updateClip}
            layout={layout}
            filters={filters}
            onFiltersChange={setFilters}
            onOrder={(list) => (shownOrder.current = list)}
            onRefresh={refresh}
            focusClipId={lastViewed.current}
            onFocused={() => (lastViewed.current = null)}
            onOpenFolder={(path) =>
              go({ view: "library", folder: path === rootDir ? null : path, clipId: null })
            }
          />
        )}

        {!inPlayer && view === "guide" && <GuideView onStartTour={() => { go(HOME); setTourOn(true); }} />}

        {!inPlayer && view === "storage" && (
          <StorageView
            onOpenClip={showClip}
            onReview={(days) => {
              try {
                localStorage.setItem("cleanupAge", String(days));
              } catch {
                /* not saved */
              }
              go({ view: "cleanup", folder: place.folder, clipId: null });
            }}
          />
        )}

        {view === "cleanup" && <CleanupView onUnavailable={setMpvProblem} onLeave={goUp} onPlayingChange={setCleanupPlaying} />}

        {!inPlayer && view === "settings" && (
          <SettingsView
            settings={settings}
            tools={tools}
            toolError={toolError}
            lastScan={lastScan}
            scanning={scanning}
            onChooseFolder={chooseFolder}
            onRescan={rescan}
            onSortByGameChange={saveSortByGame}
            onGamesChanged={refresh}
            page={settingsPage}
            font={font}
            onFontChange={setFont}
            motion={motion}
            onMotionChange={setMotion}
            fxQuality={fxQuality}
            onFxQualityChange={setFxQuality}
            theme={theme}
            onThemeChange={setTheme}
            uiScale={uiScale}
            onUiScaleChange={setUiScale}
            layout={layout}
            onLayoutChange={setLayout}
          />
        )}
      </main>

      {openClip && mpvProblem !== null && (
        <ClipPreview clip={openClip} reason={mpvProblem} onClose={goUp} />
      )}

    </div>
    </div>
    </MenuProvider>
    </NoticeProvider>
    </TagColorProvider>
    </GameIconProvider>
  );
}
