import { useEffect, useState } from "react";
import { clipDetails, fileUrl, type Clip, type ClipInfo } from "./api";
import {
  channelLabel,
  formatBitrate,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatFps,
} from "./format";

interface Props {
  clip: Clip;
  /** Why the full player is not being used. */
  reason: string;
  onClose: () => void;
}

/** Basic browser-based preview, used only when the mpv player can't start. */
export function ClipPreview({ clip, reason, onClose }: Props) {
  const [failed, setFailed] = useState(false);
  const [details, setDetails] = useState<ClipInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    clipDetails(clip.id)
      .then((d) => !cancelled && setDetails(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [clip.id]);

  return (
    <div className="preview-backdrop" onMouseDown={onClose}>
      <div className="preview" onMouseDown={(e) => e.stopPropagation()}>
        <div className="preview-video">
          {failed ? (
            <div className="preview-failed">
              <strong>Can't play this file directly</strong>
              <span className="muted">Clips like this will get a preview copy in a later milestone.</span>
            </div>
          ) : (
            <video
              src={fileUrl(clip.path)}
              controls
              autoPlay
              onError={() => setFailed(true)}
            />
          )}
        </div>

        <aside className="preview-details">
          <button className="close" onClick={onClose} aria-label="Close preview">
            ✕
          </button>
          <h2>{clip.title}</h2>
          <p className="muted file-name">{clip.fileName}</p>

          <ClipFacts clip={clip} profile={details?.video.profile} />

          <h3>Audio tracks ({clip.audioTracks})</h3>
          {clip.audioTracks === 0 && <p className="muted">No audio.</p>}
          <ol className="tracks">
            {details?.audio.map((track, i) => (
              <li key={i}>
                <span>{track.title ?? `Track ${i + 1}`}</span>
                <span className="muted">
                  {[track.codec, channelLabel(track.channels)].filter(Boolean).join(" · ")}
                </span>
              </li>
            ))}
          </ol>
          <p className="muted note">
            Basic player in use, so only the first audio track plays. The full player could not
            start: {reason}
          </p>
        </aside>
      </div>
    </div>
  );
}

/** The standard list of facts about a clip. */
export function ClipFacts({ clip, profile }: { clip: Clip; profile?: string | null }) {
  const rows: [string, string][] = [
    ["Recorded", formatDateTime(clip.createdAtMs)],
    ["Duration", formatDuration(clip.durationMs)],
    ["Resolution", `${clip.width}×${clip.height}`],
    ["Frame rate", `${formatFps(clip)} fps`],
    ["Size", formatBytes(clip.sizeBytes)],
    ["Bitrate", formatBitrate(clip.bitRate)],
    ["Video", [clip.videoCodec, profile].filter(Boolean).join(" · ")],
    ["Container", clip.container.split(",")[0]],
  ];

  return (
    <dl>
      {rows.map(([label, value]) => (
        <div key={label} className="row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
