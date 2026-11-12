import { useEffect, useRef, useState } from "react";
import { onToast, type Toast } from "./api";
import { hasParticles, runParticles } from "./Particles";
import { applyFont, applyMotion, applyTheme, storedFont, storedMotion, storedTheme } from "./useTheme";

/** The whole content of the popup window: one card that slides in and fades out. */
export function ToastWindow() {
  const [toast, setToast] = useState<(Toast & { id: number }) | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  // Premium themes add a burst of their own particles when a popup appears.
  useEffect(() => {
    const el = canvas.current;
    const theme = document.documentElement.dataset.theme ?? "";
    if (!toast || !el || !storedMotion() || toast.event !== "saved" || !hasParticles(theme)) return;
    el.width = window.innerWidth;
    el.height = window.innerHeight;
    const fx = runParticles(el, theme);
    if (!fx) return;
    const w = el.width;
    const h = el.height;
    fx.emit(30, h / 2, 26, "burst");
    fx.strike(w * 0.45, h * 0.55);
    let n = 0;
    const timer = setInterval(() => {
      n++;
      const x = 20 + Math.random() * (w - 40);
      fx.emit(x, theme === "ember" || theme === "abyss" ? h - 14 : 14, 2, "trail");
      if (n > 22) clearInterval(timer);
    }, 90);
    const end = setTimeout(() => fx.stop(), Math.max(1500, toast.durationMs));
    return () => {
      clearInterval(timer);
      clearTimeout(end);
      fx.stop();
    };
  }, [toast]);

  useEffect(() => {
    let id = 0;
    const unlisten = onToast((next) => {
      // This window is made once at startup, so pick up any theme change made since.
      applyTheme(storedTheme());
      applyMotion(storedMotion());
      applyFont(storedFont());
      setToast({ ...next, id: ++id });
    });
    return () => void unlisten.then((off) => off());
  }, []);

  if (!toast) return null;
  return (
    // A new key restarts the animation when a popup replaces another.
    <div
      key={toast.id}
      className={`toast ${toast.kind} ${toast.size} event-${toast.event}`}
      // The fade-out starts just before the window is hidden.
      style={{ "--toast-life": `${toast.durationMs - 350}ms` } as React.CSSProperties}
    >
      <span className="toast-mark" />
      <div className="toast-text">
        <div className="toast-title">{toast.title}</div>
        <div className="toast-body">{toast.body}</div>
      </div>
      <canvas ref={canvas} className="toast-fx" aria-hidden />
    </div>
  );
}
