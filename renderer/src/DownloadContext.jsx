import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const DownloadContext = createContext(null);

/**
 * Holds the state of the URL download flow (entered URL, fetched playlist info,
 * selection, per-item status and history) so it survives switching views.
 *
 * @param {React.ReactNode} children Subtree that can read the state via useDownload.
 */
export function DownloadProvider({ children }) {
  const [url, setUrl] = useState('');
  const [downloadHistory, setDownloadHistory] = useState([]);
  const [step, setStep] = useState('url');

  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [checkProgress, setCheckProgress] = useState(null);

  const [playlistInfo, setPlaylistInfo] = useState(null);
  const [selectedIndices, setSelectedIndices] = useState(new Set());
  const [libraryMap, setLibraryMap] = useState(new Map());
  const [linkIndices, setLinkIndices] = useState(new Set());
  const [playlistMemberUrls, setPlaylistMemberUrls] = useState(new Set());
  const [playlists, setPlaylists] = useState([]);
  const [targetPlaylistId, setTargetPlaylistId] = useState(null);
  const [targetPlaylistName, setTargetPlaylistName] = useState('');

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [trackStatuses, setTrackStatuses] = useState([]);
  const [result, setResult] = useState(null);

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
      setCheckProgress(data);
    });

    const unsubEntriesReady = window.api.onYtDlpEntriesReady((entries) => {
      setPlaylistInfo((prev) =>
        prev ? { ...prev, entries } : { type: 'playlist', title: null, entries }
      );
    });

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
          if (prev.length > 0) return prev;
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

  const completedCount = trackStatuses.filter(
    (s) => s.status === 'done' || s.status === 'failed'
  ).length;
  const sbTotal = Math.max(trackStatuses.length, progress?.overallTotal ?? 0, 1);
  const sbCurrent = completedCount;
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

/**
 * Read the URL download state.
 *
 * @returns {object} Download context value.
 * @throws {Error} When called outside of a DownloadProvider.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useDownload() {
  const ctx = useContext(DownloadContext);
  if (!ctx) throw new Error('useDownload must be used inside DownloadProvider');
  return ctx;
}
