import { getCurrentWindow } from "@tauri-apps/api/window";

/** ClipDeck's own window bar, replacing the Windows one. */
export function TitleBar() {
  const win = getCurrentWindow();
  return (
    <div className="titlebar" data-tauri-drag-region onDoubleClick={() => win.toggleMaximize()}>
      <img src="/icon.png" alt="" data-tauri-drag-region />
      <span data-tauri-drag-region>ClipDeck</span>
      <div className="win-buttons">
        <button onClick={() => win.minimize()} aria-label="Minimize">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" /></svg>
        </button>
        <button onClick={() => win.toggleMaximize()} aria-label="Maximize">
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" /></svg>
        </button>
        <button className="win-close" onClick={() => win.close()} aria-label="Close to tray">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" /></svg>
        </button>
      </div>
    </div>
  );
}
