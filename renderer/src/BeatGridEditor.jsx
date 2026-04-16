import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { usePlayer } from './PlayerContext.jsx';
import CuePointsEditor from './CuePointsEditor.jsx';
import './BeatGridEditor.css';

const COLS_PER_SEC = 150; // must match waveformGenerator.js
const ZOOM_LEVELS = [1000, 2000, 4000, 8000, 16000, 32000]; // ms visible in detail canvas

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

/**
 * Draw the scrollable detail waveform.
 * viewMs     — milliseconds visible in the canvas (zoom level)
 */
function drawDetail(canvas, detail, viewCenter, beats, cuePoints, viewMs) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const pxPerMs = W / viewMs;
  const midY = H / 2;

  ctx.clearRect(0, 0, W, H);

  // ── Background ─────────────────────────────────────────────────────────────
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, W, H);

  // ── Waveform ───────────────────────────────────────────────────────────────
  if (detail && detail.length >= 3) {
    const numCols = Math.floor(detail.length / 3);
    const totalMs = (numCols / COLS_PER_SEC) * 1000;

    for (let px = 0; px < W; px++) {
      const msAtPx = viewCenter - viewMs / 2 + (px / W) * viewMs;
      if (msAtPx < 0 || msAtPx > totalMs) continue;

      const col = Math.floor((msAtPx / totalMs) * numCols);
      if (col < 0 || col >= numCols) continue;

      const treble = detail[col * 3 + 0] / 255;
      const mid = detail[col * 3 + 1] / 255;
      const bass = detail[col * 3 + 2] / 255;

      const amplitude = Math.max(treble, mid, bass);
      const halfH = Math.max(1, amplitude * midY * 0.85);

      const r = Math.round(treble * 255);
      const g = Math.round(mid * 255);
      const b = Math.round(bass * 180 + 75);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(px, midY - halfH, 1, halfH * 2);
    }
  } else {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#1a1a2e');
    grad.addColorStop(1, '#111');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  // ── Center divider line ────────────────────────────────────────────────────
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(W, midY);
  ctx.stroke();

  // ── Time ruler ─────────────────────────────────────────────────────────────
  ctx.fillStyle = '#555';
  ctx.font = '10px monospace';
  const secStart = Math.floor((viewCenter - viewMs / 2) / 1000);
  const secEnd = Math.ceil((viewCenter + viewMs / 2) / 1000);
  for (let s = secStart; s <= secEnd; s++) {
    const x = W / 2 + (s * 1000 - viewCenter) * pxPerMs;
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 8);
    ctx.stroke();
    ctx.fillText(`${s}s`, x + 2, 16);
  }

  // ── Beat markers ───────────────────────────────────────────────────────────
  let measureNum = 0;
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    const x = W / 2 + (b.time - viewCenter) * pxPerMs;
    if (x < -4 || x > W + 4) continue;

    if (b.beatNum === 1) measureNum = Math.floor(i / 4) + 1;

    const isBeat1 = b.beatNum === 1;
    const lineH = isBeat1 ? H * 0.65 : H * 0.28;
    ctx.strokeStyle = isBeat1 ? 'rgba(255,255,255,0.85)' : 'rgba(160,160,160,0.45)';
    ctx.lineWidth = isBeat1 ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, midY - lineH / 2);
    ctx.lineTo(x, midY + lineH / 2);
    ctx.stroke();

    if (isBeat1) {
      ctx.fillStyle = 'rgba(200,200,200,0.7)';
      ctx.font = '10px monospace';
      ctx.fillText(measureNum, x + 3, midY - lineH / 2 - 3);
    }
  }

  // ── Cue point markers ──────────────────────────────────────────────────────
  if (cuePoints && cuePoints.length > 0) {
    for (const cue of cuePoints) {
      const x = W / 2 + (cue.position_ms - viewCenter) * pxPerMs;
      if (x < -10 || x > W + 10) continue;

      const color = cue.color || '#00b4d8';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();

      const label = cue.hot_cue_index >= 0 ? 'ABCDEFGH'[cue.hot_cue_index] : '●';
      ctx.fillStyle = color;
      ctx.fillRect(x, H - 18, cue.hot_cue_index >= 0 ? 12 : 10, 14);
      ctx.fillStyle = '#000';
      ctx.font = 'bold 9px monospace';
      ctx.fillText(label, x + 2, H - 6);
    }
  }

  // ── Red center playhead (fixed at W/2) ────────────────────────────────────
  ctx.strokeStyle = '#e03030';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.stroke();

  ctx.fillStyle = '#e03030';
  ctx.beginPath();
  ctx.moveTo(W / 2 - 5, 0);
  ctx.lineTo(W / 2 + 5, 0);
  ctx.lineTo(W / 2, 7);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(W / 2 - 5, H);
  ctx.lineTo(W / 2 + 5, H);
  ctx.lineTo(W / 2, H - 7);
  ctx.closePath();
  ctx.fill();
}

