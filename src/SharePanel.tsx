import { useState } from "react";
import { errorMessage, revealInFolder, shareClip, type Clip, type Shared } from "./api";
import { clock } from "./TrimPanel";

const LIMITS = [8, 10, 20, 50, 100];

function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not saved */
  }
}

/** Make a small copy of the clip and put it on the clipboard, ready to paste into Discord. */
export function SharePanel({
  clip,
  range,
  trackNames,
  onClose,
}: {
  clip: Clip;
  /** The part to share, or null for the whole clip. */
  range: { start: number; end: number } | null;
  /** Names of the clip's audio tracks, in order. */
  trackNames: string[];
  onClose: () => void;
}) {
  const [limit, setLimit] = useState<number>(() => {
    const saved = stored("shareLimit", 20);
    return LIMITS.includes(saved) ? saved : 20;
  });
  const [audio, setAudio] = useState<string>(clip.audioTracks > 1 ? "mix" : clip.audioTracks === 1 ? "0" : "none");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Shared | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const start = range?.start ?? 0;
  const end = range?.end ?? clip.durationMs / 1000;

  async function make() {
    setBusy(true);
    setDone(null);
    setProblem(null);
    save("shareLimit", limit);
    try {
      setDone(await shareClip(clip.id, start, end, limit, audio));
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="trim-panel share-panel">
      <div className="trim-row">
        <strong>Share to Discord</strong>
        <span className="muted">
          {range ? `Selection ${clock(start)} to ${clock(end)}` : `Whole clip, ${clock(end)}`}
        </span>
        <label className="trim-mode" title="The copy is squeezed to fit under this size. Discord's limit is 20 MB.">
          Size limit
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {LIMITS.map((l) => (
              <option key={l} value={l}>
                {l} MB
              </option>
            ))}
          </select>
        </label>
        {clip.audioTracks > 0 && (
          <label className="trim-mode" title="Which audio goes into the copy.">
            Audio
            <select value={audio} onChange={(e) => setAudio(e.target.value)}>
              {clip.audioTracks > 1 && <option value="mix">All tracks mixed</option>}
              {Array.from({ length: clip.audioTracks }, (_, i) => (
                <option key={i} value={String(i)}>
                  {trackNames[i] ?? `Track ${i + 1}`}
                </option>
              ))}
              <option value="none">No audio</option>
            </select>
          </label>
        )}
        <span className="spacer" />
        <button className="primary" onClick={make} disabled={busy || end - start < 0.2}>
          {busy ? "Working…" : "Make and copy"}
        </button>
        <button onClick={onClose} disabled={busy}>
          Close
        </button>
      </div>
      {busy && <div className="muted small">Squeezing the clip down. This can take a little while for long clips.</div>}
      {done && (
        <div className="good small">
          Copied ({(done.sizeBytes / 1_000_000).toFixed(1)} MB). Paste it into Discord with Ctrl+V.{" "}
          <button className="link" onClick={() => revealInFolder(done.path).catch(() => {})}>
            Show file
          </button>
        </div>
      )}
      {problem && <div className="bad small">{problem}</div>}
    </div>
  );
}
