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

  // ── step: select ─────────────────────────────────────────────────────────────
  const [playlistInfo, setPlaylistInfo] = useState(null);
  const [selectedIndices, setSelectedIndices] = useState(new Set());
  const [duplicateUrls, setDuplicateUrls] = useState(new Set());
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
      unsubTrack();
    };
  }, []);

  // ── derived ──────────────────────────────────────────────────────────────────
  // Progress summary for the sidebar progress bar
  const sidebarProgress = loading
    ? {
        current: progress?.overallCurrent ?? 0,
        total: progress?.overallTotal ?? (trackStatuses.length || 1),
        pct: progress?.pct ?? 0,
        msg: progress?.msg ?? 'Downloading…',
      }
    : null;

  const resetToUrl = useCallback(() => {
    setStep('url');
    setPlaylistInfo(null);
    setSelectedIndices(new Set());
    setDuplicateUrls(new Set());
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
        playlistInfo,
        setPlaylistInfo,
        selectedIndices,
        setSelectedIndices,
        duplicateUrls,
        setDuplicateUrls,
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
