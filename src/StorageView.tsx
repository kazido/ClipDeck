import { useEffect, useState } from "react";
import { errorMessage, storageOverview, type Clip, type Storage, type Usage } from "./api";
import { formatBytes } from "./format";
import { gameColor } from "./format";

/** Where the space goes: by game, by month, the biggest clips, and old clips worth reviewing. */
export function StorageView({
  onOpenClip,
  onReview,
}: {
  onOpenClip: (clip: Clip) => void;
  onReview: (days: number) => void;
}) {
  const [data, setData] = useState<Storage | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    storageOverview()
      .then(setData)
      .catch((e) => setProblem(errorMessage(e)));
  }, []);

  if (problem) return <div className="storage"><p className="bad">{problem}</p></div>;
  if (!data) return <div className="storage"><p className="muted">Counting…</p></div>;

  const monthLabel = (m: string | null) => {
    if (!m) return "Unknown";
    const [y, mo] = m.split("-").map(Number);
    return new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  };

  return (
    <div className="storage">
      <h1>Storage</h1>
      <p className="page-sub">
        {data.totalClips} clips take up <strong>{formatBytes(data.totalBytes)}</strong>.
      </p>

      <section>
        <h2>Older clips</h2>
        <p className="muted small">Clips you haven't starred. Review them in a cleanup round to free up space.</p>
        <div className="age-cards">
          {data.aged.map((a) => (
            <div key={a.days} className="age-card">
              <div className="age-days">{a.days === 365 ? "Over a year old" : `Over ${a.days} days old`}</div>
              <div className="age-size">{formatBytes(a.bytes)}</div>
              <div className="muted small">{a.clips} clip{a.clips === 1 ? "" : "s"}</div>
              <button onClick={() => onReview(a.days)} disabled={a.clips === 0}>
                Review these
              </button>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>By game</h2>
        <Bars rows={data.byGame} total={data.totalBytes} label={(u) => u.name ?? "No game"} color={(u) => (u.name ? gameColor(u.name) : "var(--muted)")} />
      </section>

      <section>
        <h2>By month</h2>
        <Bars rows={data.byMonth} total={data.totalBytes} label={(u) => monthLabel(u.name)} color={() => "var(--accent)"} />
      </section>

      <section>
        <h2>Largest clips</h2>
        <ol className="largest">
          {data.largest.map((c) => (
            <li key={c.id}>
              <span className="largest-title">{c.title}</span>
              {c.game && <span className="muted small">{c.game}</span>}
              <span className="largest-size">{formatBytes(c.sizeBytes)}</span>
              <button onClick={() => onOpenClip(c)}>Open</button>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Bars({
  rows,
  total,
  label,
  color,
}: {
  rows: Usage[];
  total: number;
  label: (u: Usage) => string;
  color: (u: Usage) => string;
}) {
  return (
    <div className="bars">
      {rows.map((u, i) => (
        <div className="bar-row" key={`${u.name}-${i}`}>
          <span className="bar-label">{label(u)}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${total > 0 ? Math.max((u.bytes / total) * 100, 0.5) : 0}%`, background: color(u) }} />
          </span>
          <span className="bar-value">
            {formatBytes(u.bytes)} <span className="muted small">({u.clips})</span>
          </span>
        </div>
      ))}
    </div>
  );
}
