import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { listTagInfos, type TagInfo } from "./api";

/** The colors people can give a tag. */
export const TAG_COLORS = ["#ff6b6b", "#ff9f43", "#ffd166", "#7bd88f", "#4dd0c8", "#4f8bff", "#a78bfa", "#f472b6", "#9aa0b4"];

interface TagColorApi {
  infos: TagInfo[];
  /** The color of a tag, if it has one. */
  color: (name: string) => string | undefined;
  reload: () => void;
}
const TagColorContext = createContext<TagColorApi>({ infos: [], color: () => undefined, reload: () => {} });
export const useTagColors = () => useContext(TagColorContext);

/** Loads every tag and its color once, and shares them with the whole app. */
export function TagColorProvider({ children }: { children: React.ReactNode }) {
  const [infos, setInfos] = useState<TagInfo[]>([]);
  const reload = useCallback(() => {
    listTagInfos().then(setInfos).catch(() => {});
  }, []);
  useEffect(reload, [reload]);
  // Tags change in many places (a clip, the manager), so any of them can ask for a fresh look.
  useEffect(() => {
    window.addEventListener("tags-changed", reload);
    return () => window.removeEventListener("tags-changed", reload);
  }, [reload]);

  const api = useMemo<TagColorApi>(() => {
    const byName = new Map(infos.map((t) => [t.name.toLowerCase(), t.color ?? undefined]));
    return { infos, color: (name) => byName.get(name.toLowerCase()), reload };
  }, [infos, reload]);
  return <TagColorContext.Provider value={api}>{children}</TagColorContext.Provider>;
}

/** CSS for a tag label in its color (or plain when it has none). */
export function tagStyle(color: string | undefined): React.CSSProperties | undefined {
  return color ? { borderColor: color, background: `${color}26`, color } : undefined;
}
