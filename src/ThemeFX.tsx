import { useEffect, useRef, useState } from "react";
import { useNotice } from "./Notice";
import type { FxQuality, ThemeName } from "./useTheme";

type Point = [number, number];
interface Env {
  ctx: CanvasRenderingContext2D;
  w: () => number;
  h: () => number;
}
/** Starts an effect and returns the function that stops it. */
type Effect = (env: Env) => () => void;

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Frames per second the effects aim for. Set from the quality setting before an effect starts. */
let targetFps = 60;

/** Calls `draw(seconds since last frame, now)` about 60 times a second until stopped. Idle while the window is hidden. */
function loop(draw: (dt: number, now: number) => void): () => void {
  let raf = 0;
  let last = performance.now();
  let alive = true;
  const frame = (now: number) => {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    const dt = (now - last) / 1000;
    if (dt < 1 / targetFps - 0.002) return;
    last = now;
    if (!document.hidden) draw(Math.min(dt, 0.25), now);
  };
  raf = requestAnimationFrame(frame);
  return () => {
    alive = false;
    cancelAnimationFrame(raf);
  };
}

// ---------------------------------------------------------------- Storm ----

/** A jagged line from one point to another, by repeatedly nudging midpoints sideways. */
function jagged(a: Point, b: Point, spread: number, depth: number): Point[] {
  if (depth === 0) return [a, b];
  const mid: Point = [(a[0] + b[0]) / 2 + (Math.random() - 0.5) * spread, (a[1] + b[1]) / 2 + (Math.random() - 0.5) * spread * 0.4];
  const left = jagged(a, mid, spread / 2, depth - 1);
  return [...left.slice(0, -1), ...jagged(mid, b, spread / 2, depth - 1)];
}

function makeBolt(w: number, h: number, x: number, distant: boolean): Point[][] {
  if (distant) {
    // Far away: short, thin, and high up.
    const end: Point = [x + (Math.random() - 0.5) * w * 0.1, h * rand(0.2, 0.4)];
    const main = jagged([x, 30], end, 70, 6);
    const from = main[Math.floor(main.length * 0.5)];
    return [main, jagged(from, [from[0] + rand(-110, 110), from[1] + rand(40, 100)], 50, 4)];
  }
  const end: Point = [x + (Math.random() - 0.5) * w * 0.3, h * rand(0.5, 0.97)];
  const main = jagged([x, -10], end, 190, 7);
  const bolts = [main];
  for (let i = 0; i < 3; i++) {
    const from = main[Math.floor(main.length * rand(0.2, 0.7))];
    bolts.push(jagged(from, [from[0] + rand(-420, 420), from[1] + rand(120, 320)], 100, 5));
  }
  return bolts;
}

