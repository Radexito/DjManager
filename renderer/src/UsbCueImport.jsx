import { useCallback, useEffect, useState } from 'react';
import './ExportModal.css';

// #259 — pull the cue points set on a CDJ back into the library.
// Opened automatically when a Rekordbox stick with new cues is detected, or
// manually from the library context menu (then it asks for the stick).
//
// Two import modes (#518 review):
//   extend  — add the stick's cues, refresh the slots it moved, never delete.
//   replace — mirror the stick exactly, so library cues it does not carry go.

const MODES = [
  {
    key: 'extend',
    label: 'Extend',
    sub: 'Add the cues from the stick, keep the ones already in the library',
  },
  {
    key: 'replace',
    label: 'Replace',
    sub: 'Mirror the stick - library cues it does not carry are deleted',
  },
];

export default function UsbCueImport({ usbRoot = '', onClose }) {
  const [root, setRoot] = useState(usbRoot || '');
  const [mode, setMode] = useState('extend');
  const [scan, setScan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const runScan = useCallback(async (target, scanMode) => {
    if (!target) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await window.api.scanUsbCues({ usbRoot: target, mode: scanMode });
      if (!res?.ok) setError(res?.error || 'Could not read the USB.');
      else setScan(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (root) runScan(root, mode);
  }, [root, mode, runScan]);

  const handlePickFolder = async () => {
    const dir = await window.api.openDirDialog();
    if (dir) setRoot(dir);
  };

  const handleImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.api.importUsbCues({ usbRoot: root, mode });
      if (!res?.ok) setError(res?.error || 'Import failed.');
      else setResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const summary = scan?.summary;
  const pending = summary ? summary.add + summary.update : 0;
  const removing = summary ? summary.remove : 0;
  const activeMode = MODES.find((m) => m.key === mode) ?? MODES[0];

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="export-modal">
        <div className="export-modal-header">
          <span className="export-modal-title">Import cue points from USB</span>
          <button className="export-modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="export-modal-body">
          {result ? (
            <>
              <div className="export-status-msg export-status-msg--success">
                Cue points imported ({result.mode === 'replace' ? 'replace' : 'extend'})
              </div>
              <div className="export-status-sub">
                {result.added} added · {result.updated} moved · {result.removed} removed ·{' '}
                {result.skipped} already in the library
                {result.tracks ? ` · ${result.tracks} track${result.tracks === 1 ? '' : 's'}` : ''}
              </div>
              {result.added + result.updated + result.removed === 0 && (
                <div className="export-status-sub">
                  Nothing changed - the library already matches this stick.
                </div>
              )}
              <button className="export-done-btn" onClick={onClose}>
                Done
              </button>
            </>
          ) : !root ? (
            <>
              <div className="export-modal-desc">
                Point DjManager at the Rekordbox USB to pull back the hot cues and memory cues you
                set on the hardware.
              </div>
              <div className="export-options">
                <button className="export-option-btn" onClick={handlePickFolder}>
                  <span className="export-option-icon">🎧</span>
                  <span className="export-option-label">Choose USB folder…</span>
                  <span className="export-option-sub">
                    Usually /run/media/&lt;you&gt;/&lt;stick&gt;
                  </span>
                </button>
              </div>
            </>
          ) : busy && !scan ? (
            <div className="export-status-msg">Reading cues from the USB…</div>
          ) : scan ? (
            <>
              <div className="export-modal-desc">
                {summary.cues} cue{summary.cues === 1 ? '' : 's'} found on the stick across{' '}
                {summary.tracks} track{summary.tracks === 1 ? '' : 's'}.
              </div>
              <div className="usb-cue-modes">
                {MODES.map((m) => (
                  <button
                    key={m.key}
                    className={`usb-cue-mode${mode === m.key ? ' usb-cue-mode--active' : ''}`}
                    onClick={() => setMode(m.key)}
                    disabled={busy}
                  >
                    <span className="usb-cue-mode-label">{m.label}</span>
                    <span className="usb-cue-mode-sub">{m.sub}</span>
                  </button>
                ))}
              </div>
              <div className="export-status-sub">
                {summary.add} new · {summary.update} moved on hardware · {summary.skip} already
                match
                {mode === 'replace' ? ` · ${removing} to delete` : ''}
              </div>
              {mode === 'replace' && removing > 0 && (
                <div className="usb-cue-warning">
                  Replace deletes {removing} library cue{removing === 1 ? '' : 's'} that this stick
                  does not carry. Extend keeps them.
                </div>
              )}
              <div className="export-status-path">{root}</div>
              {scan.tracks.length > 0 && (
                <div className="export-modal-desc">
                  {scan.tracks
                    .slice(0, 8)
                    .map(
                      (t) =>
                        `${t.title} — ${t.add.length} new, ${t.update.length} moved, ${t.skip.length} same${
                          t.remove.length ? `, ${t.remove.length} deleted` : ''
                        }`
                    )
                    .join('\n')}
                  {scan.tracks.length > 8 ? `\n…and ${scan.tracks.length - 8} more` : ''}
                </div>
              )}
              <div className="export-options">
                <button
                  className="export-option-btn"
                  disabled={busy || (pending === 0 && removing === 0)}
                  onClick={handleImport}
                >
                  <span className="export-option-icon">📥</span>
                  <span className="export-option-label">
                    {pending === 0 && removing === 0
                      ? 'Nothing to import'
                      : mode === 'replace'
                        ? `Replace with ${pending} cue${pending === 1 ? '' : 's'}`
                        : `Import ${pending} cue${pending === 1 ? '' : 's'}`}
                  </span>
                  <span className="export-option-sub">
                    {mode === 'replace'
                      ? `${activeMode.label} mode: the library will match the stick`
                      : 'Extend mode: nothing is ever deleted'}
                  </span>
                </button>
                <button
                  className="export-option-btn export-option-btn--secondary"
                  onClick={onClose}
                >
                  <span className="export-option-label">Not now</span>
                </button>
              </div>
            </>
          ) : (
            <div className="export-status-msg export-status-msg--error">
              Nothing to import from this folder.
            </div>
          )}
          {error && <div className="export-error-detail">{error}</div>}
        </div>
      </div>
    </div>
  );
}
