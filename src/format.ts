interface FrameRate {
  fpsNum: number;
  fpsDen: number;
}

export function formatFps({ fpsNum, fpsDen }: FrameRate): string {
  if (fpsDen <= 0 || fpsNum <= 0) return "?";
  const value = fpsNum / fpsDen;
  // MKV reports rates like 59.9401; show those as 59.94, and 60.0002 as 60.
  const rounded = Math.round(value * 100) / 100;
  return Math.abs(rounded - Math.round(rounded)) < 0.011 ? `${Math.round(rounded)}` : rounded.toFixed(2);
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** 0:07, 1:23, 1:02:03 */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function formatBitrate(bps: number | null): string {
  if (bps === null) return "unknown";
  return `${(bps / 1_000_000).toFixed(1)} Mbps`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function channelLabel(channels: number | null): string {
  if (channels === 1) return "mono";
  if (channels === 2) return "stereo";
  return channels ? `${channels} ch` : "";
}

/** A steady color for a game name, so each game is easy to recognise. */
export function gameColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 70% 62%)`;
}