function drawOverview(canvas, overview, viewCenter, durationMs, playheadMs, cuePoints, viewMs) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, W, H);

  const numCols = overview ? Math.floor(overview.length / 4) : 0;

  if (numCols > 0) {
    const midY = H / 2;
    for (let px = 0; px < W; px++) {
      const col = Math.floor((px / W) * numCols);
      if (col >= numCols) continue;

      const rms = overview[col * 4 + 0] / 255;
      const bass = overview[col * 4 + 1] / 255;
      const mid = overview[col * 4 + 2] / 255;
      const treble = overview[col * 4 + 3] / 255;

      const amplitude = Math.max(rms, bass, mid, treble);
      const halfH = Math.max(1, amplitude * midY * 0.9);

      const r = Math.round(treble * 220);
      const g = Math.round(mid * 200);
      const b = Math.round(bass * 160 + 60);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(px, midY - halfH, 1, halfH * 2);
    }
  }

  // ── Cue markers ────────────────────────────────────────────────────────────
  if (cuePoints && cuePoints.length > 0 && durationMs > 0) {
    for (const cue of cuePoints) {
      const px = (cue.position_ms / durationMs) * W;
      if (px < 0 || px > W) continue;
      ctx.strokeStyle = cue.color || '#00b4d8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, H);
      ctx.stroke();
    }
  }

  // ── Viewport highlight ────────────────────────────────────────────────────
  if (durationMs > 0) {
    const viewStart = viewCenter - viewMs / 2;
    const viewEnd = viewCenter + viewMs / 2;
    const x1 = Math.max(0, (viewStart / durationMs) * W);
    const x2 = Math.min(W, (viewEnd / durationMs) * W);
    ctx.fillStyle = 'rgba(224,48,48,0.08)';
    ctx.fillRect(x1, 0, x2 - x1, H);
    ctx.strokeStyle = 'rgba(224,48,48,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x1, 0, x2 - x1, H);
  }

  // ── Playhead ──────────────────────────────────────────────────────────────
  if (playheadMs != null && durationMs > 0) {
    const px = (playheadMs / durationMs) * W;
    ctx.strokeStyle = '#e03030';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, H);
    ctx.stroke();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export default function BeatGridEditor({ track, onClose, onApply }) {
  const { currentTrack, isPlaying, currentTime, duration, togglePlay, play, seek, stop } =
    usePlayer();

  const [offset, setOffset] = useState(track.beatgrid_offset ?? 0);
  // bpmInput is the live-preview BPM — drives the beatgrid immediately
  const [bpmInput, setBpmInput] = useState(() => {
    const bpm = track.bpm_override ?? track.bpm ?? 0;
    return bpm > 0 ? String(Math.round(bpm * 10) / 10) : '';
  });
  const [waveformLoading, setWaveformLoading] = useState(true);

  // Zoom level — index into ZOOM_LEVELS
  const [zoomIdx, setZoomIdx] = useState(3); // default: 8000 ms
  const viewMsRef = useRef(ZOOM_LEVELS[3]);

  // ── TAP tempo state ────────────────────────────────────────────────────────
  const [tapBpm, setTapBpm] = useState(null);
  const tapTimesRef = useRef([]);
  const tapResetTimerRef = useRef(null);

  // ── RAF-loop refs ──────────────────────────────────────────────────────────
  const detailCanvasRef = useRef(null);
  const overviewCanvasRef = useRef(null);
  const rafRef = useRef(null);

  const waveformDetailRef = useRef(null);
  const waveformOverviewRef = useRef(null);
  const beatsRef = useRef([]);
  const cuePointsRef = useRef([]);
  const viewCenterRef = useRef(-1000); // 1 s pre-roll so track start sits right of the playhead
  const trackDurationMsRef = useRef(0);
  const isPlayingRef = useRef(false);
  const isThisTrackRef = useRef(false);
  const currentTimeSecRef = useRef(0);
  const lastTimeUpdateRef = useRef(0);
  const userScrollingRef = useRef(false);
  const wheelTimerRef = useRef(null);
  const seekRef = useRef(seek);

  const trackDurationMs = (track.duration ?? duration ?? 0) * 1000;
  const isThisTrack = currentTrack?.id === track.id;

  // Live preview BPM: use whatever is in the input field (so tapping updates grid immediately)
  const previewBpm = (() => {
    const p = parseFloat(bpmInput);
    return Number.isFinite(p) && p > 0 ? p : (track.bpm_override ?? track.bpm ?? 0);
  })();

  const beats = computeBeats(track.beatgrid, previewBpm, offset);

  // Keep refs in sync with latest render values so RAF callbacks always read
  // current state without stale-closure issues. useLayoutEffect runs
  // synchronously after every render (before paint) — equivalent to assigning
  // during render but avoids the react-compiler lint rule.
  useLayoutEffect(() => {
    seekRef.current = seek;
    beatsRef.current = beats;
    viewMsRef.current = ZOOM_LEVELS[zoomIdx];
    trackDurationMsRef.current = trackDurationMs;
    isPlayingRef.current = isPlaying;
    isThisTrackRef.current = isThisTrack;
  });

  useEffect(() => {
    currentTimeSecRef.current = currentTime;
    lastTimeUpdateRef.current = performance.now();
  }, [currentTime]);

  // Reset the wall-clock reference the moment playback starts so the elapsed
  // interpolation doesn't overshoot from a stale timestamp (causes 1-frame glitch).
  useEffect(() => {
    if (isPlaying) lastTimeUpdateRef.current = performance.now();
  }, [isPlaying]);

  // ── Load waveform ─────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    window.api
      .getEditorWaveform(track.id)
      .then((result) => {
        if (!alive || !result) return;
        waveformDetailRef.current = result.detail ? new Uint8Array(result.detail) : null;
        waveformOverviewRef.current = result.overview ? new Uint8Array(result.overview) : null;
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setWaveformLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [track.id]);

  // ── Load cue points ───────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    window.api.getCuePoints(track.id).then((pts) => {
      if (alive) cuePointsRef.current = pts ?? [];
    });
    return () => {
      alive = false;
    };
  }, [track.id]);

  useEffect(() => {
    const unsub = window.api.onCuePointsUpdated(({ trackId }) => {
      if (trackId !== track.id) return;
      window.api.getCuePoints(track.id).then((pts) => {
        cuePointsRef.current = pts ?? [];
      });
    });
    return unsub;
  }, [track.id]);

  // ── RAF loop ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const loop = () => {
      // Only extrapolate forward when actually playing — pausing must freeze the playhead
      const elapsed = isPlayingRef.current
        ? (performance.now() - lastTimeUpdateRef.current) / 1000
        : 0;
      const estTimeSec = currentTimeSecRef.current + elapsed;
      const playheadMs = estTimeSec * 1000;
      const vms = viewMsRef.current;

      // Auto-scroll: keep the playhead centred — no Min clamp so it works from t=0
      if (isThisTrackRef.current && isPlayingRef.current && !userScrollingRef.current) {
        viewCenterRef.current = playheadMs;
      }

      const vc = viewCenterRef.current;
      const dur = trackDurationMsRef.current;
      const ph = isThisTrackRef.current ? playheadMs : null;
      const cues = cuePointsRef.current;

      const dc = detailCanvasRef.current;
      if (dc) drawDetail(dc, waveformDetailRef.current, vc, beatsRef.current, cues, vms);

      const oc = overviewCanvasRef.current;
      if (oc) drawOverview(oc, waveformOverviewRef.current, vc, dur, ph, cues, vms);

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // ── Resize observer ───────────────────────────────────────────────────────
  useEffect(() => {
    const canvases = [detailCanvasRef.current, overviewCanvasRef.current].filter(Boolean);
    if (!canvases.length) return;
    const ro = new ResizeObserver(() => {
      for (const canvas of canvases) {
        canvas.width = canvas.offsetWidth * window.devicePixelRatio;
        canvas.height = canvas.offsetHeight * window.devicePixelRatio;
      }
    });
    for (const canvas of canvases) ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // ── Close — stop playback ─────────────────────────────────────────────────
  const handleClose = useCallback(() => {
    if (isThisTrackRef.current) stop();
    onClose();
  }, [stop, onClose]);

  // ── Zoom controls ─────────────────────────────────────────────────────────
  const zoomIn = () =>
    setZoomIdx((i) => {
      const next = Math.max(0, i - 1);
      viewMsRef.current = ZOOM_LEVELS[next];
      return next;
    });
  const zoomOut = () =>
    setZoomIdx((i) => {
      const next = Math.min(ZOOM_LEVELS.length - 1, i + 1);
      viewMsRef.current = ZOOM_LEVELS[next];
      return next;
    });

  // ── Detail canvas drag — vinyl-style: grab pauses, drag scrubs, release seeks ─
  const dragRef = useRef(null);
  const wasPlayingRef = useRef(false); // remember if track was playing when grabbed

  const onDetailMouseDown = (e) => {
    if (e.target !== detailCanvasRef.current) return;
    userScrollingRef.current = true;
    wasPlayingRef.current = isThisTrackRef.current && isPlayingRef.current;
    dragRef.current = { startX: e.clientX, startCenter: viewCenterRef.current, dragged: false };

    // Pause on grab (vinyl-stop) — no seek, position unchanged
    if (wasPlayingRef.current) togglePlay();
  };

  // Mouse move: update view position visually only — no seek (prevents audio stutter)
  const onMouseMove = useCallback((e) => {
    if (!dragRef.current) return;
    const canvas = detailCanvasRef.current;
    if (!canvas) return;
    const deltaPx = dragRef.current.startX - e.clientX;
    // Only count as a real drag after >4 px to filter out click micro-movement
    if (Math.abs(deltaPx) > 4) dragRef.current.dragged = true;
    if (!dragRef.current.dragged) return;
    const pxPerMs = canvas.offsetWidth / viewMsRef.current;
    const deltaMs = deltaPx / pxPerMs;
    const maxCenter = trackDurationMsRef.current || 600_000;
    viewCenterRef.current = Math.max(0, Math.min(maxCenter, dragRef.current.startCenter + deltaMs));
  }, []);

  // Mouse up: if user dragged, seek to the scrubbed position
  const onMouseUp = () => {
    if (dragRef.current?.dragged && isThisTrackRef.current) {
      const targetSec = viewCenterRef.current / 1000;
      seekRef.current(targetSec);
      currentTimeSecRef.current = targetSec;
      lastTimeUpdateRef.current = performance.now();
    }
    dragRef.current = null;
    wasPlayingRef.current = false;
    userScrollingRef.current = false;
  };

  // ── Wheel to scroll ───────────────────────────────────────────────────────
  const onDetailWheel = useCallback((e) => {
    e.preventDefault();
    userScrollingRef.current = true;
    const canvas = detailCanvasRef.current;
    if (!canvas) return;
    const pxPerMs = canvas.offsetWidth / viewMsRef.current;
    const deltaMs = e.deltaX / pxPerMs || e.deltaY / pxPerMs;
    const maxCenter = trackDurationMsRef.current || 600_000;
    viewCenterRef.current = Math.max(0, Math.min(maxCenter, viewCenterRef.current + deltaMs));
    clearTimeout(wheelTimerRef.current);
    // Short delay so a scroll burst doesn't immediately snap back to playhead
    wheelTimerRef.current = setTimeout(() => {
      userScrollingRef.current = false;
    }, 600);
  }, []);

  // ── Overview click-to-jump ────────────────────────────────────────────────
  const onOverviewClick = useCallback(
    (e) => {
      const canvas = overviewCanvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / rect.width;
      const ms = frac * (trackDurationMsRef.current || 600_000);
      const clamped = Math.max(
        viewMsRef.current / 2,
        Math.min(trackDurationMsRef.current || 600_000, ms)
      );
      viewCenterRef.current = clamped;
      userScrollingRef.current = false;
      if (isThisTrackRef.current) seek(clamped / 1000);
    },
    [seek]
  );

  // ── Play / pause ──────────────────────────────────────────────────────────
  const handlePlayPause = useCallback(() => {
    if (isThisTrack) {
      togglePlay();
    } else {
      play(track, [track], 0, null, null);
      userScrollingRef.current = false;
    }
  }, [isThisTrack, togglePlay, play, track]);

  // ── Nudge ─────────────────────────────────────────────────────────────────
  const nudge = (deltaMs) => setOffset((prev) => prev + deltaMs);
  const resetOffset = () => setOffset(0);

  // ── TAP tempo ─────────────────────────────────────────────────────────────
  const handleTap = useCallback(() => {
    const now = performance.now();
    const times = tapTimesRef.current;
    if (times.length > 0 && now - times[times.length - 1] > 3000) times.length = 0;
    times.push(now);
    if (times.length > 8) times.splice(0, times.length - 8);
    if (times.length >= 2) {
      const intervals = [];
      for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
      const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      setTapBpm(Math.round((60000 / avgMs) * 10) / 10);
    }
    clearTimeout(tapResetTimerRef.current);
    tapResetTimerRef.current = setTimeout(() => {
      tapTimesRef.current = [];
      setTapBpm(null);
    }, 3000);
  }, []);

  const applyTapBpm = useCallback(() => {
    if (tapBpm == null) return;
    setBpmInput(String(tapBpm));
    setTapBpm(null);
    tapTimesRef.current = [];
    clearTimeout(tapResetTimerRef.current);
  }, [tapBpm]);

  // ── Apply ─────────────────────────────────────────────────────────────────
  const handleApply = () => {
    const parsed = parseFloat(bpmInput);
    const bpmOverride = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 10) / 10 : null;
    onApply(track.id, { beatgrid_offset: offset, bpm_override: bpmOverride });
    onClose();
  };

  // ── Keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 'Escape') handleClose();
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        nudge(e.shiftKey ? -10 : -1);
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        nudge(e.shiftKey ? 10 : 1);
      }
      if (e.key === ' ') {
        e.preventDefault();
        handlePlayPause();
      }
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        handleTap();
      }
      if (e.key === '+' || e.key === '=') zoomIn();
      if (e.key === '-') zoomOut();
      if (e.key === 'Enter') handleApply();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [offset, bpmInput, handlePlayPause, handleClose, handleTap]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cue points callback ───────────────────────────────────────────────────
  const handleCuePointsChange = useCallback((pts) => {
    cuePointsRef.current = pts ?? [];
  }, []);

  const offsetLabel = offset === 0 ? '0 ms' : `${offset > 0 ? '+' : ''}${offset} ms`;
  const analyzerBpm = track.bpm_override != null ? null : track.bpm;
  const viewMs = ZOOM_LEVELS[zoomIdx];

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
            🎛 Prepare Track
            <span className="bge-track-name">
              {track.title}
              {track.artist ? ` — ${track.artist}` : ''}
            </span>
          </span>
          <button className="bge-close" onClick={handleClose} title="Close (Esc)">
            ✕
          </button>
        </div>

        {/* Detail waveform */}
        <div className="bge-canvas-wrap" onWheel={onDetailWheel}>
          {waveformLoading && <div className="bge-loading">Loading waveform…</div>}
          <button
            className={`bge-play-overlay${isThisTrack && isPlaying ? ' bge-play-overlay--playing' : ''}`}
            onClick={handlePlayPause}
            title={isThisTrack && isPlaying ? 'Pause (Space)' : 'Play (Space)'}
          >
            {isThisTrack && isPlaying ? '⏸' : '▶'}
          </button>
          {/* Zoom controls */}
          <div className="bge-zoom-controls">
            <button
              className="bge-zoom-btn"
              onClick={zoomOut}
              disabled={zoomIdx === ZOOM_LEVELS.length - 1}
              title="Zoom out (−)"
            >
              −
            </button>
            <span className="bge-zoom-label">
              {viewMs >= 1000 ? `${viewMs / 1000}s` : `${viewMs}ms`}
            </span>
            <button
              className="bge-zoom-btn"
              onClick={zoomIn}
              disabled={zoomIdx === 0}
              title="Zoom in (+)"
            >
              +
            </button>
          </div>
          <canvas
            ref={detailCanvasRef}
            className="bge-canvas"
            onMouseDown={onDetailMouseDown}
            title="Click to seek · Drag to scrub · Scroll to navigate"
          />
          <div className="bge-canvas-hint">
            click / drag to seek · scroll to navigate · ← → nudge grid · +/− zoom
          </div>
        </div>

        {/* Overview */}
        <div className="bge-overview-wrap">
          <canvas
            ref={overviewCanvasRef}
            className="bge-overview-canvas"
            onClick={onOverviewClick}
            title="Click to jump to position"
          />
        </div>

        {/* Controls */}
        <div className="bge-controls">
          {/* Grid offset */}
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

          {/* BPM + TAP inline */}
          <div className="bge-row">
            <span className="bge-label">BPM</span>
            <div className="bge-bpm-row">
              <input
                className="bge-bpm-input"
                type="number"
                min="20"
                max="400"
                step="0.1"
                value={bpmInput}
                onChange={(e) => setBpmInput(e.target.value)}
                placeholder={previewBpm > 0 ? String(Math.round(previewBpm * 10) / 10) : 'e.g. 128'}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleApply();
                }}
              />
              {/* TAP button inline */}
              <button
                className={`bge-tap-btn${tapBpm != null ? ' bge-tap-btn--active' : ''}`}
                onClick={handleTap}
                title="Tap to the beat (T)"
              >
                {tapBpm != null ? `${tapBpm}` : 'TAP'}
              </button>
              {/* Apply tapped BPM — slides in when a tap result is ready */}
              <div
                className={`bge-tap-apply-wrap${tapBpm != null ? ' bge-tap-apply-wrap--visible' : ''}`}
              >
                <button
                  className="bge-tap-apply-btn"
                  onClick={applyTapBpm}
                  title={`Click to use ${tapBpm} BPM`}
                >
                  ✓ Use {tapBpm}
                </button>
              </div>
              {analyzerBpm != null && <span className="bge-bpm-hint">analyzer: {analyzerBpm}</span>}
              {track.bpm_override != null && (
                <span className="bge-bpm-hint bge-bpm-hint--override">override active</span>
              )}
            </div>
          </div>
        </div>

        {/* Cue Points */}
        <div className="bge-cue-section">
          <CuePointsEditor trackId={track.id} onCuePointsChange={handleCuePointsChange} />
        </div>

        {/* Footer */}
        <div className="bge-footer">
          <button className="bge-btn bge-btn--cancel" onClick={handleClose}>
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
