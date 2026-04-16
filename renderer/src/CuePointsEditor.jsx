import { useState, useEffect, useCallback, useRef } from 'react';
import { usePlayer } from './PlayerContext.jsx';
import './CuePointsEditor.css';

const COLOR_PALETTE = [
  '#ff6b35', // orange-red  (Rekordbox hot cue A)
  '#ff0000', // red
  '#ff9900', // orange
  '#ffff00', // yellow
  '#00ff00', // green
  '#00b4d8', // cyan (default)
  '#0080ff', // blue
  '#cc00ff', // violet
];

function msToTime(ms) {
  if (ms == null) return '0:00.0';
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  const tenth = Math.floor((totalSec % 1) * 10);
  return `${m}:${String(s).padStart(2, '0')}.${tenth}`;
}

const HOT_CUE_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

// Visibility preference keys in localStorage
const LS_SHOW_HOT = 'cue-show-hot';
const LS_SHOW_MEM = 'cue-show-mem';

function readVis(key) {
  try {
    return localStorage.getItem(key) !== 'false';
  } catch {
    return true;
  }
}

function writeVis(key, val) {
  try {
    localStorage.setItem(key, String(val));
    window.dispatchEvent(new CustomEvent('cue-visibility-changed', { detail: { key, val } }));
  } catch {
    /* ignore */
  }
}

