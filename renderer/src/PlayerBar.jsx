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

export default function PlayerBar({ onNavigateToPlaylist, onArtistSearch }) {
  const {
    mediaPort,
    currentTrack,
    currentPlaylistId,
    currentPlaylistName,
    isPlaying,
    currentTime,
    duration,
    shuffle,
    repeat,
    outputDeviceId,
    volume,
    history,
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

  useEffect(() => {
    async function loadDevices() {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === 'audiooutput'));
    }
    loadDevices();
  }, []);

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

  // Fetch waveform data when track changes, then draw
  useEffect(() => {
    const canvas = waveCanvasRef.current;
    if (!currentTrack) {
      waveDataRef.current = null;
      if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    window.api.getTrackWaveform(currentTrack.id).then((raw) => {
      waveDataRef.current = raw ? new Uint8Array(raw) : null;
      if (!waveDataRef.current && canvas) {
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
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

  return (
    <div className="player-bar">
      {/* Left: album art + current track info */}
      <div className="player-left">
        {artSrc ? (
          <img className="player-art" src={artSrc} alt="Album art" draggable={false} />
        ) : (
          <div className="player-art player-art--placeholder">♪</div>
        )}
        <div className="player-track-info">
          {currentTrack ? (
            <>
              <div className="player-title" title={currentTrack.title}>
                {currentTrack.title}
              </div>
              <div
                className={`player-artist${currentTrack.artist ? ' player-artist--clickable' : ''}`}
                title={currentTrack.artist ? `Search: ARTIST is ${currentTrack.artist}` : undefined}
                onClick={() => currentTrack.artist && onArtistSearch?.(currentTrack.artist)}
              >
                {currentTrack.artist || 'Unknown'}
              </div>
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

      {/* Center: transport controls + seekbar */}
      <div className="player-center">
        <div className="player-controls">
          <button
            className={`player-btn player-btn--toggle${shuffle ? ' player-btn--active' : ''}`}
            onClick={toggleShuffle}
            title="Shuffle"
          >
            ⇄
          </button>
          <button className="player-btn" onClick={prev} title="Previous">
            ⏮
          </button>
          <button className="player-btn player-btn--play" onClick={togglePlay} title="Play / Pause">
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button className="player-btn" onClick={next} title="Next">
            ⏭
          </button>
          <button
            className={`player-btn player-btn--toggle${repeat !== 'none' ? ' player-btn--active' : ''}`}
            onClick={cycleRepeat}
            title={`Repeat: ${repeat}`}
          >
            {repeat === 'one' ? '↺¹' : '↺'}
          </button>
        </div>

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
                .filter(
                  (cue) => cue.enabled !== 0 && (cue.hot_cue_index >= 0 ? showHotCues : showMemCues)
                )
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
                          ? `Hot cue ${'ABCDEFGH'[cue.hot_cue_index]}`
                          : 'Memory cue')
                      }
                      onClick={() => seek(cue.position_ms / 1000)}
                    />
                  );
                })}
          </div>
          <span className="player-time">{formatTime(duration)}</span>
        </div>
      </div>

      {/* Right: volume + device picker + history + navigate to playlist */}
      <div className="player-right">
        {/* Volume control */}
        <div className="player-volume-wrap">
          <span className="player-volume-icon" title="Volume">
            {volume === 0 ? '🔇' : volume < 0.4 ? '🔉' : '🔊'}
          </span>
          <input
            type="range"
            className="player-volume-slider"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            title={`Volume: ${Math.round(volume * 100)}%`}
          />
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

        {/* Playback history */}
        <div className="player-history-wrap" ref={historyWrapRef}>
          <button
            className={`player-btn${showHistory ? ' player-btn--active' : ''}`}
            onClick={() => setShowHistory((s) => !s)}
            title="Playback history"
            disabled={history.length === 0}
          >
            🕐
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

        {currentPlaylistId && (
          <button
            className="player-btn"
            onClick={() => onNavigateToPlaylist(String(currentPlaylistId))}
            title="Go to current playlist"
          >
            ☰
          </button>
        )}
      </div>
    </div>
  );
}
