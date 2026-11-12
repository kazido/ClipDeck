import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMenu } from "./ContextMenu";
import { useNotice } from "./Notice";
import { useGameIcons } from "./GameIcons";
import * as mpv from "./mpv";
import { ConfirmDelete, GameDialog, SelectionBar, TagDialog } from "./BulkActions";
import { AddClipsDialog } from "./MoveDialogs";
import { FilterMenu, StatusChip } from "./FilterMenu";
import { errorMessage, fileUrl, copyClipFile, copyClipFiles, deleteClips, listGames, listTags, moveClips, pickFolder, renameClip, revealInFolder, setClipGame, setClipTags, setFavorite, type Clip, type ClipQuery, type Folder } from "./api";
import { gameColor, formatBytes, formatDate, formatDuration, formatFps } from "./format";

const MIN_CARD_WIDTH = 260;
const GAP = 16;
const CARD_TEXT_HEIGHT = 56;

interface Props {
  clips: Clip[];
  /** Subfolders of the current folder. Hidden while searching. */
  folders: Folder[];
  /** The clips folder chosen in Settings. */
  rootDir: string;
  /** The folder being shown: `rootDir` or something inside it. */
  currentDir: string;
  query: ClipQuery;
  onQueryChange: (query: ClipQuery) => void;
  onOpen: (clip: Clip) => void;
  onClipChange: (clip: Clip) => void;
  onOpenFolder: (path: string) => void;
  layout: "folders" | "all";
  filters: Filters;
  onFiltersChange: (filters: Filters) => void;
  /** Tells the app the clips in the order they are shown, for the player's arrows. */
  onOrder: (clips: Clip[]) => void;
  /** The clip that was just closed in the player: scrolled to and highlighted on return. */
  focusClipId?: number | null;
  /** Called once the clip has been focused, so it is not focused again. */
  onFocused?: () => void;
  /** Reload the lists after clips were removed. */
  onRefresh: () => void;
}

export type GroupBy = "none" | "game" | "month";
const NO_GAME = "\u0000none"; // clips without a game only match when no game is selected

/** What the Filters popup controls. An empty `games` list means every game. */
export interface Filters {
  games: string[];
  tags: string[];
  favoritesOnly: boolean;
  groupBy: GroupBy;
}
export const DEFAULT_FILTERS: Filters = { games: [], tags: [], favoritesOnly: false, groupBy: "none" };

type Item = { kind: "folder"; folder: Folder } | { kind: "clip"; clip: Clip };
/** What the cards need to take part in selecting clips. */
interface Selection {
  ids: Set<number>;
  click: (clip: Clip, e: React.MouseEvent) => void;
  toggle: (clip: Clip) => void;
  askDelete: (clip: Clip) => void;
  /** Ask where to move this clip (or the whole selection, if it is part of it). */
  askMove: (clip: Clip) => void;
  /** Begin dragging this clip (or the whole selection) towards a folder. */
  startDrag: (clip: Clip, e: React.MouseEvent) => void;
}

interface Section {
  title?: string;
  count?: number;
  items: Item[];
}

function monthLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** Folders first, then favourites, then the rest (grouped if asked). */
function buildSections(folders: Folder[], clips: Clip[], filters: Filters): Section[] {
  const { groupBy, games, favoritesOnly } = filters;
  const wantedTags = filters.tags ?? [];
  const filtering = games.length > 0 || wantedTags.length > 0 || favoritesOnly;
  const shown = clips.filter(
    (c) =>
      (games.length === 0 || games.includes(c.game ?? NO_GAME)) &&
      (wantedTags.length === 0 || c.tags.some((t) => wantedTags.includes(t))) &&
      (!favoritesOnly || c.favorite),
  );
  const sections: Section[] = [];
  if (folders.length > 0 && !filtering) {
    sections.push({ items: folders.map((folder): Item => ({ kind: "folder", folder })) });
  }
  const asItems = (list: Clip[]) => list.map((clip): Item => ({ kind: "clip", clip }));
  const favorites = shown.filter((c) => c.favorite);
  const rest = shown.filter((c) => !c.favorite);
  if (favorites.length > 0) sections.push({ title: "\u2605 Favorites", count: favorites.length, items: asItems(favorites) });

  if (groupBy === "none") {
    if (rest.length > 0) {
      const title = favorites.length > 0 ? "All clips" : undefined;
      sections.push({ title, count: rest.length, items: asItems(rest) });
    }
    return sections;
  }
  const groups = new Map<string, Clip[]>();
  for (const clip of rest) {
    const key = groupBy === "game" ? (clip.game ?? "No game") : monthLabel(clip.createdAtMs);
    groups.set(key, [...(groups.get(key) ?? []), clip]);
  }
  let keys = [...groups.keys()];
  if (groupBy === "game") {
    keys.sort((a, b) => (a === "No game" ? 1 : b === "No game" ? -1 : a.localeCompare(b)));
  }
  for (const key of keys) sections.push({ title: key, count: groups.get(key)!.length, items: asItems(groups.get(key)!) });
  return sections;
}

