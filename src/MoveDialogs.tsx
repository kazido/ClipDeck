import { useEffect, useMemo, useState } from "react";
import { errorMessage, fileUrl, listClips, type Clip } from "./api";

const lastPart = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const sameDir = (a: string, b: string) => a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();

/** The folder a clip file sits in. */
const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")));

/** Pick any clips from the whole library to put into one folder. */
export function AddClipsDialog({
  folder,
  onAdd,
  onCancel,
}: {
  folder: string;
  onAdd: (ids: number[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    listClips({ sort: "date", ascending: false, search: "" }, null, true)
      .then((all) => setClips(all.filter((c) => !sameDir(dirOf(c.path), folder))))
      .catch((e) => setProblem(errorMessage(e)));
  }, [folder]);

  const shown = useMemo(() => {
    const f = search.trim().toLowerCase();
    return f ? clips.filter((c) => `${c.title} ${c.game ?? ""} ${c.tags.join(" ")}`.toLowerCase().includes(f)) : clips;
  }, [clips, search]);

  const toggle = (id: number) =>
    setPicked((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  async function add() {
    setBusy(true);
    try {
      await onAdd([...picked]);
    } catch (e) {
      setProblem(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-back" onMouseDown={onCancel}>
      <div className="modal add-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Add clips to {lastPart(folder)}</h2>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onCancel())}
          placeholder="Search clips"
          aria-label="Search clips"
          autoFocus
        />
        <div className="add-grid">
          {shown.map((c) => (
            <button key={c.id} className={picked.has(c.id) ? "add-item on" : "add-item"} onClick={() => toggle(c.id)} title={c.fileName}>
              <div className="add-thumb">{c.thumbPath && <img src={fileUrl(c.thumbPath)} alt="" loading="lazy" decoding="async" />}</div>
              <span className="add-check">{picked.has(c.id) ? "✓" : ""}</span>
              <span className="add-name">{c.title}</span>
            </button>
          ))}
          {shown.length === 0 && <p className="muted small">No other clips to add.</p>}
        </div>
        {problem && <p className="bad">{problem}</p>}
        <div className="modal-actions">
          <button className="primary" disabled={busy || picked.size === 0} onClick={add}>
            {picked.size === 0 ? "Add" : `Add ${picked.size} clip${picked.size === 1 ? "" : "s"}`}
          </button>
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
