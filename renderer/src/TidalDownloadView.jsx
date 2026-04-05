import { useState, useEffect, useRef, useCallback } from 'react';
import './DownloadView.css';
import './TidalDownloadView.css';

// Supported TIDAL URL types
const TIDAL_URL_TYPES = [
  { label: 'Track', example: 'tidal.com/browse/track/…' },
  { label: 'Album', example: 'tidal.com/browse/album/…' },
  { label: 'Playlist', example: 'tidal.com/browse/playlist/…' },
  { label: 'Mix', example: 'tidal.com/browse/mix/…' },
];

export default function TidalDownloadView({ onGoToLibrary, onGoToPlaylist, style }) {
  // ── setup state ───────────────────────────────────────────────────────────
  const [setup, setSetup] = useState(null); // null = checking | { installed, loggedIn }

  // ── login state ───────────────────────────────────────────────────────────
  const [loginState, setLoginState] = useState('idle'); // 'idle' | 'waiting' | 'done' | 'error'
  const [loginUrl, setLoginUrl] = useState(null);
  const [loginError, setLoginError] = useState(null);

  // ── download state ────────────────────────────────────────────────────────
  const [url, setUrl] = useState('');
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [playlists, setPlaylists] = useState([]);
  const [targetPlaylistId, setTargetPlaylistId] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);

  const inputRef = useRef(null);

  // ── install state ─────────────────────────────────────────────────────────
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState([]);
  const [installError, setInstallError] = useState(null);

  // ── initial setup check ───────────────────────────────────────────────────
  const checkSetup = useCallback(async () => {
    setSetup(null);
    const info = await window.api.tidalCheck();
    setSetup(info);
  }, []);

  useEffect(() => {
    checkSetup();

    const unsubProgress = window.api.onTidalProgress((data) => {
      if (data === null) {
        setDownloading(false);
        setProgressMsg('');
      } else {
        setProgressMsg(data.msg || '');
      }
    });

    const unsubLoginUrl = window.api.onTidalLoginUrl((url) => {
      setLoginUrl(url);
      // Auto-open in browser
      window.api.openExternal(url);
    });

    const unsubInstall = window.api.onTidalInstallProgress((data) => {
      setInstallLog((prev) => [...prev.slice(-199), data.msg]);
    });

    return () => {
      unsubProgress();
      unsubLoginUrl();
      unsubInstall();
    };
  }, [checkSetup]);

  // Load playlists when we know the user is logged in
  useEffect(() => {
    if (setup?.loggedIn) {
      window.api
        .getPlaylists()
        .then(setPlaylists)
        .catch(() => setPlaylists([]));
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [setup?.loggedIn]);

  // ── login flow ────────────────────────────────────────────────────────────
  const handleLogin = async () => {
    setLoginState('waiting');
    setLoginUrl(null);
    setLoginError(null);

    const res = await window.api.tidalLogin();
    if (res.ok) {
      setLoginState('done');
      await checkSetup();
    } else {
      setLoginState('error');
      setLoginError(res.error);
    }
  };

  const openLoginUrl = (e) => {
    e.preventDefault();
    if (loginUrl) window.api.openExternal(loginUrl);
  };

  // ── download flow ─────────────────────────────────────────────────────────
  const handleDownload = async (e) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || downloading) return;

    setDownloading(true);
    setResult(null);
    setProgressMsg('Starting…');

    const res = await window.api.tidalDownloadUrl({
      url: trimmed,
      existingPlaylistId: targetPlaylistId || null,
      newPlaylistName: !targetPlaylistId && newPlaylistName.trim() ? newPlaylistName.trim() : null,
    });

    setDownloading(false);
    setResult(res);

    if (res.ok) {
      setHistory((prev) => [
        { url: trimmed, at: Date.now(), count: res.trackIds.length },
        ...prev.slice(0, 19),
      ]);
      // Refresh playlist list
      window.api
        .getPlaylists()
        .then(setPlaylists)
        .catch(() => {});
    }
  };

  const handleReset = () => {
    setUrl('');
    setResult(null);
    setProgressMsg('');
    setNewPlaylistName('');
    setTargetPlaylistId(null);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const formatTime = (ts) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // ── render: checking ──────────────────────────────────────────────────────
  if (setup === null) {
    return (
      <div className="dl-view" style={style}>
        <div className="dl-header">
          <h2 className="dl-title">TIDAL Download</h2>
          <p className="dl-subtitle tidal-checking">Checking setup…</p>
        </div>
      </div>
    );
  }

  // ── render: not installed ─────────────────────────────────────────────────
  if (!setup.installed) {
    const handleRetry = async () => {
      setInstalling(true);
      setInstallLog([]);
      setInstallError(null);
      const res = await window.api.tidalInstall();
      setInstalling(false);
      if (res.ok) {
        await checkSetup();
      } else {
        setInstallError(res.error);
      }
    };

    return (
      <div className="dl-view" style={style}>
        <div className="dl-header">
          <h2 className="dl-title">TIDAL Download</h2>
          <p className="dl-subtitle">tidal-dl-ng could not be installed during startup.</p>
        </div>
        <div className="tidal-install-box">
          {!installing && !installError && (
            <>
              <div className="tidal-install-title">Installation failed</div>
              <p className="tidal-install-note">
                tidal-dl-ng could not be installed automatically. Click Retry to try again, or check
                Settings → Dependencies.
              </p>
              <button className="dl-btn" onClick={handleRetry}>
                Retry
              </button>
            </>
          )}
          {installing && (
            <>
              <div className="tidal-install-title">Installing…</div>
              <div className="tidal-install-log">
                {installLog.slice(-8).map((line, i) => (
                  <div key={i} className="tidal-install-log-line">
                    {line}
                  </div>
                ))}
                {installLog.length === 0 && (
                  <div className="tidal-install-log-line">Starting pip…</div>
                )}
              </div>
            </>
          )}
          {installError && (
            <>
              <div className="tidal-install-title" style={{ color: 'var(--error, #f55)' }}>
                Installation failed
              </div>
              <p className="tidal-install-note">{installError}</p>
              <button className="dl-btn" onClick={handleRetry}>
                Retry
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── render: login required ────────────────────────────────────────────────
  if (!setup.loggedIn) {
    return (
      <div className="dl-view" style={style}>
        <div className="dl-header">
          <h2 className="dl-title">TIDAL Download</h2>
          <p className="dl-subtitle">Connect your TIDAL account to start downloading.</p>
        </div>

        <div className="tidal-login-box">
          {loginState === 'idle' && (
            <>
              <p className="tidal-login-desc">
                Click below to start the TIDAL login flow. A browser page will open — approve the
                request there, then return here.
              </p>
              <button className="dl-btn tidal-login-btn" onClick={handleLogin}>
                Connect TIDAL account
              </button>
            </>
          )}

          {loginState === 'waiting' && (
            <>
              <div className="tidal-login-waiting">
                <span className="tidal-spinner">⋯</span>
                Waiting for TIDAL authentication…
              </div>
              {loginUrl ? (
                <div className="tidal-login-url-box">
                  <p className="tidal-login-url-label">
                    A browser tab was opened. If it didn&apos;t open, click the link below:
                  </p>
                  <a href={loginUrl} className="tidal-login-url-link" onClick={openLoginUrl}>
                    {loginUrl}
                  </a>
                </div>
              ) : (
                <p className="tidal-login-url-label">Opening browser…</p>
              )}
            </>
          )}

          {loginState === 'done' && (
            <div className="dl-result dl-result--ok">✓ Logged in successfully</div>
          )}

          {loginState === 'error' && (
            <div className="dl-result dl-result--err">
              <span>✗ Login failed: {loginError}</span>
              <button
                type="button"
                className="dl-back-btn"
                onClick={() => setLoginState('idle')}
                style={{ marginTop: 8, alignSelf: 'flex-start' }}
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── render: download UI ───────────────────────────────────────────────────
  return (
    <div className="dl-view" style={style}>
      <div className="dl-header">
        <h2 className="dl-title">TIDAL Download</h2>
        <p className="dl-subtitle">
          Paste a TIDAL URL to download and import tracks into your library.
        </p>
      </div>

      <form className="dl-form" onSubmit={handleDownload}>
        <div className="dl-input-row">
          <input
            ref={inputRef}
            className="dl-input"
            type="url"
            placeholder="https://tidal.com/browse/album/…"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setResult(null);
            }}
            onPaste={(e) => {
              const text = e.clipboardData?.getData('text')?.trim();
              if (text) {
                e.preventDefault();
                setUrl(text);
                setResult(null);
              }
            }}
            disabled={downloading}
            autoComplete="off"
            spellCheck={false}
          />
          <button className="dl-btn" type="submit" disabled={downloading || !url.trim()}>
            {downloading ? (
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
                Downloading…
              </span>
            ) : (
              'Download →'
            )}
          </button>
        </div>

        {/* Playlist target */}
        <div className="dl-playlist-target">
          <label className="dl-playlist-target-label">Save to playlist</label>
          <select
            className="dl-playlist-select"
            value={targetPlaylistId ?? ''}
            onChange={(e) => setTargetPlaylistId(e.target.value || null)}
            disabled={downloading}
          >
            <option value="">None / new playlist</option>
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
              placeholder="New playlist name (optional)"
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
              disabled={downloading}
            />
          )}
        </div>
      </form>

      {/* Progress */}
      {downloading && progressMsg && (
        <div className="dl-form" style={{ marginTop: 16 }}>
          <div className="dl-progress">
            <div className="dl-progress-bar">
              <div className="tidal-progress-indeterminate" />
            </div>
            <span className="dl-progress-msg">{progressMsg}</span>
          </div>
        </div>
      )}

      {/* Result */}
      {result?.ok && (
        <div className="dl-result dl-result--ok" style={{ marginTop: 16, maxWidth: 640 }}>
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
            <button type="button" className="dl-goto-btn" onClick={handleReset}>
              ← New download
            </button>
          </div>
        </div>
      )}
      {result?.error && (
        <div className="dl-result dl-result--err" style={{ marginTop: 16, maxWidth: 640 }}>
          <span>✗ {result.error}</span>
          <button
            type="button"
            className="dl-back-btn"
            onClick={handleReset}
            style={{ marginTop: 8, alignSelf: 'flex-start' }}
          >
            ← Try again
          </button>
        </div>
      )}

      {/* URL types */}
      <div className="dl-sources" style={{ marginTop: result ? 32 : 32 }}>
        <div className="dl-sources-title">Supported URL types</div>
        <div className="dl-sources-grid">
          {TIDAL_URL_TYPES.map((t) => (
            <div key={t.label} className="dl-source-chip">
              <span className="dl-source-icon">♫</span>
              <span>{t.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Session history */}
      {history.length > 0 && (
        <div className="dl-history">
          <div className="dl-history-title">Session downloads</div>
          {history.map((item, i) => (
            <div key={i} className="dl-history-item">
              <span className="dl-history-icon">♫</span>
              <span className="dl-history-url">{item.url}</span>
              <span className="dl-history-time">
                {item.count} track{item.count !== 1 ? 's' : ''} · {formatTime(item.at)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Re-auth footer */}
      <div className="tidal-reauth">
        <button
          type="button"
          className="tidal-reauth-btn"
          onClick={() => {
            setSetup({ ...setup, loggedIn: false });
            setLoginState('idle');
          }}
        >
          Switch TIDAL account
        </button>
      </div>
    </div>
  );
}
