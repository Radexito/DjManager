import { useState, useEffect, useRef, useCallback } from 'react';
import './BeatGridEditor.css';

const VIEW_MS = 8000; // milliseconds visible at once

/** Compute beat array from beatgrid JSON + bpm + offset (ms). */
function computeBeats(beatgridJson, bpm, offsetMs = 0) {
  let beats = [];
  try {
    if (beatgridJson) {
      const raw = typeof beatgridJson === 'string' ? JSON.parse(beatgridJson) : beatgridJson;
      if (Array.isArray(raw) && raw.length > 0) {
        beats =
          typeof raw[0] === 'number'
            ? raw.map((t, i) => ({ time: Math.round(t * 1000), beatNum: (i % 4) + 1 }))
            : raw.map((b, i) => ({
                time: Math.round((b.position ?? b.time ?? b.offset ?? 0) * 1000),
                beatNum: (i % 4) + 1,
              }));
      }
    }
  } catch {
    // malformed beatgrid JSON — fall through to BPM-generated grid
  }

  if (!beats.length && bpm > 0) {
    const intervalMs = (60 / bpm) * 1000;
    const count = Math.ceil(600_000 / intervalMs);
    beats = Array.from({ length: count }, (_, i) => ({
      time: Math.round(i * intervalMs),
      beatNum: (i % 4) + 1,
    }));
  }

  return beats.map((b) => ({ ...b, time: b.time + offsetMs })).filter((b) => b.time >= 0);
}

function drawCanvas(canvas, beats, viewCenter, waveformOverview) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const pxPerMs = W / VIEW_MS;

  ctx.clearRect(0, 0, W, H);

  // ── Background ────────────────────────────────────────────────────────
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, W, H);

  // ── Waveform overview (if available from DB) ──────────────────────────
  if (waveformOverview && waveformOverview.byteLength > 0) {
    // waveform_overview is a flat Uint8Array of amplitude values (one per column)
    const data = new Uint8Array(waveformOverview);
    const totalMs = (data.length / W) * VIEW_MS;
    ctx.fillStyle = '#1a4a6a';
    for (let px = 0; px < W; px++) {
      const msAtPx = viewCenter - VIEW_MS / 2 + (px / W) * VIEW_MS;
      const sampleIdx = Math.floor((msAtPx / totalMs) * data.length);
      if (sampleIdx < 0 || sampleIdx >= data.length) continue;
      const amp = data[sampleIdx] / 255;
      const barH = Math.max(1, amp * H * 0.7);
      ctx.fillRect(px, H - barH, 1, barH);
    }
  } else {
    // Subtle gradient fill as placeholder
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#1a1a2e');
    grad.addColorStop(1, '#111');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  // ── Time ruler at top ─────────────────────────────────────────────────
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  const secStart = Math.floor((viewCenter - VIEW_MS / 2) / 1000);
  const secEnd = Math.ceil((viewCenter + VIEW_MS / 2) / 1000);
  ctx.fillStyle = '#555';
  ctx.font = '10px monospace';
  for (let s = secStart; s <= secEnd; s++) {
    const x = W / 2 + (s * 1000 - viewCenter) * pxPerMs;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 6);
    ctx.stroke();
    ctx.fillText(`${s}s`, x + 2, 14);
  }

  // ── Beat markers ──────────────────────────────────────────────────────
  let measureNum = 0;
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    const x = W / 2 + (b.time - viewCenter) * pxPerMs;
    if (x < -4 || x > W + 4) continue;

    if (b.beatNum === 1) measureNum = Math.floor(i / 4) + 1;

    const isBeat1 = b.beatNum === 1;
    const lineH = isBeat1 ? H * 0.75 : H * 0.35;
    ctx.strokeStyle = isBeat1 ? 'rgba(255,255,255,0.9)' : 'rgba(150,150,150,0.55)';
    ctx.lineWidth = isBeat1 ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, H - lineH);
    ctx.lineTo(x, H);
    ctx.stroke();

    if (isBeat1) {
      ctx.fillStyle = 'rgba(200,200,200,0.7)';
      ctx.font = '10px monospace';
      ctx.fillText(measureNum, x + 3, H - lineH - 3);
    }
  }

  // ── Center cursor (playhead / reference line) ─────────────────────────
  ctx.strokeStyle = '#f7c07e';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.stroke();
  ctx.setLineDash([]);
}

