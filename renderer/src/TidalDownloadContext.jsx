import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const TidalDownloadContext = createContext(null);

export function TidalDownloadProvider({ children }) {
  // ── shared ──────────────────────────────────────────────────────────────────
  const [url, setUrl] = useState('');
  const [step, setStep] = useState('url'); // 'url' | 'select' | 'download'

  // ── step: url ───────────────────────────────────────────────────────────────
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState(null);

  // ── step: select ─────────────────────────────────────────────────────────────
  const [playlistInfo, setPlaylistInfo] = useState(null); // { type, title, entries }
  const [selectedIndices, setSelectedIndices] = useState(new Set());
  const [linkIndices, setLinkIndices] = useState(new Set()); // in library, not in target playlist
  const [libraryMap, setLibraryMap] = useState(new Map()); // url → trackId
  const [playlistMemberUrls, setPlaylistMemberUrls] = useState(new Set()); // urls already in target playlist
  const [playlists, setPlaylists] = useState([]);
  const [targetPlaylistId, setTargetPlaylistId] = useState(null);
  const [targetPlaylistName, setTargetPlaylistName] = useState('');

  // ── step: download ───────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null); // { msg }
  const [trackStatuses, setTrackStatuses] = useState([]); // [{ index, title, artist, status }]
  const [result, setResult] = useState(null); // { ok, trackIds, playlistId, error }

  // Subscribe to IPC events — context never unmounts
  useEffect(() => {
    const unsubProgress = window.api.onTidalProgress((data) => {
      if (data === null) {
        setLoading(false);
        setProgress(null);
      } else {
        setProgress(data);
      }
    });

    const unsubTrack = window.api.onTidalTrackUpdate((update) => {
      if (update.type === 'init') {
        // Initialize the track status list from the selected entries
        setTrackStatuses(
          (update.tracks ?? []).map((e) => ({
            index: e.index,
            title: e.title,
            artist: e.artist,
            status: 'pending',
          }))
        );
      } else {
        setTrackStatuses((prev) => {
          const next = [...prev];
          const i = update.index;
          while (next.length <= i) {
            const n = next.length;
            next.push({ index: n, title: `Track ${n + 1}`, artist: '', status: 'pending' });
          }
          next[i] = { ...next[i], ...update };
          return next;
        });
      }
    });

    return () => {
      unsubProgress();
      unsubTrack();
    };
  }, []);

  // ── derived ──────────────────────────────────────────────────────────────────
  const completedCount = trackStatuses.filter(
    (s) => s.status === 'done' || s.status === 'failed'
  ).length;
  const sbTotal = Math.max(trackStatuses.length, 1);
  const sidebarProgress = loading
    ? {
        current: completedCount,
        total: sbTotal,
        pct: sbTotal > 0 ? Math.round((completedCount / sbTotal) * 100) : 0,
        msg: progress?.msg ?? 'Downloading…',
      }
    : null;

  const resetToUrl = useCallback(() => {
    setStep('url');
    setPlaylistInfo(null);
    setSelectedIndices(new Set());
    setLinkIndices(new Set());
    setLibraryMap(new Map());
    setPlaylistMemberUrls(new Set());
    setTargetPlaylistId(null);
    setTargetPlaylistName('');
    setFetchError(null);
    setResult(null);
    setTrackStatuses([]);
    setProgress(null);
  }, []);

  return (
    <TidalDownloadContext.Provider
      value={{
        url,
        setUrl,
        step,
        setStep,
        fetching,
        setFetching,
        fetchError,
        setFetchError,
        playlistInfo,
        setPlaylistInfo,
        selectedIndices,
        setSelectedIndices,
        linkIndices,
        setLinkIndices,
        libraryMap,
        setLibraryMap,
        playlistMemberUrls,
        setPlaylistMemberUrls,
        playlists,
        setPlaylists,
        targetPlaylistId,
        setTargetPlaylistId,
        targetPlaylistName,
        setTargetPlaylistName,
        loading,
        setLoading,
        progress,
        setProgress,
        trackStatuses,
        setTrackStatuses,
        result,
        setResult,
        sidebarProgress,
        resetToUrl,
      }}
    >
      {children}
    </TidalDownloadContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTidalDownload() {
  const ctx = useContext(TidalDownloadContext);
  if (!ctx) throw new Error('useTidalDownload must be used inside TidalDownloadProvider');
  return ctx;
}
