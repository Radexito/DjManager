import SearchBar from './SearchBar.jsx';
import './TopBar.css';

export default function TopBar({ search, onSearchChange, onOpenSettings }) {
  return (
    <div className="top-bar">
      <div className="top-bar__logo">
        <img className="top-bar__logo-img" src="/logo.png" alt="DJ Manager" draggable={false} />
      </div>

      <div className="top-bar__search">
        <SearchBar value={search} onChange={onSearchChange} />
      </div>

      <div className="top-bar__actions">
        <button className="top-bar__settings-btn" onClick={onOpenSettings} title="Settings">
          ⚙
        </button>
      </div>
    </div>
  );
}
