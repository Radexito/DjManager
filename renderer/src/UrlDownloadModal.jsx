import { useState, useEffect, useRef } from 'react';
import './UrlDownloadModal.css';

export default function UrlDownloadModal({ onClose }) {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState(null); // null | { msg, pct } | 'done' | { error }
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();

    const unsub = window.api.onYtDlpProgress((data) => {
      if (data === null) {
        // signal: finished
        setLoading(false);
      } else {
        setStatus(data);
      }
    });

    return unsub;
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;

    setLoading(true);
    setStatus({ msg: 'Starting…', pct: 0 });

    const result = await window.api.ytDlpDownloadUrl(trimmed);
    setLoading(false);

    if (result.ok) {
      setStatus('done');
    } else {
      setStatus({ error: result.error });
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && !loading) onClose();
  };

  return (
    <div className="url-modal-backdrop" onMouseDown={loading ? undefined : onClose}>
      <div className="url-modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="url-modal-header">
          <span>Download from URL</span>
          <button className="url-modal-close" onClick={onClose} disabled={loading}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="url-modal-form">
          <input
            ref={inputRef}
            className="url-modal-input"
            type="url"
            placeholder="https://www.youtube.com/watch?v=…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={loading}
          />
          <button className="url-modal-btn" type="submit" disabled={loading || !url.trim()}>
            {loading ? 'Downloading…' : 'Download'}
          </button>
        </form>

        {status && status !== 'done' && !status.error && (
          <div className="url-modal-progress">
            {/* Overall bar — only for playlists */}
            {(status.overallTotal ?? 1) > 1 && (
              <div className="url-modal-progress-row">
                <span className="url-modal-progress-label">
                  Overall {status.overallCurrent} / {status.overallTotal}
                </span>
                <div className="url-modal-progress-bar">
                  <div
                    className="url-modal-progress-fill"
                    style={{ width: `${status.pct ?? 0}%` }}
                  />
                </div>
              </div>
            )}
            {/* Per-track bar */}
            <div className="url-modal-progress-row">
              {(status.overallTotal ?? 1) > 1 && (
                <span className="url-modal-progress-label">Track</span>
              )}
              <div className="url-modal-progress-bar">
                <div
                  className="url-modal-progress-fill"
                  style={{ width: `${status.trackPct ?? status.pct ?? 0}%` }}
                />
              </div>
            </div>
            <span className="url-modal-progress-msg">{status.msg}</span>
          </div>
        )}

        {status === 'done' && (
          <div className="url-modal-result url-modal-result--ok">✓ Track added to library</div>
        )}

        {status?.error && (
          <div className="url-modal-result url-modal-result--err">✗ {status.error}</div>
        )}
      </div>
    </div>
  );
}
