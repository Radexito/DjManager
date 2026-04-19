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
  if (audioRef.current == null) {
    const a = new Audio();
    // Required for Web Audio API (createMediaElementSource) to process audio from
    // the local media server — without this Chromium won't send an Origin header
    // and CORS is not negotiated, causing the graph to output silence.
    a.crossOrigin = 'anonymous';
    audioRef.current = a;
  }
  // eslint-disable-next-line react-hooks/refs
  const audio = audioRef.current;

  // Web Audio graph: MediaElementSource → GainNode → DynamicsCompressor (limiter) → destination
  // GainNode has no 1.0 ceiling so positive replay_gain boosts work without clipping.
  const audioCtxRef = useRef(null);
  const gainNodeRef = useRef(null);

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
  const [mediaPort, setMediaPort] = useState(null);
  useEffect(() => {
    window.api.getMediaPort().then((port) => {
      mediaPortRef.current = port;
      setMediaPort(port);
      console.log('[diag] media server port =', port);
      // Probe reachability — a 404/403/500 still means the server is up; a network error means blocked
      fetch(`http://127.0.0.1:${port}/__diag_probe__`)
        .then((r) => console.log('[diag] media server reachable, probe status =', r.status))
        .catch((e) => console.warn('[diag] media server UNREACHABLE:', e.message));
    });

    // Log available audio output devices
    if (navigator.mediaDevices?.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices().then((devices) => {
        const outputs = devices.filter((d) => d.kind === 'audiooutput');
        console.log(`[diag] audio output devices (${outputs.length}):`);
        outputs.forEach((d) =>
          console.log(
            `[diag]   id=${d.deviceId.slice(0, 16)}… label=${d.label || '(no label — needs permission)'}`
          )
        );
      });
    }
  }, []);

  // Web Audio graph is built lazily on first play() call — see buildAudioGraph() below.
  // Building it at mount time creates the AudioContext without a user gesture, leaving it
  // permanently suspended on Electron/Chrome (autoplay policy), so resume() never works.

  // Build the Web Audio graph on first user interaction so AudioContext is created
  // inside a user gesture — the only reliable way to get it into 'running' state on
  // Electron/Chrome without an explicit autoplay policy exception.
  // createMediaElementSource can only be called ONCE per audio element in Chromium;
  // the guard ensures StrictMode's double-invoke doesn't break it.
  const buildAudioGraph = useCallback(() => {
    if (audioCtxRef.current) return; // already built
    try {
      const ctx = new AudioContext();
      console.log('[player] AudioContext created, state =', ctx.state);
      const source = ctx.createMediaElementSource(audio);
      const gain = ctx.createGain();
      gain.gain.value = 1.0;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -1.0;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.1;
      source.connect(gain);
      gain.connect(limiter);
      limiter.connect(ctx.destination);
      audioCtxRef.current = ctx;
      gainNodeRef.current = gain;
      audio.volume = 1.0;
      console.log('[player] Web Audio graph built OK');
    } catch (err) {
      console.warn(
        '[player] Web Audio graph unavailable, falling back to audio.volume:',
        err.message
      );
    }
  }, [audio]);

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
    async (newQueue, index, playlistId = null, playlistName = null) => {
      const track = newQueue[index];
      if (!track) return;
      const gen = ++playGenRef.current;
      const port = mediaPortRef.current;
      if (!port) {
        console.error('[player] media server not ready yet');
        return;
      }
      const filePath = track.file_path;
      // Normalize to forward slashes (Windows paths use backslashes), then encode each segment
      const posixPath = filePath.replace(/\\/g, '/');
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
      console.log('[diag] playAtIndex src =', src);
      // Build Web Audio graph on first play (must be inside user gesture so ctx starts running)
      buildAudioGraph();
      audio.pause(); // cleanly stop current pipeline before swapping source
      audio.src = src;
      // Resume AudioContext — called within the same user gesture, so it works reliably
      if (audioCtxRef.current?.state === 'suspended') {
        try {
          await audioCtxRef.current.resume();
        } catch (_e) {
          // resume() rejects if context is closed — safe to ignore
        }
      }
      console.log(
        '[player] ctx.state after resume =',
        audioCtxRef.current?.state ?? 'no ctx (fallback mode)'
      );
      // Setting src triggers an implicit load; calling audio.load() would race with play()
      audio
        .play()
        .then(() => {
          console.log('[diag] play() resolved OK  readyState=', audio.readyState);
        })
        .catch((err) => {
          // AbortError is expected when we switch tracks before play() resolves
          if (gen === playGenRef.current && err.name !== 'AbortError')
            console.error(
              '[diag] play() FAILED:',
              err.name,
              err.message,
              'readyState=',
              audio.readyState,
              'networkState=',
              audio.networkState,
              'src=',
              audio.src
            );
        });
      setCurrentTrack(track);
      setQueue(newQueue);
      setQueueIndex(index);
      setCurrentPlaylistId(playlistId);
      setCurrentPlaylistName(playlistName ?? null);
    },
    [audio, buildAudioGraph]
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
        audio.play().catch((err) => {
          if (err.name !== 'AbortError') console.error(err);
        });
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

  const togglePlay = useCallback(async () => {
    if (audio.paused) {
      buildAudioGraph();
      if (audioCtxRef.current?.state === 'suspended') {
        try {
          await audioCtxRef.current.resume();
        } catch (_e) {
          // resume() rejects if context is closed — safe to ignore
        }
      }
      audio.play().catch((err) => {
        if (err.name !== 'AbortError') console.error(err);
      });
    } else {
      audio.pause();
    }
  }, [audio, buildAudioGraph]);

  const next = useCallback(() => {
    const q = queueRef.current;
    const idx = idxRef.current;
    const plId = currentPlaylistIdRef.current;
    const plName = currentPlaylistNameRef.current;
    if (shuffleRef.current) {
      playAtIndexRef.current(q, Math.floor(Math.random() * q.length), plId, plName);
    } else if (idx < q.length - 1) {
      playAtIndexRef.current(q, idx + 1, plId, plName);
    } else if (repeatRef.current === 'all' && q.length > 0) {
      playAtIndexRef.current(q, 0, plId, plName);
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

  // Apply user volume combined with per-track replay_gain through the GainNode.
  // GainNode has no 1.0 ceiling so positive gain (boosting quiet tracks) works correctly.
  useEffect(() => {
    const rg = currentTrack?.replay_gain ?? 0;
    const gainLinear = Math.pow(10, rg / 20);
    const gain = gainNodeRef.current;
    if (gain) {
      gain.gain.value = gainLinear * volume;
    } else {
      // Fallback before the Web Audio graph is initialised
      audio.volume = Math.min(1.0, gainLinear * volume);
    }
  }, [volume, currentTrack, audio]);

  const cycleRepeat = useCallback(
    () => setRepeat((r) => (r === 'none' ? 'all' : r === 'all' ? 'one' : 'none')),
    []
  );

  const setDevice = useCallback(
    async (deviceId) => {
      setOutputDeviceId(deviceId);
      const ctx = audioCtxRef.current;
      // When the Web Audio graph is active, audio routes through AudioContext — use
      // ctx.setSinkId() to redirect output. Fall back to audio.setSinkId() if the
      // graph is not yet initialised (should be rare).
      if (ctx && typeof ctx.setSinkId === 'function') {
        console.log('[diag] ctx.setSinkId →', deviceId || '(default)');
        await ctx.setSinkId(deviceId || '').catch((err) => {
          console.error('[diag] ctx.setSinkId FAILED:', err.name, err.message);
        });
      } else if (typeof audio.setSinkId === 'function') {
        console.log('[diag] setSinkId (fallback) →', deviceId || '(default)');
        await audio.setSinkId(deviceId).catch((err) => {
          console.error('[diag] setSinkId FAILED:', err.name, err.message);
        });
      } else {
        console.warn('[diag] setSinkId not available');
      }
    },
    [audio]
  );

  // ── navigator.mediaSession — hardware media keys ──────────────────────────
  useEffect(() => {
    if (!navigator.mediaSession) return;
    navigator.mediaSession.setActionHandler('play', () => {
      if (audio.src)
        audio.play().catch((err) => {
          if (err.name !== 'AbortError') console.error(err);
        });
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
      if (audio.paused)
        audio.play().catch((err) => {
          if (err.name !== 'AbortError') console.error(err);
        });
      else audio.pause();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [audio]);

  const patchCurrentTrack = useCallback(
    (id, fields) => setCurrentTrack((prev) => (prev?.id === id ? { ...prev, ...fields } : prev)),
    []
  );

  // Reload audio src for the current track (e.g. after normalization produces a new file).
  // Pass the new file path explicitly so we don't race with pending React state updates.
  // Seeks back to the position the player was at before the reload.
  const reloadCurrentTrack = useCallback(
    (newFilePath, shouldPlay = false) => {
      const port = mediaPortRef.current;
      console.log(
        '[reloadCurrentTrack] called with path=',
        newFilePath,
        'shouldPlay=',
        shouldPlay,
        'port=',
        port
      );
      if (!port || !newFilePath) return;
      const posixPath = newFilePath.replace(/\\/g, '/');
      const encodedPath = posixPath
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/');
      const gen = ++playGenRef.current;
      const savedTime = audio.currentTime;
      const src = `http://127.0.0.1:${port}/${encodedPath.replace(/^\//, '')}?t=${gen}`;
      console.log('[reloadCurrentTrack] setting audio.src =', src, 'savedTime=', savedTime);
      audio.pause();
      audio.src = src;
      audio.addEventListener(
        'canplay',
        () => {
          console.log(
            '[reloadCurrentTrack] canplay fired, seeking to',
            savedTime,
            'shouldPlay=',
            shouldPlay
          );
          audio.currentTime = savedTime;
          if (shouldPlay) {
            audio.play().catch((err) => {
              if (gen === playGenRef.current && err.name !== 'AbortError')
                console.error('[player] reloadCurrentTrack play error:', err);
            });
          }
        },
        { once: true }
      );
    },
    [audio]
  );

  // Update the queue in-place without changing the current track or index.
  // Called by MusicLibrary when tracks are added to the currently-playing source
  // so shuffle picks from the full up-to-date list.
  const updateQueue = useCallback((newQueue) => {
    setQueue(newQueue);
  }, []);

  return (
    <PlayerContext.Provider
      value={{
        mediaPort,
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
        patchCurrentTrack,
        reloadCurrentTrack,
        updateQueue,
        audioRef,
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
