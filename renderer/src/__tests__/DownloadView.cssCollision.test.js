import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const downloadCss = fs.readFileSync(path.join(dirname, '../DownloadView.css'), 'utf8');
const tidalCss = fs.readFileSync(path.join(dirname, '../TidalDownloadView.css'), 'utf8');
const tidalJsx = fs.readFileSync(path.join(dirname, '../TidalDownloadView.jsx'), 'utf8');

// Regression for #406: TidalDownloadView.jsx imports both DownloadView.css and
// TidalDownloadView.css into the same global stylesheet cascade (plain CSS, not
// scoped per-component). Reusing a class name across the two files with
// conflicting rules lets one silently clobber the other app-wide, not just
// within the owning component. `.dl-track-row`/`.dl-track-title` collided this
// way — Tidal's 3-column grid overrode DownloadView's 2-column grid, squeezing
// the YT-DLP download progress table's title column down to 20px and truncating
// names to 1-2 characters.
describe('DownloadView / TidalDownloadView CSS — no track-row class collisions', () => {
  it('TidalDownloadView.css does not redefine .dl-track-row or .dl-track-title', () => {
    expect(tidalCss.includes('.dl-track-row')).toBe(false);
    expect(tidalCss.includes('.dl-track-title')).toBe(false);
  });

  it('DownloadView.css still owns .dl-track-row and .dl-track-title', () => {
    expect(downloadCss.includes('.dl-track-row')).toBe(true);
    expect(downloadCss.includes('.dl-track-title')).toBe(true);
  });

  it('TidalDownloadView.jsx uses tidal-prefixed classes instead of the shared names', () => {
    expect(tidalJsx.includes('dl-track-row')).toBe(false);
    expect(tidalJsx.includes('dl-track-title')).toBe(false);
    expect(tidalJsx.includes('tidal-track-row')).toBe(true);
    expect(tidalJsx.includes('tidal-track-title')).toBe(true);
  });
});