const storm: Effect = ({ ctx, w, h }) => {
  // A rain streak is a slanted line that fades in towards its leading end. Each
  // size is drawn once and then stamped, which keeps hundreds of drops cheap.
  const wind = 0.24;
  const streak = (len: number, width: number) => {
    const c = document.createElement("canvas");
    const sw = Math.ceil(len * wind) + 6;
    c.width = sw;
    c.height = Math.ceil(len) + 2;
    const x = c.getContext("2d")!;
    const g = x.createLinearGradient(sw - 3, 1, 3, len);
    g.addColorStop(0, "rgba(190, 215, 255, 0)");
    g.addColorStop(0.7, "rgba(190, 215, 255, 0.55)");
    g.addColorStop(1, "rgba(235, 245, 255, 1)");
    x.strokeStyle = g;
    x.lineWidth = width;
    x.lineCap = "round";
    x.beginPath();
    x.moveTo(sw - 3, 1);
    x.lineTo(3, len);
    x.stroke();
    return c;
  };
  // Three depths: far (small, faint, slow), middle, near (long, bright, fast)
  const kinds = [
    { img: streak(16, 1), v: 520, a: 0.16, share: 0.5 },
    { img: streak(26, 1.2), v: 820, a: 0.26, share: 0.33 },
    { img: streak(42, 1.6), v: 1250, a: 0.4, share: 0.17 },
  ];
  interface Drop { x: number; y: number; k: number; v: number }
  const newDrop = (anywhere: boolean): Drop => {
    const roll = Math.random();
    const k = roll < kinds[0].share ? 0 : roll < kinds[0].share + kinds[1].share ? 1 : 2;
    return { x: rand(-160, w() + 160), y: anywhere ? rand(0, h()) : rand(-120, 0), k, v: kinds[k].v * rand(0.85, 1.15) };
  };
  const drops = Array.from({ length: 240 }, () => newDrop(true));

  let strike: { start: number; bolts: Point[][]; distant: boolean; pulses: number[]; x: number } | null = null;
  let nextAt = performance.now() + 2200;

  return loop((dt, now) => {
    const W = w();
    const H = h();
    const t = now / 1000;
    ctx.clearRect(0, 0, W, H);

    if (!strike && now >= nextAt) {
      const distant = Math.random() < 0.5;
      const x = W * rand(0.1, 0.9);
      strike = { start: now, x, bolts: makeBolt(W, H, x, distant), distant, pulses: distant ? [0, 240, 430] : [0, 110, 240, 600] };
      nextAt = now + rand(4500, 11000);
    }
    let flash = 0;
    if (strike) {
      const since = now - strike.start;
      for (const p of strike.pulses) {
        const s = since - p;
        if (s >= 0 && s < 210) flash = Math.max(flash, 1 - s / 210);
      }
      if (since > 1000) strike = null;
    }
    const near = strike && !strike.distant ? flash : 0;
    const far = strike && strike.distant ? flash : 0;

    // A cold blue glow from the top of the screen. It breathes slowly, and
    // surges with every flash of lightning.
    ctx.globalCompositeOperation = "lighter";
    const breath = 0.5 + 0.5 * Math.sin(t * 0.45);
    const top = 0.085 + breath * 0.04 + near * 0.3 + far * 0.15;
    const glow = ctx.createLinearGradient(0, 0, 0, H * 0.55);
    glow.addColorStop(0, `rgba(70, 120, 255, ${top})`);
    glow.addColorStop(0.45, `rgba(60, 100, 230, ${top * 0.4})`);
    glow.addColorStop(1, "rgba(60, 100, 230, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H * 0.55);
    if (strike) {
      // The flash is brightest above the strike itself
      const lobe = ctx.createRadialGradient(strike.x, 0, 0, strike.x, 0, W * (strike.distant ? 0.4 : 0.65));
      lobe.addColorStop(0, `rgba(170, 200, 255, ${0.3 * near + 0.14 * far})`);
      lobe.addColorStop(1, "rgba(170, 200, 255, 0)");
      ctx.fillStyle = lobe;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalCompositeOperation = "source-over";

    // Rain
    for (const d of drops) {
      const kind = kinds[d.k];
      d.y += d.v * dt;
      d.x -= d.v * wind * dt;
      if (d.y > H + 50) Object.assign(d, newDrop(false));
      ctx.globalAlpha = Math.min(1, kind.a + near * 0.2);
      ctx.drawImage(kind.img, d.x, d.y - kind.img.height);
    }
    ctx.globalAlpha = 1;

    // The bolt itself
    if (strike && flash > 0.01) {
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalCompositeOperation = "lighter";
      strike.bolts.forEach((line, i) => {
        const trace = () => {
          ctx.beginPath();
          line.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        };
        const main = i === 0;
        if (strike!.distant) {
          ctx.strokeStyle = `rgba(150, 180, 255, ${0.16 * flash})`;
          ctx.lineWidth = main ? 12 : 7;
          trace();
          ctx.stroke();
          ctx.strokeStyle = `rgba(215, 228, 255, ${0.55 * flash})`;
          ctx.lineWidth = main ? 2.4 : 1.4;
          trace();
          ctx.stroke();
        } else {
          for (const [width, alpha, color] of [
            [main ? 26 : 14, 0.09, "120, 165, 255"],
            [main ? 12 : 7, 0.25, "140, 185, 255"],
            [main ? 5 : 3, 0.7, "220, 232, 255"],
            [main ? 2.2 : 1.3, 1, "255, 255, 255"],
          ] as const) {
            ctx.strokeStyle = `rgba(${color}, ${alpha * flash})`;
            ctx.lineWidth = width;
            trace();
            ctx.stroke();
          }
        }
      });
      ctx.globalCompositeOperation = "source-over";
    }
  });
};

// ---------------------------------------------------------------- Ember ----

const ember: Effect = ({ ctx, w, h }) => {
  // A fire burning below the screen: a glow along the bottom that pulses, with
  // yellow in its heart, and now and then a stronger surge, as if the fire had
  // just been fed.
  interface Spark { x: number; y: number; vx: number; vy: number; r: number; life: number; age: number; hue: number }
  const makeSpark = (fromBottom: boolean): Spark => ({
    x: rand(0, w()),
    y: fromBottom ? h() + 10 : rand(0, h()),
    vx: rand(-0.12, 0.12),
    vy: -rand(0.3, 1.0),
    r: rand(0.8, 2.2),
    life: rand(7, 16),
    age: fromBottom ? 0 : rand(0, 6),
    hue: rand(14, 50),
  });
  const sparks = Array.from({ length: 30 }, () => makeSpark(false));

  let surge: { start: number; length: number; power: number } | null = null;
  let nextSurge = performance.now() + 1500;
  let smoothSurge = 0;

  return loop((dt, now) => {
    const W = w();
    const H = h();
    const t = now / 1000;
    ctx.clearRect(0, 0, W, H);

    // A surge swells quickly and dies away
    if (!surge && now >= nextSurge) {
      surge = { start: now, length: rand(900, 1700), power: rand(0.55, 1) };
      nextSurge = now + rand(2200, 5200);
    }
    let level = 0;
    if (surge) {
      const k = (now - surge.start) / surge.length;
      if (k >= 1) surge = null;
      else level = Math.pow(Math.sin(Math.min(k, 1) * Math.PI), 1.4) * surge.power;
    }
    smoothSurge += (level - smoothSurge) * Math.min(1, dt * 10);

    const slow = 0.5 + 0.5 * Math.sin(t * 0.9);
    const mid = 0.5 + 0.5 * Math.sin(t * 2.4 + 1.3);
    const quick = 0.5 + 0.5 * Math.sin(t * 7.3 + Math.sin(t * 2.9) * 2);
    const pulse = 0.5 + slow * 0.3 + mid * 0.12 + quick * 0.08; // 0.5 to 1
    const heat = pulse + smoothSurge * 0.9;

    ctx.globalCompositeOperation = "lighter";

    // Red-orange light along the whole bottom edge
    const tall = H * (0.4 + smoothSurge * 0.14);
    const base = ctx.createLinearGradient(0, H - tall, 0, H);
    base.addColorStop(0, "rgba(255, 80, 15, 0)");
    base.addColorStop(0.5, `rgba(255, 85, 18, ${0.06 * heat})`);
    base.addColorStop(0.85, `rgba(255, 120, 30, ${0.26 * heat})`);
    base.addColorStop(1, `rgba(255, 170, 55, ${0.4 * heat})`);
    ctx.fillStyle = base;
    ctx.fillRect(0, H - tall, W, tall);

    // Pools of hotter light, yellow at the centre, swelling out of step with each other
    for (const [cx, phase, size] of [[0.26, 0.0, 0.5], [0.52, 1.7, 0.36], [0.77, 3.4, 0.46]] as const) {
      const k = 0.5 + 0.5 * Math.sin(t * 0.85 + phase);
      const strength = (0.35 + 0.65 * k) * (0.6 + 0.4 * pulse) + smoothSurge * 0.55;
      const r = W * size * (0.75 + 0.3 * k + smoothSurge * 0.25);
      const g = ctx.createRadialGradient(W * cx, H + 30, 0, W * cx, H + 30, r);
      g.addColorStop(0, `rgba(255, 225, 110, ${0.3 * strength})`);
      g.addColorStop(0.25, `rgba(255, 160, 45, ${0.2 * strength})`);
      g.addColorStop(0.6, `rgba(255, 90, 25, ${0.08 * strength})`);
      g.addColorStop(1, "rgba(255, 70, 20, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, H - r, W, r + 40);
    }
    ctx.globalCompositeOperation = "source-over";

    // Sparks drifting up; more of them when the fire surges
    for (const e of sparks) {
      e.age += dt * (1 + smoothSurge * 1.5);
      e.x += (e.vx + Math.sin((e.age + e.r) * 1.7) * 0.18) * dt * 60;
      e.y += e.vy * dt * 60 * (1 + smoothSurge * 0.8);
      if (e.age > e.life || e.y < -10) Object.assign(e, makeSpark(true));
      const fade = Math.sin(Math.min(e.age / e.life, 1) * Math.PI);
      ctx.beginPath();
      ctx.fillStyle = `hsla(${e.hue}, 100%, 62%, ${0.75 * fade})`;
      ctx.shadowColor = `hsla(${e.hue}, 100%, 55%, 0.9)`;
      ctx.shadowBlur = 10;
      ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  });
};

// --------------------------------------------------------------- Aurora ----

const aurora: Effect = ({ ctx, w, h }) => {
  // Curtains of light: many thin vertical rays hanging from a waving line, each
  // brightest at the top and fading as it falls, with the brightness rippling along.
  const curtains = [
    { hue: 150, y: 0.15, amp: 60, f: 0.0042, s: 0.33, a: 0.42, drop: 230 },
    { hue: 170, y: 0.2, amp: 75, f: 0.0031, s: -0.25, a: 0.32, drop: 280 },
    { hue: 285, y: 0.12, amp: 50, f: 0.0052, s: 0.42, a: 0.26, drop: 200 },
  ];
  return loop((_dt, now) => {
    const W = w();
    const H = h();
    const t = now / 1000;
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";
    for (const c of curtains) {
      for (let x = 0; x <= W; x += 5) {
        const top = H * c.y + Math.sin(x * c.f + t * c.s) * c.amp + Math.sin(x * c.f * 2.3 - t * c.s * 0.7) * c.amp * 0.4;
        const ripple = 0.5 + 0.5 * Math.sin(x * 0.045 + t * 0.9 + c.hue) * Math.sin(x * 0.011 - t * 0.4);
        const len = c.drop * (0.55 + 0.45 * Math.sin(x * 0.007 + t * 0.25 + c.hue));
        const alpha = c.a * (0.25 + 0.75 * ripple);
        const g = ctx.createLinearGradient(0, top, 0, top + len);
        g.addColorStop(0, `hsla(${c.hue}, 95%, 66%, ${alpha})`);
        g.addColorStop(0.18, `hsla(${c.hue}, 90%, 58%, ${alpha * 0.7})`);
        g.addColorStop(1, `hsla(${c.hue + 20}, 85%, 50%, 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x, top, 6, len);
      }
    }
    ctx.globalCompositeOperation = "source-over";
  });
};

// --------------------------------------------------------------- Matrix ----

const matrix: Effect = ({ ctx, w, h }) => {
  // Streams of falling characters: a bright white head, a long green trail that
  // fades out behind it, and characters that keep changing as they fall. Some
  // streams are nearer (brighter, faster) and some farther (dimmer, slower).
  const FS = 18;
  const glyphs = "0123456789ABCDEFZｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ:.=*+-<>";
  const letter = () => glyphs[Math.floor(Math.random() * glyphs.length)];
  interface Stream { y: number; v: number; len: number; glyphs: string[]; depth: number }
  interface Col { x: number; streams: Stream[] }
  const makeStream = (startAbove: boolean): Stream => {
    const depth = rand(0.4, 1);
    const len = Math.floor(rand(12, 30));
    return {
      y: startAbove ? -len * FS - rand(0, h() * 0.6) : rand(0, h()),
      v: rand(90, 250) * (0.55 + depth * 0.45),
      len,
      glyphs: Array.from({ length: len }, letter),
      depth,
    };
  };
  const count = Math.ceil(Math.max(window.screen.width, 1600) / FS) + 2;
  const cols: Col[] = Array.from({ length: count }, (_, i) => ({
    x: i * FS,
    streams: Math.random() < 0.8 ? [makeStream(false)] : [],
  }));

  return loop((dt) => {
    const W = w();
    const H = h();
    ctx.clearRect(0, 0, W, H);
    ctx.font = `${FS - 2}px "Cascadia Mono", Consolas, monospace`;
    ctx.textBaseline = "top";
    for (const c of cols) {
      if (c.x > W) continue;
      // A fresh stream now and then, so columns do not sit empty for long
      if (c.streams.length === 0 && Math.random() < 0.012 * dt * 30) c.streams.push(makeStream(true));
      for (let n = c.streams.length - 1; n >= 0; n--) {
        const s = c.streams[n];
        s.y += s.v * dt;
        // Characters in the trail change from time to time
        if (Math.random() < 0.25 * dt * 30) s.glyphs[Math.floor(rand(0, s.len))] = letter();
        const headRow = Math.floor(s.y / FS);
        for (let i = 0; i < s.len; i++) {
          const y = (headRow - i) * FS;
          if (y < -FS || y > H) continue;
          const fade = Math.pow(1 - i / s.len, 1.3);
          if (i === 0) {
            ctx.shadowColor = "rgba(120, 255, 170, 0.9)";
            ctx.shadowBlur = 12;
            ctx.fillStyle = `rgba(225, 255, 235, ${0.95 * s.depth})`;
          } else {
            ctx.shadowBlur = 0;
            ctx.fillStyle = i === 1 ? `rgba(150, 255, 190, ${0.8 * s.depth})` : `rgba(0, 255, 102, ${0.6 * fade * s.depth})`;
          }
          ctx.fillText(s.glyphs[i], c.x, y);
        }
        ctx.shadowBlur = 0;
        if ((headRow - s.len) * FS > H) c.streams.splice(n, 1);
      }
    }
  });
};

// --------------------------------------------------------------- Cosmos ----

// --------------------------------------------------------------- Sakura ----

const sakura: Effect = ({ ctx, w, h }) => {
  // Petals drifting down. Now and then a gust of wind sweeps across: the petals
  // are blown sideways and spin faster, and more blow in from the edge.
  interface Petal { x: number; y: number; vy: number; sway: number; phase: number; rot: number; vr: number; size: number; depth: number; push: number; blown: boolean }
  const make = (anywhere: boolean, blown = false): Petal => {
    const depth = Math.random();
    return {
      x: blown ? rand(-120, -10) : rand(0, w()),
      y: blown ? rand(-20, h()) : anywhere ? rand(0, h()) : rand(-40, -5),
      vy: 20 + depth * 34,
      sway: rand(18, 46),
      phase: rand(0, 6.28),
      rot: rand(0, 6.28),
      vr: rand(-1.2, 1.2),
      size: 5 + depth * 9,
      depth,
      push: 0,
      blown,
    };
  };
  const petals: Petal[] = Array.from({ length: 36 }, () => make(true));

  let gust: { start: number; length: number; power: number } | null = null;
  let nextGust = performance.now() + 4000;
  // Long faint wisps that show where the wind is blowing
  const wisps = Array.from({ length: 7 }, () => ({ y: rand(0.1, 0.9), len: rand(220, 520), speed: rand(0.8, 1.3), off: rand(0, 0.25) }));

  return loop((dt, now) => {
    const W = w();
    const H = h();
    const t = now / 1000;
    ctx.clearRect(0, 0, W, H);

    if (!gust && now >= nextGust) {
      gust = { start: now, length: rand(3500, 5500), power: rand(0.7, 1) };
      nextGust = now + rand(9000, 18000);
      // Extra petals carried in from the left
      for (let i = 0; i < 26; i++) petals.push(make(false, true));
    }
    let wind = 0;
    let k = 0;
    if (gust) {
      k = (now - gust.start) / gust.length;
      if (k >= 1) gust = null;
      else wind = Math.pow(Math.sin(k * Math.PI), 1.2) * gust.power;
    }

    // Faint streaks of wind
    if (gust && wind > 0.02) {
      ctx.lineCap = "round";
      for (const wi of wisps) {
        const p = k * wi.speed - wi.off;
        if (p < 0 || p > 1.05) continue;
        const x = -wi.len + p * (W + wi.len * 2);
        const y = wi.y * H + Math.sin(p * 6 + wi.y * 9) * 18;
        const g = ctx.createLinearGradient(x - wi.len, y, x, y);
        g.addColorStop(0, "rgba(255, 190, 220, 0)");
        g.addColorStop(1, `rgba(255, 215, 235, ${0.26 * wind})`);
        ctx.strokeStyle = g;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x - wi.len, y + Math.sin(p * 6 + 2) * 6);
        ctx.quadraticCurveTo(x - wi.len / 2, y - 10, x, y);
        ctx.stroke();
      }
    }

    for (let i = petals.length - 1; i >= 0; i--) {
      const p = petals[i];
      // Wind pushes harder on the petals that are closer (bigger)
      p.push += ((wind * (260 + p.depth * 320)) - p.push) * Math.min(1, dt * 2.2);
      p.x += p.push * dt;
      p.y += (p.vy * (1 + wind * 0.7) + (p.blown ? Math.sin(t * 3 + p.phase) * 30 * wind : 0)) * dt;
      p.rot += p.vr * dt * (1 + wind * 4);
      const x = p.x + Math.sin(t * 0.8 + p.phase) * p.sway;
      if (p.blown && (x > W + 60 || p.y > H + 30)) {
        petals.splice(i, 1);
        continue;
      }
      if (!p.blown) {
        if (p.y > H + 20) Object.assign(p, make(false));
        // A petal blown off one side comes back in from the other
        if (p.x > W + 40) p.x -= W + 80;
        if (p.x < -40 - p.sway) p.x += W + 80;
      }
      ctx.save();
      ctx.translate(x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = `rgba(255, 175, 210, ${0.35 + p.depth * 0.35})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, p.size * (1 + wind * 0.25), p.size * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  });
};

// --------------------------------------------------------------- Abyss ----

const abyss: Effect = ({ ctx, w, h }) => {
  // Light falling into deep water: slow beams of pale teal from above, glowing
  // plankton drifting, and the odd bubble rising.
  // One soft beam of light, painted once: bright down its middle, fading smoothly
  // to nothing at the sides, and fading out as it goes down. Every beam on screen is
  // this picture, stretched and leaned, so there are no hard edges anywhere.
  const beamImage = (() => {
    const BW = 256;
    const BH = 512;
    const c = document.createElement("canvas");
    c.width = BW;
    c.height = BH;
    const x = c.getContext("2d")!;
    const across = x.createLinearGradient(0, 0, BW, 0);
    for (let i = 0; i <= 24; i++) {
      const u = i / 24;
      const d = (u - 0.5) / 0.5;
      const a = Math.exp(-d * d * 3.2); // a smooth bell from side to side
      across.addColorStop(u, `rgba(140, 245, 238, ${a})`);
    }
    x.fillStyle = across;
    x.fillRect(0, 0, BW, BH);
    x.globalCompositeOperation = "destination-in";
    const down = x.createLinearGradient(0, 0, 0, BH);
    down.addColorStop(0, "rgba(0, 0, 0, 1)");
    down.addColorStop(0.35, "rgba(0, 0, 0, 0.55)");
    down.addColorStop(0.75, "rgba(0, 0, 0, 0.18)");
    down.addColorStop(1, "rgba(0, 0, 0, 0)");
    x.fillStyle = down;
    x.fillRect(0, 0, BW, BH);
    return c;
  })();
  const beams = Array.from({ length: 9 }, () => ({
    x: rand(0.02, 0.98),
    width: rand(110, 320),
    lean: rand(-0.38, 0.38),
    phase: rand(0, 6.28),
    speed: rand(0.1, 0.26),
    a: rand(0.1, 0.24),
  }));

  const dot = (r: number, g: number, b: number) => {
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const x = c.getContext("2d")!;
    const grad = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
    grad.addColorStop(0.3, `rgba(${r}, ${g}, ${b}, 0.4)`);
    grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    x.fillStyle = grad;
    x.fillRect(0, 0, 32, 32);
    return c;
  };
  const sprites = [dot(80, 240, 235), dot(110, 200, 255), dot(160, 255, 220), dot(150, 130, 255)];
  interface Plankton { x: number; y: number; vx: number; vy: number; size: number; phase: number; speed: number; sprite: number }
  const make = (): Plankton => ({
    x: rand(0, w()),
    y: rand(0, h()),
    vx: rand(-6, 6),
    vy: rand(-12, -3),
    size: rand(4, 13),
    phase: rand(0, 6.28),
    speed: rand(0.4, 1.4),
    sprite: Math.floor(rand(0, sprites.length)),
  });
  const plankton = Array.from({ length: 80 }, make);

  interface Bubble { x: number; y: number; r: number; v: number; phase: number }
  const newBubble = (anywhere: boolean): Bubble => ({ x: rand(0, w()), y: anywhere ? rand(0, h()) : h() + 20, r: rand(2, 6), v: rand(22, 55), phase: rand(0, 6.28) });
  const bubbles = Array.from({ length: 16 }, () => newBubble(true));

  return loop((dt, now) => {
    const W = w();
    const H = h();
    const t = now / 1000;
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";

    // Beams of light from the surface, swaying and breathing
    for (const b of beams) {
      const x0 = W * b.x + Math.sin(t * b.speed + b.phase) * 70;
      const lean = b.lean + Math.sin(t * b.speed * 0.7 + b.phase) * 0.14;
      const len = H * 1.1;
      const strength = b.a * (0.6 + 0.4 * Math.sin(t * b.speed * 2.1 + b.phase * 2));
      ctx.save();
      // Lean the beam: a shear, so its top stays put while its foot swings aside
      ctx.transform(1, 0, lean, 1, x0, 0);
      ctx.globalAlpha = Math.max(0, strength) * 2.4;
      ctx.drawImage(beamImage, -b.width / 2, 0, b.width, len);
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // A pale shimmer along the very top, where the light comes in
    const top = ctx.createLinearGradient(0, 0, 0, H * 0.2);
    top.addColorStop(0, `rgba(110, 230, 235, ${0.1 + 0.04 * Math.sin(t * 0.6)})`);
    top.addColorStop(1, "rgba(110, 230, 235, 0)");
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, W, H * 0.2);

    // Plankton, glowing and fading as they drift
    for (const p of plankton) {
      p.x += (p.vx + Math.sin(t * 0.5 + p.phase) * 9) * dt;
      p.y += p.vy * dt;
      if (p.y < -20) {
        p.y = H + 20;
        p.x = rand(0, W);
      }
      if (p.x < -20) p.x = W + 20;
      if (p.x > W + 20) p.x = -20;
      ctx.globalAlpha = 0.25 + 0.5 * (0.5 + 0.5 * Math.sin(t * p.speed + p.phase));
      ctx.drawImage(sprites[p.sprite], p.x - p.size, p.y - p.size, p.size * 2, p.size * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    // Bubbles
    ctx.lineWidth = 1;
    for (const b of bubbles) {
      b.y -= b.v * dt;
      if (b.y < -20) Object.assign(b, newBubble(false));
      const x = b.x + Math.sin(t * 1.3 + b.phase) * 10;
      ctx.strokeStyle = "rgba(190, 245, 255, 0.28)";
      ctx.beginPath();
      ctx.arc(x, b.y, b.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
      ctx.beginPath();
      ctx.arc(x - b.r * 0.35, b.y - b.r * 0.35, Math.max(0.8, b.r * 0.22), 0, Math.PI * 2);
      ctx.fill();
    }
  });
};


// ---------------------------------------------------- High quality extras ----
// On High, a second layer of large, soft, slow particles drifts in front of the usual ones.
// Each is a blurred picture made once and then stamped, so they cost little.

type Paint = (x: CanvasRenderingContext2D, s: number) => void;

function sprite(size: number, blur: number, paint: Paint): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const pad = Math.ceil(blur * 3);
  c.width = c.height = Math.ceil(size + pad * 2);
  const x = c.getContext("2d")!;
  x.filter = `blur(${blur}px)`;
  x.translate(c.width / 2, c.height / 2);
  paint(x, size);
  return c;
}

const blob = (color: string, squash = 1): Paint => (x, s) => {
  x.fillStyle = color;
  x.beginPath();
  x.ellipse(0, 0, s * 0.42, s * 0.42 * squash, 0, 0, Math.PI * 2);
  x.fill();
};

interface Layer {
  count: number;
  sprites: HTMLCanvasElement[];
  /** Add light to what is behind (glows) instead of covering it. */
  glow?: boolean;
  vx: [number, number];
  vy: [number, number];
  /** Drawn width in pixels. */
  size: [number, number];
  alpha: [number, number];
  /** Sideways wobble, in pixels. */
  sway?: number;
  spin?: number;
  /** Fade in and out gently. */
  twinkle?: boolean;
}

interface Bit {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  pic: number;
  phase: number;
  rot: number;
  spin: number;
}

function layers(make: () => Layer[]): Effect {
  return ({ ctx, w, h }) => {
    const list = make();
    const bits = list.map((layer) =>
      Array.from({ length: layer.count }, (): Bit => ({
        x: rand(0, w()),
        y: rand(0, h()),
        vx: rand(...layer.vx),
        vy: rand(...layer.vy),
        size: rand(...layer.size),
        alpha: rand(...layer.alpha),
        pic: Math.floor(rand(0, layer.sprites.length)),
        phase: rand(0, 6.28),
        rot: rand(0, 6.28),
        spin: layer.spin ? rand(-layer.spin, layer.spin) : 0,
      })),
    );
    return loop((dt, now) => {
      const W = w();
      const H = h();
      const t = now / 1000;
      ctx.clearRect(0, 0, W, H);
      list.forEach((layer, li) => {
        ctx.globalCompositeOperation = layer.glow ? "lighter" : "source-over";
        for (const b of bits[li]) {
          b.x += b.vx * dt;
          b.y += b.vy * dt;
          b.rot += b.spin * dt;
          const m = b.size;
          if (b.x < -m) b.x = W + m;
          else if (b.x > W + m) b.x = -m;
          if (b.y < -m) b.y = H + m;
          else if (b.y > H + m) b.y = -m;
          const x = b.x + (layer.sway ? Math.sin(t * 0.8 + b.phase) * layer.sway : 0);
          ctx.globalAlpha = b.alpha * (layer.twinkle ? 0.55 + 0.45 * Math.sin(t * 1.3 + b.phase) : 1);
          const img = layer.sprites[b.pic];
          const k = b.size / (img.width * 0.8);
          const half = (img.width * k) / 2;
          if (b.spin) {
            ctx.save();
            ctx.translate(x, b.y);
            ctx.rotate(b.rot);
            ctx.drawImage(img, -half, -half, half * 2, half * 2);
            ctx.restore();
          } else {
            ctx.drawImage(img, x - half, b.y - half, half * 2, half * 2);
          }
        }
      });
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    });
  };
}

const HIGH_EXTRAS: Partial<Record<ThemeName, Effect>> = {
  // Big soft flakes of ash, and a warm haze, drift up through the glowing embers.
  ember: layers(() => [
    {
      count: 20,
      sprites: [blob("rgba(165, 140, 125, 0.95)", 0.7), blob("rgba(135, 110, 95, 0.95)", 0.55), blob("rgba(190, 150, 120, 0.9)", 0.8)].map((p) => sprite(70, 5, p)),
      vx: [10, 42],
      vy: [-34, -10],
      size: [26, 74],
      alpha: [0.2, 0.42],
      sway: 16,
      spin: 1,
    },
    {
      count: 8,
      sprites: [sprite(160, 26, blob("rgba(255, 120, 40, 0.9)"))],
      glow: true,
      vx: [-6, 6],
      vy: [-14, -5],
      size: [140, 280],
      alpha: [0.05, 0.1],
      twinkle: true,
    },
  ]),
  // Banks of mist roll past and big heavy drops streak by in front of the rain.
  storm: layers(() => [
    {
      count: 7,
      sprites: [sprite(260, 30, blob("rgba(175, 200, 245, 0.9)", 0.45))],
      vx: [34, 80],
      vy: [-2, 2],
      size: [260, 520],
      alpha: [0.05, 0.1],
    },
    {
      count: 12,
      sprites: [sprite(40, 3, (x, s) => { x.fillStyle = "rgba(215, 232, 255, 0.95)"; x.beginPath(); x.ellipse(0, 0, s * 0.1, s * 0.4, 0.18, 0, Math.PI * 2); x.fill(); })],
      vx: [-150, -90],
      vy: [760, 1150],
      size: [20, 38],
      alpha: [0.22, 0.42],
    },
  ]),
  // Soft lights float up and glimmer, in the colors of the ribbons.
  aurora: layers(() => [
    {
      count: 34,
      sprites: ["rgba(110, 255, 200, 0.95)", "rgba(150, 190, 255, 0.95)", "rgba(200, 150, 255, 0.95)"].map((c) => sprite(34, 4, blob(c))),
      glow: true,
      vx: [-8, 8],
      vy: [-26, -7],
      size: [12, 38],
      alpha: [0.35, 0.75],
      sway: 16,
      twinkle: true,
    },
  ]),
  // Large blurred characters fall slowly, in front of the sharp ones.
  matrix: layers(() => [
    {
      count: 14,
      sprites: "ｱｳｶｻﾀﾅﾊﾏ0138".split("").map((ch) =>
        sprite(80, 3, (x, s) => {
          x.fillStyle = "rgba(60, 255, 130, 0.95)";
          x.font = `${s}px "Cascadia Mono", Consolas, monospace`;
          x.textAlign = "center";
          x.textBaseline = "middle";
          x.fillText(ch, 0, 0);
        }),
      ),
      glow: true,
      vx: [-3, 3],
      vy: [34, 90],
      size: [50, 96],
      alpha: [0.14, 0.3],
      twinkle: true,
    },
  ]),
  // Big out-of-focus petals sail past in the foreground.
  sakura: layers(() => [
    {
      count: 12,
      sprites: ["rgba(255, 170, 205, 0.95)", "rgba(255, 205, 225, 0.95)", "rgba(255, 140, 185, 0.95)"].map((c) => sprite(90, 5, blob(c, 0.58))),
      vx: [22, 64],
      vy: [26, 66],
      size: [38, 90],
      alpha: [0.32, 0.6],
      sway: 34,
      spin: 1.4,
    },
  ]),
  // Large soft orbs of light rise like out-of-focus bubbles.
  abyss: layers(() => [
    {
      count: 14,
      sprites: [
        sprite(150, 6, (x, s) => {
          x.fillStyle = "rgba(90, 235, 245, 0.35)";
          x.beginPath();
          x.arc(0, 0, s * 0.4, 0, Math.PI * 2);
          x.fill();
          x.strokeStyle = "rgba(190, 255, 255, 0.9)";
          x.lineWidth = s * 0.03;
          x.stroke();
        }),
      ],
      glow: true,
      vx: [-4, 4],
      vy: [-20, -6],
      size: [46, 130],
      alpha: [0.1, 0.22],
      sway: 12,
      twinkle: true,
    },
  ]),
};

// ------------------------------------------------------------- Component ----

const EFFECTS: Partial<Record<ThemeName, Effect>> = { storm, ember, aurora, matrix, sakura, abyss };

/**
 * The special effect behind a premium theme. It is drawn on a layer behind the
 * whole interface (panels let it show through, clips are drawn over it) and never takes clicks.
 * It stops when animations are off, and while a video is on screen.
 *
 * Quality: High draws 60 times a second with an extra layer of big soft particles, Balanced draws the
 * usual particles 30 times a second, and Light has no particles at all (only soft moving gradients). Whatever the choice, it drops to 30 while the window is not in front,
 * and steps down a level by itself if the computer cannot keep up.
 */
export function ThemeFX({
  theme,
  motion,
  paused,
  quality,
  onSlow,
}: {
  theme: ThemeName;
  motion: boolean;
  paused: boolean;
  quality: FxQuality;
  /** Called with the next lower quality when the computer is struggling. */
  onSlow: (lower: FxQuality) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const extraRef = useRef<HTMLCanvasElement>(null);
  const extra = HIGH_EXTRAS[theme];
  const effect = EFFECTS[theme];
  const light = quality === "light";
  const running = !!effect && motion && !paused;
  const [focused, setFocused] = useState(() => document.hasFocus());
  const notify = useNotice();
  const slowRef = useRef((lower: FxQuality) => {
    onSlow(lower);
    notify(`Your computer was struggling, so background effects were lowered to ${lower === "light" ? "Light" : "Balanced"}. You can change this in Settings.`);
  });
  slowRef.current = (lower: FxQuality) => {
    onSlow(lower);
    notify(`Your computer was struggling, so background effects were lowered to ${lower === "light" ? "Light" : "Balanced"}. You can change this in Settings.`);
  };

  useEffect(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  }, []);

  // The target speed follows the quality and whether the window is in front.
  useEffect(() => {
    targetFps = quality === "high" && focused ? 60 : 30;
  }, [quality, focused]);

  // Particles (High and Balanced)
  useEffect(() => {
    const canvas = ref.current;
    if (!effect || !running || light || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const size = () => {
      // Balanced draws at the window's plain size instead of the screen's sharper scaled size,
      // which is far fewer pixels on a scaled or 4K screen and looks almost the same behind the panels.
      const dpr = quality === "high" ? window.devicePixelRatio || 1 : 1;
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    window.addEventListener("resize", size);
    document.documentElement.dataset.fx = "on";
    const stop = effect({ ctx, w: () => window.innerWidth, h: () => window.innerHeight });
    return () => {
      document.documentElement.dataset.fx = "off";
      stop();
      window.removeEventListener("resize", size);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    };
  }, [effect, running, light, quality]);

  // The extra layer of big soft particles (High only). Blurry, so it never needs the sharp resolution.
  useEffect(() => {
    const canvas = extraRef.current;
    if (!extra || !running || quality !== "high" || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const size = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    size();
    window.addEventListener("resize", size);
    const stop = extra({ ctx, w: () => window.innerWidth, h: () => window.innerHeight });
    return () => {
      stop();
      window.removeEventListener("resize", size);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    };
  }, [extra, running, quality]);

  // Gradients only (Light): panels still let the colors show through
  useEffect(() => {
    if (!effect || !running || !light) return;
    document.documentElement.dataset.fx = "on";
    return () => {
      document.documentElement.dataset.fx = "off";
    };
  }, [effect, running, light]);

  // Watching for a struggling computer: if the screen is being refreshed far less often than it
  // should be for two checks in a row while the window is in front, drop to the next level.
  useEffect(() => {
    if (!effect || !running || light) return;
    let frames = 0;
    let since = performance.now();
    let slowChecks = 0;
    let settling = true; // the first few seconds are not judged
    let raf = requestAnimationFrame(function tick() {
      frames++;
      raf = requestAnimationFrame(tick);
    });
    const timer = setInterval(() => {
      const now = performance.now();
      const rate = (frames * 1000) / (now - since);
      frames = 0;
      since = now;
      if (settling || document.hidden || !document.hasFocus()) {
        settling = false;
        slowChecks = 0;
        return;
      }
      slowChecks = rate < 40 ? slowChecks + 1 : 0;
      if (slowChecks >= 2) {
        slowChecks = 0;
        slowRef.current(quality === "high" ? "balanced" : "light");
      }
    }, 3000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(timer);
    };
  }, [effect, running, light, quality]);

  if (!effect) return null;
  if (light) return <div className="theme-fx fx-gradient" aria-hidden />;
  return (
    <>
      <canvas ref={ref} className="theme-fx" aria-hidden />
      {quality === "high" && extra && <canvas ref={extraRef} className="theme-fx" aria-hidden />}
    </>
  );
}
