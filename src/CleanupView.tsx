import { useEffect, useRef, useState } from "react";
import * as mpv from "./mpv";
import {
  cleanupBatch,
  cleanupInfo,
  errorMessage,
  fileUrl,
  finishPendingDeletes,
  getClip,
  getSettings,
  moveClips,
  pickFolder,
  markPendingDelete,
  resetReviewed,
  setFavorite,
  setReviewed,
  type Clip,
} from "./api";
import { formatBytes } from "./format";
import { PlayerView } from "./PlayerView";

const ROUNDS = [
  { n: 5, name: "Quick round", blurb: "A few spare minutes" },
  { n: 10, name: "Standard round", blurb: "A good session" },
  { n: 20, name: "Deep clean", blurb: "A proper tidy-up" },
];
const SECONDS_PER_CLIP = 15;
const STATS_KEY = "cleanupStats";

/** What cleanup has done so far, remembered between runs, so estimates can match how you really clean. */
interface Lifetime {
  kept: number;
  deleted: number;
  freed: number;
}
function readLifetime(): Lifetime {
  try {
    return { kept: 0, deleted: 0, freed: 0, ...JSON.parse(localStorage.getItem(STATS_KEY) ?? "{}") };
  } catch {
    return { kept: 0, deleted: 0, freed: 0 };
  }
}
function addLifetime(kept: number, deleted: number, freed: number) {
  const now = readLifetime();
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify({ kept: now.kept + kept, deleted: now.deleted + deleted, freed: now.freed + freed }));
  } catch {
    /* not saved */
  }
}

