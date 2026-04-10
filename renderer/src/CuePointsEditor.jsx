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

export default function CuePointsEditor({ trackId, onCuePointsChange }) {
  const { currentTime } = usePlayer() ?? {};
  const [cuePoints, setCuePoints] = useState([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [confirmGen, setConfirmGen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editLabel, setEditLabel] = useState('');

  const revRef = useRef(0);
  const [rev, setRev] = useState(0);
  const reload = useCallback(() => {
    revRef.current += 1;
    setRev(revRef.current);
    window.dispatchEvent(new CustomEvent('cue-points-updated', { detail: { trackId } }));
  }, [trackId]);

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

  const handleDelete = async (id) => {
    await window.api.deleteCuePoint(id);
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

  const { seek } = usePlayer() ?? {};

  return (
    <div className="cpe">
      <div className="cpe__header">
        <span className="cpe__title">Cue Points</span>
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
        </div>
      </div>

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
      ) : (
        <div className="cpe__list">
          {cuePoints.map((cue) => (
            <div key={cue.id} className="cpe__row">
              {/* Hot cue badge or memory cue dot */}
              <div
                className="cpe__badge"
                style={{ background: cue.color }}
                title={
                  cue.hot_cue_index >= 0
                    ? `Hot cue ${HOT_CUE_LABELS[cue.hot_cue_index]}`
                    : 'Memory cue'
                }
              >
                {cue.hot_cue_index >= 0 ? HOT_CUE_LABELS[cue.hot_cue_index] : '●'}
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

              {/* Delete */}
              <button
                className="cpe__del"
                onClick={() => handleDelete(cue.id)}
                title="Delete cue point"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
