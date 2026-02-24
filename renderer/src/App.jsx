import { useState, useEffect } from 'react';
import Sidebar from './Sidebar.jsx';
import MusicLibrary from './MusicLibrary.jsx';
import SettingsModal from './SettingsModal.jsx';
import PlayerBar from './PlayerBar.jsx';
import { PlayerProvider } from './PlayerContext.jsx';
import './App.css';

function App() {
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('music');
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const unsub = window.api.onOpenSettings(() => setShowSettings(true));
    return unsub;
  }, []);

  return (
    <PlayerProvider>
      <div className="app-main">
        <Sidebar
          selectedMenuItemId={selectedPlaylistId}
          onMenuSelect={setSelectedPlaylistId}
        />
        <MusicLibrary selectedPlaylist={selectedPlaylistId} />
      </div>
      <PlayerBar onNavigateToPlaylist={setSelectedPlaylistId} />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </PlayerProvider>
  );
}

export default App;
