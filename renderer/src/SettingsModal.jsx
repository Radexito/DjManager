import { useState, useEffect, useCallback } from 'react';
import './SettingsModal.css';

const DEFAULT_TARGET = -9;

const COOKIE_BROWSERS = [
  { value: '', label: 'None (not logged in)' },
  { value: 'chrome', label: 'Chrome' },
  { value: 'chromium', label: 'Chromium' },
  { value: 'brave', label: 'Brave' },
  { value: 'firefox', label: 'Firefox' },
  { value: 'librewolf', label: 'LibreWolf' },
  { value: 'edge', label: 'Edge' },
];

function SettingsModal({ onClose }) {
  const [activeSection, setActiveSection] = useState('library');
  const [targetInput, setTargetInput] = useState(String(DEFAULT_TARGET));
  const [autoNormalizeOnImport, setAutoNormalizeOnImport] = useState(false);
  const [confirmClear, setConfirmClear] = useState(null); // 'library' | 'userdata'
  const [normalizing, setNormalizing] = useState(false);
  const [normalizeProgress, setNormalizeProgress] = useState(null); // { completed, total } | null
  const [normalizeResult, setNormalizeResult] = useState(null);
  const [confirmNormalize, setConfirmNormalize] = useState(false);
  const [resettingNorm, setResettingNorm] = useState(false);
  const [normalizedCount, setNormalizedCount] = useState(null); // number of already-normalized tracks
  const [depVersions, setDepVersions] = useState(null);
  const [updatingAll, setUpdatingAll] = useState(false);
  const [ytdlpVersionInput, setYtdlpVersionInput] = useState('');
  const [ytdlpUpdating, setYtdlpUpdating] = useState(false);
  const [cookiesBrowser, setCookiesBrowser] = useState('');

  // Library location
  const [libraryPath, setLibraryPath] = useState('');
  const [moveProgress, setMoveProgress] = useState(null); // { moved, total, pct } | null
  const [confirmMove, setConfirmMove] = useState(null); // pending new dir path

  // Escape key closes dialog
  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    window.api
      .getSetting('normalize_target_lufs', String(DEFAULT_TARGET))
      .then((v) => setTargetInput(v));
    window.api
      .getSetting('auto_normalize_on_import', 'false')
      .then((v) => setAutoNormalizeOnImport(v === 'true'));
  }, []);

  useEffect(() => {
    if (activeSection === 'library') {
      window.api.getLibraryPath().then(setLibraryPath);
    }
    if (activeSection === 'normalization') {
      window.api.getNormalizedCount().then(setNormalizedCount);
    }
    if (activeSection === 'updates') {
      window.api.getDepVersions().then(setDepVersions);
    }
    if (activeSection === 'downloads') {
      window.api.getSetting('ytdlp_cookies_browser', '').then(setCookiesBrowser);
    }
  }, [activeSection]);

  const handleUpdateAll = async () => {
    setUpdatingAll(true);
    await window.api.updateAllDeps();
    const versions = await window.api.getDepVersions();
    setDepVersions(versions);
    setUpdatingAll(false);
  };

  const handleUpdateYtDlp = async (tag = null) => {
    setYtdlpUpdating(true);
    await window.api.updateYtDlp(tag);
    const versions = await window.api.getDepVersions();
    setDepVersions(versions);
    setYtdlpUpdating(false);
    if (tag) setYtdlpVersionInput('');
  };

  const handleTargetChange = (raw) => {
    setTargetInput(raw);
    setNormalizeResult(null);
    const num = Number(raw);
    if (Number.isFinite(num) && num >= -60 && num <= 0) {
      window.api.setSetting('normalize_target_lufs', raw);
    }
  };

  const handleNormalize = async () => {
    setConfirmNormalize(false);
    setNormalizing(true);
    setNormalizeResult(null);
    setNormalizeProgress(null);
    const unsub = window.api.onNormalizeProgress(({ completed, total, done }) => {
      setNormalizeProgress(done ? null : { completed, total });
      if (done) unsub();
    });
    try {
      const { normalized, skipped, total } = await window.api.normalizeLibrary();
      setNormalizeResult({ type: 'normalize', normalized, skipped, total });
      window.api.getNormalizedCount().then(setNormalizedCount);
    } finally {
      unsub();
      setNormalizing(false);
      setNormalizeProgress(null);
    }
  };

  const handleResetAllNormalization = async () => {
    setResettingNorm(true);
    setNormalizeResult(null);
    try {
      const { updated } = await window.api.resetNormalization({});
      setNormalizeResult({ type: 'reset', count: updated });
      setNormalizedCount(0);
    } finally {
      setResettingNorm(false);
    }
  };

  const handleAutoNormalizeToggle = (checked) => {
    setAutoNormalizeOnImport(checked);
    window.api.setSetting('auto_normalize_on_import', String(checked));
  };

  const handleCookiesBrowserChange = (value) => {
    setCookiesBrowser(value);
    window.api.setSetting('ytdlp_cookies_browser', value);
  };

  const handleClearLibrary = async () => {
    await window.api.clearLibrary();
    setConfirmClear(null);
    onClose();
  };

  const handleClearUserData = async () => {
    await window.api.clearUserData();
  };

  const handleOpenLogs = async () => {
    await window.api.openLogDir();
  };

  const handleBrowseLibrary = async () => {
    const dir = await window.api.openDirDialog();
    if (dir) setConfirmMove(dir);
  };

  const handleConfirmMove = async () => {
    const newDir = confirmMove;
    setConfirmMove(null);
    setMoveProgress({ moved: 0, total: 0, pct: 0 });
    const unsub = window.api.onMoveLibraryProgress((data) => setMoveProgress(data));
    try {
      await window.api.moveLibrary(newDir);
      setLibraryPath(newDir);
      setMoveProgress(null);
    } finally {
      unsub?.();
    }
  };

  const sections = [
    { id: 'library', label: 'Library' },
    { id: 'normalization', label: 'Normalization' },
    { id: 'downloads', label: 'Downloads' },
    { id: 'updates', label: 'Dependencies' },
    { id: 'advanced', label: 'Advanced' },
  ];

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="settings-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-sidebar">
          <div className="settings-title">Settings</div>
          {sections.map((s) => (
            <div
              key={s.id}
              className={`settings-nav-item${activeSection === s.id ? ' active' : ''}`}
              onClick={() => setActiveSection(s.id)}
            >
              {s.label}
            </div>
          ))}
        </div>

        <div className="settings-content">
          {activeSection === 'library' && (
            <>
              <h3>Library</h3>
              <div className="settings-group">
                <div className="settings-group-title">Library Location</div>
                <p className="settings-group-desc">
                  Where imported audio files are stored. Moving the library copies all files to the
                  new location and updates the database.
                </p>
                <div className="settings-row settings-row-action">
                  <div className="settings-path-display" title={libraryPath}>
                    {libraryPath || '…'}
                  </div>
                  <button
                    className="btn-secondary"
                    onClick={handleBrowseLibrary}
                    disabled={!!moveProgress}
                  >
                    Change…
                  </button>
                </div>
                {moveProgress && (
                  <div className="move-progress">
                    <div className="move-progress-label">
                      Moving files… {moveProgress.moved}/{moveProgress.total} ({moveProgress.pct}%)
                    </div>
                    <div className="deps-bar-track">
                      <div className="deps-bar-fill" style={{ width: `${moveProgress.pct}%` }} />
                    </div>
                  </div>
                )}
                {confirmMove && (
                  <div className="settings-confirm-row" style={{ marginTop: '0.75rem' }}>
                    <span>
                      Move library to <b>{confirmMove}</b>?
                    </span>
                    <button className="btn-primary" onClick={handleConfirmMove}>
                      Move
                    </button>
                    <button className="btn-secondary" onClick={() => setConfirmMove(null)}>
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

          {activeSection === 'normalization' && (
            <>
              <h3>Normalization</h3>
              <div className="settings-group">
                <p className="settings-group-desc">
                  Creates a gain-adjusted copy of each track&apos;s audio file at the target
                  loudness. Original files are preserved — you can revert at any time.
                  Already-normalized tracks are skipped automatically.
                </p>
                <div className="settings-row">
                  <label>Target loudness</label>
                  <div className="settings-input-row">
                    <input
                      type="number"
                      min="-30"
                      max="-6"
                      step="0.5"
                      value={targetInput}
                      onChange={(e) => handleTargetChange(e.target.value)}
                    />
                    <span className="settings-unit">LUFS</span>
                  </div>
                </div>
                <div className="settings-row">
                  <label htmlFor="auto-normalize-toggle">Auto-normalize on import</label>
                  <div className="settings-toggle-row">
                    <input
                      id="auto-normalize-toggle"
                      type="checkbox"
                      checked={autoNormalizeOnImport}
                      onChange={(e) => handleAutoNormalizeToggle(e.target.checked)}
                    />
                    <span className="settings-toggle-desc">
                      Automatically normalize every imported track (MP3 import, YT-DLP, TIDAL) after
                      its analysis finishes. Off by default.
                    </span>
                  </div>
                </div>
                <div className="settings-row settings-row-action">
                  <div>
                    <div className="settings-action-label">Normalize Whole Library</div>
                    <div className="settings-action-desc">
                      Processes every un-normalized analyzed track with ffmpeg. This may take a
                      while for large libraries.
                    </div>
                  </div>
                  {confirmNormalize ? (
                    <div className="settings-confirm-row">
                      <span>Apply to entire library?</span>
                      <button
                        className="btn-primary"
                        onClick={handleNormalize}
                        disabled={normalizing}
                      >
                        {normalizing ? 'Normalizing…' : 'Yes, normalize'}
                      </button>
                      <button className="btn-secondary" onClick={() => setConfirmNormalize(false)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      className="btn-primary"
                      onClick={() => {
                        setConfirmNormalize(true);
                        setNormalizeResult(null);
                      }}
                      disabled={normalizing}
                    >
                      Normalize Library
                    </button>
                  )}
                </div>
                {normalizing && normalizeProgress && (
                  <div className="settings-normalize-progress">
                    <div className="settings-normalize-progress-bar">
                      <div
                        className="settings-normalize-progress-fill"
                        style={{
                          width:
                            normalizeProgress.total > 0
                              ? `${Math.round((normalizeProgress.completed / normalizeProgress.total) * 100)}%`
                              : '0%',
                        }}
                      />
                    </div>
                    <span className="settings-normalize-progress-label">
                      {normalizeProgress.completed} / {normalizeProgress.total}
                    </span>
                  </div>
                )}
                {normalizeResult?.type === 'normalize' && (
                  <div className="settings-normalize-result">
                    {normalizeResult.normalized === 0
                      ? normalizeResult.total === 0
                        ? 'All tracks are already normalized — nothing to do.'
                        : 'No tracks could be normalized. Make sure tracks are analyzed first.'
                      : `Done — normalized ${normalizeResult.normalized} track${normalizeResult.normalized !== 1 ? 's' : ''}${normalizeResult.skipped > 0 ? `, skipped ${normalizeResult.skipped}` : ''}.`}
                  </div>
                )}
                <div className="settings-row settings-row-action">
                  <div>
                    <div className="settings-action-label">Reset All Normalization</div>
                    <div className="settings-action-desc">
                      Removes normalized files from every track — playback returns to originals.
                      {normalizedCount !== null && normalizedCount > 0 && (
                        <span className="settings-action-count">
                          {' '}
                          ({normalizedCount} track{normalizedCount !== 1 ? 's' : ''} normalized)
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    className="btn-secondary"
                    onClick={handleResetAllNormalization}
                    disabled={resettingNorm || normalizing || normalizedCount === 0}
                  >
                    {resettingNorm ? 'Resetting…' : 'Reset All'}
                  </button>
                </div>
                {normalizeResult?.type === 'reset' && (
                  <div className="settings-normalize-result">
                    {normalizeResult.count === 0
                      ? 'Nothing to reset — no tracks had a normalized file.'
                      : `Reset — removed normalization from ${normalizeResult.count} track${normalizeResult.count !== 1 ? 's' : ''}.`}
                  </div>
                )}
              </div>
            </>
          )}

          {activeSection === 'downloads' && (
            <>
              <h3>Downloads</h3>

              <div className="settings-group">
                <div className="settings-group-title">Audio Format</div>
                <p className="settings-group-desc">
                  yt-dlp always downloads the best available audio-only stream. YouTube and
                  SoundCloud are converted to MP3 (VBR best ≈ 320 kbps). Bandcamp is saved as FLAC
                  to preserve lossless quality when available.
                </p>
              </div>

              <div className="settings-group">
                <div className="settings-group-title">Browser Cookies</div>
                <p className="settings-group-desc">
                  Use cookies from your browser so yt-dlp can access age-restricted content,
                  Bandcamp purchases, and other authenticated sources. You must already be logged in
                  to the site in that browser.
                </p>
                <div className="settings-row">
                  <label>Browser</label>
                  <select
                    value={cookiesBrowser}
                    onChange={(e) => handleCookiesBrowserChange(e.target.value)}
                    className="settings-select"
                  >
                    {COOKIE_BROWSERS.map((b) => (
                      <option key={b.value} value={b.value}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </div>
                {cookiesBrowser && (
                  <div
                    className="settings-cookie-status settings-cookie-status--ok"
                    style={{ marginTop: '0.5rem' }}
                  >
                    🟢 Cookies active — <strong>{cookiesBrowser}</strong>. Make sure the browser is
                    closed or not actively using the cookie store when downloading.
                  </div>
                )}
                {!cookiesBrowser && (
                  <div
                    className="settings-cookie-status settings-cookie-status--warn"
                    style={{ marginTop: '0.5rem' }}
                  >
                    🔒 No browser selected — private or age-restricted content may fail.
                  </div>
                )}
              </div>
            </>
          )}

          {activeSection === 'updates' && (
            <>
              <h3>Dependencies</h3>

              <div className="settings-group">
                <div className="settings-group-title">Installed Versions</div>
                <p className="settings-group-desc">
                  FFmpeg, mixxx-analyzer, and yt-dlp are downloaded automatically on first launch.
                </p>
                <div className="dep-version-list">
                  <div className="dep-version-row">
                    <span className="dep-version-name">FFmpeg</span>
                    <span className="dep-version-tag">{depVersions?.ffmpeg?.version ?? '…'}</span>
                  </div>
                  <div className="dep-version-row">
                    <span className="dep-version-name">mixxx-analyzer</span>
                    <span className="dep-version-tag">{depVersions?.analyzer?.version ?? '…'}</span>
                  </div>
                  <div className="dep-version-row">
                    <span className="dep-version-name">yt-dlp</span>
                    <span className="dep-version-tag">{depVersions?.ytDlp?.version ?? '…'}</span>
                  </div>
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-group-title">Update</div>
                <div className="settings-row settings-row-action">
                  <div>
                    <div className="settings-action-label">Update All Dependencies</div>
                    <div className="settings-action-desc">
                      Re-downloads the latest FFmpeg, mixxx-analyzer, and yt-dlp.
                    </div>
                  </div>
                  <button
                    className="btn-primary"
                    onClick={handleUpdateAll}
                    disabled={updatingAll || ytdlpUpdating}
                  >
                    {updatingAll ? 'Updating…' : 'Update All'}
                  </button>
                </div>

                <div className="settings-row settings-row-action" style={{ marginTop: '0.75rem' }}>
                  <div>
                    <div className="settings-action-label">Update yt-dlp</div>
                    <div className="settings-action-desc">
                      Re-downloads the latest yt-dlp binary independently.
                    </div>
                  </div>
                  <button
                    className="btn-secondary"
                    onClick={() => handleUpdateYtDlp(null)}
                    disabled={updatingAll || ytdlpUpdating}
                  >
                    {ytdlpUpdating && !ytdlpVersionInput ? 'Updating…' : 'Update yt-dlp'}
                  </button>
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-group-title">Install Specific yt-dlp Version</div>
                <p className="settings-group-desc">
                  Enter a release tag from{' '}
                  <a
                    href="https://github.com/yt-dlp/yt-dlp/releases"
                    target="_blank"
                    rel="noreferrer"
                    className="settings-link"
                  >
                    yt-dlp/releases
                  </a>{' '}
                  to pin a specific version (e.g. <code className="settings-code">2025.01.15</code>
                  ).
                </p>
                <div className="settings-row">
                  <input
                    type="text"
                    placeholder="e.g. 2025.01.15"
                    value={ytdlpVersionInput}
                    onChange={(e) => setYtdlpVersionInput(e.target.value)}
                    className="settings-version-input"
                    disabled={ytdlpUpdating || updatingAll}
                  />
                  <button
                    className="btn-secondary"
                    onClick={() => handleUpdateYtDlp(ytdlpVersionInput.trim())}
                    disabled={!ytdlpVersionInput.trim() || ytdlpUpdating || updatingAll}
                  >
                    {ytdlpUpdating && ytdlpVersionInput ? 'Installing…' : 'Install'}
                  </button>
                </div>
              </div>
            </>
          )}

          {activeSection === 'advanced' && (
            <>
              <h3>Advanced</h3>

              <div className="settings-group">
                <div className="settings-group-title">Diagnostics</div>
                <p className="settings-group-desc">
                  Logs are saved daily and kept for 7 days. Include the log folder when reporting
                  bugs.
                </p>
                <div className="settings-row settings-row-action">
                  <div>
                    <div className="settings-action-label">Log Files</div>
                    <div className="settings-action-desc">
                      Opens the folder containing runtime log files.
                    </div>
                  </div>
                  <button className="btn-secondary" onClick={handleOpenLogs}>
                    Open Log Folder
                  </button>
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-group-title">Danger Zone</div>
                <p className="settings-group-desc">
                  These actions are permanent and cannot be undone.
                </p>

                <div className="settings-row settings-row-action">
                  <div>
                    <div className="settings-action-label">Clear Library</div>
                    <div className="settings-action-desc">
                      Removes all tracks and audio files. Your playlists will also be cleared.
                    </div>
                  </div>
                  {confirmClear === 'library' ? (
                    <div className="settings-confirm-row">
                      <span>Are you sure?</span>
                      <button className="btn-danger" onClick={handleClearLibrary}>
                        Yes, clear
                      </button>
                      <button className="btn-secondary" onClick={() => setConfirmClear(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button className="btn-danger" onClick={() => setConfirmClear('library')}>
                      Clear Library
                    </button>
                  )}
                </div>

                <div className="settings-row settings-row-action">
                  <div>
                    <div className="settings-action-label">Clear All User Data</div>
                    <div className="settings-action-desc">
                      Deletes the entire app data folder and quits. The app will start fresh on next
                      launch.
                    </div>
                  </div>
                  {confirmClear === 'userdata' ? (
                    <div className="settings-confirm-row">
                      <span>Are you sure?</span>
                      <button className="btn-danger" onClick={handleClearUserData}>
                        Yes, delete & quit
                      </button>
                      <button className="btn-secondary" onClick={() => setConfirmClear(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button className="btn-danger" onClick={() => setConfirmClear('userdata')}>
                      Clear All User Data
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <button className="settings-close" onClick={onClose}>
          ✕
        </button>
      </div>

      {/* Inline confirm backdrop blocked by modal's stopPropagation */}
    </div>
  );
}

export default SettingsModal;
