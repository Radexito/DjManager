import { useState, useEffect, useRef, useCallback } from 'react';
import { useTidalDownload } from './TidalDownloadContext.jsx';
import './DownloadView.css';
import './TidalDownloadView.css';

// Supported TIDAL URL types for the helper footer
const TIDAL_URL_TYPES = [
  { label: 'Track', example: 'tidal.com/browse/track/…' },
  { label: 'Album', example: 'tidal.com/browse/album/…' },
  { label: 'Playlist', example: 'tidal.com/browse/playlist/…' },
  { label: 'Mix', example: 'tidal.com/browse/mix/…' },
];

const STATUS_ICON = {
  pending: { icon: '□', label: 'Pending' },
  downloading: { icon: '⋯', label: 'Downloading' },
  importing: { icon: '↓', label: 'Importing' },
  done: { icon: '✓', label: 'Done' },
  failed: { icon: '✗', label: 'Failed' },
};

function fmtDuration(secs) {
  if (!secs) return '';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function TidalDownloadView({ onGoToLibrary, onGoToPlaylist, style }) {
  // ── context state (persists across tab switches) ──────────────────────────
  const {
    url,
    setUrl,
    step,
    setStep,
    fetching,
    setFetching,
    fetchError,
    setFetchError,
    playlistInfo,
    setPlaylistInfo,
    selectedIndices,
    setSelectedIndices,
    linkIndices,
    setLinkIndices,
    libraryMap,
    setLibraryMap,
    playlists,
    setPlaylists,
    targetPlaylistId,
    setTargetPlaylistId,
    targetPlaylistName,
    setTargetPlaylistName,
    loading,
    setLoading,
    trackStatuses,
    result,
    setResult,
    resetToUrl,
  } = useTidalDownload();

  // ── local state (UI gates — do not need to persist) ───────────────────────
  const [setup, setSetup] = useState(null); // null = checking | { installed, loggedIn }
  const [loginState, setLoginState] = useState('idle'); // 'idle'|'waiting'|'done'|'error'
  const [loginUrl, setLoginUrl] = useState(null);
  const [loginError, setLoginError] = useState(null);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState([]);
  const [installError, setInstallError] = useState(null);

  const inputRef = useRef(null);

  const checkSetup = useCallback(() => {
    setSetup(null);
    window.api.tidalCheck().then(setSetup);
  }, []);

  // Subscribe to login/install IPC events on mount
  useEffect(() => {
    checkSetup();
    const unsubLoginUrl = window.api.onTidalLoginUrl((u) => {
      setLoginUrl(u);
      window.api.openExternal(u);
    });
    const unsubInstall = window.api.onTidalInstallProgress((data) => {
      setInstallLog((prev) => [...prev.slice(-199), data.msg]);
    });
    return () => {
      unsubLoginUrl();
      unsubInstall();
    };
  }, [checkSetup]);

  // Load playlists once logged in
  useEffect(() => {
    if (setup?.loggedIn) {
      window.api
        .getPlaylists()
        .then(setPlaylists)
        .catch(() => setPlaylists([]));
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [setup?.loggedIn, setPlaylists]);

  // ── login flow ─────────────────────────────────────────────────────────────
  const handleLogin = async () => {
    setLoginState('waiting');
    setLoginUrl(null);
    setLoginError(null);
    const res = await window.api.tidalLogin();
    if (res.ok) {
      setLoginState('done');
      checkSetup();
    } else {
      setLoginState('error');
      setLoginError(res.error);
    }
  };

  // ── step url → select: fetch track info ───────────────────────────────────
  const handleLoad = async (e) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || fetching) return;

    setFetching(true);
    setFetchError(null);

    try {
      const res = await window.api.tidalFetchInfo(trimmed);
      if (!res.ok) {
        setFetchError(res.error);
        return;
      }

      setPlaylistInfo(res);

      // Check which entries are already in the library
      const newLibraryMap = new Map();
      try {
        const entryChecks = (res.entries ?? [])
          .filter((e) => e.url || e.id)
          .map((e) => ({ url: e.url, id: String(e.id) }));
        if (entryChecks.length > 0) {
          const found = await window.api.checkDuplicateUrls(entryChecks);
          for (const { url: u, trackId } of found) {
            if (u) newLibraryMap.set(u, trackId);
          }
        }
      } catch {
        // non-fatal
      }
      setLibraryMap(newLibraryMap);

      const pls = await window.api.getPlaylists().catch(() => []);
      setPlaylists(pls);
      const match = pls.find((p) => p.name.toLowerCase() === (res.title ?? '').toLowerCase());
      if (match) {
        setTargetPlaylistId(match.id);
        setTargetPlaylistName('');
      } else {
        setTargetPlaylistId(null);
        setTargetPlaylistName(res.title ?? '');
      }

      // Single tracks and mixes skip the select step — go straight to download
      if (res.type === 'track' || res.type === 'mix' || (res.entries?.length ?? 0) === 0) {
        const allIndices = new Set(
          (res.entries ?? []).filter((e) => !newLibraryMap.has(e.url)).map((e) => e.index)
        );
        const linkIdx = new Set(
          (res.entries ?? []).filter((e) => newLibraryMap.has(e.url)).map((e) => e.index)
        );
        setSelectedIndices(allIndices);
        setLinkIndices(linkIdx);
        setStep('download');
        await runDownload(
          res,
          allIndices,
          linkIdx,
          newLibraryMap,
          match?.id ?? null,
          res.title ?? ''
        );
        return;
      }

      // Pre-select non-library entries; pre-link library entries
      setSelectedIndices(
        new Set(res.entries.filter((e) => !newLibraryMap.has(e.url)).map((e) => e.index))
      );
      setLinkIndices(
        new Set(res.entries.filter((e) => newLibraryMap.has(e.url)).map((e) => e.index))
      );
      setStep('select');
    } catch (err) {
      setFetchError(err.message);
    } finally {
      setFetching(false);
    }
  };

  // ── step select → download ─────────────────────────────────────────────────
  const handleDownload = async () => {
    if (selectedIndices.size === 0 && linkIndices.size === 0) return;
    if (!playlistInfo) return;
    setStep('download');
    await runDownload(
      playlistInfo,
      selectedIndices,
      linkIndices,
      libraryMap,
      targetPlaylistId,
      targetPlaylistName
    );
  };

  async function runDownload(info, indices, links, libMap, playlistId, playlistName) {
    const selectedEntries = (info.entries ?? [])
      .filter((e) => indices.has(e.index))
      .sort((a, b) => a.index - b.index);

    const linkEntries = (info.entries ?? [])
      .filter((e) => links.has(e.index))
      .sort((a, b) => a.index - b.index);

    const linkTrackIds = linkEntries.map((e) => libMap.get(e.url)).filter(Boolean);

    setLoading(true);
    setResult(null);

    const res = await window.api.tidalDownloadUrl({
      url,
      selectedEntries,
      linkTrackIds,
      existingPlaylistId: playlistId || null,
      newPlaylistName: !playlistId && playlistName?.trim() ? playlistName.trim() : null,
    });

    setLoading(false);
    setResult(res);

    if (res.ok) {
      await window.api
        .getPlaylists()
        .then(setPlaylists)
        .catch(() => {});
    }
  }

  // ── toggle selection ────────────────────────────────────────────────────────
  const handleToggleEntry = useCallback(
    (index, entry) => {
      const isInLibrary = entry && libraryMap.has(entry.url);
      if (isInLibrary) {
        // library entries toggle in linkIndices
        setLinkIndices((prev) => {
          const next = new Set(prev);
          if (next.has(index)) next.delete(index);
          else next.add(index);
          return next;
        });
      } else {
        setSelectedIndices((prev) => {
          const next = new Set(prev);
          if (next.has(index)) next.delete(index);
          else next.add(index);
          return next;
        });
      }
    },
    [libraryMap, setSelectedIndices, setLinkIndices]
  );

  const handleToggleAll = useCallback(() => {
    if (!playlistInfo) return;
    const downloadable = playlistInfo.entries.filter((e) => !libraryMap.has(e.url));
    const linkable = playlistInfo.entries.filter((e) => libraryMap.has(e.url));
    const allDownSelected = downloadable.every((e) => selectedIndices.has(e.index));
    const allLinkSelected = linkable.every((e) => linkIndices.has(e.index));
    if (allDownSelected && allLinkSelected) {
      setSelectedIndices(new Set());
      setLinkIndices(new Set());
    } else {
      setSelectedIndices(new Set(downloadable.map((e) => e.index)));
      setLinkIndices(new Set(linkable.map((e) => e.index)));
    }
  }, [playlistInfo, libraryMap, selectedIndices, linkIndices, setSelectedIndices, setLinkIndices]);

  // ── render: checking setup ────────────────────────────────────────────────
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
      if (res.ok) checkSetup();
      else setInstallError(res.error);
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
                  <div className="tidal-install-log-line">Starting installer…</div>
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
                  <a
                    href={loginUrl}
                    className="tidal-login-url-link"
                    onClick={(e) => {
                      e.preventDefault();
                      window.api.openExternal(loginUrl);
                    }}
                  >
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

  // ── render: step — url ────────────────────────────────────────────────────
  if (step === 'url') {
    return (
      <div className="dl-view" style={style}>
        <div className="dl-header">
          <h2 className="dl-title">TIDAL Download</h2>
          <p className="dl-subtitle">Paste a TIDAL URL to import tracks into your library.</p>
        </div>

        <form className="dl-form" onSubmit={handleLoad}>
          <div className="dl-input-row">
            <input
              ref={inputRef}
              className="dl-input"
              type="url"
              placeholder="https://tidal.com/browse/album/…"
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
                  Fetching…
                </span>
              ) : (
                'Get tracks →'
              )}
            </button>
          </div>
          {fetchError && (
            <div className="dl-fetch-error" style={{ marginTop: 8 }}>
              ✗ {fetchError}
            </div>
          )}
        </form>

        <div className="dl-sources" style={{ marginTop: 32 }}>
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

  // ── render: step — select ─────────────────────────────────────────────────
  if (step === 'select') {
    const entries = playlistInfo?.entries ?? [];
    const downloadable = entries.filter((e) => !libraryMap.has(e.url));
    const linkable = entries.filter((e) => libraryMap.has(e.url));
    const allDownSelected = downloadable.every((e) => selectedIndices.has(e.index));
    const allLinkSelected = linkable.every((e) => linkIndices.has(e.index));
    const allSelected = entries.length > 0 && allDownSelected && allLinkSelected;
    const totalActive = selectedIndices.size + linkIndices.size;

    return (
      <div className="dl-view" style={style}>
        <div className="dl-header">
          <h2 className="dl-title">{playlistInfo?.title ?? 'Select tracks'}</h2>
          <p className="dl-subtitle">
            {entries.length} track{entries.length !== 1 ? 's' : ''}
            {libraryMap.size > 0 ? ` · ${libraryMap.size} already in library` : ''}
            {' · '}select which to download
          </p>
        </div>

        <div className="dl-select-list">
          <div className="dl-select-header">
            <label className="dl-select-all">
              <input type="checkbox" checked={allSelected} onChange={handleToggleAll} />
              <span>Select all</span>
            </label>
            <span className="dl-select-count">
              {totalActive} / {entries.length} selected
            </span>
          </div>
          <div className="dl-entries">
            {entries.map((entry) => {
              const inLibrary = libraryMap.has(entry.url);
              const checked = inLibrary
                ? linkIndices.has(entry.index)
                : selectedIndices.has(entry.index);
              return (
                <label
                  key={entry.index}
                  className={`dl-entry${inLibrary ? ' dl-entry--library' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => handleToggleEntry(entry.index, entry)}
                  />
                  <span className="dl-entry-num">{entry.index + 1}</span>
                  <span className="dl-entry-info">
                    <span className="dl-entry-title">{entry.title}</span>
                    {entry.artist && <span className="dl-entry-artist">{entry.artist}</span>}
                  </span>
                  {inLibrary && <span className="dl-entry-library-badge">✓ In library</span>}
                  {!inLibrary && entry.duration > 0 && (
                    <span className="dl-entry-dur">{fmtDuration(entry.duration)}</span>
                  )}
                </label>
              );
            })}
          </div>
        </div>

        <div className="dl-playlist-target">
          <label className="dl-playlist-target-label">Save to playlist</label>
          <select
            className="dl-playlist-select"
            value={targetPlaylistId ?? ''}
            onChange={(e) => setTargetPlaylistId(e.target.value || null)}
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
              value={targetPlaylistName}
              onChange={(e) => setTargetPlaylistName(e.target.value)}
            />
          )}
        </div>

        <div className="dl-select-actions">
          <button type="button" className="dl-back-btn" onClick={resetToUrl}>
            ← Back
          </button>
          <button
            type="button"
            className="dl-btn"
            disabled={selectedIndices.size === 0 && linkIndices.size === 0}
            onClick={handleDownload}
          >
            {selectedIndices.size > 0 && linkIndices.size > 0
              ? `Download ${selectedIndices.size} + link ${linkIndices.size} →`
              : selectedIndices.size > 0
                ? `Download ${selectedIndices.size} track${selectedIndices.size !== 1 ? 's' : ''} →`
                : `Link ${linkIndices.size} track${linkIndices.size !== 1 ? 's' : ''} to playlist →`}
          </button>
        </div>
      </div>
    );
  }

  // ── render: step — download ───────────────────────────────────────────────
  const doneCount = trackStatuses.filter((s) => s.status === 'done').length;
  const failCount = trackStatuses.filter((s) => s.status === 'failed').length;
  const totalCount = trackStatuses.length;
  const progressPct = totalCount > 0 ? Math.round(((doneCount + failCount) / totalCount) * 100) : 0;

  return (
    <div className="dl-view" style={style}>
      <div className="dl-header">
        <h2 className="dl-title">{playlistInfo?.title ?? 'Downloading…'}</h2>
        <p className="dl-subtitle">
          {loading
            ? `${doneCount} / ${totalCount} tracks added`
            : result?.ok
              ? `✓ Done — ${doneCount} track${doneCount !== 1 ? 's' : ''} added`
              : result?.error
                ? '✗ Download failed'
                : 'Starting…'}
        </p>
      </div>

      {/* Progress bar */}
      {totalCount > 0 && (
        <div className="dl-progress" style={{ marginBottom: 16 }}>
          <div className="dl-progress-bar">
            <div className="dl-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <span className="dl-progress-msg">
            {doneCount + failCount} / {totalCount}
          </span>
        </div>
      )}

      {/* Indeterminate progress when track list is unknown (mix / raw URL) */}
      {loading && totalCount === 0 && (
        <div className="dl-progress" style={{ marginBottom: 16 }}>
          <div className="dl-progress-bar">
            <div className="tidal-progress-indeterminate" />
          </div>
          <span className="dl-progress-msg">Downloading…</span>
        </div>
      )}

      {/* Per-track status list */}
      {trackStatuses.length > 0 && (
        <div className="dl-track-list">
          {trackStatuses.map((s) => {
            const si = STATUS_ICON[s.status] ?? STATUS_ICON.pending;
            return (
              <div key={s.index} className={`dl-track-row dl-track-row--${s.status}`}>
                <span className={`dl-track-icon dl-track-icon--${s.status}`} title={si.label}>
                  {si.icon}
                </span>
                <span className="dl-track-info">
                  <span className="dl-track-title">{s.title}</span>
                  {s.artist && <span className="dl-track-artist"> — {s.artist}</span>}
                </span>
                {s.error && <span className="dl-track-error">{s.error}</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* Result actions */}
      {!loading && result?.ok && (
        <div className="dl-result dl-result--ok" style={{ marginTop: 16 }}>
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
            <button type="button" className="dl-goto-btn" onClick={resetToUrl}>
              ← New download
            </button>
          </div>
        </div>
      )}
      {!loading && result?.error && (
        <div className="dl-result dl-result--err" style={{ marginTop: 16 }}>
          <span>✗ {result.error}</span>
          <button
            type="button"
            className="dl-back-btn"
            onClick={resetToUrl}
            style={{ marginTop: 8, alignSelf: 'flex-start' }}
          >
            ← Try again
          </button>
        </div>
      )}
    </div>
  );
}
