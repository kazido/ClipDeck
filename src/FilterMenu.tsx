import { useEffect, useState } from "react";
import { gameColor } from "./format";
import { useGameIcons } from "./GameIcons";
import { useTagColors } from "./TagColors";
import { getObsStatus, onObsStatus, type ClipQuery, type ObsStatus, type SortKey } from "./api";
import type { Filters, GroupBy } from "./Library";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "date", label: "Date" },
  { key: "name", label: "Name" },
  { key: "duration", label: "Duration" },
  { key: "size", label: "File size" },
];

const GROUPS: { key: GroupBy; label: string }[] = [
  { key: "game", label: "Game" },
  { key: "month", label: "Month" },
];

/** A small always-visible light: is OBS ready to save a clip? */
export function StatusChip() {
  const [status, setStatus] = useState<ObsStatus | null>(null);
  useEffect(() => {
    getObsStatus().then(setStatus).catch(() => {});
    const off = onObsStatus(setStatus);
    return () => {
      off.then((f) => f());
    };
  }, []);
  if (!status) return null;
  const [dot, text] =
    status.state === "disconnected"
      ? ["off", "OBS not connected"]
      : status.replayBufferActive
        ? ["ready", "Ready to clip"]
        : ["idle", "Replay buffer off"];
  return (
    <span className="status-chip" title="Whether OBS is ready to save a clip">
      <span className={`dot ${dot}`} />
      {text}
    </span>
  );
}

/** One button that opens a popup with the sort, filter and grouping choices as tick boxes. */
export function FilterMenu({
  filters,
  onFiltersChange,
  games,
  tags,
  query,
  onQueryChange,
}: {
  filters: Filters;
  onFiltersChange: (filters: Filters) => void;
  games: string[];
  tags: string[];
  query: ClipQuery;
  onQueryChange: (query: ClipQuery) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const active = filters.games.length + filters.tags.length + (filters.favoritesOnly ? 1 : 0) + (filters.groupBy !== "none" ? 1 : 0);
  const toggleTag = (tag: string) =>
    onFiltersChange({
      ...filters,
      tags: filters.tags.includes(tag) ? filters.tags.filter((t) => t !== tag) : [...filters.tags, tag],
    });
  const toggleGame = (game: string) =>
    onFiltersChange({
      ...filters,
      games: filters.games.includes(game) ? filters.games.filter((g) => g !== game) : [...filters.games, game],
    });

  return (
    <div className="filter-bar">
      <button
        className={query.ascending ? "rev-btn on" : "rev-btn"}
        onClick={() => onQueryChange({ ...query, ascending: !query.ascending })}
        title={query.ascending ? "Oldest / smallest first. Click to reverse." : "Newest / largest first. Click to reverse."}
        aria-label="Reverse order"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {/* Three lines and an arrow showing which way the list runs. */}
          <path d="M3 6h9M3 12h6M3 18h3" />
          {query.ascending ? <path d="M18 20V5M13.5 9.5L18 5l4.5 4.5" /> : <path d="M18 4v15M13.5 14.5L18 19l4.5-4.5" />}
        </svg>
      </button>
      {active > 0 && (
        <button
          className="clear-btn"
          onClick={() => onFiltersChange({ games: [], tags: [], favoritesOnly: false, groupBy: "none" })}
          title="Clear all filters"
        >
          Clear filters ×
        </button>
      )}
      <div className="filter-wrap" data-tour="filters">
      <button onClick={() => setOpen(!open)} aria-expanded={open}>
        Filters
        {active > 0 && <span className="filter-count">{active}</span>}
      </button>
      {open && (
        <>
          <div className="filter-back" onMouseDown={() => setOpen(false)} />
          <div className="filter-pop">
            <h4>Show</h4>
            <button
              className={filters.favoritesOnly ? "fav-toggle on" : "fav-toggle"}
              onClick={() => onFiltersChange({ ...filters, favoritesOnly: !filters.favoritesOnly })}
              aria-pressed={filters.favoritesOnly}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill={filters.favoritesOnly ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
                <path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.2 1.3-6.6L2.5 9.4l6.6-.8z" />
              </svg>
              Favorites only
            </button>

            <h4>Games</h4>
            <GamePicker games={games} selected={filters.games} onToggle={toggleGame} />

            {tags.length > 0 && (
              <>
                <h4>Tags</h4>
                <GamePicker games={tags} selected={filters.tags} onToggle={toggleTag} isTags />
              </>
            )}

            <h4>Group by</h4>
            {GROUPS.map((g) => (
              <label key={g.key}>
                <input
                  type="checkbox"
                  checked={filters.groupBy === g.key}
                  onChange={(e) => onFiltersChange({ ...filters, groupBy: e.target.checked ? g.key : "none" })}
                />
                {g.label}
              </label>
            ))}

            <h4>Sort by</h4>
            {SORTS.map((s) => (
              <label key={s.key}>
                <input
                  type="checkbox"
                  checked={query.sort === s.key}
                  onChange={() => onQueryChange({ ...query, sort: s.key })}
                />
                {s.label}
              </label>
            ))}

            {active > 0 && (
              <button style={{ marginTop: 8 }} onClick={() => onFiltersChange({ games: [], tags: [], favoritesOnly: false, groupBy: "none" })}>
                Clear filters
              </button>
            )}
          </div>
        </>
      )}
      </div>
    </div>
  );
}

/** Pick any number of games. A search box and a scrolling list keep it tidy with many games. */
function GamePicker({
  games,
  selected,
  onToggle,
  isTags,
}: {
  games: string[];
  selected: string[];
  onToggle: (game: string) => void;
  /** The list holds tags rather than games, so dots use the tag colors. */
  isTags?: boolean;
}) {
  const tagColors = useTagColors();
  const [search, setSearch] = useState("");
  const icons = useGameIcons();
  const label = (g: string) => g;
  const options = games.filter((g) => label(g).toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <div className="filter-games">
      <div className="picked-line">
        {selected.length === 0 ? (
          <span className="muted small">Nothing picked</span>
        ) : (
          <>
            <span className="small">{selected.length} picked</span>
            <button className="link" onClick={() => selected.forEach((g) => onToggle(g))}>
              Clear
            </button>
          </>
        )}
      </div>
      {games.length > 5 && (
        <input type="search" placeholder="Search games" value={search} onChange={(e) => setSearch(e.target.value)} />
      )}
      <div className="list">
        {options.map((g) => (
          <label key={g}>
            <input type="checkbox" checked={selected.includes(g)} onChange={() => onToggle(g)} />
            {!isTags && icons.icon(g) ? <img className="game-dot-icon" src={icons.icon(g)} alt="" /> : <i className="game-dot" style={{ background: (isTags && tagColors.color(g)) || gameColor(g) }} />}
            {label(g)}
          </label>
        ))}
        {options.length === 0 && <span className="muted small">No games match.</span>}
      </div>
    </div>
  );
}
