import { useEffect, useRef, useState } from "react";
import { clipAudioLevels, type AudioLevels } from "./api";
import { useMenu } from "./ContextMenu";

type Style = "bars" | "mirror" | "line";
type Colour = "blue" | "rainbow" | "white";
interface Prefs {
  style: Style;
  colour: Colour;
  off: boolean;
}
const DEFAULTS: Prefs = { style: "bars", colour: "blue", off: false };

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("visualizer") ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

/**
 * A small spectrum display that follows the clip's audio. Right-click it to
 * change the style or colour, or to turn it off.
 */
export function Visualizer({
  clipId,
  time,
  paused,
}: {
  clipId: number;
  time: number;
  paused: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const levels = useRef<AudioLevels | null>(null);
  // Where playback was last reported, so drawing can carry on between reports.
  const clock = useRef({ time: 0, at: 0, paused: true });
  const [prefs, setPrefs] = useState(loadPrefs);
  const showMenu = useMenu();

  const change = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try {
      localStorage.setItem("visualizer", JSON.stringify(next));
    } catch {
      /* not saved */
    }
  };

  useEffect(() => {
    clock.current = { time, at: performance.now(), paused };
  }, [time, paused]);

  useEffect(() => {
    let active = true;
    levels.current = null;
    clipAudioLevels(clipId)
      .then((l) => active && (levels.current = l))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [clipId]);

  useEffect(() => {
    if (prefs.off) return;
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    let raf = 0;
    const smooth: number[] = [];

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth * dpr;
      const h = el.clientHeight * dpr;
      if (el.width !== w || el.height !== h) {
        el.width = w;
        el.height = h;
      }
      ctx.clearRect(0, 0, w, h);

      const l = levels.current;
      const c = clock.current;
      const now = c.paused ? c.time : c.time + (performance.now() - c.at) / 1000;
      const bands = l?.bands ?? 32;
      const row = l ? Math.min(Math.floor(now * l.fps), Math.floor(l.data.length / l.bands) - 1) : -1;
      for (let b = 0; b < bands; b++) {
        const target = l && row >= 0 && !c.paused ? l.data[row * l.bands + b] / 255 : 0;
        const prev = smooth[b] ?? 0;
        // Rise fast, fall slowly.
        smooth[b] = target > prev ? prev + (target - prev) * 0.6 : prev + (target - prev) * 0.12;
      }

      const gap = 2 * dpr;
      const bw = (w - gap * (bands - 1)) / bands;
      const colourAt = (b: number) =>
        prefs.colour === "rainbow"
          ? `hsl(${200 + (b / bands) * 160} 85% 62%)`
          : prefs.colour === "white"
            ? "rgba(255,255,255,0.85)"
            : `hsl(${225 - (b / bands) * 25} 90% ${62 + smooth[b] * 10}%)`;

      if (prefs.style === "line") {
        ctx.beginPath();
        for (let b = 0; b < bands; b++) {
          const x = (b / (bands - 1)) * w;
          const y = h - Math.max(smooth[b], 0.04) * h * 0.9 - 2 * dpr;
          b === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.lineWidth = 2 * dpr;
        ctx.lineJoin = "round";
        ctx.strokeStyle = prefs.colour === "white" ? "rgba(255,255,255,0.9)" : colourAt(Math.floor(bands / 3));
        if (prefs.colour === "rainbow") {
          const g = ctx.createLinearGradient(0, 0, w, 0);
          g.addColorStop(0, colourAt(0));
          g.addColorStop(1, colourAt(bands));
          ctx.strokeStyle = g;
        }
        ctx.stroke();
        return;
      }

      for (let b = 0; b < bands; b++) {
        const bar = Math.max(smooth[b], 0.04) * h * (prefs.style === "mirror" ? 0.5 : 0.95);
        ctx.fillStyle = colourAt(b);
        const x = b * (bw + gap);
        const r = Math.min(bw / 2, 3 * dpr);
        ctx.beginPath();
        if (prefs.style === "mirror") ctx.roundRect(x, h / 2 - bar, bw, bar * 2, r);
        else ctx.roundRect(x, h - bar, bw, bar, [r, r, 0, 0]);
        ctx.fill();
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [prefs]);

  if (prefs.off) {
    return (
      <button className="viz-off" onClick={() => change({ off: false })} title="Show the audio visualizer">
        Visualizer
      </button>
    );
  }
  const mark = (on: boolean, text: string) => (on ? `\u2713 ${text}` : `\u2003${text}`);
  return (
    <canvas
      ref={canvas}
      className="visualizer"
      title="Right-click to change the style"
      onContextMenu={(e) =>
        showMenu(e, [
          { label: mark(prefs.style === "bars", "Bars"), onClick: () => change({ style: "bars" }) },
          { label: mark(prefs.style === "mirror", "Mirrored"), onClick: () => change({ style: "mirror" }) },
          { label: mark(prefs.style === "line", "Line"), onClick: () => change({ style: "line" }) },
          { label: mark(prefs.colour === "blue", "Blue"), onClick: () => change({ colour: "blue" }) },
          { label: mark(prefs.colour === "rainbow", "Rainbow"), onClick: () => change({ colour: "rainbow" }) },
          { label: mark(prefs.colour === "white", "White"), onClick: () => change({ colour: "white" }) },
          { label: "Turn off", onClick: () => change({ off: true }) },
        ])
      }
    />
  );
}
