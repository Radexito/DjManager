import { useState, useEffect, useRef } from 'react';
import { usePlayer } from './PlayerContext.jsx';
import { artworkUrl } from './artworkUrl.js';
import './PlayerBar.css';
import './PlayerBarCues.css';

function formatTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  return `${m}:${sec}`;
}

/**
 * Full-text row that shows EVERYTHING: when the text fits, it sits still;
 * when it overflows, it auto-scrolls (marquee) instead of ellipsizing.
 * Pauses on hover. Short names (e.g. "Armin van Buuren") never scroll —
 * only genuinely overflowing text does.
 */
function ScrollText({ className = '', children, ...rest }) {
  const rootRef = useRef(null);
  const [over, setOver] = useState(false);
  const [dur, setDur] = useState(12);

  const measure = () => {
    const el = rootRef.current;
    if (!el) return;
    const sw = el.scrollWidth;
    const cw = el.clientWidth;
    const o = sw > cw + 2; // +2: don't scroll for a sub-pixel overflow
    setOver((prev) => (prev === o ? prev : o));
    if (o) {
      // Constant-ish speed (~55px/s), bounded so very long titles don't crawl
      setDur(Math.min(45, Math.max(7, Math.round(sw / 55))));
    }
  };

  useEffect(() => {
    measure();
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-measure after every render (children/track changes) — cheap no-op when
  // nothing changed thanks to the setOver guard.
  useEffect(() => {
    const id = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(measure) : null;
    return () => id !== null && cancelAnimationFrame(id);
  });

  return (
    <div
      ref={rootRef}
      className={`player-scroll ${over ? 'player-scroll--on' : ''} ${className}`}
      {...rest}
    >
      {over ? (
        <div className="player-scroll-track" style={{ animationDuration: `${dur}s` }}>
          <span className="player-scroll-text">{children}</span>
          <span className="player-scroll-text" aria-hidden="true">
            {children}
          </span>
        </div>
      ) : (
        <span className="player-scroll-text">{children}</span>
      )}
    </div>
  );
}

export default function PlayerBar({ onNavigateToPlaylist, onArtistSearch, onOpenTrackDetails }) {
  const {
    mediaPort,
    currentTrack,
    currentPlaylistId,
    currentPlaylistName,
    isPlaying,
    shuffle,
    repeat,
    currentTime,
    duration,
    outputDeviceId,
    volume,
    history,
    playbackError,
    clearPlaybackError,
    togglePlay,
    next,
    prev,
    seek,
    toggleShuffle,
    cycleRepeat,
    setDevice,
    setVolume,
    play,
    audioRef,
  } = usePlayer();

  const [devices, setDevices] = useState([]);
  const [showDevices, setShowDevices] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [cuePoints, setCuePoints] = useState([]);
  const [showHotCues, setShowHotCues] = useState(
    () => localStorage.getItem('cue-show-hot') !== 'false'
  );
  const [showMemCues, setShowMemCues] = useState(
    () => localStorage.getItem('cue-show-mem') !== 'false'
  );
  const seekbarRef = useRef(); // uncontrolled range input
  const seekingRef = useRef(false); // true while user drags
  const deviceWrapRef = useRef();
  const historyWrapRef = useRef();
  const waveCanvasRef = useRef();
  const waveDataRef = useRef(null); // Uint8Array | null
  const seekbarBgRef = useRef(); // thin bg line behind waveform
  const colorModeRef = useRef('rgb');
  const introFracRef = useRef(0); // 0-1 fraction where intro ends
  const outroFracRef = useRef(1); // 0-1 fraction where outro starts

  // ── Resizable player-bar height ────────────────────────────────────────────
  const PB_H_KEY = 'djmanager.playerBarHeight';
  const PB_H_DEFAULT = 124; // taller default
  const PB_H_MIN = 84;
  const PB_H_MAX = 260;
  const clampPbH = (v) => Math.min(PB_H_MAX, Math.max(PB_H_MIN, Math.round(v)));
  const [barH, setBarH] = useState(() => {
    try {
      const v = parseInt(localStorage.getItem(PB_H_KEY), 10);
      return Number.isFinite(v) ? clampPbH(v) : PB_H_DEFAULT;
    } catch {
      return PB_H_DEFAULT;
    }
  });
  const resizeDragRef = useRef(null); // { startY, startH }
  const startBarResize = (e) => {
    if (e.button !== 0) return;
    resizeDragRef.current = { startY: e.clientY, startH: barH };
    const move = (ev) => {
      const d = resizeDragRef.current;
      if (!d) return;
      setBarH(clampPbH(d.startH + (d.startY - ev.clientY)));
    };
    const up = () => {
      resizeDragRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'ns-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  // Persist the height and keep the live value in a ref for the drag closure
  const barHRef = useRef(barH);
  useEffect(() => {
    barHRef.current = barH;
    try {
      localStorage.setItem(PB_H_KEY, String(barH));
    } catch {
      /* ignore */
    }
  }, [barH]);

  // ── Resizable horizontal zones ─────────────────────────────────────────────
  // zones[0]=transport cluster (null=auto), zones[1]=album-art (null=auto square,
  // 0=folded), zones[2]=title/artist text, zones[3]=right cluster.
  // The waveform area flexes to absorb the rest.
  const PZ_KEY = 'djmanager.playerBarZones.v5';
  const PZ_LIMITS = [
    { min: 0, max: 344 },
    { min: 0, max: 500 },
    { min: 180, max: 1000 },
    { min: 0, max: 700 },
  ];
  const clampPz = (v, i, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    const { min, max } = PZ_LIMITS[i];
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const [zones, setZones] = useState(() => {
    // null = natural (max-content) width; a number = fixed user-set width.
    // Transport starts PINNED at 90px → the compact 2×3 (portrait) layout;
    // widening past the saturation width flips it to 3×2.
    const d = [90, null, 380, null];
    try {
      const raw = JSON.parse(localStorage.getItem(PZ_KEY));
      if (raw && Array.isArray(raw)) {
        return raw.map((v, i) => (typeof v === 'number' ? clampPz(v, i, null) : null));
      }
    } catch {
      /* ignore */
    }
    return d;
  });
  useEffect(() => {
    try {
      localStorage.setItem(PZ_KEY, JSON.stringify(zones));
    } catch {
      /* ignore */
    }
  }, [zones]);

  // ── Volume: click toggles mute, hover reveals a vertical slider ───────────
  const [volPop, setVolPop] = useState(false);
  const lastVolumeRef = useRef(1);
  const handleVolumeClick = () => {
    if (volume > 0) {
      lastVolumeRef.current = volume;
      setVolume(0);
    } else {
      setVolume(lastVolumeRef.current > 0 ? lastVolumeRef.current : 0.8);
    }
  };
  const applyVolPointer = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.height <= 0) return;
    const frac = 1 - (e.clientY - rect.top) / rect.height;
    setVolume(Math.min(1, Math.max(0, frac)));
  };

  const zoneRefs = useRef([]);
  const startZoneSplit = (idx, e) => {
    if (e.button !== 0) return;
    const el = zoneRefs.current[idx];
    const startW = el ? el.offsetWidth : (zones[idx] ?? 200);
    const startX = e.clientX;
    const { min } = PZ_LIMITS[idx];
    // Album-art zone maxes out at its own square (100% of the thumbnail);
    // the square tracks the current bar height.
    const artSquare = Math.min(barHRef.current * 0.56, 140);
    const move = (ev) => {
      const target = startW + (ev.clientX - startX);
      let cap = PZ_LIMITS[idx].max;
      if (idx === 1) {
        cap = Math.max(1, Math.round(artSquare));
      } else if (idx === 0) {
        // Transport zone: while the layout is still portrait (below the
        // saturation width) growth is free; once it flips to landscape, stop
        // exactly when the 3×2 icons reach 100% of their height-capped
        // natural width — stretching further would only add empty margins.
        const bar = barHRef.current;
        const sat = 24 + 2.7 * ((bar - 24) / 3.85);
        if (target >= sat) {
          cap = Math.round(36 + 4.1 * ((bar - 16) / 2.5));
        }
      }
      const nw = Math.min(cap, Math.max(min, target));
      setZones((prev) => {
        const next = [...prev];
        next[idx] = Math.round(nw);
        return next;
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  useEffect(() => {
    async function loadDevices() {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === 'audiooutput'));
    }
    loadDevices();
  }, []);

  // Auto-dismiss the playback-error toast
  useEffect(() => {
    if (!playbackError) return;
    const timer = setTimeout(() => clearPlaybackError(), 4500);
    return () => clearTimeout(timer);
  }, [playbackError, clearPlaybackError]);

  // Load cue points whenever the playing track changes
  useEffect(() => {
    const id = currentTrack?.id;
    let alive = true;
    Promise.resolve(id ? window.api.getCuePoints(id) : [])
      .then((pts) => {
        if (alive) setCuePoints(pts);
      })
      .catch(() => {
        if (alive) setCuePoints([]);
      });
    return () => {
      alive = false;
    };
  }, [currentTrack?.id]);

  // Re-sync cue markers once audio duration is known — fixes the race where the
  // SQLite response arrives before durationchange fires, so markers were hidden
  // (duration > 0 guard) even though cue points were already in state.
  const hasDuration = duration > 0;
  useEffect(() => {
    const id = currentTrack?.id;
    if (!id || !hasDuration) return;
    let alive = true;
    window.api
      .getCuePoints(id)
      .then((pts) => {
        if (alive) setCuePoints(pts);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [currentTrack?.id, hasDuration]);

  // Refresh cue markers when cue points are added/edited/deleted elsewhere
  useEffect(() => {
    const id = currentTrack?.id;
    if (!id) return;
    const handler = (e) => {
      if (e.detail?.trackId === id) {
        window.api
          .getCuePoints(id)
          .then(setCuePoints)
          .catch(() => {});
      }
    };
    window.addEventListener('cue-points-updated', handler);
    return () => window.removeEventListener('cue-points-updated', handler);
  }, [currentTrack?.id]);

  // Sync visibility toggles with CuePointsEditor
  useEffect(() => {
    const handler = ({ detail: { key, val } }) => {
      if (key === 'cue-show-hot') setShowHotCues(val);
      if (key === 'cue-show-mem') setShowMemCues(val);
    };
    window.addEventListener('cue-visibility-changed', handler);
    return () => window.removeEventListener('cue-visibility-changed', handler);
  }, []);

  // Keep seekbar max in sync with duration
  useEffect(() => {
    if (seekbarRef.current) seekbarRef.current.max = duration || 0;
  }, [duration]);

  // ── Waveform canvas helpers (declared before the effects that call them) ─────

  function drawWaveform(canvas, data, mode) {
    const W = canvas.width;
    const H = canvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    if (!data || data.length < 4) return;

    const numCols = data.length / 4;
    const colW = W / numCols;
    const midY = H / 2;

    for (let i = 0; i < numCols; i++) {
      const rms = data[i * 4] / 255;
      const bass = data[i * 4 + 1];
      const mid = data[i * 4 + 2];
      const treble = data[i * 4 + 3];

      const halfH = Math.max(1, Math.round(rms * midY * 1.8));
      const x = Math.floor(i * colW);
      const w = Math.max(1, Math.ceil(colW));

      // EMA-derived band values have bass >> mid >> treble by ~10-30x, so naive
      // normalisation always picks bass as dominant and renders everything blue.
      // Gamma-compress each channel independently before normalisation so weaker
      // channels (treble, mid) become visually comparable to bass.
      const bassC = Math.pow(bass / 255, 0.55);
      const midC = Math.pow(mid / 255, 0.3);
      const trebleC = Math.pow(treble / 255, 0.2);

      const dominant = Math.max(bassC, midC, trebleC) || 0.001;
      const brightness = Math.min(1, rms * 2.5);

      const nb = (bassC / dominant) * brightness;
      const ng = (midC / dominant) * brightness;
      const nr = (trebleC / dominant) * brightness;

      let r, g, b;
      if (mode === 'classic') {
        const white = Math.min(1, nr * 2);
        r = Math.round(white * 220);
        g = Math.round(white * 220);
        b = Math.round(55 + nb * 180 + white * 55);
      } else if (mode === '3band') {
        // Blue=bass, Orange=mid, White=treble
        r = Math.min(255, Math.round(nb * 30 + ng * 255 + nr * 255));
        g = Math.min(255, Math.round(nb * 30 + ng * 140 + nr * 255));
        b = Math.min(255, Math.round(nb * 255 + ng * 0 + nr * 255));
      } else {
        // RGB: treble→red, mid→green, bass→blue
        r = Math.round(nr * 255);
        g = Math.round(ng * 255);
        b = Math.round(nb * 255);
      }

      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, midY - halfH, w, halfH * 2);
    }

    // ── Intro / outro amber overlay drawn on the canvas ──────────────────────
    const iF = introFracRef.current;
    const oF = outroFracRef.current;
    if (iF > 0.001) {
      ctx.fillStyle = 'rgba(90, 56, 0, 0.52)';
      ctx.fillRect(0, 0, iF * W, H);
    }
    if (oF < 0.999) {
      ctx.fillStyle = 'rgba(90, 56, 0, 0.52)';
      ctx.fillRect(oF * W, 0, (1 - oF) * W, H);
    }
  }

  function paintWaveform() {
    const canvas = waveCanvasRef.current;
    if (!canvas || !waveDataRef.current) return;
    // rAF ensures the canvas has been laid out and offsetWidth > 0
    requestAnimationFrame(() => {
      canvas.width = canvas.offsetWidth || canvas.clientWidth || 400;
      canvas.height = canvas.offsetHeight || canvas.clientHeight || 40;
      drawWaveform(canvas, waveDataRef.current, colorModeRef.current);
    });
  }

  // Recompute intro/outro fracs and redraw waveform when track or duration changes
  useEffect(() => {
    if (!duration) return;
    const intro = currentTrack?.intro_secs || 0;
    const outro = currentTrack?.outro_secs || 0;
    introFracRef.current = intro > 0 ? Math.min(intro / duration, 1) : 0;
    outroFracRef.current = outro > 0 ? Math.min(outro / duration, 1) : 1;
    paintWaveform(); // eslint-disable-line react-hooks/exhaustive-deps
  }, [duration, currentTrack]); // eslint-disable-line react-hooks/exhaustive-deps

  // Advance seekbar at ~60fps via rAF so the position tracks audio smoothly
  // instead of jumping every ~250ms from timeupdate events.
  useEffect(() => {
    if (!isPlaying) return;
    let rafId;
    const tick = () => {
      if (!seekingRef.current && seekbarRef.current && audioRef?.current) {
        seekbarRef.current.value = audioRef.current.currentTime;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, audioRef]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync seekbar position on pause / track change (rAF loop stopped)
  useEffect(() => {
    if (!seekingRef.current && seekbarRef.current) {
      seekbarRef.current.value = currentTime;
    }
  }, [currentTime]);

  // Close device dropdown on outside click
  useEffect(() => {
    if (!showDevices) return;
    const handler = (e) => {
      if (deviceWrapRef.current && !deviceWrapRef.current.contains(e.target)) setShowDevices(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showDevices]);

  // Close history dropdown on outside click
  useEffect(() => {
    if (!showHistory) return;
    const handler = (e) => {
      if (historyWrapRef.current && !historyWrapRef.current.contains(e.target))
        setShowHistory(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showHistory]);

  // ── Waveform color mode — load once, sync live from Settings ────────────────
  const [colorMode, setColorMode] = useState('rgb');

  useEffect(() => {
    window.api.getSetting('waveform_color_mode', 'rgb').then((m) => {
      colorModeRef.current = m;
      setColorMode(m);
    });
  }, []);

  useEffect(() => {
    colorModeRef.current = colorMode;
  }, [colorMode]);

  useEffect(() => {
    const handler = (e) => setColorMode(e.detail);
    window.addEventListener('waveform-color-mode-changed', handler);
    return () => window.removeEventListener('waveform-color-mode-changed', handler);
  }, []);

  // Redraw when color mode changes (data already loaded)
  useEffect(() => {
    paintWaveform(); // eslint-disable-line react-hooks/exhaustive-deps
  }, [colorMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Repaint the waveform at the new canvas size when the bar is resized
  useEffect(() => {
    paintWaveform(); // eslint-disable-line react-hooks/exhaustive-deps
  }, [barH]);

  // Fetch waveform data when track changes, then draw
  useEffect(() => {
    const canvas = waveCanvasRef.current;
    if (!currentTrack) {
      waveDataRef.current = null;
      if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    window.api.getTrackWaveform(currentTrack.id).then((raw) => {
      waveDataRef.current = raw ? new Uint8Array(raw) : null;
      if (!waveDataRef.current && canvas) {
        canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      } else {
        paintWaveform();
      }
    });
  }, [currentTrack?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload waveform once the background generator finishes for the current track
  useEffect(() => {
    const unsub = window.api.onWaveformReady(({ trackId }) => {
      if (!currentTrack || trackId !== currentTrack.id) return;
      window.api.getTrackWaveform(trackId).then((raw) => {
        if (!raw) return;
        waveDataRef.current = new Uint8Array(raw);
        paintWaveform();
      });
    });
    return unsub;
  }, [currentTrack?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const artSrc = artworkUrl(
    currentTrack?.has_artwork ? currentTrack?.artwork_path : null,
    mediaPort
  );

  // Transport grid adapts to its own aspect. Switch point: when the 2×3
  // (portrait) layout has already filled the full bar height — its icons hit
  // the row-count cap at satWidth; stretching wider than that adds nothing but
  // margins, so flip to the 3×2 (landscape) layout from there on.
  const portraitSatWidth = Math.round(24 + 2.7 * ((barH - 24) / 3.85));
  const landLayout = zones[0] == null ? true : zones[0] >= portraitSatWidth;

  return (
    <div className="player-bar" style={{ height: barH, '--pb-h': `${barH}px` }}>
      <div className="player-resize-handle" onPointerDown={startBarResize} title="Drag to resize" />
      {playbackError && (
        <div
          className="player-bar-toast player-bar-toast--warn"
          onClick={clearPlaybackError}
          title="Dismiss"
        >
          ⚠ {playbackError}
        </div>
      )}
      {/* Horizontal zones, user-resizable via the splitters between them:
          transport | art | track info | waveform | right controls */}
      {/* Transport layout follows the zone's aspect: wider than tall → 3×2
          (shuffle/play/repeat over prev/next), taller than wide → 2×3. */}
      <div
        className={`pz-controls${zones[0] ? ' pz-controls--fixed' : ''} ${landLayout ? 'pz-layout--land' : 'pz-layout--port'}`}
        style={zones[0] ? { width: zones[0] } : undefined}
        ref={(el) => {
          zoneRefs.current[0] = el;
        }}
      >
        <div className="player-controls-grid" aria-label="Playback controls">
          <button
            type="button"
            className={`player-btn player-btn--shuffle player-btn--toggle${shuffle ? ' player-btn--active' : ''}`}
            onClick={toggleShuffle}
            title="Shuffle"
          >
            ⇄
          </button>
          <button
            type="button"
            className="player-btn player-btn--play"
            onClick={togglePlay}
            title="Play / Pause"
          >
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button
            type="button"
            className={`player-btn player-btn--repeat player-btn--toggle${repeat !== 'none' ? ' player-btn--active' : ''}`}
            onClick={cycleRepeat}
            title={`Repeat: ${repeat}`}
          >
            <span className="rep-glyph">↺</span>
            {repeat === 'one' && (
              <sup className="rep-badge" aria-hidden="true">
                1
              </sup>
            )}
          </button>
          <button type="button" className="player-btn player-btn--next" onClick={next} title="Next">
            ⏭
          </button>
          <button
            type="button"
            className="player-btn player-btn--prev"
            onClick={prev}
            title="Previous"
          >
            ⏮
          </button>
          {/* Playback history — lives in the transport's last slot */}
          <div className="player-history-wrap" ref={historyWrapRef}>
            <button
              className="player-btn player-btn--history"
              onClick={() => setShowHistory((s) => !s)}
              disabled={history.length === 0}
              title="Playback history"
            >
              <svg
                className="player-ico"
                viewBox="0 0 24 24"
                width="1em"
                height="1em"
                aria-hidden="true"
              >
                <circle cx="12" cy="13" r="8.5" fill="none" stroke="currentColor" strokeWidth="2" />
                <path
                  d="M12 9v4.2l2.8 2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            {showHistory && history.length > 0 && (
              <div className="player-history-menu">
                <div className="player-history-header">Recent tracks</div>
                {history.map((t, i) => (
                  <div
                    key={`${t.id}-${i}`}
                    className="player-history-item"
                    title={`${t.title} — ${t.artist || 'Unknown'}`}
                    onClick={() => {
                      play(t, [t], 0, null, null);
                      setShowHistory(false);
                    }}
                  >
                    <span className="player-history-title">{t.title}</span>
                    <span className="player-history-artist">{t.artist || 'Unknown'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <div
        className="player-splitter"
        onPointerDown={(e) => startZoneSplit(0, e)}
        title="Drag to resize: transport buttons / album art"
      />
      <div
        className="pz-art"
        style={zones[1] !== null ? { width: zones[1] } : undefined}
        ref={(el) => {
          zoneRefs.current[1] = el;
        }}
      >
        <button
          type="button"
          className={`player-art-btn${currentTrack ? ' player-art-btn--enabled' : ''}`}
          onClick={() => currentTrack && onOpenTrackDetails?.(currentTrack.id, currentPlaylistId)}
          title={currentTrack ? 'Open track details' : undefined}
          disabled={!currentTrack}
        >
          {artSrc ? (
            <img className="player-art" src={artSrc} alt="Album art" draggable={false} />
          ) : (
            <div className="player-art player-art--placeholder">♪</div>
          )}
        </button>
      </div>
      <div
        className="player-splitter"
        onPointerDown={(e) => startZoneSplit(1, e)}
        title="Drag to resize: album art / track info"
      />
      <div
        className="pz-info"
        style={{ width: zones[2] }}
        ref={(el) => {
          zoneRefs.current[2] = el;
        }}
      >
        <div className="player-track-info">
          {currentTrack ? (
            <>
              {/* Clicking the title navigates to the current playlist — the
                  dedicated ☰ button was removed in favour of this. */}
              <ScrollText
                className={`player-title${currentPlaylistId ? ' player-title--clickable' : ''}`}
                title={
                  currentPlaylistId
                    ? `Go to playlist: ${currentPlaylistName || currentPlaylistId}`
                    : currentTrack.title
                }
                onClick={() => currentPlaylistId && onNavigateToPlaylist(String(currentPlaylistId))}
              >
                {currentTrack.title}
              </ScrollText>
              <ScrollText
                className={`player-artist${currentTrack.artist ? ' player-artist--clickable' : ''}`}
                title={currentTrack.artist ? `Search: ARTIST is ${currentTrack.artist}` : undefined}
                onClick={() => currentTrack.artist && onArtistSearch?.(currentTrack.artist)}
              >
                {currentTrack.artist || 'Unknown'}
              </ScrollText>
              {currentPlaylistName && (
                <div
                  className="player-from player-from--clickable"
                  title={`Go to playlist: ${currentPlaylistName}`}
                  onClick={() => onNavigateToPlaylist(String(currentPlaylistId))}
                >
                  ▶ {currentPlaylistName}
                </div>
              )}
            </>
          ) : (
            <div className="player-idle">No track playing</div>
          )}
        </div>
      </div>
      <div
        className="player-splitter"
        onPointerDown={(e) => startZoneSplit(2, e)}
        title="Drag to resize: track info / waveform"
      />

      {/* Center: full-width seekbar / waveform */}
      <div className="player-seek">
        <span className="player-time">{formatTime(currentTime)}</span>
        <div className="player-seekbar-wrap">
          <div ref={seekbarBgRef} className="player-seekbar-bg" />
          <canvas ref={waveCanvasRef} className="player-waveform-canvas" />
          <input
            ref={seekbarRef}
            type="range"
            className="player-seekbar"
            min={0}
            max={duration || 0}
            step={0.5}
            defaultValue={0}
            onPointerDown={(e) => {
              console.log(`[seekbar] pointerDown value=${Number(e.target.value).toFixed(3)}`);
              seekingRef.current = true;
            }}
            onPointerUp={(e) => {
              const val = Number(e.target.value);
              console.log(`[seekbar] pointerUp  value=${val.toFixed(3)}`);
              seek(val);
              seekingRef.current = false;
            }}
          />
          {duration > 0 &&
            cuePoints
              .filter((cue) => (cue.hot_cue_index >= 0 ? showHotCues : showMemCues))
              .map((cue) => {
                const pct = Math.min((cue.position_ms / 1000 / duration) * 100, 100);
                return (
                  <button
                    key={cue.id}
                    className="player-cue-marker"
                    style={{ left: `${pct}%`, background: cue.color }}
                    title={
                      cue.label ||
                      (cue.hot_cue_index >= 0
                        ? `Hot cue ${'ABCDEFGHIJKLMNOP'[cue.hot_cue_index]}`
                        : 'Memory cue')
                    }
                    onClick={() => seek(cue.position_ms / 1000)}
                  />
                );
              })}
        </div>
        <span className="player-time">{formatTime(duration)}</span>
      </div>

      {/* Right: volume (hover slider / click mute) + device picker */}
      <div className="player-right">
        {/* Volume control: hover opens a vertical slider, click mutes/unmutes */}
        <div
          className="player-volume-wrap"
          onMouseEnter={() => setVolPop(true)}
          onMouseLeave={() => setVolPop(false)}
        >
          <button
            type="button"
            className="player-btn player-volume-btn"
            onClick={handleVolumeClick}
            title={volume === 0 ? 'Unmute (click)' : 'Mute (click)'}
          >
            {volume === 0 ? '🔇' : volume < 0.4 ? '🔉' : '🔊'}
          </button>
          {volPop && (
            <div className="player-volume-pop">
              <div
                className="vol-vert"
                title={`Volume: ${Math.round(volume * 100)}%`}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                  applyVolPointer(e);
                }}
                onPointerMove={(e) => {
                  if (e.buttons === 1) applyVolPointer(e);
                }}
              >
                <div className="vol-vert-track" />
                <div className="vol-vert-fill" style={{ height: `${Math.round(volume * 100)}%` }} />
                <div
                  className="vol-vert-thumb"
                  style={{ bottom: `calc(${Math.round(volume * 100)}% - 6px)` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Device picker */}
        <div className="player-device-wrap" ref={deviceWrapRef}>
          <button
            className="player-btn"
            onClick={() => setShowDevices((s) => !s)}
            title="Audio output device"
          >
            🎧
          </button>
          {showDevices && (
            <div className="player-device-menu">
              {devices.length === 0 && (
                <div className="player-device-item player-device-item--empty">No devices found</div>
              )}
              {devices.map((d) => (
                <div
                  key={d.deviceId}
                  className={`player-device-item${d.deviceId === outputDeviceId ? ' player-device-item--active' : ''}`}
                  onClick={() => {
                    setDevice(d.deviceId);
                    setShowDevices(false);
                  }}
                >
                  {d.label || `Output device`}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
