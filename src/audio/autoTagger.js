const MB_BASE = 'https://musicbrainz.org/ws/2';
const DISCOGS_BASE = 'https://api.discogs.com';
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

    return normalise({
      source: 'MusicBrainz',
      url: `https://musicbrainz.org/recording/${rec.id}`,
      title: rec.title,
      artist: artists,
      album: release.title ?? '',
      label,
      year,
      genres,
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

    return normalise({
      source: 'Discogs',
      url: r.resource_url ? `https://www.discogs.com/release/${r.id}` : '',
      title: album,
      artist,
      album,
      label,
      year,
      genres,
    });
  });
}
