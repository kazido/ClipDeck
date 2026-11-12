import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ToastWindow } from "./ToastWindow";
import "./styles.css";
import { applyFont, applyMotion, applyTheme, storedFont, storedMotion, storedTheme } from "./useTheme";

// The same page is loaded in two windows: the app itself, and the small
// popup window (opened with "#toast" on the address).
const isToastWindow = window.location.hash === "#toast";

// Set the colors before anything is drawn, so the theme never flashes.
applyTheme(storedTheme());
applyMotion(storedMotion());
applyFont(storedFont());

// The popup window lives in its own page, so it hears about theme changes through storage.
window.addEventListener("storage", (e) => {
  if (e.key === "theme") applyTheme(storedTheme());
  if (e.key === "motion") applyMotion(storedMotion());
  if (e.key === "font") applyFont(storedFont());
});

// Clicking a button, slider or tick box should not leave it "selected": a
// stuck focus ring looks messy, and Space would press that button again instead
// of pausing the video. Keyboard use (Tab, arrow keys) is unaffected.
document.addEventListener("pointerup", (e) => {
  const target = e.target instanceof Element ? e.target : null;
  const control = target?.closest<HTMLElement>("button, [role='button'], input[type='range'], input[type='checkbox']");
  if (control) setTimeout(() => control.blur(), 0);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isToastWindow ? <ToastWindow /> : <App />}</React.StrictMode>,
);
