import { useState, useEffect, useCallback } from 'react';
import FormatConfirmModal from './FormatConfirmModal.jsx';
import './ExportModal.css';

const STEPS = {
  idle: 'idle',
  confirm: 'confirm',
  pickFolder: 'pickFolder',
  checkingFormat: 'checkingFormat',
  needsFormat: 'needsFormat',
  formatting: 'formatting',
  exporting: 'exporting',
  done: 'done',
  error: 'error',
};

function ProgressBar({ pct }) {
  return (
    <div className="export-progress-track">
      <div className="export-progress-fill" style={{ width: `${pct ?? 0}%` }} />
    </div>
  );
}

function ExportModal({ onClose, playlistId, initialMode }) {
  const [step, setStep] = useState(initialMode ? STEPS.confirm : STEPS.idle);
  const [mode, setMode] = useState(initialMode ?? null);
  const [usbInfo, setUsbInfo] = useState(null);
  const [usbRoot, setUsbRoot] = useState(null);
  const [progress, setProgress] = useState(null); // { msg, pct }
  const [formatProgress, setFormatProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [useNormalized, setUseNormalized] = useState(true);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === 'Escape' && (step === STEPS.idle || step === STEPS.confirm)) onClose();
    },
    [onClose, step]
  );
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Progress listeners
  useEffect(() => {
    const unsubRekordbox = window.api.onExportRekordboxProgress(setProgress);
    const unsubAll = window.api.onExportAllProgress(setProgress);
    const unsubFormat = window.api.onFormatUsbProgress(setFormatProgress);
    return () => {
      unsubRekordbox();
      unsubAll();
      unsubFormat();
    };
  }, []);

  const pickFolder = async (exportMode) => {
    setMode(exportMode);
    const dir = await window.api.openDirDialog();
    if (!dir) return;
    setUsbRoot(dir);
    setStep(STEPS.checkingFormat);
    const info = await window.api.checkUsbFormat(dir);
    setUsbInfo(info);
    if (info.needsFormat) {
      setStep(STEPS.needsFormat);
    } else {
      startExport(exportMode, dir);
    }
  };

  const handleFormatConfirm = async () => {
    setStep(STEPS.formatting);
    const res = await window.api.formatUsb({ device: usbInfo.device, mountPoint: usbRoot });
    if (!res.ok) {
      setError(res.error);
      setStep(STEPS.error);
      return;
    }
    startExport(mode, usbRoot);
  };

  const startExport = async (exportMode, dir) => {
    setStep(STEPS.exporting);
    setProgress({ msg: 'Starting…', pct: 0 });
    let res;
    if (exportMode === 'rekordbox') {
      res = await window.api.exportRekordbox({
        usbRoot: dir,
        playlistId: playlistId ?? null,
        useNormalized,
      });
    } else {
      res = await window.api.exportAll({
        usbRoot: dir,
        playlistId: playlistId ?? null,
        useNormalized,
      });
    }
    if (res.ok) {
      setResult(res);
      setStep(STEPS.done);
    } else {
      setError(res.error);
      setStep(STEPS.error);
    }
  };

  const handleExportM3U = async () => {
    // Per-playlist M3U uses existing flow — just close this modal
    onClose();
  };

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && step === STEPS.idle && onClose()}
    >
      <div className="export-modal">
        <div className="export-modal-header">
          <span className="export-modal-title">Export</span>
          {step === STEPS.idle && (
            <button className="export-modal-close" onClick={onClose}>
              ✕
            </button>
          )}
        </div>

        {step === STEPS.idle && (
          <div className="export-modal-body">
            <p className="export-modal-desc">
              {playlistId
                ? 'Export this playlist to a Pioneer-compatible USB drive for CDJ/XDJ players.'
                : 'Choose an export format. Rekordbox USB creates a Pioneer-compatible drive you can plug directly into CDJ/XDJ players.'}
            </p>
            <label className="export-normalized-option">
              <input
                type="checkbox"
                checked={useNormalized}
                onChange={(e) => setUseNormalized(e.target.checked)}
              />
              <span>Apply loudness normalization to exported files</span>
            </label>
            <div className="export-options">
              <button className="export-option-btn" onClick={() => pickFolder('rekordbox')}>
                <span className="export-option-icon">💾</span>
                <span className="export-option-label">Export Rekordbox USB</span>
                <span className="export-option-sub">PDB + beat grids · all playlists</span>
              </button>
              <button className="export-option-btn" onClick={() => pickFolder('all')}>
                <span className="export-option-icon">📦</span>
                <span className="export-option-label">Export All</span>
                <span className="export-option-sub">Rekordbox USB + M3U playlists</span>
              </button>
              <button
                className="export-option-btn export-option-btn--secondary"
                onClick={handleExportM3U}
              >
                <span className="export-option-icon">📋</span>
                <span className="export-option-label">Export M3U</span>
                <span className="export-option-sub">Right-click a playlist in the sidebar</span>
              </button>
            </div>
          </div>
        )}

        {step === STEPS.confirm && (
          <div className="export-modal-body">
            <p className="export-modal-desc">
              {mode === 'rekordbox'
                ? 'Export this playlist to a Pioneer-compatible USB drive for CDJ/XDJ players.'
                : 'Export Rekordbox USB + M3U playlists to a folder.'}
            </p>
            <label className="export-normalized-option">
              <input
                type="checkbox"
                checked={useNormalized}
                onChange={(e) => setUseNormalized(e.target.checked)}
              />
              <span>Apply loudness normalization to exported files</span>
            </label>
            <div className="export-confirm-actions">
              <button className="export-option-btn" onClick={() => pickFolder(mode)}>
                <span className="export-option-icon">{mode === 'rekordbox' ? '💾' : '📦'}</span>
                <span className="export-option-label">Choose folder &amp; Export</span>
              </button>
              <button className="export-cancel-btn" onClick={onClose}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {step === STEPS.checkingFormat && (
          <div className="export-modal-body export-modal-body--center">
            <div className="export-spinner" />
            <p>Checking drive format…</p>
          </div>
        )}

        {step === STEPS.needsFormat && usbInfo && (
          <div className="export-modal-body">
            <p className="export-needs-format-title">⚠️ Drive format warning</p>
            <p className="export-needs-format-desc">
              This drive is formatted as <strong>{usbInfo.fsLabel}</strong>. Pioneer CDJ/XDJ players
              require FAT32 or exFAT to read the drive directly.
            </p>
            <p className="export-needs-format-sub">
              <span className="export-info-label">Device:</span> {usbInfo.device ?? 'unknown'} ·{' '}
              <span className="export-info-label">Mount:</span> {usbRoot}
            </p>
            <p className="export-needs-format-hint">
              You can still export to this folder (e.g. to inspect the files or copy manually), or
              reformat the drive to FAT32 first.
            </p>
            <div className="export-needs-format-actions">
              <button
                className="export-option-btn export-option-btn--secondary"
                onClick={() => startExport(mode, usbRoot)}
              >
                Export Anyway
              </button>
              <button
                className="export-option-btn export-option-btn--danger"
                onClick={() => setStep('confirmFormat')}
              >
                Format to FAT32 &amp; Export
              </button>
              <button className="export-cancel-btn" onClick={() => setStep(STEPS.idle)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {step === 'confirmFormat' && usbInfo && (
          <FormatConfirmModal
            fsLabel={usbInfo.fsLabel}
            device={usbInfo.device}
            mountPoint={usbRoot}
            onConfirm={handleFormatConfirm}
            onCancel={() => setStep(STEPS.needsFormat)}
          />
        )}

        {step === STEPS.formatting && (
          <div className="export-modal-body export-modal-body--center">
            <div className="export-spinner" />
            <p className="export-status-msg">{formatProgress?.msg ?? 'Formatting drive…'}</p>
          </div>
        )}

        {step === STEPS.exporting && (
          <div className="export-modal-body">
            <p className="export-status-msg">{progress?.msg ?? 'Exporting…'}</p>
            <ProgressBar pct={progress?.pct} />
            <p className="export-status-pct">{progress?.pct ?? 0}%</p>
          </div>
        )}

        {step === STEPS.done && result && (
          <div className="export-modal-body export-modal-body--center">
            <div className="export-success-icon">✅</div>
            <p className="export-status-msg export-status-msg--success">Export complete!</p>
            <p className="export-status-sub">
              {result.newTrackCount != null && result.trackCount !== result.newTrackCount ? (
                <>
                  {result.newTrackCount} new track{result.newTrackCount !== 1 ? 's' : ''} added ·{' '}
                  {result.trackCount} total on USB
                </>
              ) : (
                <>
                  {result.trackCount} track{result.trackCount !== 1 ? 's' : ''}
                </>
              )}
              {result.playlistCount
                ? ` · ${result.playlistCount} playlist${result.playlistCount !== 1 ? 's' : ''}`
                : ''}{' '}
              on USB
            </p>
            <p className="export-status-path">{result.usbRoot}</p>
            <button className="export-done-btn" onClick={onClose}>
              Done
            </button>
          </div>
        )}

        {step === STEPS.error && (
          <div className="export-modal-body export-modal-body--center">
            <div className="export-error-icon">❌</div>
            <p className="export-status-msg export-status-msg--error">Export failed</p>
            <p className="export-error-detail">{error}</p>
            <button className="export-done-btn" onClick={() => setStep(STEPS.idle)}>
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default ExportModal;
