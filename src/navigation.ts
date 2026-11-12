// In-app navigation that behaves like a web browser's.
//
// Every place the user goes (a page, a folder, an open clip) is a step in the
// window's history. Back and forward - the mouse side buttons, Alt+Left and
// Alt+Right - then work without any extra code, and new pages get them for
// free. Escape is different: it always goes "up" one level, towards the top
// of the library.

import { useCallback, useEffect, useRef, useState } from "react";

export type View = "library" | "settings" | "cleanup" | "storage" | "guide";

export interface Place {
  view: View;
  /** Subfolder being browsed in the library. Null is the top of the clips folder. */
  folder: string | null;
  /** The clip that is open, if any. */
  clipId: number | null;
}

export const HOME: Place = { view: "library", folder: null, clipId: null };

const same = (a: Place, b: Place) =>
  a.view === b.view && a.folder === b.folder && a.clipId === b.clipId;

/** The place one level up from `place`, or null at the top of the library. */
export function parentOf(place: Place, rootDir: string | null): Place | null {
  if (place.clipId !== null) return { ...place, clipId: null };
  if (place.view !== "library") return { view: "library", folder: place.folder, clipId: null };
  if (place.folder === null) return null;
  const cut = Math.max(place.folder.lastIndexOf("\\"), place.folder.lastIndexOf("/"));
  const parent = cut > 0 ? place.folder.slice(0, cut) : null;
  const insideRoot = parent !== null && rootDir !== null && parent.length > rootDir.length;
  return { ...place, folder: insideRoot ? parent : null };
}

export function useNavigation() {
  const [place, setPlace] = useState<Place>(HOME);
  // Our own record of the history steps we created, so "up" can tell whether
  // the previous step is the place it wants (and simply go back to it).
  const steps = useRef<Place[]>([HOME]);
  const position = useRef(0);

  useEffect(() => {
    window.history.replaceState({ position: 0, place: HOME }, "");

    const onPopState = (e: PopStateEvent) => {
      const next: Place | undefined = e.state?.place;
      position.current = next ? (e.state.position ?? 0) : 0;
      setPlace(next ?? HOME);
    };
    // Some setups deliver the mouse side buttons as plain clicks instead.
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 3) window.history.back();
      else if (e.button === 4) window.history.forward();
      else return;
      e.preventDefault();
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  /** Go somewhere new, as a fresh history step. */
  const go = useCallback((next: Place) => {
    const current = steps.current[position.current] ?? HOME;
    if (same(current, next)) return;
    position.current += 1;
    steps.current = [...steps.current.slice(0, position.current), next];
    window.history.pushState({ position: position.current, place: next }, "");
    setPlace(next);
  }, []);

  /** Go up one level (Escape). Does nothing at the top of the library. */
  const up = useCallback(
    (rootDir: string | null) => {
      const current = steps.current[position.current] ?? HOME;
      const target = parentOf(current, rootDir);
      if (!target) return;
      const previous = steps.current[position.current - 1];
      if (previous && same(previous, target)) window.history.back();
      else go(target);
    },
    [go],
  );

  /** Forget the history and start again at `next` (e.g. after changing the clips folder). */
  const reset = useCallback((next: Place) => {
    steps.current[position.current] = next;
    window.history.replaceState({ position: position.current, place: next }, "");
    setPlace(next);
  }, []);

  return { place, go, up, reset };
}
