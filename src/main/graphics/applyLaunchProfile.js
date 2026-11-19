/**
 * Applies a resolved launch profile to Electron. Split from the decision so the
 * decision stays testable without an Electron runtime; this part only forwards.
 *
 * Must run before the `ready` event, otherwise Chromium has already started and
 * both the acceleration flag and the switches are ignored.
 */
export function applyLaunchProfile(app, profile) {
  if (!app) throw new Error('applyLaunchProfile: an Electron app instance is required');
  if (!profile) throw new Error('applyLaunchProfile: a resolved launch profile is required');

  if (!profile.hardwareAcceleration) app.disableHardwareAcceleration();

  for (const entry of profile.switches ?? []) {
    if (!entry?.name) continue;
    if (entry.value === undefined) app.commandLine.appendSwitch(entry.name);
    else app.commandLine.appendSwitch(entry.name, entry.value);
  }

  return profile;
}
