import { useEffect, useRef } from 'react';
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
 * First-time setup overlay.
 *
 * Behaves like a classic Windows installer console: every step streams into a
 * scrollable log the user can read, and when the run finishes the window STAYS
 * open with a Close button. It never auto-dismisses after real work.
 *
 * props:
 *   progress - live progress event ({ stepId, pct, msg, error, ... }) or null
 *   log      - accumulated console lines [{ text, kind: 'log' | 'error' }]
 *   done     - true when the run finished successfully (progress was cleared)
 *   onRetry  - re-run dependency install
 *   onClose  - dismiss the overlay (only offered once done / on error)
 */
export function DepsOverlay({ progress, log = [], done = false, onRetry, onClose }) {
  const logRef = useRef(null);

  // Keep the newest line visible while the log grows (console behaviour).
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  if (!progress && !done) return null;

  const {
    stepId,
    stepIndex,
    stepTotal,
    stepPct,
    bytesDownloaded,
    bytesTotal,
    bytesPerSec,
    etaSec,
    pct,
    error,
  } = progress ?? {};

  const isError = !!error;
  const running = !done && !isError;

  // Step list (only meaningful while a multi-step run is live).
  const hasSteps = running && stepTotal > 0 && stepId !== undefined;
  const activeSteps = hasSteps
    ? KNOWN_STEPS.filter((s) => KNOWN_STEPS.indexOf(s) < stepTotal || s.id === stepId).slice(
        0,
        stepTotal
      )
    : [];
  const currentIdx = activeSteps.findIndex((s) => s.id === stepId);

  const speed = fmtSpeed(bytesPerSec);
  const eta = fmtEta(etaSec);
  const hasBytes = bytesTotal > 0 && bytesDownloaded > 0;
  const showBar = running && (stepPct >= 0 || pct >= 0);

  return (
    <div className="deps-overlay">
      <div className="deps-box deps-box--wide">
        <div className="deps-title">
          {isError ? 'Setup failed' : done ? 'Setup complete' : 'First-time setup'}
        </div>

        {hasSteps && (
          <div className="deps-steps">
            {activeSteps.map((s, i) => {
              const isActive = s.id === stepId && !isError;
              const isDoneStep = i < currentIdx;
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

        {showBar && (
          <div className="deps-bar-track">
            <div className="deps-bar-fill" style={{ width: `${stepPct >= 0 ? stepPct : pct}%` }} />
          </div>
        )}

        {running && stepTotal > 1 && (
          <div className="deps-overall">
            Step {stepIndex} of {stepTotal}
          </div>
        )}

        {log.length > 0 && (
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
