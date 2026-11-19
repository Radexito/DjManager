import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('searchMusicBrainz cover art validation', () => {
  let searchMusicBrainz;

  beforeEach(async () => {
    vi.resetModules();
    ({ searchMusicBrainz } = await import('../audio/autoTagger.js'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears coverUrl for release ids whose Cover Art Archive image 404s', async () => {
    const mbResponse = {
      recordings: [
        {
          id: 'rec-1',
          title: 'Track One',
          'artist-credit': [{ name: 'Artist A' }],
          releases: [{ id: 'release-ok', title: 'Album A', date: '2020-01-01' }],
        },
        {
          id: 'rec-2',
          title: 'Track Two',
          'artist-credit': [{ name: 'Artist B' }],
          releases: [{ id: 'release-404', title: 'Album B', date: '2019-01-01' }],
        },
      ],
    };

    global.fetch = vi.fn((url, opts) => {
      if (opts?.method === 'HEAD') {
        return Promise.resolve({ ok: url.includes('release-ok') });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(mbResponse) });
    });

    const results = await searchMusicBrainz('artist a track one');

    expect(results[0].coverUrl).toBe('https://coverartarchive.org/release/release-ok/front-500');
    expect(results[1].coverUrl).toBe('');
  });
});
