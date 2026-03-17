import { useState, useEffect, useRef } from 'react';
import './DownloadView.css';

const SUPPORTED_SOURCES = [
  { name: 'YouTube', icon: '▶' },
  { name: 'SoundCloud', icon: '☁' },
  { name: 'Bandcamp', icon: '♫' },
  { name: 'Mixcloud', icon: '🎛' },
  { name: 'Vimeo', icon: '🎬' },
  { name: 'Twitch', icon: '🟣' },
  { name: 'Twitter / X', icon: '𝕏' },
  { name: 'Instagram', icon: '📷' },
  { name: 'Facebook', icon: 'f' },
  { name: 'TikTok', icon: '♪' },
  { name: 'Dailymotion', icon: '🎥' },
  { name: 'Deezer', icon: '🎵' },
];

const PLATFORM_ICONS = { youtube: '▶', soundcloud: '☁', bandcamp: '♫', other: '⬇' };

export default function DownloadView({ onGoToLibrary }) {
  const [url, setUrl] = useState('');
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    const unsub = window.api.onYtDlpProgress((data) => {
      if (data === null) {
        setLoading(false);
        setProgress(null);
      } else setProgress(data);
    });
    return unsub;
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setResult(null);
    setProgress({ msg: 'Starting download…', pct: 0 });
    const res = await window.api.ytDlpDownloadUrl(trimmed);
    setLoading(false);
    setProgress(null);
    setResult(res);
    if (res.ok) {
      setHistory((prev) => [{ url: trimmed, at: Date.now() }, ...prev.slice(0, 19)]);
      setUrl('');
    }
  };

  const handlePaste = (e) => {
    const text = e.clipboardData?.getData('text')?.trim();
    if (text && !loading) {
      setUrl(text);
      setResult(null);
    }
  };

  const detectIcon = (u) => {
    try {
      const host = new URL(u).hostname.toLowerCase();
      if (host.includes('youtube') || host.includes('youtu.be')) return PLATFORM_ICONS.youtube;
      if (host.includes('soundcloud')) return PLATFORM_ICONS.soundcloud;
      if (host.includes('bandcamp')) return PLATFORM_ICONS.bandcamp;
    } catch {}
    return PLATFORM_ICONS.other;
  };

  const formatTime = (ts) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="dl-view">
      <div className="dl-header">
        <h2 className="dl-title">YT-DLP Download</h2>
        <p className="dl-subtitle">
          Paste a URL — audio is extracted as M4A and added to your library.
        </p>
      </div>

      <form className="dl-form" onSubmit={handleSubmit} onPaste={handlePaste}>
        <div className="dl-input-row">
          <input
            ref={inputRef}
            className="dl-input"
            type="url"
            placeholder="https://www.youtube.com/watch?v=…"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setResult(null);
            }}
            disabled={loading}
            autoComplete="off"
            spellCheck={false}
          />
          <button className="dl-btn" type="submit" disabled={loading || !url.trim()}>
            {loading ? 'Downloading…' : 'Download'}
          </button>
        </div>

        {progress && (
          <div className="dl-progress">
            <div className="dl-progress-bar">
              <div className="dl-progress-fill" style={{ width: `${progress.pct ?? 0}%` }} />
            </div>
            <span className="dl-progress-msg">{progress.msg}</span>
          </div>
        )}

        {result?.ok && (
          <div className="dl-result dl-result--ok">
            <span>✓ Track added to your library</span>
            <button type="button" className="dl-goto-btn" onClick={onGoToLibrary}>
              View in Music →
            </button>
          </div>
        )}
        {result?.error && <div className="dl-result dl-result--err">✗ {result.error}</div>}
      </form>

      <div className="dl-sources">
        <div className="dl-sources-title">Supported sources</div>
        <div className="dl-sources-grid">
          {SUPPORTED_SOURCES.map((s) => (
            <div key={s.name} className="dl-source-chip">
              <span className="dl-source-icon">{s.icon}</span>
              <span>{s.name}</span>
            </div>
          ))}
          <div className="dl-source-chip dl-source-chip--more">+1000 more</div>
        </div>
      </div>

      {history.length > 0 && (
        <div className="dl-history">
          <div className="dl-history-title">Session downloads</div>
          {history.map((item, i) => (
            <div key={i} className="dl-history-item">
              <span className="dl-history-icon">{detectIcon(item.url)}</span>
              <span className="dl-history-url">{item.url}</span>
              <span className="dl-history-time">{formatTime(item.at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
