import { createContext, useCallback, useContext, useRef, useState } from "react";

type Kind = "good" | "bad";
type Notify = (text: string, kind?: Kind) => void;
const NoticeContext = createContext<Notify>(() => {});
export const useNotice = () => useContext(NoticeContext);

/** A small message that appears at the bottom of the window for a few seconds. */
export function NoticeProvider({ children }: { children: React.ReactNode }) {
  const [notice, setNotice] = useState<{ text: string; kind: Kind; id: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const notify = useCallback<Notify>((text, kind = "good") => {
    window.clearTimeout(timer.current);
    setNotice({ text, kind, id: Date.now() });
    timer.current = window.setTimeout(() => setNotice(null), kind === "bad" ? 6000 : 2800);
  }, []);
  return (
    <NoticeContext.Provider value={notify}>
      {children}
      {notice && (
        <div key={notice.id} className={notice.kind === "bad" ? "notice bad" : "notice"} role="status">
          {notice.text}
        </div>
      )}
    </NoticeContext.Provider>
  );
}
