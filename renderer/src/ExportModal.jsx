import { useState, useEffect, useCallback } from 'react';
import FormatConfirmModal from './FormatConfirmModal.jsx';
import './ExportModal.css';

const STEPS = {
  idle: 'idle',
  confirm: 'confirm',
  pickFolder: 'pickFolder',
  checkingFormat: 'checkingFormat',
  needsFormat: 'needsFormat',
  notRemovable: 'notRemovable',
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

// Keep in sync with DEVICE_PROFILES keys/labels in src/usb/deviceFormats.js
const DEVICE_OPTIONS = [
  { key: 'cdj-3000', label: 'CDJ-3000' },
  { key: 'cdj-2000nxs2', label: 'CDJ-2000NXS2' },
  { key: 'xdj-rx3', label: 'XDJ-RX3' },
  { key: 'xdj-rx2', label: 'XDJ-RX2' },
  { key: 'xdj-1000mk2', label: 'XDJ-1000MK2' },
  { key: 'xdj-700', label: 'XDJ-700' },
];

function ExportFormatOptions({ targetDevice, setTargetDevice, forceMp3, setForceMp3 }) {
  return (
    <div className="export-format-options">
      <label className="export-device-option">
        <span>Target device</span>
        <select value={targetDevice} onChange={(e) => setTargetDevice(e.target.value)}>
          <option value="">None — keep source formats</option>
          {DEVICE_OPTIONS.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <label className="export-normalized-option">
        <input type="checkbox" checked={forceMp3} onChange={(e) => setForceMp3(e.target.checked)} />
        <span>Re-encode all tracks to MP3</span>
      </label>
    </div>
  );
}

function ExportModal({ onClose, playlistId, initialMode }) {
  const [step, setStep] = useState(initialMode ? STEPS.confirm : STEPS.idle);
  const [usbInfo, setUsbInfo] = useState(null);
  const [usbRoot, setUsbRoot] = useState(null);
  const [progress, setProgress] = useState(null); // { msg, pct }
  const [formatProgress, setFormatProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [useNormalized, setUseNormalized] = useState(true);
  // #463: optional — a trimmed track can be exported as the whole file instead.
  const [applyTrim, setApplyTrim] = useState(true);
  const [targetDevice, setTargetDevice] = useState('');
  const [forceMp3, setForceMp3] = useState(false);

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
    const unsubAll = window.api.onExportAllProgress(setProgress);
    const unsubFormat = window.api.onFormatUsbProgress(setFormatProgress);
    return () => {
      unsubAll();
      unsubFormat();
    };
  }, []);

  const pickFolder = async () => {
    const dir = await window.api.openDirDialog();
    if (!dir) return;
    setUsbRoot(dir);
    setStep(STEPS.checkingFormat);
    const info = await window.api.checkUsbFormat(dir);
    setUsbInfo(info);
    if (info.needsFormat && !info.removable) {
      // Never offer to format a drive we couldn't positively confirm is removable —
      // block here so the user isn't shown a "Format" button for an internal disk.
      setStep(STEPS.notRemovable);
    } else if (info.needsFormat) {
      setStep(STEPS.needsFormat);
    } else {
      startExport(dir);
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
    startExport(usbRoot);
  };

  const startExport = async (dir) => {
    setStep(STEPS.exporting);
    setProgress({ msg: 'Starting…', pct: 0 });
    const res = await window.api.exportAll({
      usbRoot: dir,
      playlistId: playlistId ?? null,
      useNormalized,
      applyTrim,
      targetDevice: targetDevice || null,
      forceMp3,
    });
    if (res.ok) {
      setResult(res);
      setStep(STEPS.done);
    } else {
      setError(res.error);
      setStep(STEPS.error);
    }
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
            <label className="export-normalized-option">
              <input
                type="checkbox"
                checked={applyTrim}
                onChange={(e) => setApplyTrim(e.target.checked)}
              />
              <span>Apply trim ranges (IN/OUT) to exported files (off exports the whole file)</span>
            </label>
            <ExportFormatOptions
              targetDevice={targetDevice}
              setTargetDevice={setTargetDevice}
              forceMp3={forceMp3}
              setForceMp3={setForceMp3}
            />
            <div className="export-options">
              <button className="export-option-btn" onClick={() => pickFolder()}>
                <span className="export-option-icon">📦</span>
                <span className="export-option-label">Export All</span>
                <span className="export-option-sub">Rekordbox USB + M3U playlists</span>
              </button>
            </div>
          </div>
        )}

        {step === STEPS.confirm && (
          <div className="export-modal-body">
            <p className="export-modal-desc">Export Rekordbox USB + M3U playlists to a folder.</p>
            <label className="export-normalized-option">
              <input
                type="checkbox"
                checked={useNormalized}
                onChange={(e) => setUseNormalized(e.target.checked)}
              />
              <span>Apply loudness normalization to exported files</span>
            </label>
            <label className="export-normalized-option">
              <input
                type="checkbox"
                checked={applyTrim}
                onChange={(e) => setApplyTrim(e.target.checked)}
              />
              <span>Apply trim ranges (IN/OUT) to exported files (off exports the whole file)</span>
            </label>
            <ExportFormatOptions
              targetDevice={targetDevice}
              setTargetDevice={setTargetDevice}
              forceMp3={forceMp3}
              setForceMp3={setForceMp3}
            />
            <div className="export-confirm-actions">
              <button className="export-option-btn" onClick={() => pickFolder()}>
                <span className="export-option-icon">📦</span>
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
            <p className="export-needs-format-hint">
              <strong>Note:</strong> if you export anyway, Rekordbox and CDJ/XDJ players will not be
              able to read this drive — Pioneer hardware only recognizes FAT32 or exFAT.
            </p>
            <div className="export-needs-format-actions">
              <button
                className="export-option-btn export-option-btn--secondary"
                onClick={() => startExport(usbRoot)}
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

        {step === STEPS.notRemovable && usbInfo && (
          <div className="export-modal-body">
            <p className="export-needs-format-title">⚠️ Cannot format this drive</p>
            <p className="export-needs-format-desc">
              This drive is formatted as <strong>{usbInfo.fsLabel}</strong>, but it could not be
              confirmed as removable media. To prevent accidentally erasing an internal disk,
              formatting is only allowed on drives positively identified as removable/external.
            </p>
            <p className="export-needs-format-sub">
              <span className="export-info-label">Device:</span> {usbInfo.device ?? 'unknown'} ·{' '}
              <span className="export-info-label">Mount:</span> {usbRoot}
            </p>
            <p className="export-needs-format-hint">
              You can still export to this folder as-is, or choose a different, removable drive to
              format.
            </p>
            <p className="export-needs-format-hint">
              <strong>Note:</strong> if you export anyway, Rekordbox and CDJ/XDJ players will not be
              able to read this drive — Pioneer hardware only recognizes FAT32 or exFAT.
            </p>
            <div className="export-needs-format-actions">
              <button
                className="export-option-btn export-option-btn--secondary"
                onClick={() => startExport(usbRoot)}
              >
                Export Anyway
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
