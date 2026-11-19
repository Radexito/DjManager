import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const TidalDownloadContext = createContext(null);

/**
 * Holds the state of the TIDAL download flow (entered URL, fetched playlist,
 * selection, target playlist and progress) so it survives switching views.
 *
 * @param {React.ReactNode} children Subtree that can read the state via useTidalDownload.
 */
export function TidalDownloadProvider({ children }) {
  const [url, setUrl] = useState('');
  const [step, setStep] = useState('url');

  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState(null);

  const [playlistInfo, setPlaylistInfo] = useState(null);
  const [selectedIndices, setSelectedIndices] = useState(new Set());
  const [linkIndices, setLinkIndices] = useState(new Set());
  const [libraryMap, setLibraryMap] = useState(new Map());
  const [playlistMemberUrls, setPlaylistMemberUrls] = useState(new Set());
  const [playlists, setPlaylists] = useState([]);
  const [targetPlaylistId, setTargetPlaylistId] = useState(null);
  const [targetPlaylistName, setTargetPlaylistName] = useState('');

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [trackStatuses, setTrackStatuses] = useState([]);
  const [result, setResult] = useState(null);

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

/**
 * Read the TIDAL download state.
 *
 * @returns {object} TIDAL download context value.
 * @throws {Error} When called outside of a TidalDownloadProvider.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useTidalDownload() {
  const ctx = useContext(TidalDownloadContext);
  if (!ctx) throw new Error('useTidalDownload must be used inside TidalDownloadProvider');
  return ctx;
}
