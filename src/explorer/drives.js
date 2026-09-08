import fs from 'node:fs';

/**
 * Enumerate present Windows drive roots ("C:\", "D:\", ...) without spawning
 * a shell — 26 stat calls, no admin rights needed. Drives that exist but are
 * inaccessible (empty card readers, disconnected network drives) are skipped.
 *
 * @param {{platform?: string, existsSync?: (p: string) => boolean}} [opts]
 *   injectable for tests
 * @returns {string[]} drive roots, e.g. ['C:\\', 'D:\\']
 */
export function detectWindowsDrives({
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  if (platform !== 'win32') return [];
  const roots = [];
  for (let i = 0; i < 26; i++) {
    const root = `${String.fromCharCode(65 + i)}:\\`;
    try {
      if (existsSync(root)) roots.push(root);
    } catch {
      // drive present but not accessible — skip it
    }
  }
  return roots;
}
