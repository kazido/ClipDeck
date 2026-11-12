import { useEffect, useReducer, useRef, useState } from "react";
import { clipDetails, clipFilmstrip, clipKeyframes, copyClipFile, deleteClips, errorMessage, revealInFolder, createTag, setClipNotes, type Clip, type Filmstrip } from "./api";
import { useNotice } from "./Notice";
import { ConfirmDelete } from "./BulkActions";
import { BigFrame } from "./FramePreview";
import { ClipEditor } from "./ClipEditor";
import { TagManager } from "./TagManager";
import { Visualizer } from "./Visualizer";
import { TrimPanel, effectiveStart, type TrimState } from "./TrimPanel";
import { SharePanel } from "./SharePanel";
import { ClipFacts } from "./Player";
import * as mpv from "./mpv";

interface Props {
  clip: Clip;
  /** The clip was renamed or given a different game. */
  onChange: (clip: Clip) => void;
  /** Go to the neighbouring clips in the library; missing at either end. */
  onPrev?: () => void;
  /** A trimmed copy was saved and added to the library. */
  onExported: (clip: Clip) => void;
  onOpenClip: (clip: Clip) => void;
  /** The clip was moved to the Recycle Bin. When missing, the Delete button is hidden. */
  onDeleted?: (clip: Clip) => void;
  onNext?: () => void;
  onClose: () => void;
  /** Called when mpv can't start, so the app can use the basic player instead. */
  onUnavailable: (reason: string) => void;
}

const MIX = "mix";

/** Full-size player built on mpv, with our own controls. */
/** The longest a clip's note may be (the backend enforces the same limit). */
const NOTES_MAX = 500;

