import { useEffect, useRef, useState } from 'react';
import './DepsOverlay.css';

const KNOWN_STEPS = [
  { id: 'ffmpeg', label: 'FFmpeg' },
  { id: 'analyzer', label: 'mixxx-analyzer' },
  { id: 'ytdlp', label: 'yt-dlp' },
  { id: 'tidal', label: 'tidal-dl-ng' },
];

function fmt(bytes) {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function fmtSpeed(bps) {
  return bps > 0 ? `${fmt(bps)}/s` : null;
}

function fmtEta(sec) {
  if (sec <= 0) return null;
  if (sec < 60) return `~${Math.ceil(sec)}s`;
  return `~${Math.ceil(sec / 60)}m`;
}

/**
 * First-time setup overlay, installer-console style.
 *
 * - Required dependency steps render as a checklist (done/active/pending).
 * - The optional tidal-dl-ng step renders as a normal step row too (marked
 *   "optional"), with the required rows staying checked while it runs.
 * - The raw log console is COLLAPSED by default; "Show log" expands it.
 * - When a run finishes the overlay STAYS open with a Close button; it never
 *   auto-dismisses after real work.
 *
 * props:
 *   progress - live progress event ({ stepId, stepTotal, pct, error, ... })
 *   log      - accumulated console lines [{ text, kind: 'log' | 'error' }]
 *   done     - true when the run finished successfully (progress was cleared)
 *   onRetry  - re-run dependency install
 *   onClose  - dismiss the overlay (only offered once done / on error)
 */
export function DepsOverlay({ progress, log = [], done = false, onRetry, onClose }) {
  const logRef = useRef(null);
  const [showLog, setShowLog] = useState(false);

  // Keep the newest line visible while the log grows (console behaviour).
  useEffect(() => {
    if (!showLog) return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length, showLog]);

  if (!progress && !done) return null;

  const {
    stepId,
    stepPct,
    bytesDownloaded,
    bytesTotal,
    bytesPerSec,
    etaSec,
    pct,
    error,
    stepsCompleted,
  } = progress ?? {};

  const isError = !!error;
  const running = !done && !isError;

  // Step checklist. Show the FULL list (FFmpeg, mixxx-analyzer, yt-dlp,
  // tidal-dl-ng) up front, installer style: pending rows stay visible until
  // they run. Required rows flip to done as stepsCompleted advances; the
  // auto-installed tidal row activates after them.
  const hasSteps = running;
  const activeSteps = hasSteps ? KNOWN_STEPS : [];
  const doneCount =
    stepsCompleted ??
    Math.max(
      0,
      activeSteps.findIndex((s) => s.id === stepId)
    );

  const speed = fmtSpeed(bytesPerSec);
  const eta = fmtEta(etaSec);
  const hasBytes = bytesTotal > 0 && bytesDownloaded > 0;
  const showBar = running && (stepPct >= 0 || pct >= 0);
  // Optional step streams log lines without a percentage: show an animated
  // indeterminate bar instead of nothing.
  const indeterminate = running && !!stepId && pct != null && pct < 0;

  return (
    <div className="deps-overlay">
      <div className="deps-box deps-box--wide">
        <div className="deps-title">
          {isError ? 'Setup failed' : done ? 'Setup complete' : 'First-time setup'}
        </div>

        {hasSteps && (
          <div className="deps-steps">
            {activeSteps.map((s, i) => {
              const isDoneStep = i < doneCount;
              const isActive = s.id === stepId && running && !isDoneStep;
              return (
                <div
                  key={s.id}
                  className={`deps-step${isActive ? ' active' : ''}${isDoneStep ? ' done' : ''}`}
                >
                  <span className="deps-step-icon">{isDoneStep ? '✓' : isActive ? '↓' : '·'}</span>
                  <span className="deps-step-label">{s.label}</span>
                  {isActive && hasBytes && (
                    <span className="deps-step-meta">
                      {fmt(bytesDownloaded)} / {fmt(bytesTotal)}
                      {speed && ` · ${speed}`}
                      {eta && ` · ${eta}`}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {showBar && !indeterminate && (
          <div className="deps-bar-track">
            <div className="deps-bar-fill" style={{ width: `${stepPct >= 0 ? stepPct : pct}%` }} />
          </div>
        )}

        {indeterminate && (
          <div className="deps-bar-track">
            <div className="deps-bar-fill deps-bar-fill--indet" />
          </div>
        )}

        {log.length > 0 && (
          <div className="deps-console">
            <button type="button" className="deps-log-toggle" onClick={() => setShowLog((s) => !s)}>
              {showLog ? 'Hide log ▴' : `Show log (${log.length}) ▾`}
            </button>
            {showLog && (
              <div className="deps-log" ref={logRef}>
                {log.map((l, i) => (
                  <div
                    key={i}
                    className={`deps-log-line${l.kind === 'error' ? ' deps-log-line--err' : ''}`}
                  >
                    {l.text}
                  </div>
                ))}
                {running && <div className="deps-log-cursor">▌</div>}
              </div>
            )}
          </div>
        )}

        {done && !isError && (
          <div className="deps-done-note">All done. You can close this window.</div>
        )}

        {isError && !done && (
          <div className="deps-error">
            <span>{error || 'Something went wrong during setup.'}</span>
          </div>
        )}

        <div className="deps-actions">
          {isError && !done && onRetry && (
            <button className="deps-btn" onClick={onRetry}>
              Retry
            </button>
          )}
          {onClose && (done || isError) && (
            <button className="deps-btn deps-btn--primary" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
