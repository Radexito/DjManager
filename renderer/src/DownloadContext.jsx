import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const DownloadContext = createContext(null);

export function DownloadProvider({ children }) {
  // ── shared ──────────────────────────────────────────────────────────────────
  const [url, setUrl] = useState('');
  const [downloadHistory, setDownloadHistory] = useState([]);
  const [step, setStep] = useState('url'); // 'url' | 'select' | 'download'

  // ── step: url ───────────────────────────────────────────────────────────────
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [checkProgress, setCheckProgress] = useState(null); // { checked, total } | null

  // ── step: select ─────────────────────────────────────────────────────────────
  const [playlistInfo, setPlaylistInfo] = useState(null);
  const [selectedIndices, setSelectedIndices] = useState(new Set());
  // libraryMap: Map<entryUrl, trackId> — tracks already in the library
  const [libraryMap, setLibraryMap] = useState(new Map());
  // linkIndices: Set<entryIndex> — tracks to link (in library, user wants to add to playlist)
  const [linkIndices, setLinkIndices] = useState(new Set());
  // playlistMemberUrls: Set<entryUrl> — tracks already in the TARGET playlist
  const [playlistMemberUrls, setPlaylistMemberUrls] = useState(new Set());
  const [playlists, setPlaylists] = useState([]);
  const [targetPlaylistId, setTargetPlaylistId] = useState(null);
  const [targetPlaylistName, setTargetPlaylistName] = useState('');

  // ── step: download ───────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [trackStatuses, setTrackStatuses] = useState([]);
  const [result, setResult] = useState(null);

  // Subscribe to IPC events once — context never unmounts
  useEffect(() => {
    const unsubProgress = window.api.onYtDlpProgress((data) => {
      if (data === null) {
        setLoading(false);
        setProgress(null);
      } else {
        setProgress(data);
      }
    });

    const unsubCheckProgress = window.api.onYtDlpCheckProgress((data) => {
      setCheckProgress(data); // null when done
    });

    // Fires once the flat-playlist fetch is done — populate entries before availability check
    const unsubEntriesReady = window.api.onYtDlpEntriesReady((entries) => {
      setPlaylistInfo((prev) =>
        prev ? { ...prev, entries } : { type: 'playlist', title: null, entries }
      );
    });

    // Fires after each individual entry is checked — flip unavailable flag in-place
    const unsubEntryChecked = window.api.onYtDlpEntryChecked(({ id, unavailable }) => {
      setPlaylistInfo((prev) => {
        if (!prev?.entries) return prev;
        const updated = prev.entries.map((e) =>
          e.id === id ? { ...e, unavailable, checked: true } : e
        );
        return { ...prev, entries: updated };
      });
    });

    const unsubTrack = window.api.onYtDlpTrackUpdate((update) => {
      if (update.type === 'init') {
        setTrackStatuses((prev) => {
          if (prev.length >= update.total) return prev;
          return Array.from({ length: update.total }, (_, i) => ({
            index: i,
            title: `Track ${i + 1}`,
            url: '',
            status: 'pending',
          }));
        });
      } else if (update.type === 'unavailable') {
        setTrackStatuses((prev) =>
          prev.map((t) =>
            t.title?.includes(update.videoId) || t.url?.includes(update.videoId)
              ? { ...t, status: 'failed', error: update.reason }
              : t
          )
        );
      } else {
        setTrackStatuses((prev) => {
          const next = [...prev];
          const i = update.index;
          while (next.length <= i) {
            const n = next.length;
            next.push({ index: n, title: `Track ${n + 1}`, url: '', status: 'pending' });
          }
          next[i] = { ...next[i], ...update };
          return next;
        });
      }
    });

    return () => {
      unsubProgress();
      unsubCheckProgress();
      unsubEntriesReady();
      unsubEntryChecked();
      unsubTrack();
    };
  }, []);

  // ── derived ──────────────────────────────────────────────────────────────────
  const completedCount = trackStatuses.filter(
    (s) => s.status === 'done' || s.status === 'failed'
  ).length;
  const sbTotal = Math.max(trackStatuses.length, progress?.overallTotal ?? 0, 1);
  const sbCurrent = loading ? Math.min(completedCount + 1, sbTotal) : completedCount;
  const sidebarProgress = loading
    ? {
        current: sbCurrent,
        total: sbTotal,
        pct: progress?.pct ?? 0,
        msg: progress?.msg ?? 'Downloading…',
      }
    : null;

  const resetToUrl = useCallback(() => {
    setStep('url');
    setPlaylistInfo(null);
    setSelectedIndices(new Set());
    setLibraryMap(new Map());
    setLinkIndices(new Set());
    setPlaylistMemberUrls(new Set());
    setTargetPlaylistId(null);
    setTargetPlaylistName('');
    setFetchError(null);
    setResult(null);
    setTrackStatuses([]);
    setProgress(null);
  }, []);

  return (
    <DownloadContext.Provider
      value={{
        url,
        setUrl,
        downloadHistory,
        setDownloadHistory,
        step,
        setStep,
        fetching,
        setFetching,
        fetchError,
        setFetchError,
        checkProgress,
        setCheckProgress,
        playlistInfo,
        setPlaylistInfo,
        selectedIndices,
        setSelectedIndices,
        libraryMap,
        setLibraryMap,
        linkIndices,
        setLinkIndices,
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
    </DownloadContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useDownload() {
  const ctx = useContext(DownloadContext);
  if (!ctx) throw new Error('useDownload must be used inside DownloadProvider');
  return ctx;
}
