import { useEffect, useState } from "react";
import {
  errorMessage,
  getObsStatus,
  launchObs,
  onObsProblem,
  onObsStatus,
  setReplayBuffer,
  type ObsStatus,
} from "./api";

/** Sidebar widget: is OBS ready to clip, with the one button that fixes it. */
export function ObsStatusPanel({ onError }: { onError: (message: string) => void }) {
  const [status, setStatus] = useState<ObsStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getObsStatus().then(setStatus).catch(() => {});
    const offStatus = onObsStatus((next) => {
      setStatus(next);
      setBusy(false);
    });
    const offProblem = onObsProblem((message) => {
      setBusy(false);
      onError(message);
    });
    return () => {
      offStatus.then((off) => off());
      offProblem.then((off) => off());
    };
  }, [onError]);

  if (!status) return null;

  // A request to OBS normally answers within a second; never stay "busy" for long.
  function act(action: Promise<void>) {
    setBusy(true);
    setTimeout(() => setBusy(false), 8000);
    action.catch((e) => {
      setBusy(false);
      onError(errorMessage(e));
    });
  }

  if (status.state === "disconnected") {
    return (
      <div className="obs" data-tour="obs" title={status.reason}>
        <div className="obs-line">
          <span className="dot off" />
          OBS not connected
        </div>
        <button onClick={() => act(launchObs())} disabled={busy}>
          {busy ? "Starting…" : "Start OBS"}
        </button>
      </div>
    );
  }

  const ready = status.replayBufferActive;
  return (
    <div className="obs" data-tour="obs">
      <div className="obs-line">
        <span className={ready ? "dot ready" : "dot idle"} />
        {ready ? "Ready to clip" : "Replay buffer off"}
      </div>
      <button onClick={() => act(setReplayBuffer(!ready))} disabled={busy}>
        {ready ? "Turn off" : "Turn on"}
      </button>
    </div>
  );
}
