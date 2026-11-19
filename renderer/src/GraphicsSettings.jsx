import { useEffect, useState } from 'react';

/**
 * Graphics section of the settings modal.
 *
 * Three options, exactly as the plan specifies: Automatic, Force enabled, Force
 * disabled. "Force enabled" after a fallback is the one choice that needs a
 * second, explicit confirmation — it is the state that just crashed the app.
 *
 * The component asks the main process for the current state instead of holding
 * its own copy: graphics.json is the single source of truth for the whole feature.
 */

const GRAPHICS_MODES = [
  { value: 'auto', label: 'Automatic' },
  { value: 'enabled', label: 'Force enabled' },
  { value: 'disabled', label: 'Force disabled' },
];

/**
 * Settings block for hardware acceleration: pick automatic, forced-on or forced
 * off, asking for explicit risk confirmation before re-enabling acceleration
 * after a GPU crash. Changing the mode persists it and relaunches the app.
 */
export default function GraphicsSettings() {
  const [state, setState] = useState(null);
  const [mode, setMode] = useState('auto');
  const [error, setError] = useState(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(window.api?.getGraphicsState?.())
      .then((next) => {
        if (cancelled || !next) return;
        setState(next);
        setMode(next.mode ?? 'auto');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const applyMode = async (nextMode, confirmRisk = false) => {
    setError(null);
    const result = await window.api.setGraphicsMode({ mode: nextMode, confirmRisk });
    if (result?.requiresConfirmation) {
      setNeedsConfirm(true);
      setConfirmed(false);
      return;
    }
    if (!result?.ok) {
      setError(result?.error ?? 'Could not save graphics settings.');
      return;
    }
    setNeedsConfirm(false);
    await window.api.relaunchApp();
  };

  const onModeChange = (nextMode) => {
    setMode(nextMode);
    setNeedsConfirm(false);
    setConfirmed(false);
    void applyMode(nextMode);
  };

  return (
    <div className="settings-group" data-testid="graphics-settings">
      <div className="settings-group-title">Hardware acceleration</div>
      <p className="settings-group-desc">
        Automatic uses Chromium&apos;s defaults and falls back to software rendering after repeated
        GPU crashes. Force enabled ignores that fallback — use it only if you know your driver is
        stable. Force disabled turns acceleration off permanently.
      </p>

      <div className="settings-row">
        <label htmlFor="graphics-mode">Graphics mode</label>
        <select
          id="graphics-mode"
          className="settings-select"
          value={mode}
          onChange={(event) => onModeChange(event.target.value)}
        >
          {GRAPHICS_MODES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {state?.notice === 'gpu-crash' && (
        <p className="settings-group-desc" data-testid="graphics-fallback-note">
          Acceleration is currently off because the GPU process crashed{' '}
          {state.crashCount ? `${state.crashCount} time(s)` : 'recently'}.
        </p>
      )}

      {needsConfirm && (
        <div className="settings-group" data-testid="graphics-confirm">
          <p className="settings-group-desc">
            Hardware acceleration was disabled after a GPU crash. Re-enabling it may crash the app
            again.
          </p>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{' '}
            I understand the risk
          </label>
          <div className="settings-row">
            <button
              type="button"
              className="btn-primary"
              disabled={!confirmed}
              onClick={() => void applyMode('enabled', true)}
            >
              Enable anyway
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="settings-group-desc" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
