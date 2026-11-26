import { useState, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import Sidebar from './Sidebar.jsx';
import MusicLibrary from './MusicLibrary.jsx';
import UsbMediumView from './UsbMediumView.jsx';
import { buildArtistQuery } from './searchParser.js';
import DownloadView from './DownloadView.jsx';
import TidalDownloadView from './TidalDownloadView.jsx';
import CloudSearchView from './CloudSearchView.jsx';
import FileExplorerView from './FileExplorerView.jsx';
import HelpView from './HelpView.jsx';
import SettingsModal from './SettingsModal.jsx';
import ExportModal from './ExportModal.jsx';
import UsbCueImport from './UsbCueImport.jsx';
import PlayerBar from './PlayerBar.jsx';
import TopBar from './TopBar.jsx';
import GraphicsNotice from './GraphicsNotice.jsx';
import { PlayerProvider } from './PlayerContext.jsx';
import { DownloadProvider } from './DownloadContext.jsx';
import { TidalDownloadProvider } from './TidalDownloadContext.jsx';
import { DepsOverlay } from './DepsOverlay.jsx';
import './App.css';

/**
 * Application root: subscribes to USB cue detection, owns app-level UI state
 * (active view, settings, export and import dialogs, zoom banner, dependency
 * setup overlay) and renders the shell around the currently selected view.
 */
function App() {
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('music');
  // What the USB section is showing: { mount, playlistId, name } or null.
  const [usbSelection, setUsbSelection] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [exportState, setExportState] = useState(null);
  const [depsProgress, setDepsProgress] = useState(null);
  const [depsLog, setDepsLog] = useState([]);
  const [depsDone, setDepsDone] = useState(false);
  const depsHadWorkRef = useRef(false);
  const [zoomLevel, setZoomLevel] = useState(null);
  const [zoomKey, setZoomKey] = useState(0);
  const zoomHideTimer = useRef(null);
  const ZOOM_HIDE_DELAY = 3000;
  const [search, setSearch] = useState('');
  const [openDetailsRequest, setOpenDetailsRequest] = useState(null);
  const [locateTrackRequest, setLocateTrackRequest] = useState(null);
  const [cueImportRoot, setCueImportRoot] = useState(null);

  useEffect(() => {
    if (!window.api?.onUsbCuesDetected) return undefined;
    return window.api.onUsbCuesDetected(({ usbRoot }) => {
      setCueImportRoot((current) => (current === null ? usbRoot : current));
    });
  }, []);

  const handleArtistSearch = (artist, fromCredit) => {
    setSelectedPlaylistId('music');
    setSearch(buildArtistQuery(artist, { fromCredit: Boolean(fromCredit) }));
  };

  const handleLocateTrack = (trackId) => {
    if (!trackId) return;
    setSelectedPlaylistId('music');
    setLocateTrackRequest({ trackId, nonce: Date.now() });
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
    setUsbSelection(null);
    setSelectedPlaylistId(id);
  };

  useEffect(() => {
    const unsub = window.api.onOpenSettings(() => setShowSettings(true));
    return unsub;
  }, []);

  useEffect(() => {
    if (!window.api.onDepsProgress) return undefined;
    const unsub = window.api.onDepsProgress((data) => {
      if (data == null) {
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
      flushSync(() => {
        setZoomLevel(clamped);
        setZoomKey((k) => k + 1);
      });
      window.api.setZoomFactor(clamped);
      clearTimeout(zoomHideTimer.current);
      zoomHideTimer.current = setTimeout(() => setZoomLevel(null), ZOOM_HIDE_DELAY);
    };

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
            <GraphicsNotice />
            <div className="app-main">
              <Sidebar
                selectedMenuItemId={selectedPlaylistId}
                onMenuSelect={handleMenuSelect}
                usbSelection={usbSelection}
                onUsbSelect={setUsbSelection}
                activePlaylistId={selectedPlaylistId}
                onExportPlaylistAll={(id) => setExportState({ playlistId: id })}
              />
              {}
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
                isActive={selectedPlaylistId === 'cloud-search'}
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
              {usbSelection && (
                <UsbMediumView selection={usbSelection} onClose={() => setUsbSelection(null)} />
              )}
              {!usbSelection &&
                selectedPlaylistId !== 'download' &&
                selectedPlaylistId !== 'tidal' &&
                selectedPlaylistId !== 'cloud-search' &&
                selectedPlaylistId !== 'explorer' &&
                selectedPlaylistId !== 'help' && (
                  <MusicLibrary
                    selectedPlaylist={selectedPlaylistId}
                    search={search}
                    onSearchChange={setSearch}
                    openDetailsRequest={openDetailsRequest}
                    locateTrack={locateTrackRequest}
                    onImportUsbCues={() => setCueImportRoot('')}
                    onArtistSearch={handleArtistSearch}
                  />
                )}
            </div>
          </div>
          <PlayerBar
            onNavigateToPlaylist={setSelectedPlaylistId}
            onArtistSearch={handleArtistSearch}
            onOpenTrackDetails={handlePlayerOpenDetails}
            onLocateTrack={handleLocateTrack}
          />
          {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
          {exportState != null && (
            <ExportModal
              playlistId={exportState.playlistId}
              initialMode="all"
              onClose={() => setExportState(null)}
            />
          )}
          {cueImportRoot !== null && (
            <UsbCueImport usbRoot={cueImportRoot} onClose={() => setCueImportRoot(null)} />
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
