import { useState, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import Sidebar from './Sidebar.jsx';
import MusicLibrary from './MusicLibrary.jsx';
import DownloadView from './DownloadView.jsx';
import TidalDownloadView from './TidalDownloadView.jsx';
import CloudSearchView from './CloudSearchView.jsx';
import FileExplorerView from './FileExplorerView.jsx';
import HelpView from './HelpView.jsx';
import SettingsModal from './SettingsModal.jsx';
import ExportModal from './ExportModal.jsx';
import PlayerBar from './PlayerBar.jsx';
import TopBar from './TopBar.jsx';
import { PlayerProvider } from './PlayerContext.jsx';
import { DownloadProvider } from './DownloadContext.jsx';
import { TidalDownloadProvider } from './TidalDownloadContext.jsx';
import { DepsOverlay } from './DepsOverlay.jsx';
import './App.css';

function App() {
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('music');
  const [showSettings, setShowSettings] = useState(false);
  const [exportState, setExportState] = useState(null); // { playlistId, mode } | null
  const [depsProgress, setDepsProgress] = useState(null); // { msg, pct } or null
  const [depsLog, setDepsLog] = useState([]); // console lines [{ text, kind }]
  const [depsDone, setDepsDone] = useState(false); // run finished, awaiting Close
  const depsHadWorkRef = useRef(false); // real install ran (vs. "up to date")
  const [zoomLevel, setZoomLevel] = useState(null); // shown when != 1.0, null = hidden
  const [zoomKey, setZoomKey] = useState(0); // incremented on each zoom change to restart bar animation
  const zoomHideTimer = useRef(null);
  const ZOOM_HIDE_DELAY = 3000;
  const [search, setSearch] = useState('');
  const [openDetailsRequest, setOpenDetailsRequest] = useState(null);

  const handleArtistSearch = (artist) => {
    setSelectedPlaylistId('music');
    setSearch(`ARTIST is ${artist}`);
  };

  const handleLogoClick = () => {
    setSelectedPlaylistId('music');
    setSearch('');
  };

  const handlePlayerOpenDetails = (trackId, playlistId) => {
    if (!trackId) return;
    setSelectedPlaylistId(playlistId != null ? String(playlistId) : 'music');
    setOpenDetailsRequest({ trackId, nonce: Date.now() });
  };

  const handleMenuSelect = (id) => {
    if (id === selectedPlaylistId) setSearch('');
    setSelectedPlaylistId(id);
  };

  useEffect(() => {
    const unsub = window.api.onOpenSettings(() => setShowSettings(true));
    return unsub;
  }, []);

  // First-time setup console. Progress events stream in from the main
  // process; we accumulate them into a readable log. A finished run STAYS on
  // screen (done=true) until the user clicks Close - never auto-dismisses
  // after real work. The quiet startup case ("Dependencies up to date.")
  // produces no work events and stays hidden.
  useEffect(() => {
    if (!window.api.onDepsProgress) return undefined;
    const unsub = window.api.onDepsProgress((data) => {
      if (data == null) {
        // Run ended. Show the console with Close only if something ran;
        // otherwise (deps already fine at startup) stay silent.
        if (depsHadWorkRef.current) {
          setDepsDone(true);
          setDepsProgress(null);
        } else {
          setDepsProgress(null);
          setDepsLog([]);
        }
        depsHadWorkRef.current = false;
        return;
      }
      const { msg, pct, stepTotal, error } = data;
      const isNoop = pct === 100 && stepTotal === 0 && !error;
      if (!isNoop) depsHadWorkRef.current = true;
      setDepsLog((prev) => {
        const line = { text: error || msg || '', kind: error ? 'error' : 'log' };
        if (!line.text) return prev;
        // Skip consecutive duplicates (byte-progress re-emits the same label).
        const last = prev[prev.length - 1];
        if (last && last.text === line.text && last.kind === line.kind) return prev;
        const next = [...prev, line];
        return next.length > 400 ? next.slice(next.length - 400) : next;
      });
      setDepsProgress(data);
    });
    return unsub;
  }, []);

  const resetDepsOverlay = () => {
    depsHadWorkRef.current = false;
    setDepsDone(false);
    setDepsLog([]);
    setDepsProgress(null);
  };

  const retryDeps = () => {
    resetDepsOverlay();
    window.api.retryDeps?.();
  };

  // Zoom control: Ctrl+Scroll and Ctrl+=/−/0, persisted to localStorage
  useEffect(() => {
    const ZOOM_STEP = 0.1;
    const ZOOM_MIN = 0.5;
    const ZOOM_MAX = 2.0;
    const LS_KEY = 'app-zoom-factor';

    const clamp = (v) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
    const round = (v) => Math.round(v * 10) / 10;

    const applyZoom = (factor) => {
      const clamped = clamp(round(factor));
      localStorage.setItem(LS_KEY, String(clamped));
      // Flush counter-scale state synchronously BEFORE applying zoom so the
      // pill is already at the correct size when the page zooms — no jump.
      flushSync(() => {
        setZoomLevel(clamped);
        setZoomKey((k) => k + 1);
      });
      window.api.setZoomFactor(clamped);
      clearTimeout(zoomHideTimer.current);
      zoomHideTimer.current = setTimeout(() => setZoomLevel(null), ZOOM_HIDE_DELAY);
    };

    // Restore persisted zoom (silently — no indicator on launch)
    const saved = parseFloat(localStorage.getItem(LS_KEY));
    if (!isNaN(saved)) {
      const clamped = clamp(round(saved));
      window.api.setZoomFactor(clamped);
    }

    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const current = window.api.getZoomFactor();
      applyZoom(e.deltaY < 0 ? current + ZOOM_STEP : current - ZOOM_STEP);
    };

    const onKeyDown = (e) => {
      if (!e.ctrlKey) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        applyZoom(window.api.getZoomFactor() + ZOOM_STEP);
      } else if (e.key === '-') {
        e.preventDefault();
        applyZoom(window.api.getZoomFactor() - ZOOM_STEP);
      } else if (e.key === '0') {
        e.preventDefault();
        applyZoom(1.0);
      }
    };

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      clearTimeout(zoomHideTimer.current);
    };
  }, []);

  return (
    <PlayerProvider>
      <DownloadProvider>
        <TidalDownloadProvider>
          <div className="app-body">
            <TopBar
              onOpenHelp={() => setSelectedPlaylistId('help')}
              onOpenSettings={() => setShowSettings(true)}
              onLogoClick={handleLogoClick}
            />
            <div className="app-main">
              <Sidebar
                selectedMenuItemId={selectedPlaylistId}
                onMenuSelect={handleMenuSelect}
                activePlaylistId={selectedPlaylistId}
                onExportPlaylistRekordboxUsb={(id) =>
                  setExportState({ playlistId: id, mode: 'rekordbox' })
                }
                onExportPlaylistAll={(id) => setExportState({ playlistId: id, mode: 'all' })}
              />
              {/* Always mounted so state persists when switching tabs */}
              <DownloadView
                style={{ display: selectedPlaylistId === 'download' ? '' : 'none' }}
                onGoToLibrary={() => setSelectedPlaylistId('music')}
                onGoToPlaylist={(id) => setSelectedPlaylistId(id)}
              />
              <TidalDownloadView
                style={{ display: selectedPlaylistId === 'tidal' ? '' : 'none' }}
                onGoToLibrary={() => setSelectedPlaylistId('music')}
                onGoToPlaylist={(id) => setSelectedPlaylistId(id)}
              />
              <CloudSearchView
                style={{ display: selectedPlaylistId === 'cloud-search' ? '' : 'none' }}
                onGoToLibrary={() => setSelectedPlaylistId('music')}
                onGoToTidalSetup={() => setSelectedPlaylistId('tidal')}
              />
              <FileExplorerView
                style={{ display: selectedPlaylistId === 'explorer' ? '' : 'none' }}
              />
              <HelpView
                style={{ display: selectedPlaylistId === 'help' ? '' : 'none' }}
                active={selectedPlaylistId === 'help'}
                onClose={() => setSelectedPlaylistId('music')}
              />
              {selectedPlaylistId !== 'download' &&
                selectedPlaylistId !== 'tidal' &&
                selectedPlaylistId !== 'cloud-search' &&
                selectedPlaylistId !== 'explorer' &&
                selectedPlaylistId !== 'help' && (
                  <MusicLibrary
                    selectedPlaylist={selectedPlaylistId}
                    search={search}
                    onSearchChange={setSearch}
                    openDetailsRequest={openDetailsRequest}
                  />
                )}
            </div>
          </div>
          <PlayerBar
            onNavigateToPlaylist={setSelectedPlaylistId}
            onArtistSearch={handleArtistSearch}
            onOpenTrackDetails={handlePlayerOpenDetails}
          />
          {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
          {exportState != null && (
            <ExportModal
              playlistId={exportState.playlistId}
              initialMode={exportState.mode}
              onClose={() => setExportState(null)}
            />
          )}
          {zoomLevel !== null && zoomLevel !== 1.0 && (
            <button
              className="zoom-indicator"
              style={{ transform: `scale(${1 / zoomLevel})`, transformOrigin: 'top left' }}
              onClick={() => {
                clearTimeout(zoomHideTimer.current);
                window.api.setZoomFactor(1.0);
                localStorage.setItem('app-zoom-factor', '1');
                setZoomLevel(null);
              }}
              onMouseEnter={() => clearTimeout(zoomHideTimer.current)}
              onMouseLeave={() => {
                zoomHideTimer.current = setTimeout(() => setZoomLevel(null), ZOOM_HIDE_DELAY);
              }}
              title="Reset zoom to 100%"
            >
              <span className="zoom-indicator-label">{Math.round(zoomLevel * 100)}% ✕</span>
              <span key={zoomKey} className="zoom-indicator-bar" />
            </button>
          )}
          <DepsOverlay
            progress={depsProgress}
            log={depsLog}
            done={depsDone}
            onRetry={retryDeps}
            onClose={resetDepsOverlay}
          />
        </TidalDownloadProvider>
      </DownloadProvider>
    </PlayerProvider>
  );
}

export default App;
