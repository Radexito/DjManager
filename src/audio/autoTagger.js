const MB_BASE = 'https://musicbrainz.org/ws/2';
const DISCOGS_BASE = 'https://api.discogs.com';
const ITUNES_BASE = 'https://itunes.apple.com';
const DEEZER_BASE = 'https://api.deezer.com';
const USER_AGENT = 'DjManager/1.0 (https://github.com/Radexito/DjManager)';

// MusicBrainz requires ≥1s between requests
let _lastMbRequest = 0;
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

async function discogsFetch(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Discogs error ${res.status}`);
  return res.json();
}

// ─── Normalise ─────────────────────────────────────────────────────────────────

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

// ─── MusicBrainz ───────────────────────────────────────────────────────────────

export async function searchMusicBrainz(query) {
  const q = encodeURIComponent(query);
  const url = `${MB_BASE}/recording?query=${q}&fmt=json&limit=10&inc=releases+artists+genres+tags`;
  const data = await mbFetch(url);

  return (data.recordings ?? []).map((rec) => {
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

    // Cover Art Archive: free, no key, uses MusicBrainz release ID
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
}

// ─── Discogs ───────────────────────────────────────────────────────────────────

export async function searchDiscogs(query) {
  const q = encodeURIComponent(query);
  const url = `${DISCOGS_BASE}/database/search?q=${q}&type=release&per_page=10`;
  const data = await discogsFetch(url);

  return (data.results ?? []).map((r) => {
    // Discogs title field is often "Artist - Album (Year)" — parse it
    const rawTitle = r.title ?? '';
    const dashIdx = rawTitle.indexOf(' - ');
    const artist = dashIdx !== -1 ? rawTitle.slice(0, dashIdx).trim() : '';
    const album = dashIdx !== -1 ? rawTitle.slice(dashIdx + 3).trim() : rawTitle;

    const genres = [...(r.genre ?? []), ...(r.style ?? [])].slice(0, 5);
    const label = Array.isArray(r.label) ? (r.label[0] ?? '') : (r.label ?? '');
    const year = r.year ? String(r.year) : '';

    // Discogs provides cover_image directly in search results
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

// ─── iTunes Search API ────────────────────────────────────────────────────────
// Free, no API key. Primarily used for cover art — returns high-quality artwork.

export async function searchItunes(query) {
  const q = encodeURIComponent(query);
  const url = `${ITUNES_BASE}/search?term=${q}&media=music&limit=10&entity=song`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`iTunes error ${res.status}`);
  const data = await res.json();

  return (data.results ?? []).map((r) => {
    // artworkUrl100 can be scaled up by replacing the size segment
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

// ─── Deezer ───────────────────────────────────────────────────────────────────
// Free, no API key. Strong catalog for electronic/dance/DJ music.
// Returns cover_xl (1000×1000) — best quality of all free sources.

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
