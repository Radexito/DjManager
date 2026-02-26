import { useState, useEffect, useRef } from 'react';
import { usePlayer } from './PlayerContext.jsx';
import './PlayerBar.css';

function formatTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  return `${m}:${sec}`;
}

export default function PlayerBar({ onNavigateToPlaylist }) {
  const {
    currentTrack,
    currentPlaylistId,
    isPlaying,
    currentTime,
    duration,
    shuffle,
    repeat,
    outputDeviceId,
    togglePlay,
    next,
    prev,
    seek,
    toggleShuffle,
    cycleRepeat,
    setDevice,
  } = usePlayer();

  const [devices, setDevices] = useState([]);
  const [showDevices, setShowDevices] = useState(false);
  const seekbarRef = useRef(); // uncontrolled range input
  const seekingRef = useRef(false); // true while user drags
  const deviceWrapRef = useRef();

  useEffect(() => {
    async function loadDevices() {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === 'audiooutput'));
    }
    loadDevices();
  }, []);

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

  const repeatLabel = repeat === 'one' ? '🔂' : '🔁';

  return (
    <div className="player-bar">
      {/* Left: current track info */}
      <div className="player-left">
        {currentTrack ? (
          <>
            <div className="player-title" title={currentTrack.title}>
              {currentTrack.title}
            </div>
            <div className="player-artist">{currentTrack.artist || 'Unknown'}</div>
          </>
        ) : (
          <div className="player-idle">No track playing</div>
        )}
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
          <input
            ref={seekbarRef}
            type="range"
            className="player-seekbar"
            min={0}
            max={duration || 0}
            step={0.5}
            defaultValue={0}
            onPointerDown={() => {
              seekingRef.current = true;
            }}
            onPointerUp={(e) => {
              seek(Number(e.target.value));
              seekingRef.current = false;
            }}
          />
          <span className="player-time">{formatTime(duration)}</span>
        </div>
      </div>

      {/* Right: device picker + navigate to playlist */}
      <div className="player-right">
        <div className="player-device-wrap" ref={deviceWrapRef}>
          <button
            className="player-btn"
            onClick={() => setShowDevices((s) => !s)}
            title="Audio output"
          >
            🔊
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

        <button
          className="player-btn"
          onClick={() => currentPlaylistId && onNavigateToPlaylist(String(currentPlaylistId))}
          title="Go to current playlist"
          disabled={!currentPlaylistId}
        >
          ☰
        </button>
      </div>
    </div>
  );
}