export function Library(props: Props) {
  const { clips, rootDir, currentDir, query, onQueryChange, onOpen, onOpenFolder, onClipChange } = props;
  const { filters, onFiltersChange, onOrder } = props;
  const searching = query.search.trim() !== "";
  const folders = searching ? [] : props.folders;
  // The filter lists cover the whole library, not just the clips on this page.
  const [games, setGames] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  useEffect(() => {
    listGames().then(setGames).catch(() => {});
    listTags().then(setTags).catch(() => {});
  }, [clips]);
  const sections = useMemo(
    () => buildSections(folders, clips, filters),
    [folders, clips, filters],
  );
  const shownClips = sections.flatMap((s) => s.items.flatMap((i) => (i.kind === "clip" ? [i.clip] : [])));
  useEffect(() => {
    onOrder(shownClips);
  });
  const empty = sections.length === 0;

  // ---- selecting clips ----
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);
  const [toDelete, setToDelete] = useState<Clip[] | null>(null);
  const [pickingGame, setPickingGame] = useState(false);
  const [pickingTags, setPickingTags] = useState(false);
  const [adding, setAdding] = useState(false);
  const [drag, setDrag] = useState<{ count: number; x: number; y: number } | null>(null);
  const chosen = shownClips.filter((c) => selected.has(c.id));
  const notify = useNotice();

  // Selections only ever hold clips that are still on screen.
  useEffect(() => {
    setSelected((old) => {
      const here = new Set(shownClips.map((c) => c.id));
      const next = new Set([...old].filter((id) => here.has(id)));
      return next.size === old.size ? old : next;
    });
  });

  const toggle = (clip: Clip) => {
    anchor.current = clip.id;
    setSelected((old) => {
      const next = new Set(old);
      if (!next.delete(clip.id)) next.add(clip.id);
      return next;
    });
  };
  const click = (clip: Clip, e: React.MouseEvent) => {
    if (e.shiftKey && anchor.current !== null) {
      const ids = shownClips.map((c) => c.id);
      const a = ids.indexOf(anchor.current);
      const b = ids.indexOf(clip.id);
      if (a >= 0 && b >= 0) {
        setSelected((old) => new Set([...old, ...ids.slice(Math.min(a, b), Math.max(a, b) + 1)]));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey || selected.size > 0) toggle(clip);
    else onOpen(clip);
  };
  const selection: Selection = {
    ids: selected,
    click,
    toggle,
    askDelete: (clip) => setToDelete(selected.has(clip.id) ? chosen : [clip]),
    askMove: (clip) => chooseAndMove(selected.has(clip.id) ? chosen : [clip]),
    startDrag: (clip, e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("input, button, a")) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const ids = selected.has(clip.id) ? [...selected] : [clip.id];
      let started = false;
      let over: Element | null = null;
      const targetAt = (ev: MouseEvent) => document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-drop-dir]") ?? null;
      const onMove = (ev: MouseEvent) => {
        if (!started) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
          started = true;
          document.body.classList.add("dragging-clips");
        }
        setDrag({ count: ids.length, x: ev.clientX, y: ev.clientY });
        const t = targetAt(ev);
        if (t !== over) {
          over?.classList.remove("drop-target");
          t?.classList.add("drop-target");
          over = t;
        }
      };
      const onUp = (ev: MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (!started) return;
        document.body.classList.remove("dragging-clips");
        over?.classList.remove("drop-target");
        setDrag(null);
        // The click that follows letting go must not open the clip.
        const swallow = (c: MouseEvent) => (c.stopPropagation(), c.preventDefault());
        window.addEventListener("click", swallow, true);
        setTimeout(() => window.removeEventListener("click", swallow, true), 80);
        const dest = (targetAt(ev) as HTMLElement | null)?.dataset.dropDir;
        if (dest) void moveInto(ids, dest);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
  };

  /** Ask for a folder with Windows' own folder window, then move the clips there. */
  async function chooseAndMove(list: Clip[]) {
    try {
      const dest = await pickFolder(currentDir || rootDir);
      if (!dest) return;
      if (!dest.toLowerCase().startsWith(rootDir.toLowerCase())) {
        notify("Pick a folder inside your clips folder.", "bad");
        return;
      }
      await mpv.stop().catch(() => {});
      await moveInto(list.map((c) => c.id), dest);
    } catch (e) {
      notify(errorMessage(e), "bad");
    }
  }

  async function moveInto(ids: number[], dest: string) {
    try {
      const moved = await moveClips(ids, dest);
      setSelected(new Set());
      props.onRefresh();
      if (moved.length > 0) {
        const name = dest.split(/[\\/]/).filter(Boolean).pop() ?? dest;
        notify(moved.length === 1 ? `Moved 1 clip to ${name}.` : `Moved ${moved.length} clips to ${name}.`);
      }
    } catch (e) {
      notify(errorMessage(e), "bad");
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLSelectElement;
      if (typing || selected.size === 0) return;
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "c" && !window.getSelection()?.toString()) {
        e.preventDefault();
        copyClipFiles(chosen.map((c) => c.id))
          .then(() => notify(chosen.length === 1 ? "Copied. Paste it into Discord or a folder with Ctrl+V." : `Copied ${chosen.length} clips. Paste them into a folder with Ctrl+V.`))
          .catch((err) => notify(errorMessage(err), "bad"));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSelected(new Set());
      } else if (e.key === "Delete") {
        e.preventDefault();
        setToDelete(chosen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function favoriteSelected() {
    const make = !chosen.every((c) => c.favorite);
    for (const clip of chosen) {
      if (clip.favorite !== make) onClipChange(await setFavorite(clip.id, make));
    }
  }

  return (
    <>
      {props.layout === "folders" && (
        <Breadcrumbs rootDir={rootDir} currentDir={currentDir} onOpenFolder={onOpenFolder} />
      )}
      <div className="toolbar">
        <input
          type="search"
          data-tour="search"
          placeholder={currentDir === rootDir || props.layout === "all" ? "Search all clips" : "Search this folder"}
          value={query.search}
          onChange={(e) => onQueryChange({ ...query, search: e.target.value })}
        />
        <StatusChip />
        {props.layout === "folders" && currentDir !== rootDir && (
          <button onClick={() => setAdding(true)} title="Pick clips from your library to move into this folder">
            Add clips…
          </button>
        )}
        <span className="count">
          {folders.length > 0 && `${plural(folders.length, "folder")}, `}
          {plural(shownClips.length, "clip")}
        </span>
        <FilterMenu
          filters={filters}
          onFiltersChange={onFiltersChange}
          games={games}
          tags={tags}
          query={query}
          onQueryChange={onQueryChange}
        />
      </div>

      {empty ? (
        <div className="empty">
          <p>{searching || filters.games.length > 0 || filters.tags.length > 0 || filters.favoritesOnly ? "No clips match." : "No clips in this folder yet."}</p>
        </div>
      ) : (
        <Grid
          sections={sections}
          onOpen={onOpen}
          onOpenFolder={onOpenFolder}
          onClipChange={onClipChange}
          selection={selection}
          focusClipId={props.focusClipId ?? null}
          onFocused={props.onFocused}
        />
      )}

      {selected.size > 0 && (
        <SelectionBar
          count={selected.size}
          allFavorite={chosen.every((c) => c.favorite)}
          onFavorite={() => favoriteSelected().catch((e) => alert(errorMessage(e)))}
          onGame={() => setPickingGame(true)}
          onMove={() => chooseAndMove(chosen)}
          onTags={() => setPickingTags(true)}
          onDelete={() => setToDelete(chosen)}
          onClear={() => setSelected(new Set())}
        />
      )}
      {toDelete && (
        <ConfirmDelete
          clips={toDelete}
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            // The player may still have the file open, which would block the delete.
            await mpv.stop().catch(() => {});
            await deleteClips(toDelete.map((c) => c.id));
            setToDelete(null);
            setSelected(new Set());
            props.onRefresh();
          }}
          onForce={async () => {
            await mpv.stop().catch(() => {});
            await deleteClips(toDelete.map((c) => c.id), true);
            setToDelete(null);
            setSelected(new Set());
            props.onRefresh();
          }}
        />
      )}
      {adding && (
        <AddClipsDialog
          folder={currentDir}
          onCancel={() => setAdding(false)}
          onAdd={async (ids) => {
            await moveInto(ids, currentDir);
            setAdding(false);
          }}
        />
      )}
      {drag && (
        <div className="drag-ghost" style={{ left: drag.x + 14, top: drag.y + 14 }}>
          {drag.count === 1 ? "Move 1 clip" : `Move ${drag.count} clips`}
        </div>
      )}
      {pickingTags && (
        <TagDialog
          count={chosen.length}
          onCancel={() => setPickingTags(false)}
          onSave={async (added) => {
            for (const clip of chosen) {
              const merged = [...clip.tags];
              for (const t of added) if (!merged.some((x) => x.toLowerCase() === t.toLowerCase())) merged.push(t);
              if (merged.length !== clip.tags.length) onClipChange(await setClipTags(clip.id, merged));
            }
            setPickingTags(false);
          }}
        />
      )}
      {pickingGame && (
        <GameDialog
          count={chosen.length}
          onCancel={() => setPickingGame(false)}
          onSave={async (game) => {
            for (const clip of chosen) onClipChange(await setClipGame(clip.id, game));
            setPickingGame(false);
          }}
        />
      )}
    </>
  );
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** "Videos › Rocket League › Montage", each part clickable. */
function Breadcrumbs({
  rootDir,
  currentDir,
  onOpenFolder,
}: Pick<Props, "rootDir" | "currentDir" | "onOpenFolder">) {
  const separator = rootDir.includes("\\") ? "\\" : "/";
  const lastPart = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const inside = currentDir.startsWith(rootDir) ? currentDir.slice(rootDir.length) : "";

  const crumbs = [{ name: lastPart(rootDir), path: rootDir }];
  for (const part of inside.split(/[\\/]/).filter(Boolean)) {
    const parent = crumbs[crumbs.length - 1].path;
    crumbs.push({ name: part, path: `${parent}${separator}${part}` });
  }

  return (
    <nav className="breadcrumbs" aria-label="Folder">
      {crumbs.map((crumb, i) =>
        i === crumbs.length - 1 ? (
          <span key={crumb.path} className="crumb current">
            {crumb.name}
          </span>
        ) : (
          <span key={crumb.path}>
            <button className="crumb" data-drop-dir={crumb.path} onClick={() => onOpenFolder(crumb.path)}>
              {crumb.name}
            </button>
            <span className="muted"> › </span>
          </span>
        ),
      )}
    </nav>
  );
}

type Row = { kind: "header"; title: string; count?: number } | { kind: "items"; items: Item[] };
const HEADER_HEIGHT = 44;

/** A grid that only renders the rows currently on screen. */
function Grid({
  sections,
  onOpen,
  onOpenFolder,
  onClipChange,
  selection,
  focusClipId,
  onFocused,
}: {
  focusClipId: number | null;
  onFocused?: () => void;
  sections: Section[];
  onOpen: (clip: Clip) => void;
  onOpenFolder: (path: string) => void;
  onClipChange: (clip: Clip) => void;
  selection: Selection;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth - GAP * 2));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const columns = Math.max(1, Math.floor((width + GAP) / (MIN_CARD_WIDTH + GAP)));
  const cardWidth = (width - GAP * (columns - 1)) / columns;
  const rowHeight = Math.round((cardWidth * 9) / 16) + CARD_TEXT_HEIGHT + GAP;

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const section of sections) {
      if (section.title) out.push({ kind: "header", title: section.title, count: section.count });
      for (let at = 0; at < section.items.length; at += columns) {
        out.push({ kind: "items", items: section.items.slice(at, at + columns) });
      }
    }
    return out;
  }, [sections, columns]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i].kind === "header" ? HEADER_HEIGHT : rowHeight),
    overscan: 3,
  });

  useEffect(() => virtualizer.measure(), [rowHeight, rows, virtualizer]);

  // Coming back from the player: bring the clip you were just watching into view and focus it.
  useEffect(() => {
    if (focusClipId === null || width === 0) return;
    const at = rows.findIndex((r) => r.kind === "items" && r.items.some((i) => i.kind === "clip" && i.clip.id === focusClipId));
    if (at < 0) return;
    virtualizer.scrollToIndex(at, { align: "center" });
    const timer = setTimeout(() => {
      const card = document.querySelector<HTMLElement>(`[data-clip-id="${focusClipId}"]`);
      card?.focus({ preventScroll: true });
      card?.classList.add("just-viewed");
      onFocused?.();
    }, 80);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusClipId, width, rows.length]);

  return (
    <div className="grid-scroll" ref={scrollRef}>
      {width > 0 && (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vrow) => {
            const row = rows[vrow.index];
            if (!row) return null;
            return row.kind === "header" ? (
              <div key={vrow.key} className="grid-row section-title" style={{ transform: `translateY(${vrow.start}px)`, display: "flex" }}>
                {row.title}
                {row.count !== undefined && <span className="muted">{row.count}</span>}
              </div>
            ) : (
              <div
                key={vrow.key}
                className="grid-row"
                style={{
                  transform: `translateY(${vrow.start}px)`,
                  gridTemplateColumns: `repeat(${columns}, 1fr)`,
                }}
              >
                {row.items.map((item) =>
                  item.kind === "folder" ? (
                    <FolderCard key={item.folder.path} folder={item.folder} onOpen={onOpenFolder} />
                  ) : (
                    <ClipCard key={item.clip.id} clip={item.clip} onOpen={onOpen} onChange={onClipChange} selection={selection} />
                  ),
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ClipCard({
  clip,
  onOpen,
  onChange,
  selection,
}: {
  clip: Clip;
  onOpen: (clip: Clip) => void;
  onChange: (clip: Clip) => void;
  selection: Selection;
}) {
  const notify = useNotice();
  const gameIcons = useGameIcons();
  const isSelected = selection.ids.has(clip.id);
  const showMenu = useMenu();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(clip.title);

  async function saveName() {
    setRenaming(false);
    if (!name.trim() || name.trim() === clip.title) return;
    try {
      onChange(await renameClip(clip.id, name));
    } catch (e) {
      alert(errorMessage(e));
    }
  }

  return (
    <div
      data-clip-id={clip.id}
      className={isSelected ? "card selected" : selection.ids.size > 0 ? "card selecting" : "card"}
      role="button"
      tabIndex={0}
      onClick={(e) => selection.click(clip, e)}
      onMouseDown={(e) => selection.startDrag(clip, e)}
      onDragStart={(e) => e.preventDefault()}
      onKeyDown={(e) => e.target === e.currentTarget && e.key === "Enter" && onOpen(clip)}
      onContextMenu={(e) =>
        showMenu(e, [
          { label: "Open", onClick: () => onOpen(clip) },
          {
            label: "Copy clip",
            onClick: () =>
              copyClipFile(clip.id)
                .then(() => notify("Copied. Paste it into Discord or a folder with Ctrl+V."))
                .catch((err) => notify(errorMessage(err), "bad")),
          },
          {
            label: clip.favorite ? "Remove favorite" : "Favorite",
            onClick: () => setFavorite(clip.id, !clip.favorite).then(onChange).catch((err) => notify(errorMessage(err), "bad")),
          },
          { label: "Rename", onClick: () => { setName(clip.title); setRenaming(true); } },
          { label: isSelected ? "Deselect" : "Select", onClick: () => selection.toggle(clip) },
          { label: "Move to…", onClick: () => selection.askMove(clip) },
          { label: "Show in folder", onClick: () => revealInFolder(clip.path).catch((err) => notify(errorMessage(err), "bad")) },
          {
            label: isSelected && selection.ids.size > 1 ? `Delete ${selection.ids.size} selected…` : "Delete…",
            onClick: () => selection.askDelete(clip),
            divider: true,
            danger: true,
          },
        ])
      }
      title={clip.fileName}
    >
      <div className="card-thumb">
        {clip.thumbPath ? (
          <img src={fileUrl(clip.thumbPath)} alt="" loading="lazy" decoding="async" />
        ) : (
          <span className="muted">{clip.status === "pending" ? "Processing…" : "No thumbnail"}</span>
        )}
        <button
          className={isSelected ? "select-box on" : "select-box"}
          title={isSelected ? "Deselect" : "Select"}
          aria-label="Select"
          onClick={(e) => {
            e.stopPropagation();
            selection.toggle(clip);
          }}
        >
          {isSelected && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.5l4.5 4.5L19 7" />
            </svg>
          )}
        </button>
        <button
          className={clip.favorite ? "star on" : "star"}
          title={clip.favorite ? "Remove from favorites" : "Add to favorites"}
          aria-label="Favorite"
          onClick={(e) => {
            e.stopPropagation();
            setFavorite(clip.id, !clip.favorite).then(onChange).catch((err) => alert(errorMessage(err)));
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill={clip.favorite ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
            <path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.2 1.3-6.6L2.5 9.4l6.6-.8z" />
          </svg>
        </button>
        <span className="badge duration">{formatDuration(clip.durationMs)}</span>
      </div>
      <div className="card-title-row">
        {clip.game && (
          <span className="title-game" title={clip.game}>
            {gameIcons.icon(clip.game) ? (
              <img src={gameIcons.icon(clip.game)} alt="" />
            ) : (
              <i style={{ background: gameColor(clip.game) }}>{clip.game.slice(0, 1).toUpperCase()}</i>
            )}
          </span>
        )}
        {renaming ? (
          <input
            className="card-title-input"
            value={name}
            autoFocus
            onFocus={(e) => e.target.select()}
            onChange={(e) => setName(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") saveName();
              if (e.key === "Escape") setRenaming(false);
            }}
            onBlur={saveName}
          />
        ) : (
          <div
            className="card-title editable"
            title="Click to rename"
            onClick={(e) => {
              e.stopPropagation();
              setName(clip.title);
              setRenaming(true);
            }}
          >
            {clip.title}
          </div>
        )}
      </div>
      <div className="card-meta hover-only">
        {clip.game ? `${clip.game} · ` : ""}
        {clip.height}p{formatFps(clip)} · {formatBytes(clip.sizeBytes)} · {formatDate(clip.createdAtMs)}
      </div>
    </div>
  );
}

function FolderCard({ folder, onOpen }: { folder: Folder; onOpen: (path: string) => void }) {
  // The clips form a carousel: the one the mouse is over (left to right
  // across the card) slides to the middle, and the others fan out behind it.
  const [active, setActive] = useState(0);
  const n = folder.thumbs.length;
  const pick = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setActive(Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * n))));
  };
  return (
    <button
      className="card folder"
      data-drop-dir={folder.path}
      onClick={() => onOpen(folder.path)}
      onMouseMove={pick}
      onMouseLeave={() => setActive(0)}
      title={folder.path}
    >
      <div className="folder-art">
        {folder.thumbs.map((thumb, i) => {
          const d = i - active;
          const away = Math.abs(d);
          return (
            <img
              key={thumb}
              className="folder-clip"
              style={{
                zIndex: 10 - away,
                transform: `translateX(${d * 24}%) scale(${1 - away * 0.1})`,
                filter: `brightness(${1 - away * 0.28})`,
              }}
              src={fileUrl(thumb)}
              alt=""
              loading="lazy"
              decoding="async"
            />
          );
        })}
      </div>
      <div className="card-title">{folder.name}</div>
      <div className="card-meta">{plural(folder.clipCount, "clip")}</div>
    </button>
  );
}
