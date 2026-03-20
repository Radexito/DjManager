import { useState, useEffect, useRef, useCallback } from 'react';
import './DownloadView.css';

const SUPPORTED_SOURCES = [
  { name: 'YouTube', icon: '▶', url: 'https://www.youtube.com' },
  { name: 'SoundCloud', icon: '☁', url: 'https://soundcloud.com' },
  { name: 'Bandcamp', icon: '♫', url: 'https://bandcamp.com' },
  { name: 'Mixcloud', icon: '🎛', url: 'https://www.mixcloud.com' },
  { name: 'Vimeo', icon: '🎬', url: 'https://vimeo.com' },
  { name: 'Twitch', icon: '🟣', url: 'https://www.twitch.tv' },
  { name: 'Twitter / X', icon: '𝕏', url: 'https://x.com' },
  { name: 'Instagram', icon: '📷', url: 'https://www.instagram.com' },
  { name: 'Facebook', icon: 'f', url: 'https://www.facebook.com' },
  { name: 'TikTok', icon: '♪', url: 'https://www.tiktok.com' },
  { name: 'Dailymotion', icon: '🎥', url: 'https://www.dailymotion.com' },
  { name: 'Deezer', icon: '🎵', url: 'https://www.deezer.com' },
];

const YT_DLP_SUPPORTED_SITES = 'https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md';
const PLATFORM_ICONS = { youtube: '▶', soundcloud: '☁', bandcamp: '♫', other: '⬇' };

const STATUS_ICON = {
  pending: { icon: '□', label: 'Pending' },
  downloading: { icon: '⋯', label: 'Downloading' },
  importing: { icon: '↓', label: 'Importing' },
  done: { icon: '✓', label: 'Done' },
  failed: { icon: '✗', label: 'Failed' },
};

function fmtDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function DownloadView({ onGoToLibrary, onGoToPlaylist }) {
  // ── shared state ─────────────────────────────────────────────────────────
  const [url, setUrl] = useState('');
  const [history, setHistory] = useState([]);
  const [step, setStep] = useState('url'); // 'url' | 'select' | 'download'

  // ── step: url ─────────────────────────────────────────────────────────────
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const inputRef = useRef(null);

  // ── step: select ──────────────────────────────────────────────────────────
  const [playlistInfo, setPlaylistInfo] = useState(null); // { type, title, entries }
  const [selectedIndices, setSelectedIndices] = useState(new Set());
  const [playlists, setPlaylists] = useState([]); // existing playlists for combobox
  const [targetPlaylistId, setTargetPlaylistId] = useState(null); // null = create new
  const [targetPlaylistName, setTargetPlaylistName] = useState('');

  // ── step: download ────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [trackStatuses, setTrackStatuses] = useState([]);
  const [result, setResult] = useState(null);

  useEffect(() => {
    inputRef.current?.focus();

    const unsubProgress = window.api.onYtDlpProgress((data) => {
      if (data === null) {
        setLoading(false);
        setProgress(null);
      } else setProgress(data);
    });

    const unsubTrack = window.api.onYtDlpTrackUpdate((update) => {
      if (update.type === 'init') {
        // Only use 'init' to populate if the list isn't already pre-populated from step 2
        setTrackStatuses((prev) => {
          if (prev.length >= update.total) return prev;
          return Array.from({ length: update.total }, (_, i) => ({
            index: i,
            title: `Track ${i + 1}`,
            url: '',
            status: 'pending',
          }));
        });
      } else {
        setTrackStatuses((prev) => {
          const next = [...prev];
          const i = update.index;
          while (next.length <= i) {
            const n = next.length;
            next.push({ index: n, title: `Track ${n + 1}`, url: '', status: 'pending' });
          }
          next[i] = { ...next[i], ...update };
          return next;
        });
      }
    });

    return () => {
      unsubProgress();
      unsubTrack();
    };
  }, []);

  // ── handlers ──────────────────────────────────────────────────────────────

  const openLink = (e, href) => {
    e.preventDefault();
    window.api.openExternal(href);
  };

  const detectIcon = (u) => {
    try {
      const host = new URL(u).hostname.toLowerCase();
      if (host.includes('youtube') || host.includes('youtu.be')) return PLATFORM_ICONS.youtube;
      if (host.includes('soundcloud')) return PLATFORM_ICONS.soundcloud;
      if (host.includes('bandcamp')) return PLATFORM_ICONS.bandcamp;
    } catch {
      /* invalid URL */
    }
    return PLATFORM_ICONS.other;
  };

  const formatTime = (ts) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Step 1 → 2: fetch playlist info
  const handleLoad = async (e) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || fetching) return;
    console.log('[DownloadView] handleLoad start, url=', trimmed);
    setFetching(true);
    setFetchError(null);
    try {
      if (typeof window.api.ytDlpFetchInfo !== 'function') {
        throw new Error(
          'ytDlpFetchInfo is not available — please restart the app to load the latest preload changes.'
        );
      }
      const res = await window.api.ytDlpFetchInfo(trimmed);
      console.log('[DownloadView] ytDlpFetchInfo result:', res);
      if (!res.ok) {
        setFetchError(res.error);
        return;
      }
      setPlaylistInfo(res);
      setSelectedIndices(new Set(res.entries.map((_, i) => i)));
      // Initialise playlist target defaults
      setTargetPlaylistId(null);
      setTargetPlaylistName(res.title || '');
      // Fetch existing playlists for the combobox
      try {
        const existingPlaylists = await window.api.getPlaylists();
        setPlaylists(existingPlaylists || []);
      } catch {
        setPlaylists([]);
      }
      setStep('select');
    } catch (err) {
      console.error('[DownloadView] handleLoad error:', err);
      setFetchError(err.message);
    } finally {
      setFetching(false);
    }
  };

  // Step 2 → 1: go back
  const handleBack = useCallback(() => {
    setStep('url');
    setPlaylistInfo(null);
    setFetchError(null);
  }, []);

  // Step 2: toggle a single entry
  const handleToggleEntry = useCallback((index) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  // Step 2: select / deselect all
  const handleToggleAll = useCallback(() => {
    setSelectedIndices((prev) =>
      prev.size === playlistInfo.entries.length
        ? new Set()
        : new Set(playlistInfo.entries.map((_, i) => i))
    );
  }, [playlistInfo]);

  // Step 2 → 3: start download
  const handleDownload = async () => {
    if (selectedIndices.size === 0) return;

    // Pre-populate the track list with real titles from the selection, in playlist order
    const selectedEntries = playlistInfo.entries
      .filter((e) => selectedIndices.has(e.index))
      .sort((a, b) => a.index - b.index);

    setStep('download');
    setLoading(true);
    setResult(null);
    setTrackStatuses(
      selectedEntries.map((e, i) => ({
        index: i,
        title: e.title,
        url: e.url,
        status: 'pending',
      }))
    );
    setProgress({
      msg: 'Starting download…',
      pct: 0,
      trackPct: 0,
      overallCurrent: 1,
      overallTotal: selectedEntries.length,
    });

    // Build --playlist-items string (1-based) only when a subset is selected
    let playlistItems = null;
    if (playlistInfo.type === 'playlist' && selectedIndices.size < playlistInfo.entries.length) {
      playlistItems = Array.from(selectedIndices)
        .sort((a, b) => a - b)
        .map((i) => i + 1)
        .join(',');
    }

    const res = await window.api.ytDlpDownloadUrl({
      url,
      playlistItems,
      playlistTitle: playlistInfo?.title || null,
      existingPlaylistId: playlistInfo?.type === 'playlist' ? targetPlaylistId : null,
      newPlaylistName:
        playlistInfo?.type === 'playlist' && !targetPlaylistId
          ? targetPlaylistName || playlistInfo?.title || 'Imported Playlist'
          : null,
    });
    setLoading(false);
    setProgress(null);
    setResult(res);
    if (res.ok) setHistory((prev) => [{ url, at: Date.now() }, ...prev.slice(0, 19)]);
  };

  // Step 3 → 1: start fresh
  const handleDownloadAnother = () => {
    setStep('url');
    setPlaylistInfo(null);
    setResult(null);
    setTrackStatuses([]);
    setProgress(null);
    setUrl('');
    setPlaylists([]);
    setTargetPlaylistId(null);
    setTargetPlaylistName('');
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  // ── derived ───────────────────────────────────────────────────────────────
  const isPlaylist = trackStatuses.length > 1 || (progress?.overallTotal ?? 0) > 1;
  const completedCount = trackStatuses.filter(
    (t) => t.status === 'done' || t.status === 'failed'
  ).length;
  // Drive overall counter from trackStatuses (truth source) to avoid yt-dlp reset on retry
  const overallTotal = trackStatuses.length || (progress?.overallTotal ?? 1);
  const overallCurrent = loading ? Math.min(completedCount + 1, overallTotal) : completedCount;
  const overallPct = overallTotal > 0 ? Math.round((overallCurrent / overallTotal) * 100) : 0;

  const allSelected = playlistInfo && selectedIndices.size === playlistInfo.entries.length;
  const someSelected = playlistInfo && selectedIndices.size > 0 && !allSelected;

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="dl-view">
      <div className="dl-header">
        <h2 className="dl-title">YT-DLP Download</h2>
        <p className="dl-subtitle">
          {step === 'url' && 'Paste a URL to preview and choose tracks before downloading.'}
          {step === 'select' &&
            (playlistInfo?.type === 'playlist'
              ? `${playlistInfo.entries.length} tracks found — select what to download.`
              : 'Ready to download.')}
          {step === 'download' && 'Downloading and importing to your library…'}
        </p>
      </div>

      {/* ── Step 1: URL input ─────────────────────────────────────────────── */}
      {step === 'url' && (
        <>
          <form className="dl-form" onSubmit={handleLoad}>
            <div className="dl-input-row">
              <input
                ref={inputRef}
                className="dl-input"
                type="url"
                placeholder="https://www.youtube.com/watch?v=…"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setFetchError(null);
                }}
                onPaste={(e) => {
                  const text = e.clipboardData?.getData('text')?.trim();
                  if (text) {
                    e.preventDefault();
                    setUrl(text);
                    setFetchError(null);
                  }
                }}
                disabled={fetching}
                autoComplete="off"
                spellCheck={false}
              />
              <button className="dl-btn" type="submit" disabled={fetching || !url.trim()}>
                {fetching ? (
                  <span className="dl-fetch-spinner">
                    <svg className="dl-spinner-svg" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="8" r="6" stroke="rgba(255,255,255,0.3)" strokeWidth="2" />
                      <path
                        d="M8 2a6 6 0 0 1 6 6"
                        stroke="#fff"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                    Loading…
                  </span>
                ) : (
                  'Load →'
                )}
              </button>
            </div>
            {fetchError && (
              <div className="dl-result dl-result--err">
                <span>✗ {fetchError}</span>
              </div>
            )}
          </form>

          <div className="dl-sources">
            <div className="dl-sources-title">Supported sources</div>
            <div className="dl-sources-grid">
              {SUPPORTED_SOURCES.map((s) => (
                <a
                  key={s.name}
                  href={s.url}
                  className="dl-source-chip dl-source-chip--link"
                  onClick={(e) => openLink(e, s.url)}
                >
                  <span className="dl-source-icon">{s.icon}</span>
                  <span>{s.name}</span>
                </a>
              ))}
              <a
                href={YT_DLP_SUPPORTED_SITES}
                className="dl-source-chip dl-source-chip--more dl-source-chip--link"
                onClick={(e) => openLink(e, YT_DLP_SUPPORTED_SITES)}
              >
                +1000 more
              </a>
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
        </>
      )}

      {/* ── Step 2: track selection ───────────────────────────────────────── */}
      {step === 'select' && playlistInfo && (
        <div className="dl-select">
          <div className="dl-select-header">
            <button className="dl-back-btn" onClick={handleBack}>
              ← Back
            </button>
            <div className="dl-select-meta">
              <span className="dl-select-playlist-title">
                {playlistInfo.title || (playlistInfo.type === 'playlist' ? 'Playlist' : 'Track')}
              </span>
              {playlistInfo.type === 'playlist' && (
                <span className="dl-select-count">{playlistInfo.entries.length} tracks</span>
              )}
            </div>
          </div>

          {playlistInfo.type === 'playlist' && (
            <div className="dl-select-toolbar">
              <label className="dl-select-all-label">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={handleToggleAll}
                />
                {allSelected ? 'Deselect all' : 'Select all'}
              </label>
              <span className="dl-select-selected-count">
                {selectedIndices.size} / {playlistInfo.entries.length} selected
              </span>
            </div>
          )}

          <div className="dl-select-list">
            {playlistInfo.entries.map((entry) => (
              <label key={entry.index} className="dl-select-item">
                {playlistInfo.type === 'playlist' && (
                  <input
                    type="checkbox"
                    checked={selectedIndices.has(entry.index)}
                    onChange={() => handleToggleEntry(entry.index)}
                  />
                )}
                <span className="dl-select-item-num">{entry.index + 1}.</span>
                <span className="dl-select-item-title">{entry.title}</span>
                {entry.duration && (
                  <span className="dl-select-item-dur">{fmtDuration(entry.duration)}</span>
                )}
              </label>
            ))}
          </div>

          <div className="dl-select-footer">
            {playlistInfo.type === 'playlist' && (
              <div className="dl-playlist-target">
                <label className="dl-playlist-target-label">Save to playlist</label>
                <select
                  className="dl-playlist-select"
                  value={targetPlaylistId ?? ''}
                  onChange={(e) => setTargetPlaylistId(e.target.value || null)}
                >
                  <option value="">New playlist</option>
                  {playlists.map((pl) => (
                    <option key={pl.id} value={pl.id}>
                      {pl.name}
                    </option>
                  ))}
                </select>
                {!targetPlaylistId && (
                  <input
                    className="dl-playlist-name-input"
                    type="text"
                    placeholder="Playlist name"
                    value={targetPlaylistName}
                    onChange={(e) => setTargetPlaylistName(e.target.value)}
                  />
                )}
              </div>
            )}
            <button
              className="dl-btn"
              onClick={handleDownload}
              disabled={selectedIndices.size === 0}
            >
              {allSelected
                ? `Download all (${selectedIndices.size})`
                : `Download selected (${selectedIndices.size})`}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: download progress ─────────────────────────────────────── */}
      {step === 'download' && (
        <div className="dl-form">
          {isPlaylist && (progress || trackStatuses.length > 0) && (
            <div className="dl-progress">
              <div className="dl-progress-label">
                <span>Overall</span>
                <span>
                  {overallCurrent} / {overallTotal}
                </span>
              </div>
              <div className="dl-progress-bar">
                <div className="dl-progress-fill" style={{ width: `${overallPct}%` }} />
              </div>
            </div>
          )}

          {progress && (
            <div className="dl-progress">
              <div className="dl-progress-label">
                <span>{isPlaylist ? 'Current track' : 'Download'}</span>
                <span>{progress.trackPct ?? progress.pct ?? 0}%</span>
              </div>
              <div className="dl-progress-bar">
                <div
                  className="dl-progress-fill dl-progress-fill--track"
                  style={{ width: `${progress.trackPct ?? progress.pct ?? 0}%` }}
                />
              </div>
              <span className="dl-progress-msg">{progress.msg}</span>
            </div>
          )}

          {trackStatuses.length > 0 && (
            <div className="dl-track-table">
              <div className="dl-track-table-head">
                <span>Track</span>
                <span>Status</span>
              </div>
              <div className="dl-track-table-body">
                {trackStatuses.map((t) => (
                  <div key={t.index} className="dl-track-row">
                    <span className="dl-track-title">{t.title}</span>
                    <span className={`dl-track-status dl-track-status--${t.status}`}>
                      {STATUS_ICON[t.status]?.icon ?? '□'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result?.ok && (
            <div className="dl-result dl-result--ok">
              <span>
                {result.trackIds.length === 1
                  ? '✓ Track added to your library'
                  : `✓ ${result.trackIds.length} tracks added to your library`}
              </span>
              <div className="dl-result-actions">
                {result.playlistId ? (
                  <button
                    type="button"
                    className="dl-goto-btn"
                    onClick={() => onGoToPlaylist(result.playlistId)}
                  >
                    Go to Playlist →
                  </button>
                ) : (
                  <button type="button" className="dl-goto-btn" onClick={onGoToLibrary}>
                    View in Music →
                  </button>
                )}
                <button type="button" className="dl-goto-btn" onClick={handleDownloadAnother}>
                  ← New download
                </button>
              </div>
            </div>
          )}
          {result?.error && (
            <div className="dl-result dl-result--err">
              <span>✗ {result.error}</span>
              {result.error.includes('400') && (
                <span className="dl-result-hint">
                  YouTube blocked the request. Try setting a browser in Settings → Downloads →
                  Browser Cookies so yt-dlp can use your session.
                </span>
              )}
              <button
                type="button"
                className="dl-back-btn"
                onClick={handleBack}
                style={{ marginTop: 8, alignSelf: 'flex-start' }}
              >
                ← Try again
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
