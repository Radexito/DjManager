import { useState, useEffect } from 'react';
import Sidebar from './Sidebar.jsx';
import MusicLibrary from './MusicLibrary.jsx';
import DownloadView from './DownloadView.jsx';
import TidalDownloadView from './TidalDownloadView.jsx';
import SettingsModal from './SettingsModal.jsx';
import ExportModal from './ExportModal.jsx';
import PlayerBar from './PlayerBar.jsx';
import TopBar from './TopBar.jsx';
import { PlayerProvider } from './PlayerContext.jsx';
import { DownloadProvider } from './DownloadContext.jsx';
import './App.css';

function App() {
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('music');
  const [showSettings, setShowSettings] = useState(false);
  const [exportState, setExportState] = useState(null); // { playlistId, mode } | null
  const [depsProgress, setDepsProgress] = useState(null); // { msg, pct } or null
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

  return (
    <PlayerProvider>
      <DownloadProvider>
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
            {selectedPlaylistId !== 'download' && selectedPlaylistId !== 'tidal' && (
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
        {depsProgress && (
          <div className="deps-overlay">
            <div className="deps-box">
              <div className="deps-title">First-time setup</div>
              <div className="deps-msg">{depsProgress.msg}</div>
              {depsProgress.pct >= 0 && depsProgress.pct < 100 && (
                <div className="deps-bar-track">
                  <div className="deps-bar-fill" style={{ width: `${depsProgress.pct}%` }} />
                </div>
              )}
            </div>
          </div>
        )}
      </DownloadProvider>
    </PlayerProvider>
  );
}

export default App;
