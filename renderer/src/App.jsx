import { useState, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import Sidebar from './Sidebar.jsx';
import MusicLibrary from './MusicLibrary.jsx';
import DownloadView from './DownloadView.jsx';
import TidalDownloadView from './TidalDownloadView.jsx';
import FileExplorerView from './FileExplorerView.jsx';
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
  const [zoomLevel, setZoomLevel] = useState(null); // shown when != 1.0, null = hidden
  const [zoomKey, setZoomKey] = useState(0); // incremented on each zoom change to restart bar animation
  const zoomHideTimer = useRef(null);
  const ZOOM_HIDE_DELAY = 3000;
  const [search, setSearch] = useState('');

  const handleArtistSearch = (artist) => {
    setSelectedPlaylistId('music');
    setSearch(`ARTIST is ${artist}`);
  };

  useEffect(() => {
    const unsub = window.api.onOpenSettings(() => setShowSettings(true));
    return unsub;
  }, []);

  useEffect(() => {
    if (!window.api.onDepsProgress) return;
    const unsub = window.api.onDepsProgress((data) => setDepsProgress(data));
    return unsub;
  }, []);

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
              search={search}
              onSearchChange={setSearch}
              onOpenSettings={() => setShowSettings(true)}
            />
            <div className="app-main">
              <Sidebar
                selectedMenuItemId={selectedPlaylistId}
                onMenuSelect={setSelectedPlaylistId}
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
              <FileExplorerView
                style={{ display: selectedPlaylistId === 'explorer' ? '' : 'none' }}
              />
              {selectedPlaylistId !== 'download' &&
                selectedPlaylistId !== 'tidal' &&
                selectedPlaylistId !== 'explorer' && (
                  <MusicLibrary
                    selectedPlaylist={selectedPlaylistId}
                    search={search}
                    onSearchChange={setSearch}
                  />
                )}
            </div>
          </div>
          <PlayerBar
            onNavigateToPlaylist={setSelectedPlaylistId}
            onArtistSearch={handleArtistSearch}
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
          <DepsOverlay progress={depsProgress} onRetry={() => window.api.retryDeps?.()} />
        </TidalDownloadProvider>
      </DownloadProvider>
    </PlayerProvider>
  );
}

export default App;