/** A number that counts up to its value when it appears. */
function CountUp({ value, format = (n: number) => String(Math.round(n)), ms = 900 }: { value: number; format?: (n: number) => string; ms?: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (document.documentElement.dataset.motion === "off") {
      setShown(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const from = 0;
    const tick = (now: number) => {
      const k = Math.min((now - start) / ms, 1);
      setShown(from + (value - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return <>{format(shown)}</>;
}

/** A burst of small colored pieces, for finishing a round that freed space. */
function Confetti() {
  const pieces = Array.from({ length: 28 }, (_, i) => i);
  return (
    <div className="confetti" aria-hidden>
      {pieces.map((i) => (
        <i
          key={i}
          style={{
            left: `${(i * 37) % 100}%`,
            animationDelay: `${(i % 7) * 0.07}s`,
            animationDuration: `${1.4 + (i % 5) * 0.25}s`,
            background: i % 3 === 0 ? "var(--accent)" : i % 3 === 1 ? "var(--good)" : "#ffc857",
            transform: `rotate(${i * 29}deg)`,
          }}
        />
      ))}
    </div>
  );
}
const AGES: { days: number | null; label: string }[] = [
  { days: null, label: "Any age" },
  { days: 30, label: "Older than 30 days" },
  { days: 90, label: "Older than 90 days" },
  { days: 180, label: "Older than 180 days" },
  { days: 365, label: "Older than a year" },
];
const NUDGE_KEY = "cleanupNoNudge";

type Decision = "keep" | "delete" | "skip" | null;
interface Snapshot {
  title: string;
  game: string | null;
  tags: string;
  size: number;
  favorite: boolean;
}

const snapshot = (c: Clip): Snapshot => ({ title: c.title, game: c.game, tags: c.tags.join("\u0001"), size: c.sizeBytes, favorite: c.favorite });

/** Has the clip been renamed, tagged, given a game or trimmed since the round began? */
function touched(now: Clip, before: Snapshot | undefined): boolean {
  if (!before) return false;
  const s = snapshot(now);
  return s.title !== before.title || s.game !== before.game || s.tags !== before.tags || s.size !== before.size || s.favorite !== before.favorite;
}

function readNoNudge(): boolean {
  try {
    return localStorage.getItem(NUDGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * A quick round of clip cleanup: random clips that aren't starred and haven't
 * been looked at yet, one at a time. Deleting only hides a clip; the files go
 * to the Recycle Bin when the round ends (or the app closes), so Back can
 * always undo a choice before then.
 */
export function CleanupView({
  onUnavailable,
  onLeave,
  onPlayingChange,
}: {
  onUnavailable: (reason: string) => void;
  onLeave: () => void;
  /** True while a clip is on screen (the window has to be see-through for the video). */
  onPlayingChange: (playing: boolean) => void;
}) {
  // Only clips older than this many days (set from the Storage page too).
  const [age, setAge] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem("cleanupAge"));
      return v > 0 ? v : null;
    } catch {
      return null;
    }
  });
  const [remaining, setRemaining] = useState<number | null>(null);
  const [poolBytes, setPoolBytes] = useState(0);
  const [lifetime, setLifetime] = useState<Lifetime>(readLifetime);
  const [round, setRound] = useState<Clip[] | null>(null);
  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [before, setBefore] = useState<Record<number, Snapshot>>({});
  const [done, setDone] = useState<{ kept: number; deleted: number; skipped: number; freed: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [nudge, setNudge] = useState(false);
  const [dontAsk, setDontAsk] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A random clip shown in the example picture (nothing is changed by looking).
  const [sample, setSample] = useState<Clip | null>(null);
  const busyRef = useRef(false);

  const loadInfo = () =>
    cleanupInfo(age)
      .then((i) => {
        setRemaining(i.remaining);
        setPoolBytes(i.bytes);
      })
      .catch((e) => setProblem(errorMessage(e)));
  useEffect(() => {
    loadInfo();
  }, [age]);
  useEffect(() => {
    cleanupBatch(1)
      .then((b) => setSample(b[0] ?? null))
      .catch(() => {});
  }, []);

  // Anything still waiting to be deleted when this screen goes away is deleted then.
  const waiting = useRef(0);
  waiting.current = decisions.filter((d) => d === "delete").length;
  useEffect(
    () => () => {
      if (waiting.current > 0) finishPendingDeletes().catch(() => {});
    },
    [],
  );

  async function start(count: number) {
    setProblem(null);
    try {
      try {
        localStorage.setItem("cleanupAge", age === null ? "" : String(age));
      } catch {
        /* not saved */
      }
      const batch = await cleanupBatch(count, age);
      setRound(batch);
      setIndex(0);
      setDecisions(batch.map(() => null));
      setBefore(Object.fromEntries(batch.map((c) => [c.id, snapshot(c)])));
      setDone(null);
    } catch (e) {
      setProblem(errorMessage(e));
    }
  }

  const clip = round && !done && index < round.length ? round[index] : null;
  const playing = clip !== null;
  useEffect(() => {
    onPlayingChange(playing);
  }, [playing]);
  useEffect(() => () => onPlayingChange(false), []);

  function update(updated: Clip) {
    setRound((r) => r && r.map((c) => (c.id === updated.id ? updated : c)));
  }

  /** End the round: carry out the deletions and show the summary. */
  async function finish() {
    if (busyRef.current || !round) return;
    busyRef.current = true;
    setBusy(true);
    try {
      // The player may still have a file open, which would block deleting it.
      if (waiting.current > 0) await mpv.stop().catch(() => {});
      const result = await finishPendingDeletes();
      const count = (d: Decision) => decisions.filter((x) => x === d).length;
      addLifetime(count("keep"), result.count, result.bytes);
      setLifetime(readLifetime());
      setDone({ kept: count("keep"), deleted: result.count, skipped: count("skip"), freed: result.bytes });
      setNudge(false);
      loadInfo();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  // A round that runs out of clips ends by itself.
  useEffect(() => {
    if (round && !done && index >= round.length) finish();
  }, [index, round, done]);

  async function decide(action: Exclude<Decision, null>) {
    if (!clip || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setProblem(null);
    try {
      if (action === "keep") await setReviewed(clip.id, true);
      if (action === "delete") await markPendingDelete(clip.id, true);
      setDecisions((d) => d.map((x, i) => (i === index ? action : x)));
      setIndex((i) => i + 1);
      setNudge(false);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  /** Pick a folder, move the clip there, and count it as kept. */
  async function moveAndKeep() {
    if (!clip || busyRef.current) return;
    try {
      const root = (await getSettings()).sourceDir;
      const parent = clip.path.slice(0, Math.max(clip.path.lastIndexOf("\\"), clip.path.lastIndexOf("/")));
      const dest = await pickFolder(parent);
      if (!dest) return;
      if (root && !dest.toLowerCase().startsWith(root.toLowerCase())) {
        setProblem("Pick a folder inside your clips folder.");
        return;
      }
      await mpv.stop().catch(() => {});
      await moveClips([clip.id], dest);
      update(await getClip(clip.id));
      await decide("keep");
    } catch (e) {
      setProblem(errorMessage(e));
    }
  }

  function askKeep() {
    if (clip && !readNoNudge() && !touched(clip, before[clip.id])) {
      setDontAsk(false);
      setNudge(true);
    } else {
      decide("keep");
    }
  }

  /** Go back one clip and undo what was chosen for it. */
  async function back() {
    if (index === 0 || busyRef.current || !round) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const previous = round[index - 1];
      const choice = decisions[index - 1];
      if (choice === "keep") await setReviewed(previous.id, false);
      if (choice === "delete") await markPendingDelete(previous.id, false);
      setDecisions((d) => d.map((x, i) => (i === index - 1 ? null : x)));
      setIndex(index - 1);
      setNudge(false);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function toggleFavorite() {
    if (!clip || busyRef.current) return;
    try {
      update(await setFavorite(clip.id, !clip.favorite));
    } catch (e) {
      setProblem(errorMessage(e));
    }
  }

  async function leave() {
    if (waiting.current > 0) await finishPendingDeletes().catch(() => {});
    waiting.current = 0;
    onLeave();
  }

  if (clip && round) {
    const kept = decisions.filter((d) => d === "keep").length;
    const toDelete = decisions.filter((d) => d === "delete").length;
    const markedBytes = round.reduce((sum, c, i) => sum + (decisions[i] === "delete" ? c.sizeBytes : 0), 0);
    return (
      <div className="cleanup">
        <div className="cleanup-top">
          <strong>
            Clip {index + 1} of {round.length}
          </strong>
          <span className="muted">
            {kept} kept, {toDelete} to delete
            {markedBytes > 0 && <> (frees about {formatBytes(markedBytes)})</>}
          </span>
          <span className="spacer" />
          <button onClick={finish} disabled={busy} title="Stop here: clips you marked for deletion go to the Recycle Bin">
            End session
          </button>
        </div>
        <div className="cu-progress" aria-hidden>
          <i style={{ width: `${(index / round.length) * 100}%` }} />
        </div>
        <PlayerView
          clip={clip}
          onChange={update}
          onExported={() => {}}
          onOpenClip={() => {}}
          onClose={leave}
          onUnavailable={onUnavailable}
        />
        <div className="cleanup-actions">
          <button className="back-btn" onClick={back} disabled={busy || index === 0} title="Go back and undo your choice for the previous clip">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3" />
            </svg>
            Back
          </button>
          <button className="big danger" onClick={() => decide("delete")} disabled={busy} title="Hide it now; it goes to the Recycle Bin when the session ends">
            Delete
          </button>
          <button className="big skip" onClick={() => decide("skip")} disabled={busy} title="Leave it for a later round">
            Skip
          </button>
          <button
            className={clip.favorite ? "fav-btn on" : "fav-btn"}
            onClick={toggleFavorite}
            disabled={busy}
            title={clip.favorite ? "Starred: it won't come up in cleanup again. Click to unstar." : "Star it as a favorite. Starred clips are left out of cleanup rounds."}
            aria-label="Favorite"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill={clip.favorite ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
              <path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.2 1.3-6.6L2.5 9.4l6.6-.8z" />
            </svg>
          </button>
          <button className="big skip" onClick={moveAndKeep} disabled={busy} title="Move it to a folder (it counts as kept)">
            Move…
          </button>
          <button className="big keep" onClick={askKeep} disabled={busy}>
            Keep
          </button>
        </div>
        {problem && <div className="bad small cleanup-problem">{problem}</div>}

        {nudge && (
          <div className="modal-back" onMouseDown={() => setNudge(false)}>
            <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
              <h2>Keep it as it is?</h2>
              <p className="muted small">
                You haven't trimmed, renamed or tagged this clip. You can still do that, or keep it anyway.
              </p>
              <label className="trim-mode">
                <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
                Don't ask me again
              </label>
              <div className="modal-actions">
                <button
                  className="primary"
                  onClick={() => {
                    if (dontAsk) {
                      try {
                        localStorage.setItem(NUDGE_KEY, "1");
                      } catch {
                        /* not saved */
                      }
                    }
                    decide("keep");
                  }}
                  autoFocus
                >
                  Keep it
                </button>
                <button onClick={() => setNudge(false)}>Go back to the clip</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Estimates: the average clip size here, and how much of a round you usually delete.
  const average = remaining && remaining > 0 ? poolBytes / remaining : 0;
  const decided = lifetime.kept + lifetime.deleted;
  const deleteRate = decided >= 10 ? lifetime.deleted / decided : 0.3;
  const estimate = (n: number) => Math.min(n, remaining ?? 0) * average * deleteRate;
  const minutes = (n: number) => Math.max(1, Math.round((Math.min(n, remaining ?? n) * SECONDS_PER_CLIP) / 60));

  if (done) {
    return (
      <div className="cleanup-start cu-done">
        {done.deleted > 0 && <Confetti />}
        <div className="cu-done-card">
          <h1>{done.deleted > 0 ? "Nicely done!" : "Round finished"}</h1>
          {done.deleted > 0 ? (
            <>
              <div className="cu-big">
                <CountUp value={done.freed} format={formatBytes} ms={1200} />
              </div>
              <p className="muted">freed. Your deleted clips are in the Recycle Bin if you change your mind.</p>
            </>
          ) : (
            <p className="muted">Nothing deleted this time. Your clips are safe and sound.</p>
          )}
          <div className="cu-chips">
            <span className="cu-chip keep">{done.kept} kept</span>
            <span className="cu-chip del">{done.deleted} deleted</span>
            {done.skipped > 0 && <span className="cu-chip">{done.skipped} skipped</span>}
          </div>
          <div className="setting-row">
            <button className="primary" onClick={() => start(ROUNDS[1].n)} disabled={remaining === 0}>
              Another round
            </button>
            <button onClick={onLeave}>Back to the library</button>
          </div>
          {problem && <p className="bad small">{problem}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="cleanup-start">
      <div className="cleanup-intro">
        <h1>Clean up your clips</h1>
        <p className="muted">
          Watch a few random clips and decide: keep it, or delete it. Nothing is deleted until you finish, and deleted
          clips go to the Recycle Bin.
        </p>

        <div className="cu-stats">
          <div className="cu-stat">
            <span className="cu-num">{remaining === null ? "–" : <CountUp value={remaining} />}</span>
            <span className="muted">clips to review</span>
          </div>
          <div className="cu-stat">
            <span className="cu-num">{remaining === null ? "–" : <CountUp value={poolBytes} format={formatBytes} />}</span>
            <span className="muted">in those clips</span>
          </div>
          {lifetime.freed > 0 && (
            <div className="cu-stat good">
              <span className="cu-num">
                <CountUp value={lifetime.freed} format={formatBytes} />
              </span>
              <span className="muted">freed so far</span>
            </div>
          )}
        </div>

        <h3 className="cu-heading">Pick a round</h3>
        <div className="cu-rounds">
          {ROUNDS.map((r, i) => (
            <button key={r.n} className="cu-round" style={{ animationDelay: `${0.08 * i}s` }} onClick={() => start(r.n)} disabled={!remaining}>
              <span className="cu-round-name">{r.name}</span>
              <span className="cu-round-meta">
                {Math.min(r.n, remaining ?? r.n)} clips, about {minutes(r.n)} min
              </span>
              <span className="cu-round-save">
                {average > 0 ? <>might free ~{formatBytes(estimate(r.n))}</> : r.blurb}
              </span>
            </button>
          ))}
        </div>
        <label className="cu-focus">
          Focus on
          <select value={age ?? ""} onChange={(e) => setAge(e.target.value === "" ? null : Number(e.target.value))}>
            {AGES.map((a) => (
              <option key={a.label} value={a.days ?? ""}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">
          Estimates use your average clip size and how much of a round you usually delete
          {decided >= 10 ? ` (about ${Math.round(deleteRate * 100)}%)` : " (we'll learn as you go; starting at about a third)"}.
        </p>
        {remaining === 0 && (
          <p className="muted small">
            You've been through every clip.{" "}
            <button className="link" onClick={() => resetReviewed().then(loadInfo).catch((e) => setProblem(errorMessage(e)))}>
              Let kept clips come up again
            </button>
          </p>
        )}
        {problem && <p className="bad small">{problem}</p>}
      </div>
      <div className="mock-wrap">
        <CleanupPreview sample={sample} />
      </div>
    </div>
  );
}

/** A little looping picture of how a round works. */
function CleanupPreview({ sample }: { sample: Clip | null }) {
  return (
    <div className="mock" aria-hidden>
      <div className="mock-bar">
        <strong>Clip 3 of 10</strong>
        <span>2 kept, 1 to delete</span>
        <span className="mock-end">End session</span>
      </div>
      <div
        className="mock-video"
        style={sample?.thumbPath ? { backgroundImage: `linear-gradient(rgba(0,0,0,0.25), rgba(0,0,0,0.55)), url("${fileUrl(sample.thumbPath)}")` } : undefined}
      >
        <div className="mock-title">{sample?.title ?? "Funny moment"}</div>
        <div className="mock-caption c1">Watch it. Rename, tag or trim it if you like.</div>
        <div className="mock-caption c2">Not a keeper? Delete. It only goes to the Recycle Bin when you finish, so Back can undo it.</div>
        <div className="mock-caption c3">A good one? Keep it and it won't come up again.</div>
      </div>
      <div className="mock-actions">
        <span className="mock-btn back">Back</span>
        <span className="mock-btn del">Delete</span>
        <span className="mock-btn skip">Skip</span>
        <span className="mock-btn star">★</span>
        <span className="mock-btn keep">Keep</span>
        <span className="mock-cursor" />
      </div>
    </div>
  );
}