export default function CuePointsEditor({ trackId, onCuePointsChange }) {
  const { currentTime } = usePlayer() ?? {};
  const [cuePoints, setCuePoints] = useState([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [confirmGen, setConfirmGen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editLabel, setEditLabel] = useState('');
  const [typePickerId, setTypePickerId] = useState(null); // cue id whose type picker is open

  // Close type picker on outside click
  useEffect(() => {
    if (typePickerId === null) return;
    const close = (e) => {
      if (!e.target.closest('.cpe__badge-wrap')) setTypePickerId(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [typePickerId]);

  // Visibility toggles — persisted in localStorage, shared with PlayerBar via custom event
  const [showHot, setShowHot] = useState(() => readVis(LS_SHOW_HOT));
  const [showMem, setShowMem] = useState(() => readVis(LS_SHOW_MEM));

  // Keep in sync if another component changes visibility
  useEffect(() => {
    const handler = ({ detail: { key, val } }) => {
      if (key === LS_SHOW_HOT) setShowHot(val);
      if (key === LS_SHOW_MEM) setShowMem(val);
    };
    window.addEventListener('cue-visibility-changed', handler);
    return () => window.removeEventListener('cue-visibility-changed', handler);
  }, []);

  const toggleShowHot = () => {
    const next = !showHot;
    setShowHot(next);
    writeVis(LS_SHOW_HOT, next);
  };
  const toggleShowMem = () => {
    const next = !showMem;
    setShowMem(next);
    writeVis(LS_SHOW_MEM, next);
  };

  const revRef = useRef(0);
  const [rev, setRev] = useState(0);
  const reload = useCallback(() => {
    revRef.current += 1;
    setRev(revRef.current);
    window.dispatchEvent(new CustomEvent('cue-points-updated', { detail: { trackId } }));
  }, [trackId]);

  // Listen for auto-cue IPC events from main process (e.g. auto-generate on import)
  useEffect(() => {
    const unsub = window.api.onCuePointsUpdated(({ trackId: updatedId }) => {
      if (updatedId === trackId) reload();
    });
    return unsub;
  }, [trackId, reload]);

  useEffect(() => {
    if (!trackId) return;
    let alive = true;
    window.api.getCuePoints(trackId).then((pts) => {
      if (!alive) return;
      setCuePoints(pts);
      onCuePointsChange?.(pts);
    });
    return () => {
      alive = false;
    };
  }, [trackId, rev, onCuePointsChange]);

  const handleAdd = async () => {
    if (!trackId) return;
    const posMs = Math.round((currentTime ?? 0) * 1000);
    setLoading(true);
    await window.api.addCuePoint({
      trackId,
      positionMs: posMs,
      label: '',
      color: '#00b4d8',
      hotCueIndex: -1,
    });
    reload();
    setLoading(false);
  };

  const handleGenerateClick = () => {
    if (!trackId) return;
    if (cuePoints.length > 0) {
      setConfirmGen(true);
    } else {
      handleGenerate();
    }
  };

  const handleGenerate = async () => {
    setConfirmGen(false);
    if (!trackId) return;
    setGenerating(true);
    await window.api.generateCuePoints(trackId);
    reload();
    setGenerating(false);
  };

  const handleDelete = (id) => {
    setConfirmDeleteId(id);
  };

  const confirmDelete = async () => {
    if (!confirmDeleteId) return;
    await window.api.deleteCuePoint(confirmDeleteId);
    setConfirmDeleteId(null);
    reload();
  };

  const handleDeleteAll = () => setConfirmDeleteAll(true);

  const confirmDeleteAllCues = async () => {
    setConfirmDeleteAll(false);
    for (const cue of cuePoints) {
      await window.api.deleteCuePoint(cue.id);
    }
    reload();
  };

  const handleColorChange = async (id, color) => {
    await window.api.updateCuePoint(id, { color });
    reload();
  };

  const handleLabelSave = async (id) => {
    await window.api.updateCuePoint(id, { label: editLabel });
    setEditingId(null);
    reload();
  };

  const startEdit = (cue) => {
    setEditingId(cue.id);
    setEditLabel(cue.label ?? '');
  };

  const handleToggleEnabled = async (id, currentEnabled) => {
    await window.api.updateCuePoint(id, { enabled: currentEnabled === 0 ? 1 : 0 });
    reload();
  };

  // Change a cue's type: -1 = memory, 0-7 = hot cue A-H
  const handleTypeChange = async (id, hotCueIndex) => {
    setTypePickerId(null);
    await window.api.updateCuePoint(id, { hotCueIndex });
    reload();
  };

  const { seek } = usePlayer() ?? {};

  // Apply visibility filter for the list
  const visibleCues = cuePoints.filter((c) => {
    if (c.hot_cue_index >= 0) return showHot;
    return showMem;
  });

  return (
    <div className="cpe">
      <div className="cpe__header">
        <span className="cpe__title">Cue Points</span>
        <div className="cpe__vis-toggles">
          <button
            className={`cpe__vis-btn${showHot ? ' cpe__vis-btn--on' : ''}`}
            onClick={toggleShowHot}
            title={showHot ? 'Hide hot cues' : 'Show hot cues'}
          >
            Hot
          </button>
          <button
            className={`cpe__vis-btn${showMem ? ' cpe__vis-btn--on' : ''}`}
            onClick={toggleShowMem}
            title={showMem ? 'Hide memory cues' : 'Show memory cues'}
          >
            Mem
          </button>
        </div>
        <div className="cpe__actions">
          <button
            className="cpe__btn cpe__btn--add"
            onClick={handleAdd}
            disabled={loading || !trackId}
            title="Add cue point at current position"
          >
            + Add
          </button>
          <button
            className="cpe__btn cpe__btn--gen"
            onClick={handleGenerateClick}
            disabled={generating || !trackId}
            title="Auto-generate cue points from track analysis (intro, phrases, outro)"
          >
            {generating ? '…' : '⚡ Auto'}
          </button>
          {cuePoints.length > 0 && (
            <button
              className="cpe__btn cpe__btn--danger-subtle"
              onClick={handleDeleteAll}
              title="Delete all cue points"
            >
              ✕ All
            </button>
          )}
        </div>
      </div>

      {confirmDeleteAll && (
        <div className="cpe__confirm">
          <span>
            Delete all {cuePoints.length} cue point{cuePoints.length !== 1 ? 's' : ''}?
          </span>
          <button className="cpe__btn cpe__btn--danger" onClick={confirmDeleteAllCues}>
            Delete all
          </button>
          <button className="cpe__btn" onClick={() => setConfirmDeleteAll(false)}>
            Cancel
          </button>
        </div>
      )}

      {confirmGen && (
        <div className="cpe__confirm">
          <span>
            Replace {cuePoints.length} existing cue point{cuePoints.length !== 1 ? 's' : ''}?
          </span>
          <button className="cpe__btn cpe__btn--danger" onClick={handleGenerate}>
            Replace
          </button>
          <button className="cpe__btn" onClick={() => setConfirmGen(false)}>
            Cancel
          </button>
        </div>
      )}

      {cuePoints.length === 0 ? (
        <div className="cpe__empty">No cue points — add one or use ⚡ Auto</div>
      ) : visibleCues.length === 0 ? (
        <div className="cpe__empty">All cue points hidden — toggle Hot / Mem above</div>
      ) : (
        <div className="cpe__list">
          {visibleCues.map((cue) => (
            <div
              key={cue.id}
              className={`cpe__row${cue.enabled === 0 ? ' cpe__row--disabled' : ''}`}
            >
              {/* Type badge — click to open type picker */}
              <div className="cpe__badge-wrap">
                <div
                  className="cpe__badge"
                  style={{ background: cue.color }}
                  title={
                    cue.hot_cue_index >= 0
                      ? `Hot cue ${HOT_CUE_LABELS[cue.hot_cue_index]} — click to change type`
                      : 'Memory cue — click to change type'
                  }
                  onClick={() => setTypePickerId(typePickerId === cue.id ? null : cue.id)}
                >
                  {cue.hot_cue_index >= 0 ? HOT_CUE_LABELS[cue.hot_cue_index] : '●'}
                </div>

                {typePickerId === cue.id && (
                  <div className="cpe__type-picker">
                    <button
                      className={`cpe__type-opt cpe__type-opt--mem${cue.hot_cue_index < 0 ? ' cpe__type-opt--active' : ''}`}
                      onClick={() => handleTypeChange(cue.id, -1)}
                      title="Memory cue"
                    >
                      ●
                    </button>
                    {HOT_CUE_LABELS.map((label, i) => (
                      <button
                        key={label}
                        className={`cpe__type-opt${cue.hot_cue_index === i ? ' cpe__type-opt--active' : ''}`}
                        style={
                          cue.hot_cue_index === i ? { background: cue.color, color: '#000' } : {}
                        }
                        onClick={() => handleTypeChange(cue.id, i)}
                        title={`Hot cue ${label}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Time — click to seek */}
              <button
                className="cpe__time"
                onClick={() => seek?.(cue.position_ms / 1000)}
                title="Seek to cue point"
              >
                {msToTime(cue.position_ms)}
              </button>

              {/* Label — click to edit */}
              {editingId === cue.id ? (
                <input
                  className="cpe__label-input"
                  value={editLabel}
                  autoFocus
                  onChange={(e) => setEditLabel(e.target.value)}
                  onBlur={() => handleLabelSave(cue.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleLabelSave(cue.id);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                />
              ) : (
                <button
                  className="cpe__label"
                  onClick={() => startEdit(cue)}
                  title="Click to rename"
                >
                  {cue.label || <span className="cpe__label--placeholder">label…</span>}
                </button>
              )}

              {/* Color picker */}
              <div className="cpe__colors">
                {COLOR_PALETTE.map((c) => (
                  <button
                    key={c}
                    className={`cpe__color-dot${cue.color === c ? ' cpe__color-dot--active' : ''}`}
                    style={{ background: c }}
                    onClick={() => handleColorChange(cue.id, c)}
                    title={c}
                  />
                ))}
              </div>

              {/* Export toggle */}
              <button
                className={`cpe__export-toggle${cue.enabled === 0 ? ' cpe__export-toggle--off' : ''}`}
                onClick={() => handleToggleEnabled(cue.id, cue.enabled)}
                title={
                  cue.enabled === 0
                    ? 'Excluded from USB export — click to include'
                    : 'Included in USB export — click to exclude'
                }
              >
                {cue.enabled === 0 ? '⊘' : '⊙'}
              </button>

              {/* Delete */}
              {confirmDeleteId === cue.id ? (
                <div className="cpe__del-confirm">
                  <button className="cpe__btn cpe__btn--danger" onClick={confirmDelete}>
                    Delete
                  </button>
                  <button className="cpe__btn" onClick={() => setConfirmDeleteId(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  className="cpe__del"
                  onClick={() => handleDelete(cue.id)}
                  title="Delete cue point"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
