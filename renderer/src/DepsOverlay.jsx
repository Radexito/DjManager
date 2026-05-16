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

export function DepsOverlay({ progress, onRetry }) {
  if (!progress) return null;

  const {
    stepId,
    stepIndex,
    stepTotal,
    stepPct,
    bytesDownloaded,
    bytesTotal,
    bytesPerSec,
    etaSec,
    msg,
    pct,
    error,
  } = progress;

  // Build step list from known steps filtered to stepTotal count.
  // If stepId is unknown (e.g. old-format payload), fall back to simple view.
  const hasSteps = stepTotal > 0 && stepId !== undefined;

  // Derive which known steps are active in this run (stepTotal of them)
  const activeSteps = KNOWN_STEPS.filter((s) => {
    // Show step if it matches a step we've seen or will see
    const idx = KNOWN_STEPS.indexOf(s);
    return idx < stepTotal || s.id === stepId;
  }).slice(0, stepTotal);

  const currentIdx = activeSteps.findIndex((s) => s.id === stepId);
  const isError = pct === -1 || !!error;
  const isDone = pct === 100 && !error;

  const speed = fmtSpeed(bytesPerSec);
  const eta = fmtEta(etaSec);
  const hasBytes = bytesTotal > 0 && bytesDownloaded > 0;

  return (
    <div className="deps-overlay">
      <div className="deps-box">
        <div className="deps-title">First-time setup</div>

        {hasSteps && (
          <div className="deps-steps">
            {activeSteps.map((s, i) => {
              const isActive = s.id === stepId && !isDone;
              const isDoneStep = i < currentIdx || isDone;
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

        <div className="deps-msg">{msg}</div>

        {!isError && (stepPct >= 0 || pct >= 0) && (
          <div className="deps-bar-track">
            <div className="deps-bar-fill" style={{ width: `${stepPct >= 0 ? stepPct : pct}%` }} />
          </div>
        )}

        {hasSteps && stepTotal > 1 && !isDone && !isError && (
          <div className="deps-overall">
            Step {stepIndex} of {stepTotal}
          </div>
        )}

        {isError && (
          <div className="deps-error">
            <span>{error || msg}</span>
            {onRetry && (
              <button className="deps-retry-btn" onClick={onRetry}>
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
