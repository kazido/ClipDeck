import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  onClick: () => void;
  /** Draw a thin line above this item. */
  divider?: boolean;
  /** Shown in red, for things that delete. */
  danger?: boolean;
}

type ShowMenu = (e: React.MouseEvent, items: MenuItem[]) => void;
const MenuContext = createContext<ShowMenu>(() => {});
export const useMenu = () => useContext(MenuContext);

/** ClipDeck's own right-click menu. The browser menu is switched off everywhere except text boxes. */
export function MenuProvider({ children }: { children: React.ReactNode }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const show = useCallback<ShowMenu>((e, items) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);

  useEffect(() => {
    const off = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      e.preventDefault();
    };
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("contextmenu", off);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("contextmenu", off);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!menu || !el) return;
    el.style.left = `${Math.min(menu.x, window.innerWidth - el.offsetWidth - 6)}px`;
    el.style.top = `${Math.min(menu.y, window.innerHeight - el.offsetHeight - 6)}px`;
  }, [menu]);

  return (
    <MenuContext.Provider value={show}>
      {children}
      {menu && (
        <>
          <div className="menu-back" onMouseDown={() => setMenu(null)} onContextMenu={(e) => e.preventDefault()} />
          <div className="menu" ref={ref} style={{ left: menu.x, top: menu.y }}>
            {menu.items.map((item) => (
              <div key={item.label} className="menu-item">
                {item.divider && <hr />}
                <button
                  className={item.danger ? "danger-item" : undefined}
                  onClick={() => {
                    setMenu(null);
                    item.onClick();
                  }}
                >
                  {item.label}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </MenuContext.Provider>
  );
}
