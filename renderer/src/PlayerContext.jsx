import {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
} from 'react';

const PlayerContext = createContext(null);

const HISTORY_MAX = 50;

export function PlayerProvider({ children }) {
  const audioRef = useRef(null);
  if (audioRef.current == null) audioRef.current = new Audio();
  // eslint-disable-next-line react-hooks/refs
  const audio = audioRef.current;

  const [currentTrack, setCurrentTrack] = useState(null);
  const [currentPlaylistId, setCurrentPlaylistId] = useState(null);
  const [currentPlaylistName, setCurrentPlaylistName] = useState(null);
  const [queue, setQueue] = useState([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState('none'); // 'none' | 'all' | 'one'
  const [outputDeviceId, setOutputDeviceId] = useState('');
  const [volume, setVolumeState] = useState(1.0);
  const [history, setHistory] = useState([]); // ring buffer, newest first

  // Port of the local HTTP media server (started in main process before window opens).
  const mediaPortRef = useRef(null);
  useEffect(() => {
    window.api.getMediaPort().then((port) => {
      mediaPortRef.current = port;
    });
  }, []);

  // Keep mutable refs so event handlers always see latest values
  const queueRef = useRef(queue);
  const idxRef = useRef(queueIndex);
  const shuffleRef = useRef(shuffle);
  const repeatRef = useRef(repeat);
  const currentPlaylistIdRef = useRef(currentPlaylistId);
  const currentPlaylistNameRef = useRef(currentPlaylistName);
  const currentTrackRef = useRef(currentTrack);
  const volumeRef = useRef(volume);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  useEffect(() => {
    idxRef.current = queueIndex;
  }, [queueIndex]);
  useEffect(() => {
    shuffleRef.current = shuffle;
  }, [shuffle]);
  useEffect(() => {
    repeatRef.current = repeat;
  }, [repeat]);
  useEffect(() => {
    currentPlaylistIdRef.current = currentPlaylistId;
  }, [currentPlaylistId]);
  useEffect(() => {
    currentPlaylistNameRef.current = currentPlaylistName;
  }, [currentPlaylistName]);
  useEffect(() => {
    currentTrackRef.current = currentTrack;
  }, [currentTrack]);
  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  // Generation counter — incremented on every track switch so stale play() rejections are ignored
  const playGenRef = useRef(0);

  // Stable play-at-index — exposed via ref so handleEnded can call it without stale closure
  const playAtIndexRef = useRef(null);
  const playAtIndex = useCallback(
    (newQueue, index, playlistId = null, playlistName = null) => {
      const track = newQueue[index];
      if (!track) return;
      const gen = ++playGenRef.current;
      const port = mediaPortRef.current;
      if (!port) {
        console.error('[player] media server not ready yet');
        return;
      }
      // Normalize to forward slashes (Windows paths use backslashes), then encode each segment
      const posixPath = track.file_path.replace(/\\/g, '/');
      const encodedPath = posixPath
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/');
      // Always ensure exactly one leading slash (Unix paths already start with '/', Windows 'C:/...' don't)
      const src = `http://127.0.0.1:${port}/${encodedPath.replace(/^\//, '')}?t=${gen}`; // cache-bust: same file reloaded = fresh pipeline

      // Push currently playing track to history before switching
      if (currentTrackRef.current) {
        setHistory((prev) => {
          const next = [currentTrackRef.current, ...prev];
          return next.length > HISTORY_MAX ? next.slice(0, HISTORY_MAX) : next;
        });
      }
      audio.pause(); // cleanly stop current pipeline before swapping source
      audio.src = src;
      // Setting src triggers an implicit load; calling audio.load() would race with play()
      audio.play().catch((err) => {
        // AbortError is expected when we switch tracks before play() resolves
        if (gen === playGenRef.current && err.name !== 'AbortError')
          console.error('[player] play error:', err.name, err.message);
      });
      setCurrentTrack(track);
      setQueue(newQueue);
      setQueueIndex(index);
      setCurrentPlaylistId(playlistId);
      setCurrentPlaylistName(playlistName ?? null);
    },
    [audio]
  );
  useLayoutEffect(() => {
    playAtIndexRef.current = playAtIndex;
  });

  // Register audio event listeners once
  useEffect(() => {
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onDurationChange = () => setDuration(isNaN(audio.duration) ? 0 : audio.duration);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      const q = queueRef.current;
      const idx = idxRef.current;
      const rep = repeatRef.current;
      const shuf = shuffleRef.current;
      const plId = currentPlaylistIdRef.current;
      const plName = currentPlaylistNameRef.current;
      if (rep === 'one') {
        audio.currentTime = 0;
        audio.play().catch(console.error);
        return;
      }
      if (shuf) {
        playAtIndexRef.current(q, Math.floor(Math.random() * q.length), plId, plName);
      } else if (idx < q.length - 1) {
        playAtIndexRef.current(q, idx + 1, plId, plName);
      } else if (rep === 'all' && q.length > 0) {
        playAtIndexRef.current(q, 0, plId, plName);
      } else {
        setIsPlaying(false);
      }
    };

    const onError = () => {
      const code = audio.error?.code;
      const msg = audio.error?.message ?? '(none)';
      // code 1=ABORTED, 3=DECODE, 4=SRC_NOT_SUPPORTED — suppress expected pipeline churn
      if (code !== 1 && code !== 3 && code !== 4) {
        console.error(
          `[player] audio error code=${code} "${msg}"\n` +
            `  src=${audio.src}\n` +
            `  currentTime=${audio.currentTime.toFixed(3)}  duration=${isFinite(audio.duration) ? audio.duration.toFixed(3) : 'n/a'}\n` +
            `  readyState=${audio.readyState}  networkState=${audio.networkState}`
        );
      }
    };

    audio.addEventListener('error', onError);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('timeupdate', onTimeUpdate);
    return () => {
      audio.removeEventListener('error', onError);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
    };
  }, [audio]);

  const play = useCallback(
    (track, newQueue, index, playlistId = null, playlistName = null) => {
      playAtIndex(newQueue, index, playlistId, playlistName);
    },
    [playAtIndex]
  );

  const togglePlay = useCallback(() => {
    if (audio.paused) audio.play().catch(console.error);
    else audio.pause();
  }, [audio]);

  const next = useCallback(() => {
    const q = queueRef.current;
    const idx = idxRef.current;
    const plId = currentPlaylistIdRef.current;
    const plName = currentPlaylistNameRef.current;
    if (shuffleRef.current) {
      playAtIndexRef.current(q, Math.floor(Math.random() * q.length), plId, plName);
    } else if (idx < q.length - 1) {
      playAtIndexRef.current(q, idx + 1, plId, plName);
    }
  }, []);

  const prev = useCallback(() => {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
    } else {
      const q = queueRef.current;
      const idx = idxRef.current;
      const plId = currentPlaylistIdRef.current;
      const plName = currentPlaylistNameRef.current;
      if (idx > 0) playAtIndexRef.current(q, idx - 1, plId, plName);
      else audio.currentTime = 0;
    }
  }, [audio]);

  const seek = useCallback(
    (time) => {
      console.log(
        `[seek] → ${time.toFixed(3)}s  ` +
          `currentTime=${audio.currentTime.toFixed(3)}  duration=${isFinite(audio.duration) ? audio.duration.toFixed(3) : 'n/a'}  ` +
          `readyState=${audio.readyState}  networkState=${audio.networkState}`
      );
      audio.currentTime = time;
    },
    [audio]
  );

  const toggleShuffle = useCallback(() => setShuffle((s) => !s), []);

  const stop = useCallback(() => {
    audio.pause();
    audio.src = '';
    setCurrentTrack(null);
    setQueue([]);
    setQueueIndex(0);
  }, [audio]);

  const setVolume = useCallback((v) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
  }, []);

  // Apply user volume combined with per-track replay_gain
  useEffect(() => {
    const rg = currentTrack?.replay_gain ?? 0;
    const gainLinear = Math.pow(10, rg / 20);
    audio.volume = Math.min(1.0, volume * gainLinear);
  }, [volume, currentTrack, audio]);

  const cycleRepeat = useCallback(
    () => setRepeat((r) => (r === 'none' ? 'all' : r === 'all' ? 'one' : 'none')),
    []
  );

  const setDevice = useCallback(
    async (deviceId) => {
      setOutputDeviceId(deviceId);
      if (typeof audio.setSinkId === 'function') {
        await audio.setSinkId(deviceId).catch(console.error);
      }
    },
    [audio]
  );

  // ── navigator.mediaSession — hardware media keys ──────────────────────────
  useEffect(() => {
    if (!navigator.mediaSession) return;
    navigator.mediaSession.setActionHandler('play', () => {
      if (audio.src) audio.play().catch(console.error);
    });
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => next());
    navigator.mediaSession.setActionHandler('previoustrack', () => prev());
    navigator.mediaSession.setActionHandler('seekto', (d) => {
      audio.currentTime = d.seekTime;
    });
    // eslint-disable-next-line react-hooks/refs
  }, [audio, next, prev]);

  useEffect(() => {
    if (!navigator.mediaSession || !currentTrack) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: currentTrack.artist || 'Unknown',
    });
  }, [currentTrack]);

  useEffect(() => {
    if (!navigator.mediaSession) return;
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }, [isPlaying]);

  // ── Spacebar — play/pause unless focus is in a text input ─────────────────
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.code !== 'Space') return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      if (audio.paused) audio.play().catch(console.error);
      else audio.pause();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [audio]);

  return (
    <PlayerContext.Provider
      value={{
        currentTrack,
        currentPlaylistId,
        currentPlaylistName,
        queue,
        queueIndex,
        isPlaying,
        currentTime,
        duration,
        shuffle,
        repeat,
        outputDeviceId,
        volume,
        history,
        play,
        togglePlay,
        stop,
        next,
        prev,
        seek,
        toggleShuffle,
        cycleRepeat,
        setDevice,
        setVolume,
      }}
    >
      {children}
    </PlayerContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePlayer() {
  return useContext(PlayerContext);
}
