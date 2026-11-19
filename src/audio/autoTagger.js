/** MusicBrainz web service root; recording search lives under /recording. */
const MB_BASE = 'https://musicbrainz.org/ws/2';
/** Discogs API root (database search only — no auth token is used). */
const DISCOGS_BASE = 'https://api.discogs.com';
/** iTunes Search API root, queried with entity=song. */
const ITUNES_BASE = 'https://itunes.apple.com';
/** Deezer public API root, queried with /search. */
const DEEZER_BASE = 'https://api.deezer.com';
/** User agent for every metadata request; MusicBrainz rejects calls that go without one. */
const USER_AGENT = 'DjManager/1.0 (https://github.com/Radexito/DjManager)';

/** Time of the last MusicBrainz request (ms since epoch), used to space the calls out. */
let _lastMbRequest = 0;
/**
 * Fetch JSON from MusicBrainz, waiting out the ~1.1 s gap its rate limit asks
 * for, then recording the request time.
 * @param {string} url
 * @returns {Promise<object>}
 */
async function mbFetch(url) {
  const wait = 1100 - (Date.now() - _lastMbRequest);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastMbRequest = Date.now();
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`MusicBrainz error ${res.status}`);
  return res.json();
}

/**
 * Fetch JSON from Discogs.
 * @param {string} url
 * @returns {Promise<object>}
 */
async function discogsFetch(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Discogs error ${res.status}`);
  return res.json();
}

/**
 * Check that a cover art URL really answers (HEAD, no body) so the UI is not
 * offered images that 404.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function coverArtExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fill in every field of a search hit, so the four providers hand the renderer
 * the same shape instead of their own.
 * @param {object} fields
 * @returns {{source: string, url: string, title: string, artist: string, album: string,
 *            label: string, year: string, genres: string[], key: string, coverUrl: string}}
 */
function normalise(fields) {
  return {
    source: fields.source ?? '',
    url: fields.url ?? '',
    title: fields.title ?? '',
    artist: fields.artist ?? '',
    album: fields.album ?? '',
    label: fields.label ?? '',
    year: fields.year ? String(fields.year) : '',
    genres: Array.isArray(fields.genres) ? fields.genres : [],
    key: fields.key ?? '',
    coverUrl: fields.coverUrl ?? '',
  };
}

/**
 * Search MusicBrainz recordings and map them to the common hit shape, including
 * the release's label, genres and a Cover Art Archive URL that was checked.
 * @param {string} query - free text, usually "artist title"
 * @returns {Promise<Array<object>>} up to 10 hits
 */
export async function searchMusicBrainz(query) {
  const q = encodeURIComponent(query);
  const url = `${MB_BASE}/recording?query=${q}&fmt=json&limit=10&inc=releases+artists+genres+tags`;
  const data = await mbFetch(url);

  const mapped = (data.recordings ?? []).map((rec) => {
    const artists = (rec['artist-credit'] ?? [])
      .map((ac) => (typeof ac === 'object' ? (ac.name ?? ac.artist?.name) : ac))
      .filter(Boolean)
      .join(', ');

    const release = (rec.releases ?? [])[0] ?? {};
    const label = (release['label-info'] ?? [])[0]?.label?.name ?? '';

    const genres = [
      ...(rec.genres ?? []).map((g) => g.name),
      ...(rec.tags ?? []).map((t) => t.name),
    ].slice(0, 5);

    const year = release.date?.slice(0, 4) ?? rec['first-release-date']?.slice(0, 4) ?? '';

    const coverUrl = release.id
      ? `https://coverartarchive.org/release/${release.id}/front-500`
      : '';

    return normalise({
      source: 'MusicBrainz',
      url: `https://musicbrainz.org/recording/${rec.id}`,
      title: rec.title,
      artist: artists,
      album: release.title ?? '',
      label,
      year,
      genres,
      coverUrl,
    });
  });

  await Promise.all(
    mapped.map(async (r) => {
      if (r.coverUrl && !(await coverArtExists(r.coverUrl))) r.coverUrl = '';
    })
  );

  return mapped;
}

/**
 * Search Discogs releases. Discogs reports "Artist - Album" as one title, so the
 * artist is split off here when the dash is present.
 * @param {string} query
 * @returns {Promise<Array<object>>} up to 10 hits
 */
export async function searchDiscogs(query) {
  const q = encodeURIComponent(query);
  const url = `${DISCOGS_BASE}/database/search?q=${q}&type=release&per_page=10`;
  const data = await discogsFetch(url);

  return (data.results ?? []).map((r) => {
    const rawTitle = r.title ?? '';
    const dashIdx = rawTitle.indexOf(' - ');
    const artist = dashIdx !== -1 ? rawTitle.slice(0, dashIdx).trim() : '';
    const album = dashIdx !== -1 ? rawTitle.slice(dashIdx + 3).trim() : rawTitle;

    const genres = [...(r.genre ?? []), ...(r.style ?? [])].slice(0, 5);
    const label = Array.isArray(r.label) ? (r.label[0] ?? '') : (r.label ?? '');
    const year = r.year ? String(r.year) : '';

    const coverUrl = r.cover_image ?? '';

    return normalise({
      source: 'Discogs',
      url: r.resource_url ? `https://www.discogs.com/release/${r.id}` : '',
      title: album,
      artist,
      album,
      label,
      year,
      genres,
      coverUrl,
    });
  });
}

/**
 * Search the iTunes store for songs, upgrading the 100 px artwork to 600 px.
 * @param {string} query
 * @returns {Promise<Array<object>>} up to 10 hits
 */
export async function searchItunes(query) {
  const q = encodeURIComponent(query);
  const url = `${ITUNES_BASE}/search?term=${q}&media=music&limit=10&entity=song`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`iTunes error ${res.status}`);
  const data = await res.json();

  return (data.results ?? []).map((r) => {
    const coverUrl = r.artworkUrl100 ? r.artworkUrl100.replace('100x100bb', '600x600bb') : '';

    return normalise({
      source: 'iTunes',
      url: r.trackViewUrl ?? '',
      title: r.trackName ?? '',
      artist: r.artistName ?? '',
      album: r.collectionName ?? '',
      label: '',
      year: r.releaseDate ? String(new Date(r.releaseDate).getFullYear()) : '',
      genres: r.primaryGenreName ? [r.primaryGenreName] : [],
      coverUrl,
    });
  });
}

/**
 * Search Deezer tracks. Deezer has no label or year on this endpoint, so those
 * fields stay empty.
 * @param {string} query
 * @returns {Promise<Array<object>>} up to 10 hits
 */
export async function searchDeezer(query) {
  const q = encodeURIComponent(query);
  const url = `${DEEZER_BASE}/search?q=${q}&limit=10`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Deezer error ${res.status}`);
  const data = await res.json();

  return (data.data ?? []).map((r) => {
    const coverUrl = r.album?.cover_xl ?? r.album?.cover_big ?? '';
    return normalise({
      source: 'Deezer',
      url: r.link ?? '',
      title: r.title ?? '',
      artist: r.artist?.name ?? '',
      album: r.album?.title ?? '',
      label: '',
      year: '',
      genres: [],
      coverUrl,
    });
  });
}
