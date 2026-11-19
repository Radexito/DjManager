import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const downloadCss = fs.readFileSync(path.join(dirname, '../DownloadView.css'), 'utf8');
const tidalCss = fs.readFileSync(path.join(dirname, '../TidalDownloadView.css'), 'utf8');
const tidalJsx = fs.readFileSync(path.join(dirname, '../TidalDownloadView.jsx'), 'utf8');

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
