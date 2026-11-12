import { useRef, useState } from "react";
import { errorMessage, exportTrim, type Clip } from "./api";

export interface TrimState {
  start: number;
  end: number;
  precise: boolean;
}

/** 1:23.45 */
export function clock(seconds: number): string {
  const safe = Math.max(seconds, 0);
  const m = Math.floor(safe / 60);
  return `${m}:${(safe - m * 60).toFixed(2).padStart(5, "0")}`;
}

/** The start a lossless cut will really use: the keyframe at or before it. */
export function effectiveStart(trim: TrimState, keyframes: number[]): number {
  if (trim.precise || keyframes.length === 0) return trim.start;
  let best = keyframes[0];
  for (const k of keyframes) {
    if (k <= trim.start + 0.001) best = k;
    else break;
  }
  return Math.min(best, trim.start);
}

/** The trimming controls: a range bar with two handles, and the save button. */
export function TrimPanel({
  clip,
  duration,
  time,
  keyframes,
  trim,
  onTrim,
  onSeek,
  onClose,
  onExported,
  onOpenClip,
  onBeforeReplace,
  onReplaced,
  onReplaceFailed,
}: {
  clip: Clip;
  duration: number;
  time: number;
  keyframes: number[];
  trim: TrimState;
  onTrim: (trim: TrimState) => void;
  /** `final` is true for the last seek of a drag, which should be exact. */
  onSeek: (seconds: number, final: boolean) => void;
  onClose: () => void;
  onExported: (clip: Clip) => void;
  onOpenClip: (clip: Clip) => void;
  /** Called before the original is replaced, so the player can let go of the file. */
  onBeforeReplace: () => Promise<void>;
  /** The clip now is the trimmed version. */
  onReplaced: (clip: Clip) => void;
  onReplaceFailed: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<Clip | null>(null);
  const [keepOriginal, setKeepOriginal] = useState(false);

  const total = Math.max(duration, 0.1);
  const start = effectiveStart(trim, keyframes);
  const pct = (t: number) => `${Math.min(Math.max(t / total, 0), 1) * 100}%`;
  // A few hundred ticks are plenty to see where the keyframes are.
  const ticks = keyframes.filter((_, i) => i % Math.ceil(keyframes.length / 400 || 1) === 0);

  function drag(which: "start" | "end", e: React.PointerEvent) {
    e.preventDefault();
    const el = track.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    let lastT = which === "start" ? trim.start : trim.end;
    const move = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const t = Math.min(Math.max((ev.clientX - rect.left) / rect.width, 0), 1) * total;
      const next =
        which === "start"
          ? { ...trim, start: Math.min(t, trim.end - 0.1) }
          : { ...trim, end: Math.max(t, trim.start + 0.1) };
      lastT = t;
      onTrim(next);
      onSeek(t, false);
    };
    const up = () => {
      onSeek(lastT, true);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }
  async function save() {
    setSaving(true);
    setProblem(null);
    setSaved(null);
    try {
      if (!keepOriginal) await onBeforeReplace();
      const made = await exportTrim(clip.id, start, trim.end, trim.precise, keepOriginal);
      if (keepOriginal) {
        setSaved(made);
        onExported(made);
      } else {
        onReplaced(made);
      }
    } catch (e) {
      setProblem(errorMessage(e));
      if (!keepOriginal) onReplaceFailed();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="trim-panel">
      <div className="trim-track" ref={track}>
        <div className="trim-range" style={{ left: pct(start), width: `calc(${pct(trim.end)} - ${pct(start)})` }} />
        {ticks.map((k) => (
          <i key={k} className="trim-tick" style={{ left: pct(k) }} />
        ))}
        <div className="trim-playhead" style={{ left: pct(time) }} />
        <div className="trim-handle" style={{ left: pct(start) }} onPointerDown={(e) => drag("start", e)} title="Drag to set the start" />
        <div className="trim-handle end" style={{ left: pct(trim.end) }} onPointerDown={(e) => drag("end", e)} title="Drag to set the end" />
      </div>

      <div className="trim-row">
        <button
          className="trim-time"
          onClick={() => onTrim({ ...trim, start: Math.min(time, trim.end - 0.1) })}
          title="Click to set the start to where the video is now (I)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 4H5v16h4M5 12h14M15 8l4 4-4 4" />
          </svg>
          Start <strong>{clock(start)}</strong>
        </button>
        <button
          className="trim-time"
          onClick={() => onTrim({ ...trim, end: Math.max(time, trim.start + 0.1) })}
          title="Click to set the end to where the video is now (O)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 4h4v16h-4M19 12H5M9 8l-4 4 4 4" />
          </svg>
          End <strong>{clock(trim.end)}</strong>
        </button>
        <span className="muted trim-length">Length {clock(trim.end - start)}</span>

        <label
          className="trim-mode"
          title="Lossless is instant and keeps full quality, but starts at the nearest keyframe before your start point. Precise starts exactly where you say, but re-encodes the clip, which takes longer."
        >
          <input type="checkbox" checked={trim.precise} onChange={(e) => onTrim({ ...trim, precise: e.target.checked })} />
          Precise cut (slower)
        </label>

        <label className="trim-mode" title="Off: the trimmed version replaces this clip, and the original goes to the Windows Recycle Bin. On: the trimmed version is saved as a separate clip next to the original.">
          <input type="checkbox" checked={keepOriginal} onChange={(e) => setKeepOriginal(e.target.checked)} />
          Keep original
        </label>

        <span className="spacer" />
        <button className="primary" onClick={save} disabled={saving || trim.end - start < 0.1}>
          {saving ? "Saving…" : keepOriginal ? "Save as new clip" : "Save trim"}
        </button>
        <button onClick={onClose} disabled={saving}>
          Close
        </button>
      </div>
      <div className="muted small trim-note">
        {!trim.precise && start < trim.start - 0.01
          ? `Lossless cut: the start moved back to the keyframe at ${clock(start)}.`
          : "\u00a0"}
      </div>
      {saved && (
        <div className="good small">
          Saved “{saved.title}” as a new clip next to the original.{" "}
          <button className="link" onClick={() => onOpenClip(saved)}>
            Open it
          </button>
        </div>
      )}
      {problem && <div className="bad small">{problem}</div>}
    </div>
  );
}
