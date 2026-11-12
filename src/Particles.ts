// Small bursts and trails of particles in each premium theme's style, used by the popup window.

import type { ThemeName } from "./useTheme";

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  rot: number;
  spin: number;
  hue: number;
  ch: string;
  phase: number;
}

/** What gives a spark: a gentle trail behind the mouse, or a burst (a click, a new popup). */
export type Kind = "trail" | "burst";

interface Style {
  /** Pushes particles down (positive) or up (negative), in pixels per second squared. */
  gravity: number;
  /** Fraction of speed kept each second. */
  drag: number;
  /** Add light on top of what is already there. */
  glow: boolean;
  make: (x: number, y: number, kind: Kind) => Particle;
  draw: (ctx: CanvasRenderingContext2D, p: Particle, k: number) => void;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾅﾆﾇﾈﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓ01234789";

function base(x: number, y: number, over: Partial<Particle>): Particle {
  return { x, y, vx: 0, vy: 0, age: 0, life: 1, size: 3, rot: 0, spin: 0, hue: 0, ch: "", phase: rand(0, 6.28), ...over };
}

/** A random direction and speed, for bursts. */
function radial(min: number, max: number): [number, number] {
  const a = rand(0, Math.PI * 2);
  const s = rand(min, max);
  return [Math.cos(a) * s, Math.sin(a) * s];
}

const STYLES: Partial<Record<ThemeName, Style>> = {
  storm: {
    gravity: 400,
    drag: 0.5,
    glow: true,
    make: (x, y, kind) => {
      const [vx, vy] = kind === "burst" ? radial(120, 380) : [rand(-30, 10), rand(80, 200)];
      return base(x, y, { vx, vy, life: rand(0.35, 0.8), size: rand(1, 2) });
    },
    draw: (ctx, p, k) => {
      ctx.strokeStyle = `rgba(200, 225, 255, ${k})`;
      ctx.lineWidth = p.size;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 0.05, p.y - p.vy * 0.05);
      ctx.stroke();
    },
  },
  ember: {
    gravity: -140,
    drag: 0.55,
    glow: true,
    make: (x, y, kind) => {
      const [vx, vy] = kind === "burst" ? radial(40, 220) : [rand(-26, 26), rand(-90, -30)];
      return base(x, y, { vx, vy, life: rand(0.7, 1.5), size: rand(1.5, 3.6), hue: rand(18, 48) });
    },
    draw: (ctx, p, k) => {
      const r = p.size * (0.4 + k) * 3;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, `hsla(${p.hue + 12}, 100%, 75%, ${k})`);
      g.addColorStop(0.4, `hsla(${p.hue}, 100%, 55%, ${k * 0.55})`);
      g.addColorStop(1, `hsla(${p.hue - 8}, 100%, 45%, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    },
  },
  aurora: {
    gravity: -8,
    drag: 0.4,
    glow: true,
    make: (x, y, kind) => {
      const [vx, vy] = kind === "burst" ? radial(30, 150) : [rand(-14, 14), rand(-24, 4)];
      return base(x, y, { vx, vy, life: rand(1.1, 2.2), size: rand(5, 13), hue: rand(135, 285) });
    },
    draw: (ctx, p, k) => {
      const r = p.size * (1.6 - k * 0.5);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, `hsla(${p.hue}, 95%, 70%, ${k * 0.38})`);
      g.addColorStop(1, `hsla(${p.hue}, 95%, 60%, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    },
  },
  matrix: {
    gravity: 60,
    drag: 0.8,
    glow: false,
    make: (x, y, kind) => {
      const [vx, vy] = kind === "burst" ? [rand(-40, 40), rand(-60, 90)] : [0, rand(40, 110)];
      return base(x, y, { vx, vy, life: rand(0.8, 1.6), size: rand(11, 16), ch: GLYPHS[Math.floor(rand(0, GLYPHS.length))] });
    },
    draw: (ctx, p, k) => {
      ctx.font = `${p.size}px monospace`;
      ctx.fillStyle = k > 0.85 ? `rgba(210, 255, 220, ${k})` : `rgba(0, 255, 102, ${k * 0.9})`;
      ctx.fillText(p.ch, p.x, p.y);
    },
  },
  sakura: {
    gravity: 38,
    drag: 0.7,
    glow: false,
    make: (x, y, kind) => {
      const [vx, vy] = kind === "burst" ? radial(30, 170) : [rand(-24, 24), rand(-24, 14)];
      return base(x, y, { vx, vy, life: rand(1.4, 2.6), size: rand(4, 8), rot: rand(0, 6.28), spin: rand(-3, 3), hue: rand(335, 352) });
    },
    draw: (ctx, p, k) => {
      ctx.save();
      ctx.translate(p.x + Math.sin(p.age * 3 + p.phase) * 6, p.y);
      ctx.rotate(p.rot);
      ctx.scale(1, 0.62 + 0.38 * Math.sin(p.age * 4 + p.phase));
      ctx.fillStyle = `hsla(${p.hue}, 90%, 80%, ${Math.min(1, k * 1.6) * 0.9})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, p.size, p.size * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },
  },
  abyss: {
    gravity: -34,
    drag: 0.6,
    glow: false,
    make: (x, y, kind) => {
      const [vx, vy] = kind === "burst" ? radial(20, 120) : [rand(-12, 12), rand(-48, -14)];
      return base(x, y, { vx, vy, life: rand(1.2, 2.4), size: rand(2.5, 8) });
    },
    draw: (ctx, p, k) => {
      const x = p.x + Math.sin(p.age * 2.4 + p.phase) * 5;
      ctx.strokeStyle = `rgba(190, 245, 255, ${k * 0.7})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, p.y, p.size, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(255, 255, 255, ${k * 0.5})`;
      ctx.beginPath();
      ctx.arc(x - p.size * 0.35, p.y - p.size * 0.35, Math.max(0.8, p.size * 0.2), 0, Math.PI * 2);
      ctx.fill();
    },
  },
};

/** True for themes that have particles. */
export const hasParticles = (theme: string): theme is ThemeName => theme in STYLES;

type Point = [number, number];
function jagged(a: Point, b: Point, spread: number, depth: number): Point[] {
  if (depth === 0) return [a, b];
  const mid: Point = [(a[0] + b[0]) / 2 + (Math.random() - 0.5) * spread, (a[1] + b[1]) / 2 + (Math.random() - 0.5) * spread * 0.4];
  return [...jagged(a, mid, spread / 2, depth - 1).slice(0, -1), ...jagged(mid, b, spread / 2, depth - 1)];
}

export interface Particles {
  emit: (x: number, y: number, count: number, kind: Kind) => void;
  /** A flash of lightning from above to a point (Storm only; others ignore it). */
  strike: (x: number, y: number) => void;
  stop: () => void;
}

/** Runs particles on `canvas` in the style of `theme` until stopped. */
export function runParticles(canvas: HTMLCanvasElement, theme: ThemeName): Particles | null {
  const style = STYLES[theme];
  const ctx = canvas.getContext("2d");
  if (!style || !ctx) return null;

  const all: Particle[] = [];
  const bolts: { path: Point[]; age: number }[] = [];
  let raf = 0;
  let alive = true;
  let last = performance.now();

  const frame = (now: number) => {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (document.hidden) return;

    ctx.globalCompositeOperation = style.glow ? "lighter" : "source-over";
    for (let i = all.length - 1; i >= 0; i--) {
      const p = all[i];
      p.age += dt;
      if (p.age >= p.life) {
        all.splice(i, 1);
        continue;
      }
      const keep = Math.pow(style.drag, dt);
      p.vx *= keep;
      p.vy = p.vy * keep + style.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      style.draw(ctx, p, 1 - p.age / p.life);
    }
    ctx.globalCompositeOperation = "source-over";

    for (let i = bolts.length - 1; i >= 0; i--) {
      const b = bolts[i];
      b.age += dt;
      if (b.age > 0.35) {
        bolts.splice(i, 1);
        continue;
      }
      const a = 1 - b.age / 0.35;
      for (const [width, color] of [[7, `rgba(120, 160, 255, ${a * 0.25})`], [2, `rgba(240, 247, 255, ${a})`]] as const) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineJoin = "round";
        ctx.beginPath();
        b.path.forEach(([x, y], n) => (n === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.stroke();
      }
    }
  };
  raf = requestAnimationFrame(frame);

  return {
    emit: (x, y, count, kind) => {
      for (let i = 0; i < count && all.length < 400; i++) all.push(style.make(x + rand(-3, 3), y + rand(-3, 3), kind));
    },
    strike: (x, y) => {
      if (theme !== "storm") return;
      const path = jagged([x + rand(-80, 80), -10], [x, y], 120, 6);
      bolts.push({ path, age: 0 });
      for (let i = 0; i < 14; i++) all.push(style.make(x, y, "burst"));
    },
    stop: () => {
      alive = false;
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}
