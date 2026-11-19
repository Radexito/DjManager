import logo from './assets/logo.png';
import './TopBar.css';

/**
 * Top bar with the app logo and the help/settings buttons.
 *
 * @param {() => void} onOpenHelp Opens the help view.
 * @param {() => void} onOpenSettings Opens the settings modal.
 * @param {() => void} onLogoClick Switches back to the library and clears the search.
 */
export default function TopBar({ onOpenHelp, onOpenSettings, onLogoClick }) {
  return (
    <div className="top-bar">
      <div
        className="top-bar__logo"
        onClick={onLogoClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onLogoClick?.();
          }
        }}
        role="button"
        tabIndex={0}
      >
        <img className="top-bar__logo-img" src={logo} alt="DJ Manager" draggable={false} />
      </div>

      <div className="top-bar__spacer" />

      <div className="top-bar__actions">
        <button
          type="button"
          className="top-bar__link-btn"
          onClick={onOpenHelp}
          title="Help"
          aria-label="Help"
        >
          ❓
        </button>
        <button
          type="button"
          className="top-bar__settings-btn"
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Settings"
        >
          ⚙
        </button>
      </div>
    </div>
  );
}
