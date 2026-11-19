import { describe, expect, it, vi } from 'vitest';

vi.mock('../audio/tidalDlManager.js', () => ({
  downloadTidal: vi.fn(),
  reindexTidalEntries: (entries = []) => entries.map((entry, index) => ({ ...entry, index })),
}));
vi.mock('../audio/importManager.js', () => ({ importAudioFile: vi.fn() }));
vi.mock('../db/playlistRepository.js', () => ({
  addTrackToPlaylist: vi.fn(),
  findOrCreatePlaylist: vi.fn(),
}));

const { createTidalImportService } = await import('../main/services/tidalImportService.js');

const service = createTidalImportService({ send: () => {}, getTempDir: () => '/tmp/userdata' });

describe('createTidalImportService', () => {
  it('refuses to build without a scratch directory', () => {
    expect(() => createTidalImportService({})).toThrow('getTempDir is required');
  });
});

describe('tidalEntryUrl', () => {
  it('prefers the URL an account collection already carries', () => {
    expect(service.tidalEntryUrl({ url: 'https://tidal.com/browse/track/9', id: 1 })).toBe(
      'https://tidal.com/browse/track/9'
    );
  });

  it('builds the conventional track URL from an id and gives up without either', () => {
    expect(service.tidalEntryUrl({ id: 42 })).toBe('https://tidal.com/browse/track/42');
    expect(service.tidalEntryUrl({})).toBeNull();
    expect(service.tidalEntryUrl(null)).toBeNull();
  });
});

describe('tidalCollectionUrl', () => {
  it('maps every collection type to its browse URL', () => {
    expect(service.tidalCollectionUrl('playlist', 1)).toBe('https://tidal.com/browse/playlist/1');
    expect(service.tidalCollectionUrl('mix', 2)).toBe('https://tidal.com/browse/mix/2');
    expect(service.tidalCollectionUrl('album', 3)).toBe('https://tidal.com/browse/album/3');
    expect(service.tidalCollectionUrl('artist', 4)).toBe('https://tidal.com/browse/artist/4');
  });

  it('falls back to the collection page for an unknown type', () => {
    expect(service.tidalCollectionUrl('nonsense', 5)).toBe('https://tidal.com/my-collection');
  });
});
