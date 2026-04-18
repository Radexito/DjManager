import { useRef, useCallback } from 'react';
import { useDownload } from './DownloadContext.jsx';
import './DownloadView.css';

const SUPPORTED_SOURCES = [
  { name: 'YouTube', icon: '▶', url: 'https://www.youtube.com' },
  { name: 'SoundCloud', icon: '☁', url: 'https://soundcloud.com' },
  { name: 'Bandcamp', icon: '♫', url: 'https://bandcamp.com' },
  { name: 'Mixcloud', icon: '🎛', url: 'https://www.mixcloud.com' },
  { name: 'Vimeo', icon: '🎬', url: 'https://vimeo.com' },
  { name: 'Twitch', icon: '🟣', url: 'https://www.twitch.tv' },
  { name: 'Twitter / X', icon: '𝕏', url: 'https://x.com' },
  { name: 'Instagram', icon: '📷', url: 'https://www.instagram.com' },
  { name: 'Facebook', icon: 'f', url: 'https://www.facebook.com' },
  { name: 'TikTok', icon: '♪', url: 'https://www.tiktok.com' },
  { name: 'Dailymotion', icon: '🎥', url: 'https://www.dailymotion.com' },
  { name: 'Deezer', icon: '🎵', url: 'https://www.deezer.com' },
];

const YT_DLP_SUPPORTED_SITES = 'https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md';
const PLATFORM_ICONS = { youtube: '▶', soundcloud: '☁', bandcamp: '♫', other: '⬇' };

const STATUS_ICON = {
  pending: { icon: '□', label: 'Pending' },
  downloading: { icon: '⋯', label: 'Downloading' },
  importing: { icon: '↓', label: 'Importing' },
  linking: { icon: '⊟', label: 'Linking to playlist' },
  done: { icon: '✓', label: 'Done' },
  failed: { icon: '✗', label: 'Failed' },
};

function fmtDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function DownloadView({ onGoToLibrary, onGoToPlaylist, style }) {
  const {
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
    setLoading,
    progress,
    setProgress,
    trackStatuses,
    setTrackStatuses,
    result,
    setResult,
  } = useDownload();

  const inputRef = useRef(null);

  // Cancel an in-progress fetch — the IPC call will still complete but result is ignored
  const handleCancelFetch = useCallback(() => {
    setFetching(false);
    setFetchError(null);
    setCheckProgress(null);
  }, [setFetching, setFetchError, setCheckProgress]);

  // ── handlers ──────────────────────────────────────────────────────────────

  const openLink = (e, href) => {
    e.preventDefault();
    window.api.openExternal(href);
  };

  const detectIcon = (u) => {
    try {
      const host = new URL(u).hostname.toLowerCase();
      if (host.includes('youtube') || host.includes('youtu.be')) return PLATFORM_ICONS.youtube;
      if (host.includes('soundcloud')) return PLATFORM_ICONS.soundcloud;
      if (host.includes('bandcamp')) return PLATFORM_ICONS.bandcamp;
    } catch {
      /* invalid URL */
    }
    return PLATFORM_ICONS.other;
  };

  const formatTime = (ts) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Step 1 → 2: fetch playlist info
  const handleLoad = async (e) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || fetching) return;
    // Auto-prepend https:// if no protocol is present
    const normalizedUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    console.log('[DownloadView] handleLoad start, url=', normalizedUrl);
    if (normalizedUrl !== trimmed) setUrl(normalizedUrl); // update input to show normalised form
    setFetching(true);
    setFetchError(null);
    try {
      if (typeof window.api.ytDlpFetchInfo !== 'function') {
        throw new Error(
          'ytDlpFetchInfo is not available — please restart the app to load the latest preload changes.'
        );
      }
      const res = await window.api.ytDlpFetchInfo(normalizedUrl);
      console.log('[DownloadView] ytDlpFetchInfo result:', res);
      if (!res.ok) {
        setFetchError(res.error);
        return;
      }
      setPlaylistInfo(res);

      // Check which entries are already in the library
      let newLibraryMap = new Map();
      try {
        const entryChecks = res.entries
          .filter((e) => e.url || e.id)
          .map((e) => ({ url: e.url, id: e.id }));
        if (entryChecks.length > 0) {
          const found = await window.api.checkDuplicateUrls(entryChecks);
          // found = [{url, trackId}]
          for (const { url: u, trackId } of found) {
            if (u) newLibraryMap.set(u, trackId);
          }
        }
      } catch {
        // non-fatal
      }
      setLibraryMap(newLibraryMap);

      // Pre-select non-library entries; pre-link library entries that aren't in the target playlist
      setSelectedIndices(
        new Set(
          res.entries.filter((e) => !e.unavailable && !newLibraryMap.has(e.url)).map((e) => e.index)
        )
      );
      setLinkIndices(
        new Set(
          res.entries.filter((e) => !e.unavailable && newLibraryMap.has(e.url)).map((e) => e.index)
        )
      );

      // Fetch existing playlists for the combobox
      let existingPlaylists = [];
      try {
        existingPlaylists = (await window.api.getPlaylists()) || [];
        setPlaylists(existingPlaylists);
      } catch {
        setPlaylists([]);
      }
      // Auto-select existing playlist if name matches the detected title
      const detectedTitle = res.title || '';
      const match = existingPlaylists.find(
        (p) => p.name.toLowerCase() === detectedTitle.toLowerCase()
      );
      let matchedPlaylistId = null;
      if (match) {
        matchedPlaylistId = match.id;
        setTargetPlaylistId(match.id);
        setTargetPlaylistName('');
      } else {
        setTargetPlaylistId(null);
        setTargetPlaylistName(detectedTitle);
      }

      // Check which library entries are already in the matched playlist
      if (matchedPlaylistId && newLibraryMap.size > 0) {
        try {
          const memberRows = await window.api.getPlaylistSourceUrls(matchedPlaylistId);
          const memberTrackIds = new Set(memberRows.map((r) => r.trackId));
          const inPlaylist = new Set(
            [...newLibraryMap.entries()]
              .filter(([, tid]) => memberTrackIds.has(tid))
              .map(([url]) => url)
          );
          setPlaylistMemberUrls(inPlaylist);
          // Remove "already in playlist" entries from linkIndices
          setLinkIndices((prev) => {
            const next = new Set(prev);
            for (const entry of res.entries) {
              if (inPlaylist.has(entry.url)) next.delete(entry.index);
            }
            return next;
          });
        } catch {
          setPlaylistMemberUrls(new Set());
        }
      } else {
        setPlaylistMemberUrls(new Set());
      }

      setStep('select');
    } catch (err) {
      console.error('[DownloadView] handleLoad error:', err);
      setFetchError(err.message);
    } finally {
      setFetching(false);
    }
  };

  // When the target playlist changes, re-check which library entries are already in it
  const handleTargetPlaylistChange = useCallback(
    async (newPlaylistId) => {
      setTargetPlaylistId(newPlaylistId);
      if (!newPlaylistId || libraryMap.size === 0) {
        setPlaylistMemberUrls(new Set());
        // Restore all library entries to linkIndices
        if (playlistInfo) {
          setLinkIndices(
            new Set(
              playlistInfo.entries
                .filter((e) => !e.unavailable && libraryMap.has(e.url))
                .map((e) => e.index)
            )
          );
        }
        return;
      }
      try {
        const memberRows = await window.api.getPlaylistSourceUrls(newPlaylistId);
        const memberTrackIds = new Set(memberRows.map((r) => r.trackId));
        const inPlaylist = new Set(
          [...libraryMap.entries()].filter(([, tid]) => memberTrackIds.has(tid)).map(([url]) => url)
        );
        setPlaylistMemberUrls(inPlaylist);
        if (playlistInfo) {
          setLinkIndices(
            new Set(
              playlistInfo.entries
                .filter((e) => !e.unavailable && libraryMap.has(e.url) && !inPlaylist.has(e.url))
                .map((e) => e.index)
            )
          );
        }
      } catch {
        setPlaylistMemberUrls(new Set());
      }
    },
    [libraryMap, playlistInfo, setLinkIndices, setPlaylistMemberUrls, setTargetPlaylistId]
  );

  // Step 2 → 1: go back
  const handleBack = useCallback(() => {
    setStep('url');
    setPlaylistInfo(null);
    setLibraryMap(new Map());
    setLinkIndices(new Set());
    setPlaylistMemberUrls(new Set());
    setFetchError(null);
  }, [
    setFetchError,
    setLibraryMap,
    setLinkIndices,
    setPlaylistInfo,
    setPlaylistMemberUrls,
    setStep,
  ]);

  // Step 2: toggle a single entry — 3-state cycle for library entries
  // library + not-in-playlist: indeterminate (link) → unchecked → indeterminate
  // normal (not in library): checked → unchecked → checked
  const handleToggleEntry = useCallback(
    (index, entry) => {
      const isInLibrary = libraryMap.has(entry.url);
      const isInPlaylist = playlistMemberUrls.has(entry.url);
      if (isInLibrary && !isInPlaylist) {
        // 3-state: link ↔ skip
        setLinkIndices((prev) => {
          const next = new Set(prev);
          if (next.has(index)) next.delete(index);
          else next.add(index);
          return next;
        });
      } else {
        setSelectedIndices((prev) => {
          const next = new Set(prev);
          if (next.has(index)) next.delete(index);
          else next.add(index);
          return next;
        });
      }
    },
    [libraryMap, playlistMemberUrls, setLinkIndices, setSelectedIndices]
  );

  // Step 2: select / deselect all — toggles download entries; link entries follow separately
  const handleToggleAll = useCallback(() => {
    if (!playlistInfo) return;
    const downloadable = playlistInfo.entries.filter(
      (e) => !e.unavailable && !libraryMap.has(e.url)
    );
    const linkable = playlistInfo.entries.filter(
      (e) => !e.unavailable && libraryMap.has(e.url) && !playlistMemberUrls.has(e.url)
    );
    const allDownloadSelected = downloadable.every((e) => selectedIndices.has(e.index));
    const allLinkSelected = linkable.every((e) => linkIndices.has(e.index));
    const allSelected = allDownloadSelected && allLinkSelected;
    if (allSelected) {
      setSelectedIndices(new Set());
      setLinkIndices(new Set());
    } else {
      setSelectedIndices(new Set(downloadable.map((e) => e.index)));
      setLinkIndices(new Set(linkable.map((e) => e.index)));
    }
  }, [
    playlistInfo,
    libraryMap,
    playlistMemberUrls,
    selectedIndices,
    linkIndices,
    setSelectedIndices,
    setLinkIndices,
  ]);

  // Step 2 → 3: start download
  const handleDownload = async () => {
    if (selectedIndices.size === 0 && linkIndices.size === 0) return;

    // Entries to actually download via yt-dlp (not already in library)
    const downloadEntries = playlistInfo.entries
      .filter((e) => selectedIndices.has(e.index))
      .sort((a, b) => a.index - b.index);

    // Entries to link (already in library, user wants to add to playlist)
    const linkEntries = playlistInfo.entries
      .filter((e) => linkIndices.has(e.index))
      .sort((a, b) => a.index - b.index);

    // Combined display list: downloads first, then links
    const allDisplayEntries = [
      ...downloadEntries.map((e, i) => ({
        index: i,
        title: e.title,
        url: e.url,
        status: 'pending',
      })),
      ...linkEntries.map((e, i) => ({
        index: downloadEntries.length + i,
        title: e.title,
        url: e.url,
        status: 'linking',
      })),
    ];

    setStep('download');
    setLoading(true);
    setResult(null);
    setTrackStatuses(allDisplayEntries);
    setProgress({
      msg: 'Starting download…',
      pct: 0,
      trackPct: 0,
      overallCurrent: 1,
      overallTotal: downloadEntries.length,
    });

    // Determine effective playlist ID for linking (may be created by the download step)
    let effectivePlaylistId = targetPlaylistId;

    if (downloadEntries.length > 0) {
      // Always pass --playlist-items when user excluded some tracks or there are unavailable ones
      let playlistItems = null;
      const downloadOnlyEntries = downloadEntries.length;
      const totalAvailable = availableEntries.filter((e) => !libraryMap.has(e.url)).length;
      if (
        playlistInfo.type === 'playlist' &&
        (downloadOnlyEntries < totalAvailable || unavailableCount > 0 || libraryMap.size > 0)
      ) {
        playlistItems = downloadEntries
          .map((e) => e.index + 1) // original 1-based playlist indices
          .join(',');
      }

      const res = await window.api.ytDlpDownloadUrl({
        url,
        playlistItems,
        playlistTitle: playlistInfo?.title || null,
        existingPlaylistId: playlistInfo?.type === 'playlist' ? targetPlaylistId : null,
        newPlaylistName:
          playlistInfo?.type === 'playlist' && !targetPlaylistId
            ? targetPlaylistName || playlistInfo?.title || 'Imported Playlist'
            : null,
      });

      effectivePlaylistId = res.playlistId ?? targetPlaylistId;
      setLoading(false);
      setProgress(null);
      setResult(res);
      if (res.ok) setDownloadHistory((prev) => [{ url, at: Date.now() }, ...prev.slice(0, 19)]);
    }

    // Link already-downloaded tracks to the playlist (no re-download)
    if (linkEntries.length > 0 && effectivePlaylistId) {
      const trackIds = linkEntries.map((e) => libraryMap.get(e.url)).filter(Boolean);
      if (trackIds.length > 0) {
        try {
          await window.api.addTracksToPlaylist(effectivePlaylistId, trackIds);
          setTrackStatuses((prev) =>
            prev.map((t) => {
              const isLink = linkEntries.some((e) => e.url === t.url);
              return isLink ? { ...t, status: 'done' } : t;
            })
          );
        } catch (err) {
          console.error('[DownloadView] link tracks failed:', err);
        }
      }
    }

    if (downloadEntries.length === 0) {
      setLoading(false);
      setProgress(null);
      setResult({ ok: true, imported: 0 });
    }
  };

  // Step 3 → 1: start fresh
  const handleDownloadAnother = () => {
    setStep('url');
    setPlaylistInfo(null);
    setResult(null);
    setTrackStatuses([]);
    setProgress(null);
    setUrl('');
    setPlaylists([]);
    setTargetPlaylistId(null);
    setTargetPlaylistName('');
    setLibraryMap(new Map());
    setLinkIndices(new Set());
    setPlaylistMemberUrls(new Set());
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  // ── derived ───────────────────────────────────────────────────────────────
  const isPlaylist = trackStatuses.length > 1 || (progress?.overallTotal ?? 0) > 1;
  const completedCount = trackStatuses.filter(
    (t) => t.status === 'done' || t.status === 'failed'
  ).length;
  // Drive overall counter from trackStatuses (truth source) to avoid yt-dlp reset on retry
  const overallTotal = trackStatuses.length || (progress?.overallTotal ?? 1);
  // Show how many tracks have fully completed (done/failed), starting at 0.
  const overallCurrent = completedCount;
  const overallPct = overallTotal > 0 ? Math.round((overallCurrent / overallTotal) * 100) : 0;

  const availableEntries = playlistInfo ? playlistInfo.entries.filter((e) => !e.unavailable) : [];
  const unavailableCount = playlistInfo
    ? playlistInfo.entries.filter((e) => e.unavailable).length
    : 0;
  // "All selected" means: every downloadable AND every linkable entry is active
  const downloadableEntries = availableEntries.filter((e) => !libraryMap.has(e.url));
  const linkableEntries = availableEntries.filter(
    (e) => libraryMap.has(e.url) && !playlistMemberUrls.has(e.url)
  );
  const allSelected =
    playlistInfo &&
    downloadableEntries.every((e) => selectedIndices.has(e.index)) &&
    linkableEntries.every((e) => linkIndices.has(e.index)) &&
    downloadableEntries.length + linkableEntries.length > 0;
  const someSelected =
    playlistInfo && (selectedIndices.size > 0 || linkIndices.size > 0) && !allSelected;

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="dl-view" style={style}>
      <div className="dl-header">
        <h2 className="dl-title">YT-DLP Download</h2>
        <p className="dl-subtitle">
          {step === 'url' && 'Paste a URL to preview and choose tracks before downloading.'}
          {step === 'select' &&
            (playlistInfo?.type === 'playlist'
              ? `${availableEntries.length} track${availableEntries.length !== 1 ? 's' : ''} found${unavailableCount > 0 ? ` (${unavailableCount} unavailable)` : ''} — select what to download.`
              : 'Ready to download.')}
          {step === 'download' && 'Downloading and importing to your library…'}
        </p>
      </div>

      {/* ── Step 1: URL input ─────────────────────────────────────────────── */}
      {step === 'url' && (
        <>
          <form className="dl-form" onSubmit={handleLoad}>
            <div className="dl-input-row">
              <input
                ref={inputRef}
                className="dl-input"
                type="text"
                placeholder="https://www.youtube.com/watch?v=…"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setFetchError(null);
                }}
                onPaste={(e) => {
                  const text = e.clipboardData?.getData('text')?.trim();
                  if (text) {
                    e.preventDefault();
                    setUrl(text);
                    setFetchError(null);
                  }
                }}
                disabled={fetching}
                autoComplete="off"
                spellCheck={false}
              />
              <button className="dl-btn" type="submit" disabled={fetching || !url.trim()}>
                {fetching ? (
                  <span className="dl-fetch-spinner">
                    <svg className="dl-spinner-svg" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="8" r="6" stroke="rgba(255,255,255,0.3)" strokeWidth="2" />
                      <path
                        d="M8 2a6 6 0 0 1 6 6"
                        stroke="#fff"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                    {checkProgress
                      ? `Checking ${checkProgress.checked}/${checkProgress.total}…`
                      : 'Loading…'}
                  </span>
                ) : (
                  'Load →'
                )}
              </button>
              {fetching && (
                <button type="button" className="dl-btn dl-btn--cancel" onClick={handleCancelFetch}>
                  ✕
                </button>
              )}
            </div>
            {fetchError && (
              <div className="dl-result dl-result--err">
                <span>✗ {fetchError}</span>
              </div>
            )}
          </form>

          <div className="dl-sources">
            <div className="dl-sources-title">Supported sources</div>
            <div className="dl-sources-grid">
              {SUPPORTED_SOURCES.map((s) => (
                <a
                  key={s.name}
                  href={s.url}
                  className="dl-source-chip dl-source-chip--link"
                  onClick={(e) => openLink(e, s.url)}
                >
                  <span className="dl-source-icon">{s.icon}</span>
                  <span>{s.name}</span>
                </a>
              ))}
              <a
                href={YT_DLP_SUPPORTED_SITES}
                className="dl-source-chip dl-source-chip--more dl-source-chip--link"
                onClick={(e) => openLink(e, YT_DLP_SUPPORTED_SITES)}
              >
                +1000 more
              </a>
            </div>
          </div>

          {/* Live track list during availability check */}
          {fetching && checkProgress && playlistInfo?.entries?.length > 0 && (
            <div className="dl-checking-list">
              <div className="dl-checking-list-title">
                Checking availability… {checkProgress.checked}/{checkProgress.total}
              </div>
              <div className="dl-select-list">
                {playlistInfo.entries.map((entry) => (
                  <div
                    key={entry.index}
                    className={`dl-check-item${entry.unavailable ? ' dl-check-item--unavailable' : entry.checked ? ' dl-check-item--ok' : ''}`}
                  >
                    <span className="dl-check-item-icon">
                      {entry.unavailable ? '✗' : entry.checked ? '✓' : '⋯'}
                    </span>
                    <span className="dl-select-item-num">{entry.index + 1}.</span>
                    <span className="dl-select-item-title">{entry.title}</span>
                    {entry.duration && (
                      <span className="dl-select-item-dur">{fmtDuration(entry.duration)}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {downloadHistory.length > 0 && !fetching && (
            <div className="dl-history">
              <div className="dl-history-title">Session downloads</div>
              {downloadHistory.map((item, i) => (
                <div key={i} className="dl-history-item">
                  <span className="dl-history-icon">{detectIcon(item.url)}</span>
                  <span className="dl-history-url">{item.url}</span>
                  <span className="dl-history-time">{formatTime(item.at)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Step 2: track selection ───────────────────────────────────────── */}
      {step === 'select' && playlistInfo && (
        <div className="dl-select">
          <div className="dl-select-header">
            <button className="dl-back-btn" onClick={handleBack}>
              ← Back
            </button>
            <div className="dl-select-meta">
              <span className="dl-select-playlist-title">
                {playlistInfo.title || (playlistInfo.type === 'playlist' ? 'Playlist' : 'Track')}
              </span>
              {playlistInfo.type === 'playlist' && (
                <span className="dl-select-count">
                  {availableEntries.length} track{availableEntries.length !== 1 ? 's' : ''}
                  {unavailableCount > 0 && (
                    <span
                      className="dl-select-count-unavailable"
                      title={`${unavailableCount} video${unavailableCount !== 1 ? 's' : ''} are unavailable (private, deleted, or restricted)`}
                    >
                      {' '}
                      · {unavailableCount} unavailable
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>

          {playlistInfo.type === 'playlist' && (
            <div className="dl-playlist-target">
              <label className="dl-playlist-target-label">1. Save to playlist</label>
              <select
                className="dl-playlist-select"
                value={targetPlaylistId ?? ''}
                onChange={(e) => handleTargetPlaylistChange(e.target.value || null)}
              >
                <option value="">New playlist</option>
                {playlists.map((pl) => (
                  <option key={pl.id} value={pl.id}>
                    {pl.name}
                  </option>
                ))}
              </select>
              {!targetPlaylistId && (
                <input
                  className="dl-playlist-name-input"
                  type="text"
                  placeholder="Playlist name"
                  value={targetPlaylistName}
                  onChange={(e) => setTargetPlaylistName(e.target.value)}
                />
              )}
            </div>
          )}

          {playlistInfo.type === 'playlist' && (
            <div className="dl-select-toolbar">
              <label className="dl-select-all-label">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={handleToggleAll}
                />
                {allSelected ? 'Deselect all' : '2. Select tracks'}
              </label>
              <div className="dl-select-filter-btns">
                {downloadableEntries.length > 0 && (
                  <button
                    type="button"
                    className="dl-filter-btn"
                    title="Select only tracks not in your library (will download)"
                    onClick={() => {
                      setSelectedIndices(new Set(downloadableEntries.map((e) => e.index)));
                      setLinkIndices(new Set());
                    }}
                  >
                    ↓ Downloads only
                  </button>
                )}
                {linkableEntries.length > 0 && (
                  <button
                    type="button"
                    className="dl-filter-btn"
                    title="Select only tracks already in your library (will link to playlist)"
                    onClick={() => {
                      setSelectedIndices(new Set());
                      setLinkIndices(new Set(linkableEntries.map((e) => e.index)));
                    }}
                  >
                    ⊟ Link only
                  </button>
                )}
              </div>
              <span className="dl-select-selected-count">
                {selectedIndices.size + linkIndices.size} / {availableEntries.length} selected
              </span>
            </div>
          )}

          <div className="dl-select-list">
            {playlistInfo.entries
              .filter((entry) => !entry.unavailable)
              .map((entry) => {
                const isInLibrary = libraryMap.has(entry.url);
                const isInPlaylist = playlistMemberUrls.has(entry.url);
                const isLink = linkIndices.has(entry.index);
                const isSelected = selectedIndices.has(entry.index);
                return (
                  <label
                    key={entry.index}
                    className={`dl-select-item${isInLibrary ? ' dl-select-item--dupe' : ''}`}
                  >
                    {playlistInfo.type === 'playlist' && (
                      <input
                        type="checkbox"
                        checked={isSelected || isLink}
                        disabled={isInPlaylist}
                        ref={(el) => {
                          if (el) el.indeterminate = isLink && !isSelected;
                        }}
                        onChange={() => handleToggleEntry(entry.index, entry)}
                      />
                    )}
                    <span className="dl-select-item-num">{entry.index + 1}.</span>
                    <span className="dl-select-item-title">{entry.title}</span>
                    {entry.duration && (
                      <span className="dl-select-item-dur">{fmtDuration(entry.duration)}</span>
                    )}
                    {isInPlaylist && (
                      <span
                        className="dl-select-item-dupe-badge dl-select-item-badge--playlist"
                        title="Already in the selected playlist"
                      >
                        ✓ in playlist
                      </span>
                    )}
                    {isInLibrary && !isInPlaylist && (
                      <span
                        className="dl-select-item-dupe-badge"
                        title={
                          isLink
                            ? 'Will be linked to playlist (no re-download)'
                            : 'In your library — click checkbox to link to playlist'
                        }
                      >
                        {isLink ? '⊟ link' : '○ in library'}
                      </span>
                    )}
                  </label>
                );
              })}
            {unavailableCount > 0 && (
              <div className="dl-select-unavailable-note">
                {unavailableCount} video{unavailableCount !== 1 ? 's' : ''} unavailable (private,
                deleted, or restricted) — not shown
              </div>
            )}
          </div>

          <div className="dl-select-footer">
            <button
              className="dl-btn"
              onClick={handleDownload}
              disabled={selectedIndices.size === 0 && linkIndices.size === 0}
            >
              {(() => {
                const dl = selectedIndices.size;
                const lk = linkIndices.size;
                if (dl > 0 && lk > 0) return `Download ${dl} + link ${lk}`;
                if (dl > 0)
                  return allSelected ? `Download all (${dl})` : `Download selected (${dl})`;
                if (lk > 0) return `Link ${lk} to playlist`;
                return 'Download';
              })()}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: download progress ─────────────────────────────────────── */}
      {step === 'download' && (
        <div className="dl-form">
          {isPlaylist && (progress || trackStatuses.length > 0) && (
            <div className="dl-progress">
              <div className="dl-progress-label">
                <span>Overall</span>
                <span>
                  {overallCurrent} / {overallTotal}
                </span>
              </div>
              <div className="dl-progress-bar">
                <div className="dl-progress-fill" style={{ width: `${overallPct}%` }} />
              </div>
              {progress?.msg && <span className="dl-progress-msg">{progress.msg}</span>}
            </div>
          )}

          {!isPlaylist && progress && (
            <div className="dl-progress">
              <div className="dl-progress-label">
                <span>Download</span>
                <span>{progress.trackPct ?? progress.pct ?? 0}%</span>
              </div>
              <div className="dl-progress-bar">
                <div
                  className="dl-progress-fill dl-progress-fill--track"
                  style={{ width: `${progress.trackPct ?? progress.pct ?? 0}%` }}
                />
              </div>
              {progress.msg && <span className="dl-progress-msg">{progress.msg}</span>}
            </div>
          )}

          {trackStatuses.length > 0 && (
            <div className="dl-track-table">
              <div className="dl-track-table-head">
                <span>Track</span>
                <span>Status</span>
              </div>
              <div className="dl-track-table-body">
                {trackStatuses.map((t) => (
                  <div key={t.index} className="dl-track-row">
                    <span className="dl-track-title">{t.title}</span>
                    <span
                      className={`dl-track-status dl-track-status--${t.status}`}
                      title={t.error || STATUS_ICON[t.status]?.label}
                    >
                      {STATUS_ICON[t.status]?.icon ?? '□'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result?.ok && (
            <div
              className={`dl-result ${result.trackIds.length === 0 ? 'dl-result--err' : 'dl-result--ok'}`}
            >
              {result.trackIds.length === 0 ? (
                <span>
                  ✗ All {result.unavailableCount > 0 ? result.unavailableCount + ' ' : ''}tracks
                  were unavailable (deleted, private, or geo-restricted)
                </span>
              ) : (
                <span>
                  {result.trackIds.length === 1
                    ? '✓ Track added to your library'
                    : `✓ ${result.trackIds.length} tracks added to your library`}
                  {result.unavailableCount > 0 && (
                    <span className="dl-result-unavailable-note">
                      {' '}
                      · {result.unavailableCount} unavailable (skipped)
                    </span>
                  )}
                </span>
              )}
              {result.trackIds.length > 0 && (
                <div className="dl-result-actions">
                  {result.playlistId ? (
                    <button
                      type="button"
                      className="dl-goto-btn"
                      onClick={() => onGoToPlaylist(result.playlistId)}
                    >
                      Go to Playlist →
                    </button>
                  ) : (
                    <button type="button" className="dl-goto-btn" onClick={onGoToLibrary}>
                      View in Music →
                    </button>
                  )}
                  <button type="button" className="dl-goto-btn" onClick={handleDownloadAnother}>
                    ← New download
                  </button>
                </div>
              )}
              {result.trackIds.length === 0 && (
                <button
                  type="button"
                  className="dl-back-btn"
                  onClick={handleBack}
                  style={{ marginTop: 8, alignSelf: 'flex-start' }}
                >
                  ← Try again
                </button>
              )}
            </div>
          )}
          {result?.error && (
            <div className="dl-result dl-result--err">
              <span>✗ {result.error}</span>
              {result.error.includes('400') && (
                <span className="dl-result-hint">
                  YouTube blocked the request. Try setting a browser in Settings → Downloads →
                  Browser Cookies so yt-dlp can use your session.
                </span>
              )}
              <button
                type="button"
                className="dl-back-btn"
                onClick={handleBack}
                style={{ marginTop: 8, alignSelf: 'flex-start' }}
              >
                ← Try again
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
