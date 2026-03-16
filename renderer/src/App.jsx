import { useState, useEffect } from 'react';
import Sidebar from './Sidebar.jsx';
import MusicLibrary from './MusicLibrary.jsx';
import DownloadView from './DownloadView.jsx';
import SettingsModal from './SettingsModal.jsx';
import NmlExportModal from './NmlExportModal.jsx';
import PlayerBar from './PlayerBar.jsx';
import { PlayerProvider } from './PlayerContext.jsx';
import './App.css';

function App() {
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('music');
  const [showSettings, setShowSettings] = useState(false);
  const [depsProgress, setDepsProgress] = useState(null); // { msg, pct } or null
  const [nmlModal, setNmlModal] = useState(null); // { playlistId, mode } | null

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
      <div className="app-main">
        <Sidebar
          selectedMenuItemId={selectedPlaylistId}
          onMenuSelect={setSelectedPlaylistId}
          onExportPlaylistNml={(id) => setNmlModal({ playlistId: id, mode: 'playlist' })}
          onExportNmlAll={(id) => setNmlModal({ playlistId: id, mode: 'all' })}
        />
        {selectedPlaylistId === 'download' ? (
          <DownloadView
            onGoToLibrary={() => setSelectedPlaylistId('music')}
            onGoToPlaylist={(id) => setSelectedPlaylistId(id)}
          />
        ) : (
          <MusicLibrary selectedPlaylist={selectedPlaylistId} />
        )}
      </div>
      <PlayerBar onNavigateToPlaylist={setSelectedPlaylistId} />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {nmlModal && (
        <NmlExportModal
          playlistId={nmlModal.playlistId}
          initialMode={nmlModal.mode}
          onClose={() => setNmlModal(null)}
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
    </PlayerProvider>
  );
}

export default App;
