import { Fragment, useState, useEffect, useCallback, useRef } from 'react';
import { usePlayer } from './PlayerContext.jsx';
import './CuePointsEditor.css';

const COLOR_PALETTE = [
  '#ff6b35',
  '#ff0000',
  '#ff9900',
  '#ffff00',
  '#00ff00',
  '#00b4d8',
  '#0080ff',
  '#cc00ff',
];

/** Format a time in ms as m:ss.t (tenths of a second). */
function msToTime(ms) {
  if (ms == null) return '0:00.0';
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  const tenth = Math.floor((totalSec % 1) * 10);
  return `${m}:${String(s).padStart(2, '0')}.${tenth}`;
}

const HOT_CUE_LABELS = [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
  'P',
];
/**
 * Hot cue slots shown per page: decks expose sixteen hot cues (A–P), paged eight
 * at a time to keep the grid two rows tall.
 */
const HOT_CUE_PAGE_SIZE = 8;

/** Human-readable cue slot name, e.g. "Hot cue A" or "Memory cue (Intro)". */
function cueSlotName(cue) {
  const slot =
    cue.hot_cue_index >= 0 ? `Hot cue ${HOT_CUE_LABELS[cue.hot_cue_index]}` : 'Memory cue';
  const label = (cue.label ?? '').trim();
  return label ? `${slot} (${label})` : slot;
}

/** localStorage key for the "show hot cues" list toggle. */
const LS_SHOW_HOT = 'cue-show-hot';
/** localStorage key for the "show memory cues" list toggle. */
const LS_SHOW_MEM = 'cue-show-mem';

/** Read a visibility toggle from localStorage, defaulting to visible. */
function readVis(key) {
  try {
    return localStorage.getItem(key) !== 'false';
  } catch {
    return true;
  }
}

/**
 * Persist a visibility toggle and broadcast it so other cue views re-read the flag.
 */
function writeVis(key, val) {
  try {
    localStorage.setItem(key, String(val));
    window.dispatchEvent(new CustomEvent('cue-visibility-changed', { detail: { key, val } }));
  } catch {}
}

/**
 * Cue point editor for one track: add memory or hot cues at the playhead, relabel,
 * recolour, shift and delete them, and auto-generate cues from the waveform.
 *
 * Hot cues are paged in groups of HOT_CUE_PAGE_SIZE, and the list can hide hot or
 * memory cues independently (the choice is remembered per machine).
 *
 * @param {string} trackId Track whose cue points are edited.
 * @param {(cuePoints: object[]) => void} onCuePointsChange Called with the current cue
 *   list; in deferred mode it is the only way changes leave the component.
 * @param {boolean} deferred When true no database writes happen: edits are kept locally
 *   with temporary ids so a parent modal can commit them later.
 * @param {(cuePoints: object[]) => void} onRebase Called in deferred mode after cue
 *   generation has written to the database, with the freshly created cue list.
 */
