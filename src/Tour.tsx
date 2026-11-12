import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { View } from "./navigation";

interface Step {
  /** CSS selector of the thing to point at. Without one, the card sits in the middle. */
  target?: string;
  /** The page this step needs. */
  view?: View;
  title: string;
  text: string;
  /** Where the card goes relative to the target. */
  side?: "right" | "below" | "left";
}

const STEPS: Step[] = [
  {
    view: "library",
    title: "Welcome to ClipDeck",
    text: "Here's a one-minute walk around. Use the arrow keys or the buttons, and press Esc any time to stop.",
  },
  {
    view: "library",
    target: '[data-tour="nav-library"]',
    side: "right",
    title: "Your library",
    text: "Every clip OBS saves lands here by itself, sorted into a folder for each game.",
  },
  {
    view: "library",
    target: ".grid-scroll .card",
    side: "right",
    title: "Clips and folders",
    text: "Click a clip to watch it, or a folder to look inside. Drag a clip onto a folder to move it. Right-click for more, and hold Ctrl or Shift to pick several at once.",
  },
  {
    view: "library",
    target: '[data-tour="search"]',
    side: "below",
    title: "Search",
    text: "Type part of a name and every clip in every folder that matches shows up.",
  },
  {
    view: "library",
    target: '[data-tour="filters"]',
    side: "below",
    title: "Filters",
    text: "Narrow things down by game, tag or favorites, or group clips by game or month.",
  },
  {
    view: "library",
    target: '[data-tour="obs"]',
    side: "right",
    title: "OBS status",
    text: "A green light means OBS is recording the last moments of your game, ready for you to save. You can turn the replay buffer on or off here.",
  },
  {
    view: "library",
    target: '[data-tour="nav-cleanup"]',
    side: "right",
    title: "Cleanup",
    text: "A quick game for clearing out clips you don't need: keep, delete, move or skip, one at a time. Deleted clips go to the Recycle Bin.",
  },
  {
    view: "library",
    target: '[data-tour="nav-storage"]',
    side: "right",
    title: "Storage",
    text: "See which games and months take the most space, and find your biggest clips.",
  },
  {
    view: "library",
    target: '[data-tour="nav-settings"]',
    side: "right",
    title: "Settings",
    text: "Popups and sounds, themes and colors, how new clips are sorted, and the OBS connection.",
  },
  {
    view: "library",
    target: '[data-tour="nav-guide"]',
    side: "right",
    title: "Need this again?",
    text: "The Guide has the OBS setup and this tour, whenever you want them.",
  },
  {
    view: "library",
    title: "Handy keys",
    text: "Alt+Z shows or hides ClipDeck from anywhere. Esc goes back one step. Ctrl and + or − change the size of everything. Inside a clip: Space plays and pauses, and the arrow keys jump around. That's it. Enjoy!",
  },
];

const PAD = 8;

/** A walk around the app: dims everything except the thing being explained. */
export function Tour({ onClose, onGoTo }: { onClose: () => void; onGoTo: (view: View) => void }) {
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardPos, setCardPos] = useState<{ left: number; top: number } | null>(null);
  const step = STEPS[index];
  const last = index === STEPS.length - 1;

  // Take the app to the page the step is about, then find what to point at.
  useEffect(() => {
    if (step.view) onGoTo(step.view);
    // The old highlight stays until the new one is found, so the dimming never blinks.
    let tries = 0;
    const look = () => {
      const el = step.target ? document.querySelector<HTMLElement>(step.target) : null;
      if (el) {
        el.scrollIntoView({ block: "nearest" });
        setBox(el.getBoundingClientRect());
      } else if (step.target && tries++ < 8) {
        timer = setTimeout(look, 120);
      } else {
        setBox(null); // nothing to point at: show the card in the middle
      }
    };
    let timer = setTimeout(look, 80);
    const onResize = () => look();
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // Put the card beside the highlighted thing, kept inside the window.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    if (!box) {
      setCardPos({ left: (window.innerWidth - w) / 2, top: (window.innerHeight - h) / 2 });
      return;
    }
    let left = box.right + PAD + 14;
    let top = box.top + box.height / 2 - h / 2;
    if (step.side === "below") {
      left = box.left;
      top = box.bottom + PAD + 14;
    } else if (step.side === "left") {
      left = box.left - w - PAD - 14;
    }
    setCardPos({
      left: Math.max(12, Math.min(left, window.innerWidth - w - 12)),
      top: Math.max(12, Math.min(top, window.innerHeight - h - 12)),
    });
  }, [box, index, step.side]);

  const next = () => (last ? onClose() : setIndex(index + 1));
  const back = () => setIndex(Math.max(0, index - 1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "Enter") next();
      else if (e.key === "ArrowLeft") back();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <div className="tour-layer" role="dialog" aria-label="Guided tour">
      {/* One highlight that always exists: it slides between steps, or shrinks to nothing so the whole screen stays dim */}
      <div
        className={box ? "tour-spot" : "tour-spot none"}
        style={box ? { left: box.left - PAD, top: box.top - PAD, width: box.width + PAD * 2, height: box.height + PAD * 2 } : { left: "50%", top: "50%", width: 0, height: 0 }}
      />
      <div
        ref={cardRef}
        className="tour-pop"
        key={index}
        style={cardPos ? { left: cardPos.left, top: cardPos.top } : { visibility: "hidden" }}
      >
        <div className="tour-step">
          {index + 1} of {STEPS.length}
        </div>
        <h3>{step.title}</h3>
        <p>{step.text}</p>
        <div className="tour-actions">
          <button className="link" onClick={onClose}>
            {last ? "Close" : "Skip tour"}
          </button>
          <span className="spacer" />
          <button onClick={back} disabled={index === 0}>
            Back
          </button>
          <button className="primary" onClick={next}>
            {last ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
