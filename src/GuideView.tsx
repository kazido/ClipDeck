import { useCallback, useEffect, useState } from "react";
import {
  applyObsSetup,
  errorMessage,
  getObsSettings,
  getObsStatus,
  launchObs,
  onObsStatus,
  readObsSetup,
  setObsSettings,
  type ObsSetup,
  type ObsSetupReport,
  type ObsStatus,
} from "./api";

type Tab = "tour" | "obs";

/** The welcome tour and the guided OBS setup. */
export function GuideView({ onStartTour }: { onStartTour: () => void }) {
  const [tab, setTab] = useState<Tab>("tour");
  return (
    <div className="guide">
      <h1>Welcome to ClipDeck</h1>
      <p className="muted">Get set up in a couple of minutes, then forget about it. ClipDeck keeps your clips tidy while OBS does the recording.</p>
      <div className="guide-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "obs"} className={tab === "obs" ? "on" : ""} onClick={() => setTab("obs")}>
          1 · Set up OBS
        </button>
        <button role="tab" aria-selected={tab === "tour"} className={tab === "tour" ? "on" : ""} onClick={() => setTab("tour")}>
          2 · Take the tour
        </button>
      </div>
      {tab === "tour" ? <TourIntro onStart={onStartTour} /> : <ObsGuide onNext={() => setTab("tour")} />}
    </div>
  );
}

function TourIntro({ onStart }: { onStart: () => void }) {
  return (
    <div className="guide-body">
      <section className="tour-hero">
        <h2>See how it works</h2>
        <p>A short walk around the app. ClipDeck points at each part and tells you what it does, in about a minute.</p>
        <button className="primary" onClick={onStart}>
          Start the tour
        </button>
      </section>
    </div>
  );
}

const LENGTHS = [30, 60, 90, 120];

function ObsGuide({ onNext }: { onNext: () => void }) {
  const [status, setStatus] = useState<ObsStatus | null>(null);
  const [password, setPassword] = useState("");
  const [port, setPort] = useState(4455);
  const [seconds, setSeconds] = useState(60);
  const [current, setCurrent] = useState<ObsSetup | null>(null);
  const [report, setReport] = useState<ObsSetupReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const connected = status?.state === "connected";

  useEffect(() => {
    getObsStatus().then(setStatus).catch(() => {});
    getObsSettings()
      .then((s) => {
        setPassword(s.password);
        setPort(s.port);
      })
      .catch(() => {});
    const unlisten = onObsStatus(setStatus);
    return () => void unlisten.then((off) => off());
  }, []);

  const look = useCallback(() => {
    readObsSetup()
      .then((c) => {
        setCurrent(c);
        if (c.replaySeconds > 0) setSeconds((old) => (LENGTHS.includes(c.replaySeconds) ? c.replaySeconds : old));
      })
      .catch(() => setCurrent(null));
  }, []);
  useEffect(() => {
    if (connected) look();
    else setCurrent(null);
  }, [connected, look]);

  async function connect() {
    setBusy(true);
    setProblem(null);
    try {
      const saved = await getObsSettings();
      await setObsSettings({ ...saved, port, password });
    } catch (e) {
      setProblem(errorMessage(e));
    }
    setBusy(false);
  }

  async function apply() {
    setBusy(true);
    setProblem(null);
    setReport(null);
    try {
      setReport(await applyObsSetup(seconds));
      look();
    } catch (e) {
      setProblem(errorMessage(e));
    }
    setBusy(false);
  }

  return (
    <div className="guide-body">
      <ol className="steps">
        <li>
          <h3>Install OBS Studio</h3>
          <p>
            OBS is the free program that does the recording. Download it from <strong>obsproject.com</strong> and install it. You only do this once.
          </p>
        </li>

        <li>
          <h3>Let ClipDeck talk to OBS</h3>
          <p>
            In OBS, open <strong>Tools → WebSocket Server Settings</strong>. Tick <strong>Enable WebSocket server</strong>, press <strong>Show Connect Info</strong>, and copy the
            password. Paste it here.
          </p>
          <div className="guide-row">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="OBS WebSocket password" aria-label="OBS WebSocket password" />
            <input className="narrow" type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 4455)} aria-label="Port" title="Leave this at 4455 unless you changed it in OBS" />
            <button onClick={connect} disabled={busy}>
              Connect
            </button>
            <button onClick={() => launchObs().catch((e) => setProblem(errorMessage(e)))} title="Start OBS for you">
              Open OBS
            </button>
          </div>
          <p className={connected ? "good small" : "muted small"}>
            {status === null ? "Checking…" : status.state === "connected" ? "Connected to OBS." : `Not connected yet: ${status.reason}`}
          </p>
        </li>

        <li className={connected ? "" : "locked"}>
          <h3>Give OBS good settings</h3>
          <p>One click sets OBS up for clipping. It will:</p>
          <ul>
            <li>Turn on the replay buffer, which keeps the last moments of your game ready to save.</li>
            <li>Record at up to 1080p and 60 frames per second, which looks great and keeps clips a sensible size.</li>
            <li>Use high quality in the MKV format, which keeps clips safe even if OBS or your computer crashes.</li>
            <li>Save clips straight into your ClipDeck folder.</li>
          </ul>
          <p className="muted small">Audio tracks and the rest of OBS are left exactly as you have them.</p>
          <div className="guide-row">
            <label>
              Keep the last{" "}
              <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
                {LENGTHS.map((n) => (
                  <option key={n} value={n}>
                    {n} seconds
                  </option>
                ))}
              </select>
            </label>
            <button className="primary" onClick={apply} disabled={busy || !connected}>
              {busy ? "Working…" : "Set up OBS for me"}
            </button>
          </div>
          {current && (
            <p className="muted small">
              Right now OBS is at {current.width}×{current.height}, {current.fps} fps, replay buffer {current.replayBuffer ? `on (${current.replaySeconds} s)` : "off"}.
            </p>
          )}
          {report && (
            <div className="guide-report">
              {report.changes.length === 0 ? <p className="good">OBS already had these settings. Nothing needed changing.</p> : <p className="good">Done. Changed:</p>}
              <ul>
                {report.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              {report.notes.map((n) => (
                <p key={n} className="muted small">
                  {n}
                </p>
              ))}
            </div>
          )}
        </li>

        <li>
          <h3>Pick a save key</h3>
          <p>
            In OBS, open <strong>Settings → Hotkeys</strong>, find <strong>Save Replay</strong>, click its box and press the key you want, for example <strong>Alt+S</strong>. This is the key you press in
            game when something cool happens.
          </p>
        </li>

        <li>
          <h3>Try it</h3>
          <p>
            Start a game, press your save key, and a <strong>Clip saved</strong> popup appears. The clip lands in your library, filed under the game. From now on ClipDeck can start OBS and the replay buffer for you
            whenever it opens.
          </p>
        </li>
      </ol>
      {problem && <p className="bad">{problem}</p>}
      <button className="primary" onClick={onNext}>
        Next: take the tour
      </button>
    </div>
  );
}