export default function CuePointsEditor({
  trackId,
  onCuePointsChange,
  deferred = false,
  onRebase,
}) {
  const { currentTime } = usePlayer() ?? {};
  const [cuePoints, setCuePoints] = useState([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [confirmGen, setConfirmGen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [confirmSwap, setConfirmSwap] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editLabel, setEditLabel] = useState('');
  const [typePickerId, setTypePickerId] = useState(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const addMenuRef = useRef(null);

  useEffect(() => {
    if (typePickerId === null) return;
    const close = (e) => {
      if (!e.target.closest('.cpe__badge-wrap')) setTypePickerId(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [typePickerId]);

  useEffect(() => {
    if (!showAddMenu) return;
    const close = (e) => {
      if (!addMenuRef.current?.contains(e.target)) setShowAddMenu(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [showAddMenu]);

  const [showHot, setShowHot] = useState(() => readVis(LS_SHOW_HOT));
  const [showMem, setShowMem] = useState(() => readVis(LS_SHOW_MEM));

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
  const isLoadedRef = useRef(false);
  const reload = useCallback(() => {
    revRef.current += 1;
    setRev(revRef.current);
    window.dispatchEvent(new CustomEvent('cue-points-updated', { detail: { trackId } }));
  }, [trackId]);

  useEffect(() => {
    if (!deferred || !isLoadedRef.current) return;
    onCuePointsChange?.(cuePoints);
  }, [deferred, cuePoints, onCuePointsChange]);

  useEffect(() => {
    if (deferred) return;
    const unsub = window.api.onCuePointsUpdated(({ trackId: updatedId }) => {
      if (updatedId === trackId) reload();
    });
    return unsub;
  }, [trackId, reload, deferred]);

  useEffect(() => {
    if (!trackId) return;
    let alive = true;
    window.api.getCuePoints(trackId).then((pts) => {
      if (!alive) return;
      isLoadedRef.current = true;
      setCuePoints(pts);
      if (!deferred) onCuePointsChange?.(pts);
    });
    return () => {
      alive = false;
    };
  }, [trackId, rev, onCuePointsChange, deferred]);

  const handleAddMemoryCue = async () => {
    if (!trackId) return;
    setShowAddMenu(false);
    const posMs = Math.round((currentTime ?? 0) * 1000);
    if (deferred) {
      setCuePoints((prev) =>
        [
          ...prev,
          {
            id: `tmp-${Date.now()}`,
            track_id: trackId,
            position_ms: posMs,
            label: '',
            color: '#00b4d8',
            hot_cue_index: -1,
            enabled: 1,
          },
        ].sort((a, b) => a.position_ms - b.position_ms)
      );
    } else {
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
    }
  };

  const handleAddHotCue = async () => {
    if (!trackId) return;
    setShowAddMenu(false);
    const usedIndices = new Set(
      cuePoints.filter((c) => c.hot_cue_index >= 0).map((c) => c.hot_cue_index)
    );
    const nextIndex = HOT_CUE_LABELS.map((_, i) => i).find((i) => !usedIndices.has(i));
    if (nextIndex === undefined) return;
    const posMs = Math.round((currentTime ?? 0) * 1000);
    const color = COLOR_PALETTE[nextIndex % COLOR_PALETTE.length];
    if (deferred) {
      setCuePoints((prev) =>
        [
          ...prev,
          {
            id: `tmp-${Date.now()}`,
            track_id: trackId,
            position_ms: posMs,
            label: '',
            color,
            hot_cue_index: nextIndex,
            enabled: 1,
          },
        ].sort((a, b) => a.position_ms - b.position_ms)
      );
    } else {
      setLoading(true);
      await window.api.addCuePoint({
        trackId,
        positionMs: posMs,
        label: '',
        color,
        hotCueIndex: nextIndex,
      });
      reload();
      setLoading(false);
    }
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
    if (deferred) {
      const pts = await window.api.getCuePoints(trackId);
      setCuePoints(pts ?? []);
      onRebase?.(pts ?? []);
    } else {
      reload();
    }
    setGenerating(false);
  };

  const handleDelete = (id) => {
    setConfirmDeleteId(id);
  };

  const confirmDelete = async () => {
    if (!confirmDeleteId) return;
    if (deferred) {
      setCuePoints((prev) => prev.filter((c) => c.id !== confirmDeleteId));
      setConfirmDeleteId(null);
    } else {
      await window.api.deleteCuePoint(confirmDeleteId);
      setConfirmDeleteId(null);
      reload();
    }
  };

  const handleDeleteAll = () => setConfirmDeleteAll(true);

  const confirmDeleteAllCues = async () => {
    setConfirmDeleteAll(false);
    if (deferred) {
      setCuePoints([]);
    } else {
      for (const cue of cuePoints) {
        await window.api.deleteCuePoint(cue.id);
      }
      reload();
    }
  };

  const handleColorChange = async (id, color) => {
    if (deferred) {
      setCuePoints((prev) => prev.map((c) => (c.id === id ? { ...c, color } : c)));
    } else {
      await window.api.updateCuePoint(id, { color });
      reload();
    }
  };

  const handleLabelSave = async (id) => {
    if (deferred) {
      setCuePoints((prev) => prev.map((c) => (c.id === id ? { ...c, label: editLabel } : c)));
      setEditingId(null);
    } else {
      await window.api.updateCuePoint(id, { label: editLabel });
      setEditingId(null);
      reload();
    }
  };

  const startEdit = (cue) => {
    setEditingId(cue.id);
    setEditLabel(cue.label ?? '');
  };

  const handleToggleEnabled = async (id, currentEnabled) => {
    const next = currentEnabled === 0 ? 1 : 0;
    if (deferred) {
      setCuePoints((prev) => prev.map((c) => (c.id === id ? { ...c, enabled: next } : c)));
    } else {
      await window.api.updateCuePoint(id, { enabled: next });
      reload();
    }
  };

  const applyTypeChange = async (id, hotCueIndex) => {
    if (deferred) {
      setCuePoints((prev) =>
        prev.map((c) => (c.id === id ? { ...c, hot_cue_index: hotCueIndex } : c))
      );
    } else {
      await window.api.updateCuePoint(id, { hotCueIndex });
      reload();
    }
  };

  const handleTypeChange = (id, hotCueIndex) => {
    setTypePickerId(null);
    const cue = cuePoints.find((c) => c.id === id);
    if (!cue) return;
    const occupant =
      hotCueIndex >= 0
        ? cuePoints.find((c) => c.id !== id && c.hot_cue_index === hotCueIndex)
        : null;
    if (occupant) {
      const occupantMovesTo =
        cue.hot_cue_index >= 0
          ? `${cueSlotName(occupant)} takes Hot cue ${HOT_CUE_LABELS[cue.hot_cue_index]}.`
          : `${cueSlotName(occupant)} becomes a memory cue.`;
      setConfirmSwap({
        id,
        hotCueIndex,
        oldIndex: cue.hot_cue_index,
        occupantId: occupant.id,
        message:
          `${cueSlotName(occupant)} is taken. Swap: ${cueSlotName(cue)} takes ` +
          `Hot cue ${HOT_CUE_LABELS[hotCueIndex]} and ${occupantMovesTo}`,
      });
      return;
    }
    applyTypeChange(id, hotCueIndex);
  };

  const confirmSwapCues = async () => {
    const swap = confirmSwap;
    if (!swap) return;
    setConfirmSwap(null);
    if (deferred) {
      setCuePoints((prev) =>
        prev.map((c) => {
          if (c.id === swap.id) return { ...c, hot_cue_index: swap.hotCueIndex };
          if (c.id === swap.occupantId) return { ...c, hot_cue_index: swap.oldIndex };
          return c;
        })
      );
      return;
    }
    await window.api.updateCuePoint(swap.id, { hotCueIndex: swap.hotCueIndex });
    await window.api.updateCuePoint(swap.occupantId, { hotCueIndex: swap.oldIndex });
    reload();
  };

  const { seek } = usePlayer() ?? {};

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
          <div className="cpe__add-wrap" ref={addMenuRef}>
            <button
              className="cpe__btn cpe__btn--add"
              onClick={() => setShowAddMenu((v) => !v)}
              disabled={loading || !trackId}
              title="Add cue point at current position"
            >
              + Add ▾
            </button>
            {showAddMenu && (
              <div className="cpe__add-menu">
                <button className="cpe__add-option" onClick={handleAddMemoryCue}>
                  ● Memory Cue
                </button>
                <button className="cpe__add-option" onClick={handleAddHotCue}>
                  {HOT_CUE_LABELS[0]} Hot Cue
                </button>
              </div>
            )}
          </div>
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

      {confirmSwap && (
        <div
          className="cpe__confirm-backdrop"
          role="presentation"
          onClick={() => setConfirmSwap(null)}
        >
          <div
            className="cpe__confirm"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm hot cue swap"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="cpe__confirm-title">Hot cue slot is taken</div>
            <p className="cpe__confirm-message">{confirmSwap.message}</p>
            <div className="cpe__confirm-actions">
              <button className="cpe__btn cpe__btn--add" onClick={confirmSwapCues}>
                Swap
              </button>
              <button className="cpe__btn" onClick={() => setConfirmSwap(null)}>
                Cancel
              </button>
            </div>
          </div>
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
              {}
              <div className="cpe__badge-wrap">
                <div
                  className="cpe__badge"
                  style={{ background: cue.color }}
                  title={
                    cue.hot_cue_index >= 0
                      ? `Hot cue ${HOT_CUE_LABELS[cue.hot_cue_index]}${cue.hot_cue_index >= HOT_CUE_PAGE_SIZE ? ' (page 2)' : ''} — click to change type`
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
                      <Fragment key={label}>
                        {i === HOT_CUE_PAGE_SIZE && <div className="cpe__type-page-break" />}
                        <button
                          className={`cpe__type-opt${cue.hot_cue_index === i ? ' cpe__type-opt--active' : ''}`}
                          style={
                            cue.hot_cue_index === i ? { background: cue.color, color: '#000' } : {}
                          }
                          onClick={() => handleTypeChange(cue.id, i)}
                          title={`Hot cue ${label}${i >= HOT_CUE_PAGE_SIZE ? ' (page 2)' : ''}`}
                        >
                          {label}
                        </button>
                      </Fragment>
                    ))}
                  </div>
                )}
              </div>

              {}
              <button
                className="cpe__time"
                onClick={() => seek?.(cue.position_ms / 1000)}
                title="Seek to cue point"
              >
                {msToTime(cue.position_ms)}
              </button>

              {}
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

              {}
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

              {}
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

              {}
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
