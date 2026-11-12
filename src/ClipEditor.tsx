import { useEffect, useState } from "react";
import { useGameIcons } from "./GameIcons";
import { tagStyle, useTagColors } from "./TagColors";
import { errorMessage, listGames, listTags, renameClip, setClipGame, setClipTags, type Clip } from "./api";

/** The clip's name and game in the player's header, with a small editor. */
export function ClipEditor({ clip, onChange, onManageTags }: { clip: Clip; onChange: (clip: Clip) => void; onManageTags?: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(clip.title);
  useEffect(() => {
    setRenaming(false);
  }, [clip.id]);

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
    <>
      {renaming ? (
        <input
          className="title-input"
          value={name}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveName();
            if (e.key === "Escape") {
              e.preventDefault();
              setRenaming(false);
            }
          }}
        />
      ) : (
        <h2
          className="editable-title"
          title="Click to rename"
          onClick={() => {
            setName(clip.title);
            setRenaming(true);
          }}
        >
          {clip.title}
        </h2>
      )}
      <GamePicker clip={clip} onChange={onChange} />
      <TagsEditor clip={clip} onChange={onChange} onManage={onManageTags} />
    </>
  );
}

/** The clip's game as a small button; click it to pick another. Choosing saves straight away. */
function GamePicker({ clip, onChange }: { clip: Clip; onChange: (clip: Clip) => void }) {
  const [open, setOpen] = useState(false);
  const [games, setGames] = useState<string[]>([]);
  const [text, setText] = useState("");
  const icons = useGameIcons();

  function show() {
    setText("");
    listGames().then(setGames).catch(() => {});
    setOpen(true);
  }
  async function choose(game: string | null) {
    setOpen(false);
    if ((game ?? "") === (clip.game ?? "")) return;
    try {
      onChange(await setClipGame(clip.id, game));
    } catch (e) {
      alert(errorMessage(e));
    }
  }

  return (
    <div className="game-picker">
      <button
        className={clip.game ? "game-tag" : "game-tag empty"}
        onClick={() => (open ? setOpen(false) : show())}
        title="Change the game"
      >
        {clip.game && icons.icon(clip.game) && <img className="tag-game-icon" src={icons.icon(clip.game)} alt="" />}
        {clip.game ?? "+ Game"}
      </button>
      {open && (
        <>
          <div className="filter-back" onMouseDown={() => setOpen(false)} />
          <div className="game-pop" onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), setOpen(false))}>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && text.trim() && choose(text.trim())}
              placeholder="Type a new game and press Enter"
              autoFocus
            />
            <div className="game-chips">
              {games.map((g) => (
                <button key={g} className={g === clip.game ? "chip on" : "chip"} onClick={() => choose(g)}>
                  {g}
                </button>
              ))}
            </div>
            {clip.game && (
              <button className="chip" onClick={() => choose(null)}>
                Remove game
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** The clip's tags as small labels. Picking or removing one saves straight away. */
function TagsEditor({ clip, onChange, onManage }: { clip: Clip; onChange: (clip: Clip) => void; onManage?: () => void }) {
  const tagColors = useTagColors();
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<string[]>([]);
  const [text, setText] = useState("");

  async function save(tags: string[]) {
    try {
      onChange(await setClipTags(clip.id, tags));
    } catch (e) {
      alert(errorMessage(e));
    }
  }
  const has = (t: string) => clip.tags.some((x) => x.toLowerCase() === t.toLowerCase());
  const toggle = (t: string) => save(has(t) ? clip.tags.filter((x) => x.toLowerCase() !== t.toLowerCase()) : [...clip.tags, t]);

  return (
    <div className="game-picker">
      <div className="tag-row">
        {clip.tags.map((t) => (
          <span key={t} className="tag-chip" style={tagStyle(tagColors.color(t))}>
            {t}
            <button onClick={() => toggle(t)} aria-label={`Remove tag ${t}`} title="Remove tag">
              ×
            </button>
          </span>
        ))}
        <button
          className="game-tag empty"
          onClick={() => {
            if (open) return setOpen(false);
            setText("");
            listTags().then(setAll).catch(() => {});
            setOpen(true);
          }}
          title="Add a tag"
        >
          + Tag
        </button>
      </div>
      {open && (
        <>
          <div className="filter-back" onMouseDown={() => setOpen(false)} />
          <div className="game-pop" onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), setOpen(false))}>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && text.trim()) {
                  if (!has(text.trim())) toggle(text.trim());
                  setText("");
                }
              }}
              placeholder="Type a new tag and press Enter"
              autoFocus
            />
            <div className="game-chips">
              {all.map((t) => (
                <button
                  key={t}
                  className={has(t) ? "chip on" : "chip"}
                  style={tagStyle(tagColors.color(t))}
                  onClick={() => toggle(t)}
                >
                  {t}
                </button>
              ))}
              {onManage && (
                <button
                  className="chip"
                  title="Edit tags (colors, rename, delete)"
                  aria-label="Edit tags"
                  onClick={() => { setOpen(false); onManage(); }}
                >
                  ⋯
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
