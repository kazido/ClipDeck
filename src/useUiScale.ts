import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export const UI_SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

function stored(): number {
  try {
    const v = Number(localStorage.getItem("uiScale"));
    return UI_SCALES.includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

/** Interface size. Ctrl + and Ctrl - (or Ctrl and the mouse wheel) change it; Ctrl 0 resets. */
export function useUiScale(): [number, (scale: number) => void] {
  const [scale, setState] = useState(stored);
  const current = useRef(scale);

  const set = useCallback((next: number) => {
    current.current = next;
    setState(next);
    try {
      localStorage.setItem("uiScale", String(next));
    } catch {
      /* not saved */
    }
    getCurrentWebview().setZoom(next).catch(() => {});
  }, []);

  useEffect(() => {
    getCurrentWebview().setZoom(current.current).catch(() => {});
    const step = (dir: number) => {
      const at = UI_SCALES.indexOf(current.current);
      set(UI_SCALES[Math.min(UI_SCALES.length - 1, Math.max(0, at + dir))]);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return;
      if (e.key === "=" || e.key === "+") step(1);
      else if (e.key === "-") step(-1);
      else if (e.key === "0") set(1);
      else return;
      e.preventDefault();
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      step(e.deltaY < 0 ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel);
    };
  }, [set]);

  return [scale, set];
}
