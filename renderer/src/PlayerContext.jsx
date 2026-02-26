import { createContext, useContext, useRef, useState, useCallback, useEffect } from 'react';

const PlayerContext = createContext(null);

export function PlayerProvider({ children }) {
  const audioRef = useRef(null);
  if (!audioRef.current) audioRef.current = new Audio();
  const audio = audioRef.current;

  const [currentTrack, setCurrentTrack] = useState(null);
  const [currentPlaylistId, setCurrentPlaylistId] = useState(null);
  const [queue, setQueue] = useState([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState('none'); // 'none' | 'all' | 'one'
  const [outputDeviceId, setOutputDeviceId] = useState('');

  // Keep mutable refs so event handlers always see latest values
  const queueRef = useRef(queue);
  const idxRef = useRef(queueIndex);
  const shuffleRef = useRef(shuffle);
  const repeatRef = useRef(repeat);
  const currentPlaylistIdRef = useRef(currentPlaylistId);
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

  // Generation counter — incremented on every track switch so stale play() rejections are ignored
  const playGenRef = useRef(0);

  // Stable play-at-index — exposed via ref so handleEnded can call it without stale closure
  const playAtIndexRef = useRef(null);
  const playAtIndex = useCallback(
    (newQueue, index, playlistId = null) => {
      const track = newQueue[index];
      if (!track) return;
      const gen = ++playGenRef.current;
      const encodedPath = track.file_path
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/');
      const src = `media://${encodedPath}?t=${gen}`; // cache-bust: same file reloaded = fresh pipeline
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
    },
    [audio]
  );
  playAtIndexRef.current = playAtIndex;

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
      if (rep === 'one') {
        audio.currentTime = 0;
        audio.play().catch(console.error);
        return;
      }
      if (shuf) {
        playAtIndexRef.current(q, Math.floor(Math.random() * q.length), plId);
      } else if (idx < q.length - 1) {
        playAtIndexRef.current(q, idx + 1, plId);
      } else if (rep === 'all' && q.length > 0) {
        playAtIndexRef.current(q, 0, plId);
      } else {
        setIsPlaying(false);
      }
    };

    const onError = () => {
      const code = audio.error?.code;
      // Suppress expected errors from rapid track switching (aborted/decode/pipeline)
      if (code !== 1 && code !== 3 && code !== 4)
        console.error('[player] audio error:', audio.error?.message);
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
    (track, newQueue, index, playlistId = null) => {
      playAtIndex(newQueue, index, playlistId);
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
    if (shuffleRef.current) {
      playAtIndexRef.current(q, Math.floor(Math.random() * q.length), plId);
    } else if (idx < q.length - 1) {
      playAtIndexRef.current(q, idx + 1, plId);
    }
  }, []);

  const prev = useCallback(() => {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
    } else {
      const q = queueRef.current;
      const idx = idxRef.current;
      const plId = currentPlaylistIdRef.current;
      if (idx > 0) playAtIndexRef.current(q, idx - 1, plId);
      else audio.currentTime = 0;
    }
  }, [audio]);

  const seek = useCallback(
    (time) => {
      audio.currentTime = time;
    },
    [audio]
  );

  const toggleShuffle = useCallback(() => setShuffle((s) => !s), []);

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
        queue,
        queueIndex,
        isPlaying,
        currentTime,
        duration,
        shuffle,
        repeat,
        outputDeviceId,
        play,
        togglePlay,
        next,
        prev,
        seek,
        toggleShuffle,
        cycleRepeat,
        setDevice,
      }}
    >
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  return useContext(PlayerContext);
}
