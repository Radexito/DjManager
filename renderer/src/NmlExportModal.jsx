import { useState, useEffect, useCallback, useRef } from 'react';
import './NmlExportModal.css';

const STEPS = {
  idle: 'idle',
  exporting: 'exporting',
  done: 'done',
  error: 'error',
};

function ProgressBar({ pct }) {
  return (
    <div className="nml-progress-track">
      <div className="nml-progress-fill" style={{ width: `${pct ?? 0}%` }} />
    </div>
  );
}

function NmlExportModal({ onClose, playlistId, initialMode }) {
  const [step, setStep] = useState(STEPS.idle);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === 'Escape' && step === STEPS.idle) onClose();
    },
    [onClose, step]
  );
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    const unsub = window.api.onExportNmlProgress(setProgress);
    return unsub;
  }, []);

  const autoStarted = useRef(false);
  useEffect(() => {
    if (initialMode && !autoStarted.current) {
      autoStarted.current = true;
      startExport(initialMode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startExport = async (mode) => {
    const result = await window.api.openDirDialog();
    if (!result) return;

    // Ask user for file name via save dialog — use directory + default name
    const outputPath = `${result}/collection.nml`;

    setStep(STEPS.exporting);
    setProgress({ msg: 'Starting export…', pct: 0 });

    let res;
    if (mode === 'all') {
      res = await window.api.exportNmlAll({ outputPath });
    } else {
      res = await window.api.exportNml({ outputPath, playlistId });
    }

    if (res.ok) {
      setResult(res.outputPath);
      setStep(STEPS.done);
    } else {
      setError(res.error);
      setStep(STEPS.error);
    }
  };

  return (
    <div className="nml-modal-overlay" onClick={step === STEPS.idle ? onClose : undefined}>
      <div className="nml-modal" onClick={(e) => e.stopPropagation()}>
        <div className="nml-modal-header">
          <h2 className="nml-modal-title">Export Traktor NML</h2>
          {(step === STEPS.idle || step === STEPS.done || step === STEPS.error) && (
            <button className="nml-modal-close" onClick={onClose}>
              ✕
            </button>
          )}
        </div>

        {step === STEPS.idle && (
          <div className="nml-modal-body">
            <p className="nml-modal-desc">
              Export your library as a Traktor NML file, readable by Native Instruments Traktor Pro.
            </p>
            <div className="nml-modal-actions">
              {playlistId && (
                <button
                  className="nml-btn nml-btn--primary"
                  onClick={() => startExport('playlist')}
                >
                  📄 Export Playlist
                </button>
              )}
              <button className="nml-btn nml-btn--secondary" onClick={() => startExport('all')}>
                📦 Export Full Library
              </button>
            </div>
          </div>
        )}

        {step === STEPS.exporting && (
          <div className="nml-modal-body">
            <p className="nml-modal-status">{progress?.msg ?? 'Working…'}</p>
            <ProgressBar pct={progress?.pct} />
          </div>
        )}

        {step === STEPS.done && (
          <div className="nml-modal-body">
            <p className="nml-modal-success">✅ Export complete!</p>
            <p className="nml-modal-path">{result}</p>
            <p className="nml-modal-hint">
              In Traktor: right-click Playlists → Import Playlist → select the .nml file.
            </p>
            <button className="nml-btn nml-btn--primary" onClick={onClose}>
              Close
            </button>
          </div>
        )}

        {step === STEPS.error && (
          <div className="nml-modal-body">
            <p className="nml-modal-error">❌ Export failed</p>
            <p className="nml-modal-error-detail">{error}</p>
            <button className="nml-btn nml-btn--secondary" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default NmlExportModal;