export default function BeatGridEditor({ track, onClose, onApply }) {
  const effectiveBpm = track.bpm_override ?? track.bpm ?? 0;

  const [offset, setOffset] = useState(track.beatgrid_offset ?? 0);
  const [bpmInput, setBpmInput] = useState(
    effectiveBpm > 0 ? String(Math.round(effectiveBpm * 10) / 10) : ''
  );
  const [viewCenter, setViewCenter] = useState(4000); // ms — start at 4s into track

  const canvasRef = useRef(null);
  const dragRef = useRef(null); // { startX, startCenter }
  const rafRef = useRef(null);

  // Waveform overview blob (from feat/190 if available)
  const waveformOverview = track.waveform_overview ?? null;

  const beats = computeBeats(track.beatgrid, effectiveBpm, offset);

  // ── Canvas draw (RAF-throttled) ─────────────────────────────────────────
  const scheduleDraw = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      drawCanvas(canvas, beats, viewCenter, waveformOverview);
    });
  }, [beats, viewCenter, waveformOverview]);

  useEffect(() => {
    scheduleDraw();
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [scheduleDraw]);

  // ── Resize observer so canvas DPR stays correct ─────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      canvas.width = canvas.offsetWidth * window.devicePixelRatio;
      canvas.height = canvas.offsetHeight * window.devicePixelRatio;
      scheduleDraw();
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [scheduleDraw]);

  // ── Drag-to-scroll ──────────────────────────────────────────────────────
  const onMouseDown = (e) => {
    dragRef.current = { startX: e.clientX, startCenter: viewCenter };
  };

  const onMouseMove = useCallback(
    (e) => {
      if (!dragRef.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const pxPerMs = canvas.offsetWidth / VIEW_MS;
      const deltaPx = dragRef.current.startX - e.clientX;
      const deltaMs = deltaPx / pxPerMs;
      const maxCenter = (track.duration ?? 600) * 1000;
      setViewCenter(
        Math.max(VIEW_MS / 2, Math.min(maxCenter, dragRef.current.startCenter + deltaMs))
      );
    },
    [track.duration]
  );

  const onMouseUp = () => {
    dragRef.current = null;
  };

  // ── Wheel-to-scroll ──────────────────────────────────────────────────────
  const onWheel = useCallback(
    (e) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const pxPerMs = canvas.offsetWidth / VIEW_MS;
      const deltaMs = e.deltaX / pxPerMs || e.deltaY / pxPerMs;
      const maxCenter = (track.duration ?? 600) * 1000;
      setViewCenter((prev) => Math.max(VIEW_MS / 2, Math.min(maxCenter, prev + deltaMs)));
    },
    [track.duration]
  );

  // ── Nudge ────────────────────────────────────────────────────────────────
  const nudge = (deltaMs) => setOffset((prev) => prev + deltaMs);
  const resetOffset = () => setOffset(0);

  // ── Apply ────────────────────────────────────────────────────────────────
  const handleApply = () => {
    const parsed = parseFloat(bpmInput);
    const bpmOverride = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 10) / 10 : null;
    onApply(track.id, { beatgrid_offset: offset, bpm_override: bpmOverride });
    onClose();
  };

  // ── Keyboard ────────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') nudge(e.shiftKey ? -10 : -1);
      if (e.key === 'ArrowRight') nudge(e.shiftKey ? 10 : 1);
      if (e.key === 'Enter') handleApply();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [offset, bpmInput]); // eslint-disable-line react-hooks/exhaustive-deps

  const offsetLabel = offset === 0 ? '0 ms' : `${offset > 0 ? '+' : ''}${offset} ms`;

  return (
    <div
      className="bge-overlay"
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      <div className="bge-modal">
        {/* Header */}
        <div className="bge-header">
          <span className="bge-title">
            🥁 Beat Grid Editor
            <span className="bge-track-name">
              {track.title}
              {track.artist ? ` — ${track.artist}` : ''}
            </span>
          </span>
          <button className="bge-close" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>

        {/* Canvas */}
        <div className="bge-canvas-wrap" onWheel={onWheel}>
          <canvas
            ref={canvasRef}
            className="bge-canvas"
            onMouseDown={onMouseDown}
            title="Drag or scroll to navigate · ← / → to nudge grid"
          />
          <div className="bge-canvas-hint">
            drag or scroll to navigate · ← → nudge · Shift+← → ±10 ms
          </div>
        </div>

        {/* Controls */}
        <div className="bge-controls">
          <div className="bge-row">
            <span className="bge-label">Grid offset</span>
            <div className="bge-nudge-group">
              <button className="bge-nudge-btn" onClick={() => nudge(-10)}>
                −10
              </button>
              <button className="bge-nudge-btn" onClick={() => nudge(-5)}>
                −5
              </button>
              <button className="bge-nudge-btn" onClick={() => nudge(-1)}>
                −1
              </button>
              <span className="bge-offset-val">{offsetLabel}</span>
              <button className="bge-nudge-btn" onClick={() => nudge(1)}>
                +1
              </button>
              <button className="bge-nudge-btn" onClick={() => nudge(5)}>
                +5
              </button>
              <button className="bge-nudge-btn" onClick={() => nudge(10)}>
                +10
              </button>
              {offset !== 0 && (
                <button
                  className="bge-nudge-btn bge-nudge-reset"
                  onClick={resetOffset}
                  title="Reset offset to 0"
                >
                  ↺
                </button>
              )}
            </div>
          </div>

          <div className="bge-row">
            <span className="bge-label">BPM</span>
            <div className="bge-bpm-group">
              <input
                className="bge-bpm-input"
                type="number"
                min="20"
                max="400"
                step="0.1"
                value={bpmInput}
                onChange={(e) => setBpmInput(e.target.value)}
                placeholder={
                  effectiveBpm > 0 ? String(Math.round(effectiveBpm * 10) / 10) : 'e.g. 128'
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleApply();
                }}
              />
              <span className="bge-bpm-hint">
                {track.bpm_override != null ? `override active` : `analyzer: ${track.bpm ?? '—'}`}
              </span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="bge-footer">
          <button className="bge-btn bge-btn--cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="bge-btn bge-btn--apply" onClick={handleApply}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
