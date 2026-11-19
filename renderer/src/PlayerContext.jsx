import {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
} from 'react';
import { trackTrimRange } from './trackTrim.js';
import { appendHistoryEntry, loadHistory, persistHistory } from './playbackHistory.js';

const PlayerContext = createContext(null);

/**
 * Owns playback for the whole app: the single audio element, Web Audio gain for
 * track gain and crossfade, queue and shuffle/repeat state, and the media server
 * port used to stream files.
 *
 * @param {React.ReactNode} children Subtree that can read playback state via usePlayer.
 */
export function PlayerProvider({ children }) {
  const audioRef = useRef(null);
  if (audioRef.current == null) {
    const a = new Audio();
    a.crossOrigin = 'anonymous';
    audioRef.current = a;
  }
  // eslint-disable-next-line react-hooks/refs
  const audio = audioRef.current;

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
  const [repeat, setRepeat] = useState('none');
  const [outputDeviceId, setOutputDeviceId] = useState('');
  const [volume, setVolumeState] = useState(1.0);
  const [history, setHistory] = useState(loadHistory);
  const [playbackError, setPlaybackError] = useState(null);
  const [unavailableLinkedIds, setUnavailableLinkedIds] = useState(() => new Set());

  useEffect(() => {
    persistHistory(history);
  }, [history]);

  const mediaPortRef = useRef(null);
  const [mediaPort, setMediaPort] = useState(null);
  useEffect(() => {
    window.api.getMediaPort().then((port) => {
      mediaPortRef.current = port;
      setMediaPort(port);
      console.log('[diag] media server port =', port);
      fetch(`http://127.0.0.1:${port}/__diag_probe__`)
        .then((r) => console.log('[diag] media server reachable, probe status =', r.status))
        .catch((e) => console.warn('[diag] media server UNREACHABLE:', e.message));
    });

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

  const refreshAvailability = useCallback(() => {
    window.api
      .getUnavailableLinkedTracks()
      .then((ids) => setUnavailableLinkedIds(new Set(ids)))
      .catch((err) => console.warn('[player] availability check failed:', err.message));
  }, []);
  useEffect(() => {
    refreshAvailability();
    window.addEventListener('focus', refreshAvailability);
    const interval = setInterval(refreshAvailability, 20000);
    return () => {
      window.removeEventListener('focus', refreshAvailability);
      clearInterval(interval);
    };
  }, [refreshAvailability]);

  const buildAudioGraph = useCallback(() => {
    if (audioCtxRef.current) return;
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

  const queueRef = useRef(queue);
  const idxRef = useRef(queueIndex);
  const shuffleRef = useRef(shuffle);
  const repeatRef = useRef(repeat);
  const currentPlaylistIdRef = useRef(currentPlaylistId);
  const currentPlaylistNameRef = useRef(currentPlaylistName);
  const currentTrackRef = useRef(currentTrack);
  const volumeRef = useRef(volume);
  const unavailableLinkedIdsRef = useRef(unavailableLinkedIds);
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
  useEffect(() => {
    unavailableLinkedIdsRef.current = unavailableLinkedIds;
  }, [unavailableLinkedIds]);

  const playGenRef = useRef(0);

  const trimRangeRef = useRef(null);
  const trimStopArmedRef = useRef(false);
  const explicitSeekRef = useRef(false);
  const trimSignatureRef = useRef(null);
  useEffect(() => {
    const trim = trackTrimRange(currentTrack);
    trimRangeRef.current = trim;
    const signature = trim ? `${trim.startMs}:${trim.endMs}` : null;
    const changed = signature !== trimSignatureRef.current;
    trimSignatureRef.current = signature;
    if (!trim) {
      trimStopArmedRef.current = false;
      return;
    }
    if (changed) trimStopArmedRef.current = true;
  }, [currentTrack]);

  const playAtIndexRef = useRef(null);
  const nextRef = useRef(null);
  const skipStreakRef = useRef(0);
  const MAX_CONSECUTIVE_SKIPS = 25;
  const playAtIndex = useCallback(
    async (newQueue, index, playlistId = null, playlistName = null) => {
      const track = newQueue[index];
      if (!track) return;
      if (track.is_linked && unavailableLinkedIdsRef.current.has(track.id)) {
        skipStreakRef.current += 1;
        if (skipStreakRef.current > MAX_CONSECUTIVE_SKIPS) {
          setPlaybackError('Too many unavailable tracks in a row — stopping playback.');
          setIsPlaying(false);
          skipStreakRef.current = 0;
          return;
        }
        setPlaybackError(`"${track.title}" is unavailable — the file could not be found.`);
        setQueue(newQueue);
        setQueueIndex(index);
        setTimeout(() => nextRef.current?.(), 0);
        return;
      }
      const gen = ++playGenRef.current;
      const port = mediaPortRef.current;
      if (!port) {
        console.error('[player] media server not ready yet');
        return;
      }
      const filePath = track.file_path;
      const posixPath = filePath.replace(/\\/g, '/');
      const encodedPath = posixPath
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/');
      const src = `http://127.0.0.1:${port}/${encodedPath.replace(/^\//, '')}?t=${gen}`;

      if (currentTrackRef.current) {
        setHistory((prev) => appendHistoryEntry(prev, currentTrackRef.current));
      }
      console.log('[diag] playAtIndex src =', src);
      buildAudioGraph();
      audio.pause();
      const trim = trackTrimRange(track);
      trimRangeRef.current = trim;
      trimStopArmedRef.current = trim != null;
      explicitSeekRef.current = false;
      audio.src = src;
      if (trim) audio.currentTime = trim.startMs / 1000;
      if (audioCtxRef.current?.state === 'suspended') {
        try {
          await audioCtxRef.current.resume();
        } catch {}
      }
      console.log(
        '[player] ctx.state after resume =',
        audioCtxRef.current?.state ?? 'no ctx (fallback mode)'
      );
      audio
        .play()
        .then(() => {
          console.log('[diag] play() resolved OK  readyState=', audio.readyState);
          skipStreakRef.current = 0;
          if (
            trim &&
            gen === playGenRef.current &&
            !explicitSeekRef.current &&
            audio.currentTime < trim.startMs / 1000 - 0.5
          ) {
            audio.currentTime = trim.startMs / 1000;
          }
        })
        .catch((err) => {
          if (gen !== playGenRef.current || err.name === 'AbortError') return;
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
          if (err.name === 'NotSupportedError') {
            skipStreakRef.current += 1;
            if (skipStreakRef.current > MAX_CONSECUTIVE_SKIPS) {
              setPlaybackError('Too many unavailable tracks in a row — stopping playback.');
              setIsPlaying(false);
              skipStreakRef.current = 0;
              return;
            }
            setPlaybackError(`"${track.title}" is unavailable — the file could not be found.`);
            setTimeout(() => nextRef.current?.(), 0);
          }
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

  useEffect(() => {
    const advanceAfterTrack = (fromTrimEnd = false) => {
      const q = queueRef.current;
      const idx = idxRef.current;
      const rep = repeatRef.current;
      const shuf = shuffleRef.current;
      const plId = currentPlaylistIdRef.current;
      const plName = currentPlaylistNameRef.current;
      const trim = trimRangeRef.current;
      const startSec = trim ? trim.startMs / 1000 : 0;
      if (rep === 'one') {
        audio.currentTime = startSec;
        trimStopArmedRef.current = trim != null;
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
        if (fromTrimEnd) audio.pause();
        setIsPlaying(false);
      }
    };

    const checkTrimEnd = () => {
      const trim = trimRangeRef.current;
      if (!trim || !trimStopArmedRef.current || audio.paused) return;
      if (audio.currentTime >= trim.endMs / 1000 - 0.05) {
        trimStopArmedRef.current = false;
        advanceAfterTrack(true);
      }
    };

    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      checkTrimEnd();
    };
    const onDurationChange = () => setDuration(isNaN(audio.duration) ? 0 : audio.duration);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => advanceAfterTrack();

    const onError = () => {
      const code = audio.error?.code;
      const msg = audio.error?.message ?? '(none)';
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
    const trimWatch = setInterval(checkTrimEnd, 50);
    return () => {
      clearInterval(trimWatch);
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
        } catch {}
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
  useLayoutEffect(() => {
    nextRef.current = next;
  });

  const prev = useCallback(() => {
    const trim = trimRangeRef.current;
    const startSec = trim ? trim.startMs / 1000 : 0;
    if (audio.currentTime > startSec + 3) {
      audio.currentTime = startSec;
      trimStopArmedRef.current = trim != null;
    } else {
      const q = queueRef.current;
      const idx = idxRef.current;
      const plId = currentPlaylistIdRef.current;
      const plName = currentPlaylistNameRef.current;
      if (idx > 0) playAtIndexRef.current(q, idx - 1, plId, plName);
      else audio.currentTime = startSec;
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
      explicitSeekRef.current = true;
      const trim = trimRangeRef.current;
      trimStopArmedRef.current = trim != null && time < trim.endMs / 1000;
    },
    [audio]
  );

  const toggleShuffle = useCallback(() => setShuffle((s) => !s), []);

  const stop = useCallback(() => {
    audio.pause();
    audio.src = '';
    trimRangeRef.current = null;
    trimStopArmedRef.current = false;
    explicitSeekRef.current = false;
    setCurrentTrack(null);
    setQueue([]);
    setQueueIndex(0);
  }, [audio]);

  const setVolume = useCallback((v) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
  }, []);

  useEffect(() => {
    const rg = currentTrack?.replay_gain ?? 0;
    const gainLinear = Math.pow(10, rg / 20);
    const gain = gainNodeRef.current;
    if (gain) {
      gain.gain.value = gainLinear * volume;
    } else {
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
        playbackError,
        clearPlaybackError: () => setPlaybackError(null),
        unavailableLinkedIds,
        refreshAvailability,
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

/**
 * Read the playback state (current track and queue, play/pause, seek, volume,
 * shuffle/repeat and the helpers the views use to patch tracks).
 *
 * @returns {object} Player context value.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function usePlayer() {
  return useContext(PlayerContext);
}