export function PlayerView({ clip, onChange, onPrev, onNext, onExported, onOpenClip, onDeleted, onClose, onUnavailable }: Props) {
  const [state, patch] = useReducer(
    (s: mpv.PlayerState, p: Partial<mpv.PlayerState>) => ({ ...s, ...p }),
    mpv.INITIAL_STATE,
  );
  // Which entry of the Audio menu is active: a position in the track list, or MIX.
  // Starts on the first track, which is what mpv plays by default.
  const [audioChoice, setAudioChoice] = useState("0");
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [newTag, setNewTag] = useState("");
  const makeTag = () => {
    const name = newTag.trim();
    if (!name) return;
    createTag(name)
      .then(() => {
        setNewTag("");
        window.dispatchEvent(new Event("tags-changed"));
        notify(`Tag "${name}" created. Add it to a clip with + Tag.`);
      })
      .catch((e) => notify(errorMessage(e), "bad"));
  };
  const [trim, setTrim] = useState<TrimState | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [managingTags, setManagingTags] = useState(false);
  const notify = useNotice();
  const [notes, setNotes] = useState(clip.notes);
  useEffect(() => setNotes(clip.notes), [clip.id, clip.notes]);
  const [keyframes, setKeyframes] = useState<number[]>([]);
  // Tiny frames along the clip, made the first time they're wanted.
  const [strip, setStrip] = useState<Filmstrip | null>(null);
  const stripAsked = useRef<string | null>(null);
  function askForStrip() {
    const key = `${clip.id}-${clip.sizeBytes}`;
    if (stripAsked.current === key) return;
    stripAsked.current = key;
    clipFilmstrip(clip.id)
      .then((s) => stripAsked.current === key && setStrip(s))
      .catch(() => {
        if (stripAsked.current === key) stripAsked.current = null;
      });
  }
  // Track names as written by the recorder (e.g. OBS). mpv doesn't read the
  // place MP4 files keep them, so they come from our own probe of the file.
  const [trackNames, setTrackNames] = useState<(string | null)[]>([]);

  // Each clip starts with the trim panel closed.
  useEffect(() => {
    setTrim(null);
    setShareOpen(false);
    setKeyframes([]);
    setStrip(null);
    stripAsked.current = null;
    // A new clip starts playing by itself; forget anything left over from a drag.
    scrubbing.current = false;
    resumeAfter.current = false;
    setDragging(false);
    setScrubTime(null);
  }, [clip.id, clip.sizeBytes]);

  function openTrim() {
    if (trim) return setTrim(null);
    setTrim({ start: 0, end: state.duration || clip.durationMs / 1000, precise: false });
    clipKeyframes(clip.id).then(setKeyframes).catch(() => {});
    askForStrip();
  }

  useEffect(() => {
    let active = true;
    setTrackNames([]);
    clipDetails(clip.id)
      .then((details) => active && setTrackNames(details.audio.map((a) => a.title)))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [clip.id]);
  const videoArea = useRef<HTMLDivElement>(null);
  const clipPath = useRef(clip.path);
  clipPath.current = clip.path;

  const run = (action: Promise<unknown>) => action.catch((e) => setProblem(errorMessage(e)));

  // Start mpv, load the clip, and follow its state.
  useEffect(() => {
    let active = true;
    let unwatch = () => {};
    setAudioChoice("0");
    mpv
      .startMpv()
      .then(() => mpv.watchPlayer((p) => active && patch(p)))
      .then((off) => {
        unwatch = off;
        if (!active) return off();
        return mpv.loadFile(clip.path).catch((e) => setProblem(errorMessage(e)));
      })
      .catch((e) => active && onUnavailable(errorMessage(e)));
    return () => {
      active = false;
      unwatch();
      mpv.stop().catch(() => {});
    };
  }, [clip.path, onUnavailable]);

  // The window's close button destroys mpv (and only hides the window). When
  // the window is back, start mpv again and reopen the clip if it was lost.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === "hidden") return;
      mpv
        .startMpv()
        .then(async () => {
          if (await mpv.isIdle()) {
            await mpv.loadFile(clipPath.current);
            const el = videoArea.current;
            if (el) await mpv.setVideoArea(el.getBoundingClientRect());
          }
        })
        .catch(() => {});
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  // Keep mpv's picture lined up with the transparent area of the page.
  useEffect(() => {
    const el = videoArea.current;
    if (!el) return;
    const sync = () => mpv.setVideoArea(el.getBoundingClientRect()).catch(() => {});
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    window.addEventListener("resize", sync);
    // mpv ignores this until it has started, so send it again once it has.
    mpv.startMpv().then(sync, () => {});
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, []);

  function togglePlay() {
    resumeAfter.current = false;
    if (state.ended) run(mpv.seekTo(0).then(() => mpv.setPaused(false)));
    else run(mpv.togglePause());
  }

  function chooseAudio(choice: string) {
    const previous = audioChoice;
    setProblem(null);
    setAudioChoice(choice); // show it straight away; undone below if mpv refuses
    const change =
      choice === MIX
        ? mpv.mixAllAudioTracks(state.audioTracks)
        : mpv.selectAudioTrack(state.audioTracks[Number(choice)].id);
    change.catch((e) => {
      setAudioChoice(previous);
      setProblem(errorMessage(e));
    });
  }

  // ---- scrubbing (the seek bar and the trim handles work the same way) ----
  // While the pointer moves, the picture follows it with quick jumps to the
  // nearest keyframe, which keeps it lively without any extra work. As soon as
  // the pointer rests for a moment, the player moves to the exact frame, and
  // it does so for good when you let go. Frame buttons (and the , and . keys)
  // fine-tune from there. Playback pauses during a drag and resumes after.
  const scrubbing = useRef(false);
  // True from the start of a drag until the player has landed on the exact frame.
  const [dragging, setDragging] = useState(false);
  const [dragTime, setDragTime] = useState(0);
  // Set when a drag paused playback that should carry on afterwards. It stays
  // set until playback really resumes (or the user plays or pauses by hand),
  // so quick back-to-back drags can't lose it.
  const resumeAfter = useRef(false);
  const settleTimer = useRef<number | undefined>(undefined);
  const lastScrub = useRef(0);
  const latest = useRef(state);
  latest.current = state;

  // Seeks go out one at a time, keeping only the newest one waiting. Callbacks
  // of waiting seeks that get replaced are kept and run when the next one ends.
  const seekBusy = useRef(false);
  const seekNext = useRef<{ t: number; fast: boolean; dones: (() => void)[] } | null>(null);
  function seekSmooth(t: number, fast: boolean, done?: () => void) {
    if (seekBusy.current) {
      const dones = [...(seekNext.current?.dones ?? []), ...(done ? [done] : [])];
      seekNext.current = { t, fast, dones };
      return;
    }
    seekBusy.current = true;
    // A seek that never answers (for example while the clip is still loading)
    // must not block the ones after it.
    Promise.race([mpv.seekTo(t, fast), new Promise((resolve) => setTimeout(resolve, 2000))])
      .catch(() => {})
      .finally(() => {
        seekBusy.current = false;
        done?.();
        const next = seekNext.current;
        seekNext.current = null;
        if (next) {
          const [first, ...rest] = next.dones;
          seekSmooth(next.t, next.fast, () => {
            first?.();
            rest.forEach((d) => d());
          });
        }
      });
  }

  function resumePlayback() {
    if (!resumeAfter.current) return;
    resumeAfter.current = false;
    run(mpv.setPaused(false));
  }

  // Called for every move of a drag (final = false) and once on release (final = true).
  function scrub(seconds: number, final: boolean) {
    setScrubTime(final ? null : seconds);
    window.clearTimeout(settleTimer.current);
    lastScrub.current = seconds;
    if (!final) {
      setDragTime(seconds);
      if (!scrubbing.current) {
        scrubbing.current = true;
        setDragging(true);
        askForStrip();
        const s = latest.current;
        // Keep an unfinished "resume" from an earlier drag: the player may still
        // report paused from it.
        if (!s.paused && !s.ended) {
          resumeAfter.current = true;
          run(mpv.setPaused(true));
        }
      }
      seekSmooth(seconds, true);
      settleTimer.current = window.setTimeout(() => seekSmooth(seconds, false), 90);
      return;
    }
    setDragTime(seconds);
    scrubbing.current = false;
    seekSmooth(seconds, false, () => {
      // The player is on the exact frame now: swap the stand-in picture away.
      window.setTimeout(() => setDragging(false), 80);
      resumePlayback();
    });
    // Even if that seek is slow or lost, playback must not stay paused.
    window.setTimeout(() => {
      if (!scrubbing.current) {
        setDragging(false);
        resumePlayback();
      }
    }, 3000);
  }

  // A drag that ends outside the slider (or is interrupted) must still end.
  useEffect(() => {
    const end = () => {
      if (scrubbing.current) scrub(lastScrub.current, true);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  });

  // Keyboard shortcuts.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    const typing =
      e.target instanceof HTMLSelectElement ||
      e.target instanceof HTMLTextAreaElement ||
      (e.target instanceof HTMLInputElement && e.target.type !== "range" && e.target.type !== "checkbox");
    // Ctrl+C copies the clip itself, unless some text is selected to copy.
    if (!typing && e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "c" && !window.getSelection()?.toString()) {
      copyClipFile(clip.id)
        .then(() => notify("Copied. Paste it into Discord or a folder with Ctrl+V."))
        .catch((err) => notify(errorMessage(err), "bad"));
      e.preventDefault();
      return;
    }
    // Ctrl + arrow keys move to the previous or next clip.
    if (!typing && e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const go = e.key === "ArrowLeft" ? onPrev : onNext;
      if (go) go();
      e.preventDefault();
      return;
    }
    if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
    const digit = /^[1-9]$/.test(e.key) ? Number(e.key) : null;
    if (e.key === " ") togglePlay();
    else if (e.key === "ArrowLeft") run(mpv.seekBy(-5));
    else if (e.key === "ArrowRight") run(mpv.seekBy(5));
    else if (e.key === ",") run(mpv.stepFrame(-1));
    else if (e.key === ".") run(mpv.stepFrame(1));
    else if (trim && e.key.toLowerCase() === "i") setTrim({ ...trim, start: Math.min(state.time, trim.end - 0.1) });
    else if (trim && e.key.toLowerCase() === "o") setTrim({ ...trim, end: Math.max(state.time, trim.start + 0.1) });
    else if (e.key.toLowerCase() === "m") run(mpv.setMuted(!state.muted));
    else if (digit !== null) run(mpv.seekToPercent(digit * 10));
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const time = scrubTime ?? state.time;
  return (
    <div className="player-view">
      <div className="player-main">
        <header className="player-head">
          <button onClick={onClose} title="Back to library (Esc)">
            ← Library
          </button>
          <ClipEditor clip={clip} onChange={onChange} onManageTags={() => setManagingTags(true)} />
          <div className="head-actions">
          <button
            className="head-btn"
            onClick={() =>
              copyClipFile(clip.id)
                .then(() => notify("Copied. Paste it into Discord or a folder with Ctrl+V."))
                .catch((e) => notify(errorMessage(e), "bad"))
            }
            title="Copy this clip to the clipboard, ready to paste into Discord or a folder"
            aria-label="Copy clip"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="8" y="8" width="12" height="12" rx="2" />
              <path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" />
            </svg>
            Copy
          </button>
          {onDeleted && (
            <button className="delete-btn" onClick={() => setConfirmDelete(true)} title="Move this clip to the Recycle Bin" aria-label="Delete clip">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6" />
              </svg>
              Delete
            </button>
          )}
          <div className="details-wrap">
            <button onClick={() => setShowDetails(!showDetails)} aria-expanded={showDetails} title="File details">
              Details
            </button>
            {showDetails && (
              <>
                <div className="filter-back" onMouseDown={() => setShowDetails(false)} />
                <aside className="player-side details-pop">
                  <p className="muted file-name">{clip.fileName}</p>
                  <button className="file-path" title="Show this file in its folder" onClick={() => revealInFolder(clip.path).catch((e) => notify(errorMessage(e), "bad"))}>
                    {clip.path}
                  </button>
                  <ClipFacts clip={clip} />
                  <h3>Notes</h3>
                  <textarea
                    className="notes"
                    maxLength={NOTES_MAX}
                    value={notes}
                    placeholder="Add a note about this clip"
                    onChange={(e) => setNotes(e.target.value)}
                    onBlur={() => {
                      if (notes.trim() !== clip.notes) {
                        setClipNotes(clip.id, notes).then(onChange).catch((e) => notify(errorMessage(e), "bad"));
                      }
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                  <div className="notes-count muted small">
                    {notes.length} / {NOTES_MAX}
                  </div>
                  <h3>Tags</h3>
                  <button
                    onClick={() => {
                      setShowDetails(false);
                      setManagingTags(true);
                    }}
                  >
                    Manage tags…
                  </button>
                  <div className="tag-create">
                    <input
                      value={newTag}
                      onChange={(e) => setNewTag(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") makeTag();
                      }}
                      placeholder="New tag name"
                      aria-label="New tag name"
                    />
                    <button disabled={!newTag.trim()} onClick={makeTag}>
                      Create tag
                    </button>
                  </div>
                </aside>
              </>
            )}
          </div>
          <button className="viewer-close" onClick={onClose} title="Back to the library (Esc)" aria-label="Close clip">
            ✕
          </button>
          </div>
        </header>

        {/* Transparent: mpv's picture shows through here. */}
        <div className="video-wrap">
          <div className="video-area" ref={videoArea} onClick={togglePlay} />
          {dragging && strip && <BigFrame strip={strip} time={dragTime} />}
          {onPrev && (
            <button className="nav-arrow prev" onClick={onPrev} title="Previous clip (Ctrl+Left)" aria-label="Previous clip">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 4l-8 8 8 8" />
              </svg>
            </button>
          )}
          {onNext && (
            <button className="nav-arrow next" onClick={onNext} title="Next clip (Ctrl+Right)" aria-label="Next clip">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 4l8 8-8 8" />
              </svg>
            </button>
          )}
        </div>

        <div className="controls">
          {shareOpen && (
            <SharePanel
              clip={clip}
              range={trim ? { start: effectiveStart(trim, keyframes), end: trim.end } : null}
              trackNames={state.audioTracks.map((t, i) => trackNames[i] ?? t.title ?? `Track ${i + 1}`)}
              onClose={() => setShareOpen(false)}
            />
          )}
          {trim && (
            <TrimPanel
              clip={clip}
              duration={state.duration || clip.durationMs / 1000}
              time={time}
              keyframes={keyframes}
              trim={trim}
              onTrim={setTrim}
              onSeek={scrub}
              onClose={() => setTrim(null)}
              onExported={onExported}
              onOpenClip={onOpenClip}
              onBeforeReplace={() => mpv.stop().catch(() => {})}
              onReplaced={(made) => {
                setTrim(null);
                onChange(made);
                run(mpv.loadFile(made.path));
              }}
              onReplaceFailed={() => {
                run(mpv.loadFile(clip.path));
              }}
            />
          )}
          <input
            className="seek"
            type="range"
            min={0}
            max={state.duration || 1}
            step={0.001}
            value={Math.min(time, state.duration || 1)}
            onChange={(e) => scrub(Number(e.target.value), false)}
            onPointerUp={(e) => scrub(Number(e.currentTarget.value), true)}
            onKeyUp={(e) => scrub(Number(e.currentTarget.value), true)}
            aria-label="Seek"
          />

          <div className="control-row">
            <button className="play" onClick={togglePlay} title="Play / pause (Space)">
              {state.paused || state.ended ? "▶" : "❚❚"}
            </button>
            <button className="frame-btn" onClick={() => run(mpv.stepFrame(-1))} title="Back one frame (,)" aria-label="Back one frame">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                <rect x="4" y="5" width="2.5" height="14" rx="0.5" stroke="none" />
                <path d="M19 6v12l-10-6z" />
              </svg>
            </button>
            <button className="frame-btn" onClick={() => run(mpv.stepFrame(1))} title="Forward one frame (.)" aria-label="Forward one frame">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                <rect x="17.5" y="5" width="2.5" height="14" rx="0.5" stroke="none" />
                <path d="M5 6v12l10-6z" />
              </svg>
            </button>
            <span className="time">
              {formatClock(time)} / {formatClock(state.duration)}
            </span>

            <span className="spacer" />
            <button
              className={shareOpen ? "frame-btn on" : "frame-btn"}
              onClick={() => setShareOpen(!shareOpen)}
              title="Make a small copy and copy it to the clipboard, ready to paste into Discord"
              aria-label="Share"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M16 6l-4-4-4 4M12 2v13" />
              </svg>
              Share
            </button>
            <button className={trim ? "frame-btn on" : "frame-btn"} onClick={openTrim} title="Trim this clip into a new one" aria-label="Trim">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M8.5 8l11.5 9M8.5 16L20 7" />
              </svg>
              Trim
            </button>
            <Visualizer key={`${clip.id}-${clip.sizeBytes}`} clipId={clip.id} time={time} paused={state.paused || state.ended} />

            {state.audioTracks.length > 1 && (
              <label className="audio-select">
                Audio
                <select value={audioChoice} onChange={(e) => chooseAudio(e.target.value)}>
                  {state.audioTracks.map((track, i) => (
                    <option key={track.id} value={String(i)}>
                      {trackNames[i] ?? track.title ?? `Track ${i + 1}`}
                    </option>
                  ))}
                  <option value={MIX}>All tracks mixed</option>
                </select>
              </label>
            )}

            <button
              className="frame-btn icon-only"
              onClick={() => run(mpv.setMuted(!state.muted))}
              title={state.muted ? "Unmute (M)" : "Mute (M)"}
              aria-label={state.muted ? "Unmute" : "Mute"}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor" />
                {state.muted ? (
                  <path d="M16 9.5l5 5M21 9.5l-5 5" />
                ) : (
                  <>
                    <path d="M15.5 9a4 4 0 010 6" />
                    <path d="M18 6.5a8 8 0 010 11" />
                  </>
                )}
              </svg>
            </button>
            <input
              className="volume"
              type="range"
              min={0}
              max={100}
              value={state.muted ? 0 : state.volume}
              onChange={(e) => run(mpv.setVolume(Number(e.target.value)))}
              aria-label="Volume"
            />
          </div>
          {problem && <div className="bad small">{problem}</div>}
        </div>
      </div>

      {managingTags && (
        <TagManager
          onClose={() => setManagingTags(false)}
          onRenamed={(from, to) =>
            onChange({ ...clip, tags: [...new Set(clip.tags.map((t) => (t.toLowerCase() === from.toLowerCase() ? to : t)))] })
          }
          onDeleted={(gone) => onChange({ ...clip, tags: clip.tags.filter((t) => t.toLowerCase() !== gone.toLowerCase()) })}
        />
      )}
      {confirmDelete && onDeleted && (
        <ConfirmDelete
          clips={[clip]}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            // Windows won't move a file that is still open in the player.
            await mpv.stop().catch(() => {});
            try {
              await deleteClips([clip.id]);
            } catch (e) {
              mpv.loadFile(clip.path).catch(() => {});
              throw e;
            }
            setConfirmDelete(false);
            onDeleted(clip);
          }}
          onForce={async () => {
            await mpv.stop().catch(() => {});
            await deleteClips([clip.id], true);
            setConfirmDelete(false);
            onDeleted(clip);
          }}
        />
      )}
    </div>
  );
}

/** 1:23.45 */
function formatClock(seconds: number): string {
  const safe = Math.max(seconds, 0);
  const m = Math.floor(safe / 60);
  return `${m}:${(safe - m * 60).toFixed(2).padStart(5, "0")}`;
}
