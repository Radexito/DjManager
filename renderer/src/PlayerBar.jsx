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
  } = usePlayer();

  const [devices, setDevices] = useState([]);
  const [showDevices, setShowDevices] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [cuePoints, setCuePoints] = useState([]);
  const seekbarRef = useRef(); // uncontrolled range input
  const seekingRef = useRef(false); // true while user drags
  const deviceWrapRef = useRef();
  const historyWrapRef = useRef();

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
    Promise.resolve(id ? window.api.getCuePoints(id) : [])
      .then(setCuePoints)
      .catch(() => setCuePoints([]));
  }, [currentTrack?.id]);

  // Keep seekbar max in sync with duration
  useEffect(() => {
    if (seekbarRef.current) seekbarRef.current.max = duration || 0;
  }, [duration]);

  // Paint intro/outro zones on the seekbar track as a CSS gradient
  useEffect(() => {
    if (!seekbarRef.current || !duration) return;
    const intro = currentTrack?.intro_secs || 0;
    const outro = currentTrack?.outro_secs || 0;
    const introFrac = Math.min(intro / duration, 1) * 100;
    const outroFrac = Math.min(outro / duration, 1) * 100;

    // No visible zones: intro at very start, outro at very end
    if (introFrac <= 0 && outroFrac >= 100) {
      seekbarRef.current.style.background = '#333';
      return;
    }
    // Amber zones for cut-off intro/outro, neutral middle for the mix window
    seekbarRef.current.style.background =
      `linear-gradient(to right, ` +
      `#5a3800 0%, #5a3800 ${introFrac}%, ` +
      `#333 ${introFrac}%, #333 ${outroFrac}%, ` +
      `#5a3800 ${outroFrac}%, #5a3800 100%)`;
  }, [duration, currentTrack]);

  // Advance seekbar during playback — skip when user is dragging
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
              cuePoints.map((cue) => {
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
