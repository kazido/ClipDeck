import { useEffect, useState } from "react";
import { createTag, deleteTag, errorMessage, renameTag, setTagColor } from "./api";
import { TAG_COLORS, tagStyle, useTagColors } from "./TagColors";

/** A window listing every tag, to color, rename or delete them. */
export function TagManager({
  onClose,
  onRenamed,
  onDeleted,
}: {
  onClose: () => void;
  /** Called after a tag was renamed, so open screens can follow. */
  onRenamed?: (oldName: string, newName: string) => void;
  onDeleted?: (name: string) => void;
}) {
  const tags = useTagColors();
  // Tags added to clips since the app opened are not in the list yet, so look again when this opens.
  useEffect(() => {
    tags.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [palette, setPalette] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [fresh, setFresh] = useState("");

  const changed = () => {
    tags.reload();
    window.dispatchEvent(new Event("tags-changed"));
  };
  async function run(action: () => Promise<void>) {
    setProblem(null);
    try {
      await action();
      changed();
    } catch (e) {
      setProblem(errorMessage(e));
    }
  }

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal tag-manager" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>Manage tags</h2>
        <p className="muted small">Give tags a color, rename them, or delete the ones you no longer use.</p>
        <div className="tag-create">
          <input
            value={fresh}
            onChange={(e) => setFresh(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && fresh.trim()) run(async () => { await createTag(fresh); setFresh(""); });
            }}
            placeholder="New tag name"
            aria-label="New tag name"
          />
          <button disabled={!fresh.trim()} onClick={() => run(async () => { await createTag(fresh); setFresh(""); })}>
            Create tag
          </button>
        </div>
        {tags.infos.length === 0 && <p className="muted">No tags yet. Create one above, or add one to a clip.</p>}
        <ul className="tag-list">
          {tags.infos.map((t) => (
            <li key={t.name}>
              <div className="tag-line">
                <button
                  className="tag-swatch"
                  style={{ background: t.color ?? "transparent" }}
                  title="Pick a color"
                  aria-label={`Color of ${t.name}`}
                  onClick={() => setPalette(palette === t.name ? null : t.name)}
                />
                {editing === t.name ? (
                  <input
                    value={name}
                    autoFocus
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const next = name.trim();
                        setEditing(null);
                        if (next && next !== t.name) run(async () => { await renameTag(t.name, next); onRenamed?.(t.name, next); });
                      }
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setEditing(null);
                      }
                    }}
                    onBlur={() => setEditing(null)}
                  />
                ) : (
                  <span className="tag-name" style={tagStyle(t.color ?? undefined)}>
                    {t.name}
                  </span>
                )}
                <span className="muted small">
                  {t.clips} clip{t.clips === 1 ? "" : "s"}
                </span>
                <span className="spacer" />
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setEditing(t.name);
                    setName(t.name);
                  }}
                >
                  Rename
                </button>
                <button onClick={() => setAsking(asking === t.name ? null : t.name)}>Delete</button>
              </div>
              {palette === t.name && (
                <div className="palette">
                  {TAG_COLORS.map((c) => (
                    <button
                      key={c}
                      className={t.color === c ? "swatch on" : "swatch"}
                      style={{ background: c }}
                      aria-label={c}
                      onClick={() => run(() => setTagColor(t.name, c))}
                    />
                  ))}
                  <button className="chip" onClick={() => run(() => setTagColor(t.name, null))}>
                    No color
                  </button>
                </div>
              )}
              {asking === t.name && (
                <div className="confirm-row">
                  <span>
                    Remove “{t.name}” from {t.clips} clip{t.clips === 1 ? "" : "s"} and delete it?
                  </span>
                  <button
                    className="danger"
                    onClick={() => {
                      setAsking(null);
                      run(async () => {
                        await deleteTag(t.name);
                        onDeleted?.(t.name);
                      });
                    }}
                  >
                    Delete tag
                  </button>
                  <button onClick={() => setAsking(null)}>Keep it</button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {problem && <p className="bad small">{problem}</p>}
        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
