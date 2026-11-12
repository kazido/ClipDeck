import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fileUrl, type Filmstrip } from "./api";

/** Which page a frame is on, and where in it. */
function locate(strip: Filmstrip, time: number) {
  const frame = Math.min(Math.max(Math.round(time / strip.interval), 0), strip.frames - 1);
  const page = Math.min(Math.floor(frame / strip.framesPerPage), strip.pages - 1);
  const local = frame - page * strip.framesPerPage;
  return { page, col: local % strip.columns, row: Math.floor(local / strip.columns) };
}

/** The clip's frame nearest `time`, large, standing in for the video while the playhead is being dragged. */
export function BigFrame({ strip, time }: { strip: Filmstrip; time: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      const ratio = strip.frameWidth / strip.frameHeight;
      const w = Math.min(el.clientWidth, el.clientHeight * ratio);
      setSize({ w, h: w / ratio });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [strip]);

  const { page, col, row } = locate(strip, time);

  // Keep the pages on either side loaded, so crossing into the next one doesn't flash.
  const ready = useRef(new Map<number, HTMLImageElement>());
  useEffect(() => {
    for (const p of [page - 1, page, page + 1]) {
      if (p < 0 || p >= strip.pages || ready.current.has(p)) continue;
      const img = new Image();
      img.src = fileUrl(strip.pagePaths[p]);
      ready.current.set(p, img);
    }
    for (const p of [...ready.current.keys()]) {
      if (Math.abs(p - page) > 1) ready.current.delete(p);
    }
  }, [page, strip]);

  return (
    <div className="big-frame" ref={box}>
      <div
        style={{
          width: size.w,
          height: size.h,
          backgroundColor: "#000",
          backgroundImage: `url("${fileUrl(strip.pagePaths[page])}")`,
          backgroundRepeat: "no-repeat",
          backgroundSize: `${strip.columns * 100}% ${strip.rows * 100}%`,
          backgroundPosition: `${strip.columns > 1 ? (col / (strip.columns - 1)) * 100 : 0}% ${strip.rows > 1 ? (row / (strip.rows - 1)) * 100 : 0}%`,
        }}
      />
    </div>
  );
}
