import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { fileUrl, linkGameProgram, listGamePrograms, type GameProgram } from "./api";

interface GameIconApi {
  /** The icon picture for a game, if its program is known. */
  icon: (game: string | null | undefined) => string | undefined;
  /** The program file name tied to a game (for example "rocketleague.exe"). */
  program: (game: string) => string | undefined;
  link: (game: string, path: string) => Promise<void>;
  reload: () => void;
}
const GameIconContext = createContext<GameIconApi>({ icon: () => undefined, program: () => undefined, link: async () => {}, reload: () => {} });
export const useGameIcons = () => useContext(GameIconContext);

/** Loads the programs and icons of games once, and shares them with the whole app. */
export function GameIconProvider({ children }: { children: React.ReactNode }) {
  const [programs, setPrograms] = useState<GameProgram[]>([]);
  const reload = useCallback(() => {
    listGamePrograms().then(setPrograms).catch(() => {});
  }, []);
  useEffect(reload, [reload]);

  const api = useMemo<GameIconApi>(() => {
    const byGame = new Map<string, GameProgram>();
    for (const p of programs) {
      const key = p.game.toLowerCase();
      if (!byGame.has(key) || (p.iconPath && !byGame.get(key)!.iconPath)) byGame.set(key, p);
    }
    return {
      icon: (game) => {
        const p = game ? byGame.get(game.toLowerCase()) : undefined;
        return p?.iconPath ? fileUrl(p.iconPath) : undefined;
      },
      program: (game) => byGame.get(game.toLowerCase())?.exe,
      link: async (game, path) => setPrograms(await linkGameProgram(game, path)),
      reload,
    };
  }, [programs, reload]);

  return <GameIconContext.Provider value={api}>{children}</GameIconContext.Provider>;
}
