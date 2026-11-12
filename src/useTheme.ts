import { useCallback, useState } from "react";

export type ThemeName =
  | "midnight" | "black" | "nord" | "dracula" | "obsidian" | "mocha"
  | "storm" | "ember" | "aurora" | "matrix" | "sakura" | "abyss"
  | "light" | "cappuccino" | "rose" | "mint" | "lavender";

export const THEME_GROUPS = ["Dark", "Premium", "Light and pastel"] as const;

export const THEMES: { key: ThemeName; label: string; group: (typeof THEME_GROUPS)[number] }[] = [
  { key: "midnight", label: "Midnight (blue)", group: "Dark" },
  { key: "black", label: "Black (black and white)", group: "Dark" },
  { key: "nord", label: "Nord (cool frost)", group: "Dark" },
  { key: "dracula", label: "Dracula (purple)", group: "Dark" },
  { key: "obsidian", label: "Obsidian (black and gold)", group: "Dark" },
  { key: "mocha", label: "Mocha (dark coffee)", group: "Dark" },
  { key: "storm", label: "\u2726 Storm (rain and lightning)", group: "Premium" },
  { key: "ember", label: "\u2726 Ember (embers and fire)", group: "Premium" },
  { key: "aurora", label: "\u2726 Aurora (northern lights)", group: "Premium" },
  { key: "matrix", label: "\u2726 Matrix (digital rain)", group: "Premium" },
  { key: "sakura", label: "\u2726 Sakura (petals on the wind)", group: "Premium" },
  { key: "abyss", label: "\u2726 Abyss (light in deep water)", group: "Premium" },
  { key: "light", label: "Light", group: "Light and pastel" },
  { key: "cappuccino", label: "Cappuccino (warm cream)", group: "Light and pastel" },
  { key: "rose", label: "Rose (pastel pink)", group: "Light and pastel" },
  { key: "mint", label: "Mint (pastel green)", group: "Light and pastel" },
  { key: "lavender", label: "Lavender (pastel purple)", group: "Light and pastel" },
];

export function storedTheme(): ThemeName {
  try {
    const v = localStorage.getItem("theme");
    return THEMES.some((t) => t.key === v) ? (v as ThemeName) : "midnight";
  } catch {
    return "midnight";
  }
}

export function applyTheme(theme: ThemeName) {
  document.documentElement.dataset.theme = theme;
}

/** The color theme, remembered between runs. */
export function useTheme(): [ThemeName, (theme: ThemeName) => void] {
  const [theme, setState] = useState<ThemeName>(storedTheme);
  const set = useCallback((next: ThemeName) => {
    setState(next);
    applyTheme(next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* not saved */
    }
  }, []);
  return [theme, set];
}

/** Animations on or off, remembered between runs. */
export function storedMotion(): boolean {
  try {
    return localStorage.getItem("motion") !== "off";
  } catch {
    return true;
  }
}

export function applyMotion(on: boolean) {
  document.documentElement.dataset.motion = on ? "on" : "off";
}

export function useMotion(): [boolean, (on: boolean) => void] {
  const [on, setState] = useState<boolean>(storedMotion);
  const set = useCallback((next: boolean) => {
    setState(next);
    applyMotion(next);
    try {
      localStorage.setItem("motion", next ? "on" : "off");
    } catch {
      /* not saved */
    }
  }, []);
  return [on, set];
}

/** How much work the premium theme effects do: High is sharpest, Balanced is lighter on the graphics card, Light is lightest. */
export type FxQuality = "high" | "balanced" | "light";

export function storedFxQuality(): FxQuality {
  try {
    const v = localStorage.getItem("fxQuality");
    return v === "high" || v === "light" ? v : "balanced";
  } catch {
    return "balanced";
  }
}

export function useFxQuality(): [FxQuality, (q: FxQuality) => void] {
  const [quality, setState] = useState<FxQuality>(storedFxQuality);
  const set = useCallback((next: FxQuality) => {
    setState(next);
    try {
      localStorage.setItem("fxQuality", next);
    } catch {
      /* not saved */
    }
  }, []);
  return [quality, set];
}

/** Fonts the person can choose to use everywhere, in place of each theme's own. All come with Windows. */
export const FONTS: { key: string; label: string; stack: string }[] = [
  { key: "theme", label: "Each theme's own", stack: "" },
  { key: "segoe", label: "Segoe UI", stack: '"Segoe UI Variable", "Segoe UI", sans-serif' },
  { key: "arial", label: "Arial", stack: "Arial, Helvetica, sans-serif" },
  { key: "calibri", label: "Calibri", stack: "Calibri, Candara, sans-serif" },
  { key: "candara", label: "Candara", stack: "Candara, Calibri, sans-serif" },
  { key: "bahnschrift", label: "Bahnschrift", stack: 'Bahnschrift, "Segoe UI", sans-serif' },
  { key: "verdana", label: "Verdana", stack: "Verdana, Geneva, sans-serif" },
  { key: "tahoma", label: "Tahoma", stack: "Tahoma, Geneva, sans-serif" },
  { key: "trebuchet", label: "Trebuchet MS", stack: '"Trebuchet MS", sans-serif' },
  { key: "georgia", label: "Georgia (serif)", stack: "Georgia, serif" },
  { key: "palatino", label: "Palatino (serif)", stack: '"Palatino Linotype", Palatino, serif' },
  { key: "consolas", label: "Consolas (monospace)", stack: "Consolas, monospace" },
  { key: "cascadia", label: "Cascadia Code (monospace)", stack: '"Cascadia Code", "Cascadia Mono", Consolas, monospace' },
  { key: "comic", label: "Comic Sans", stack: '"Comic Sans MS", "Comic Neue", cursive' },
];

export function storedFont(): string {
  try {
    const v = localStorage.getItem("font");
    return FONTS.some((f) => f.key === v) ? (v as string) : "theme";
  } catch {
    return "theme";
  }
}

export function applyFont(key: string) {
  const root = document.documentElement;
  const font = FONTS.find((f) => f.key === key);
  if (!font || key === "theme") {
    delete root.dataset.font;
    root.style.removeProperty("--font-override");
  } else {
    root.dataset.font = "custom";
    root.style.setProperty("--font-override", font.stack);
  }
}

/** The font used everywhere, or "theme" to let each theme pick its own. */
export function useFont(): [string, (key: string) => void] {
  const [font, setState] = useState<string>(storedFont);
  const set = useCallback((next: string) => {
    setState(next);
    applyFont(next);
    try {
      localStorage.setItem("font", next);
    } catch {
      /* not saved */
    }
  }, []);
  return [font, set];
}
