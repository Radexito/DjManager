import { useEffect, useState } from 'react';
import './GraphicsNotice.css';

/**
 * Hardware-acceleration notice bar.
 *
 * Shown only when the persisted state says the app fell back after a GPU crash
 * loop. Dismissal lives in sessionStorage on purpose: the plan forbids a silent
 * fallback, but nagging on every start would be its own bug. The next start shows
 * it again.
 */

const DISMISS_KEY = 'djman.graphicsNotice.dismissed';

/**
 * Dismissible banner telling the user that hardware acceleration was turned off
 * after a GPU process crash, with an expandable crash report.
 *
 * Renders nothing unless the main process reports a "gpu-crash" notice, and stays
 * hidden for the rest of the session once dismissed.
 */
export default function GraphicsNotice() {
  const [state, setState] = useState(null);
  const [report, setReport] = useState(null);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISS_KEY) === '1');

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(window.api?.getGraphicsState?.())
      .then((next) => {
        if (!cancelled) setState(next ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const showMore = async () => {
    setOpen((wasOpen) => !wasOpen);
    if (report || open) return;
    try {
      setReport(await window.api.getGraphicsReport());
    } catch {
      setReport(null);
    }
  };

  const dismiss = () => {
    sessionStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  };

  if (dismissed || state?.notice !== 'gpu-crash') return null;

  return (
    <div className="graphics-notice" role="status" data-testid="graphics-notice">
      <span className="graphics-notice-text">
        Hardware acceleration was disabled because the GPU process crashed.
      </span>
      <button type="button" className="btn-secondary" onClick={showMore}>
        {open ? 'Hide details' : 'Show more'}
      </button>
      <button
        type="button"
        className="btn-secondary"
        aria-label="Dismiss graphics notice"
        onClick={dismiss}
      >
        ×
      </button>
      {open && (
        <div className="graphics-notice-report" data-testid="graphics-notice-report">
          {report ? (
            <>
              <p>
                Crashes recorded: {report.summary?.count ?? 0} · Mode: {report.mode ?? 'auto'}
              </p>
              <p className="graphics-notice-meta">
                {report.appVersion ? `App ${report.appVersion}` : null}
                {report.electron ? ` · Electron ${report.electron}` : null}
                {report.platform ? ` · ${report.platform}` : null}
              </p>
              <p className="graphics-notice-meta">
                No stack trace is available for child processes; the report lists crash types,
                reasons and log tail instead.
              </p>
            </>
          ) : (
            <p>Loading report…</p>
          )}
        </div>
      )}
    </div>
  );
}
