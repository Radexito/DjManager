import { useState, useEffect, useCallback } from 'react';
import './SettingsModal.css';

const DEFAULT_TARGET = -14;

function SettingsModal({ onClose }) {
  const [activeSection, setActiveSection] = useState('library');
  const [targetInput, setTargetInput] = useState(String(DEFAULT_TARGET));
  const [confirmClear, setConfirmClear] = useState(null); // 'library' | 'userdata'
  const [depVersions, setDepVersions] = useState(null);
  const [updatingAll, setUpdatingAll] = useState(false);

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
  }, []);

  useEffect(() => {
    if (activeSection === 'library') {
      window.api.getLibraryPath().then(setLibraryPath);
    }
    if (activeSection === 'updates') {
      window.api.getDepVersions().then(setDepVersions);
    }
  }, [activeSection]);

  const handleUpdateAll = async () => {
    setUpdatingAll(true);
    await window.api.updateAllDeps();
    const versions = await window.api.getDepVersions();
    setDepVersions(versions);
    setUpdatingAll(false);
  };

  const handleTargetChange = (raw) => {
    setTargetInput(raw);
    const num = Number(raw);
    if (Number.isFinite(num) && num >= -60 && num <= 0) {
      window.api.setSetting('normalize_target_lufs', raw);
    }
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
      const result = await window.api.moveLibrary(newDir);
      setLibraryPath(newDir);
      setMoveProgress(null);
    } finally {
      unsub?.();
    }
  };

  const sections = [
    { id: 'library', label: 'Library' },
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
                <div className="settings-group-title">Loudness Normalization</div>
                <p className="settings-group-desc">
                  Calculates a gain adjustment for every analyzed track so it hits the target
                  loudness during playback. Tracks without loudness data are skipped.
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
              </div>

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

          {activeSection === 'updates' && (
            <>
              <h3>Dependencies</h3>

              <div className="settings-group">
                <div className="settings-group-title">Installed Versions</div>
                <p className="settings-group-desc">
                  FFmpeg and mixxx-analyzer are required dependencies downloaded automatically on
                  first launch.
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
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-group-title">Update</div>
                <div className="settings-row settings-row-action">
                  <div>
                    <div className="settings-action-label">Update All Dependencies</div>
                    <div className="settings-action-desc">
                      Re-downloads the latest FFmpeg and mixxx-analyzer.
                    </div>
                  </div>
                  <button className="btn-primary" onClick={handleUpdateAll} disabled={updatingAll}>
                    {updatingAll ? 'Updating…' : 'Update All'}
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
