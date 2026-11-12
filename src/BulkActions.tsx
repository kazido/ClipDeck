import { useEffect, useState } from "react";
import { errorMessage, listGames, listTags, type Clip } from "./api";

/** The bar that appears at the bottom of the library while clips are selected. */
export function SelectionBar({
  count,
  allFavorite,
  onFavorite,
  onGame,
  onMove,
  onTags,
  onDelete,
  onClear,
}: {
  count: number;
  allFavorite: boolean;
  onFavorite: () => void;
  onGame: () => void;
  onMove: () => void;
  onTags: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  return (
    <div className="sel-bar">
      <strong>{count} selected</strong>
      <button onClick={onFavorite}>{allFavorite ? "Remove favorites" : "Favorite"}</button>
      <button onClick={onGame}>Set game…</button>
      <button onClick={onMove}>Move to…</button>
      <button onClick={onTags}>Add tags…</button>
      <button className="danger" onClick={onDelete}>
        Delete…
      </button>
      <button onClick={onClear} title="Clear the selection (Esc)">
        Clear
      </button>
    </div>
  );
}

/** Asks before moving clips to the Recycle Bin. */
export function ConfirmDelete({
  clips,
  onConfirm,
  onForce,
  onCancel,
}: {
  clips: Clip[];
  onConfirm: () => Promise<void>;
  /** Delete without the Recycle Bin. Offered only after the normal way has failed. */
  onForce?: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function go(action: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await action();
    } catch (e) {
      setProblem(errorMessage(e));
      setBusy(false);
    }
  }

  const names = clips.slice(0, 5).map((c) => c.title);
  return (
    <div className="modal-back" onMouseDown={onCancel}>
      <div
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <h2>
          Move {clips.length === 1 ? "this clip" : `${clips.length} clips`} to the Recycle Bin?
        </h2>
        <ul className="muted small">
          {names.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
          {clips.length > names.length && <li>and {clips.length - names.length} more</li>}
        </ul>
        <p className="muted small">You can restore them from the Recycle Bin in Windows.</p>
        {problem && <p className="bad small">{problem}</p>}
        {problem && onForce && (
          <p className="small">
            <button className="link" onClick={() => go(onForce)} disabled={busy} title="This skips the Recycle Bin. It cannot be undone.">
              Delete permanently instead (cannot be undone)
            </button>
          </p>
        )}
        <div className="modal-actions">
          <button className="danger" onClick={() => go(onConfirm)} disabled={busy} autoFocus>
            {busy ? "Working… large files can take a few seconds" : "Move to Recycle Bin"}
          </button>
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Pick a game for every selected clip. */
export function GameDialog({
  count,
  onSave,
  onCancel,
}: {
  count: number;
  onSave: (game: string | null) => Promise<void>;
  onCancel: () => void;
}) {
  const [game, setGame] = useState("");
  const [games, setGames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    listGames().then(setGames).catch(() => {});
  }, []);

  async function save() {
    setBusy(true);
    try {
      await onSave(game.trim() || null);
    } catch (e) {
      setProblem(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-back" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Set game for {count === 1 ? "1 clip" : `${count} clips`}</h2>
        <div className="clip-form">
          <div className="clip-editor">
            <input
              value={game}
              onChange={(e) => setGame(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") {
                  e.stopPropagation();
                  onCancel();
                }
              }}
              placeholder="Game (leave empty to clear)"
              aria-label="Game"
              autoFocus
            />
            <button className="primary" onClick={save} disabled={busy}>
              Save
            </button>
            <button onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
          {games.length > 0 && (
            <div className="game-chips">
              {games.map((g) => (
                <button key={g} className={g === game ? "chip on" : "chip"} onClick={() => setGame(g === game ? "" : g)}>
                  {g}
                </button>
              ))}
            </div>
          )}
          {problem && <span className="bad small">{problem}</span>}
        </div>
      </div>
    </div>
  );
}

/** Pick tags to add to every selected clip. */
export function TagDialog({
  count,
  onSave,
  onCancel,
}: {
  count: number;
  onSave: (tags: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [all, setAll] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    listTags().then(setAll).catch(() => {});
  }, []);

  const toggle = (t: string) =>
    setChosen((c) => (c.includes(t) ? c.filter((x) => x !== t) : [...c, t]));
  const options = [...new Set([...all, ...chosen])];

  async function save() {
    setBusy(true);
    try {
      await onSave(chosen);
    } catch (e) {
      setProblem(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-back" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Add tags to {count === 1 ? "1 clip" : `${count} clips`}</h2>
        <div className="clip-form">
          <div className="clip-editor">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && text.trim()) {
                  if (!chosen.includes(text.trim())) toggle(text.trim());
                  setText("");
                }
                if (e.key === "Escape") {
                  e.stopPropagation();
                  onCancel();
                }
              }}
              placeholder="Type a new tag and press Enter"
              aria-label="New tag"
              autoFocus
            />
            <button className="primary" onClick={save} disabled={busy || chosen.length === 0}>
              Add
            </button>
            <button onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
          {options.length > 0 && (
            <div className="game-chips">
              {options.map((t) => (
                <button key={t} className={chosen.includes(t) ? "chip on" : "chip"} onClick={() => toggle(t)}>
                  {t}
                </button>
              ))}
            </div>
          )}
          {problem && <span className="bad small">{problem}</span>}
        </div>
      </div>
    </div>
  );
}
