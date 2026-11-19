/**
 * Build the demonstration library used for README screenshots.
 *
 * The tracks are real, freely distributable chiptune releases from the public
 * "8-Bit No Copyright Music" YouTube playlist, downloaded with yt-dlp. BPM, key,
 * loudness and the beat grid come from the app's own analyzer, and the waveforms
 * from the app's own generator, so nothing in the screenshots is invented.
 * Cover art is CC0/public domain, fetched from Openverse.
 *
 * Usage:
 *   node scripts/demo-library.mjs [targetDir]
 *
 * Requirements: yt-dlp and ffmpeg on PATH. The analyzer is optional; without it
 * the tracks are seeded unanalyzed instead of carrying made-up numbers.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'djman-demo'));
const DOWNLOADS = path.join(DEMO, 'downloads');
const ART = path.join(DEMO, 'userdata', 'artwork');
const SYNTH = path.join(DEMO, 'synth');

const PLAYLIST =
  'https://www.youtube.com/watch?v=mRN_T6JkH-c&list=PLwJjxqYuirCLkq42mGw4XKGQlpZSfxsYd';
const TRACK_LIMIT = 20;

const PLAYLISTS = [
  ['Riverside Festival 2025 · Main Stage', '#e5383b'],
  ['Warehouse, Berlin · Night 2', '#8338ec'],
  ['Sunset Boat Party, Amsterdam', '#ffb703'],
  ['Chiptune 120-150', '#00b4d8'],
  ['8-Bit Classics', '#2a9d8f'],
  ['Mix · Best No Copyright 8-bit Music 2025', '#f77f00'],
];

/**
 * Extra synthetic tracks around Night Shade (140 BPM, 8A). The audio is a triad
 * for the intended key plus a kick at the intended tempo, and the analyzer
 * reports the key and BPM itself, so the metadata is measured, not asserted.
 * Four are harmonically compatible with 8A, four are not, which is what makes
 * "remove the key filter" visible in the README recording.
 */
const SYNTH_TRACKS = [
  ['Midnight Ferry', 'Aster Vale', 'Night Service Edits', [220.0, 261.63, 329.63], 138],
  ['Low Tide', 'Mira Onyx', 'Night Service Edits', [164.81, 392.0, 493.88], 142],
  ['Glass Corridor', 'Nordwell', 'Night Service Edits', [146.83, 349.23, 440.0], 140],
  ['Paper Lanterns', 'Palewood', 'Night Service Edits', [130.81, 329.63, 392.0], 136],
  ['Iron Bloom', 'Vantor', 'Static Gardens', [138.59, 329.63, 415.3], 140],
  ['Salt Flats', 'Halden', 'Static Gardens', [174.61, 415.3, 523.25], 138],
  ['Cold Signal', 'Kessa', 'Outer Rim', [196.0, 466.16, 587.33], 142],
  ['Tunnel Vision', 'Tessellate', 'Paper Trails', [233.08, 587.33, 698.46], 136],
];

const COVER_QUERIES = [
  'neon lights abstract',
  'sunset over hills',
  'misty forest',
  'concrete texture',
  'city at night rain',
  'paper texture',
  'desert dunes',
  'harbour at dusk',
  'snowy street',
  'vinyl records',
  'arcade machines',
  'analog synthesizer',
];

fs.mkdirSync(DOWNLOADS, { recursive: true });
fs.mkdirSync(ART, { recursive: true });
fs.mkdirSync(SYNTH, { recursive: true });
// Every run starts from an empty library; the downloaded audio and the app's
// own binaries under userdata/bin stay where they are.
for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(path.join(DEMO, `library.db${suffix}`), { force: true });
}
process.env.DB_PATH = path.join(DEMO, 'library.db');

/** Download the playlist once; yt-dlp skips files it already has. */
function downloadPlaylist() {
  console.log(`downloading ${PLAYLIST}`);
  execFileSync(
    process.env.YTDLP ?? 'yt-dlp',
    [
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '320K',
      '--ignore-errors',
      '--download-archive',
      path.join(DOWNLOADS, '.archive.txt'),
      '--write-info-json',
      '--write-thumbnail',
      '--convert-thumbnails',
      'jpg',
      '-o',
      // Absolute, so a failed download can never spill files into the repo.
      path.join(DOWNLOADS, '%(playlist_index)02d - %(title).70s.%(ext)s'),
      PLAYLIST,
    ],
    { stdio: 'inherit', cwd: DOWNLOADS }
  );
}

/** Read one downloaded track: its metadata file and the audio path. */
function readTrack(infoPath) {
  const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  const audio = infoPath.replace(/\.info\.json$/, '.mp3');
  if (!fs.existsSync(audio)) return null;

  const cleaned = String(info.title ?? '')
    .replace(/♫.*$/, '')
    .trim()
    .replace(/\s+-\s*$/, '');
  const parts = cleaned.split(/\s+-\s+/);
  const artist = parts.length > 1 ? parts[0].trim() : (info.uploader ?? 'Unknown');
  const title = parts.length > 1 ? parts.slice(1).join(' - ').trim() : cleaned;

  return {
    audio,
    videoId: info.id ?? audio,
    title: title || path.basename(audio, '.mp3'),
    artist,
    album: info.playlist_title ?? '8-Bit No Copyright Music',
    duration: Number(info.duration) || 0,
    source: info.webpage_url ?? '',
  };
}

let infos = fs
  .readdirSync(DOWNLOADS)
  .filter((name) => name.endsWith('.info.json') && !name.startsWith('00 - '))
  .sort();

if (infos.length === 0) {
  try {
    downloadPlaylist();
  } catch (error) {
    console.warn(`yt-dlp exited with ${error.status ?? 'an error'}; using what is on disk`);
  }
  infos = fs
    .readdirSync(DOWNLOADS)
    .filter((name) => name.endsWith('.info.json') && !name.startsWith('00 - '))
    .sort();
}

// A playlist can list the same video twice; a library should not.
const seen = new Set();
const tracks = infos
  .map((name) => readTrack(path.join(DOWNLOADS, name)))
  .filter(Boolean)
  .filter((track) => {
    if (seen.has(track.videoId)) return false;
    seen.add(track.videoId);
    return true;
  })
  .slice(0, TRACK_LIMIT);

if (tracks.length === 0) {
  console.error(`no tracks in ${DOWNLOADS}; is yt-dlp installed?`);
  process.exit(1);
}

const analyzer = [
  process.env.ANALYZER,
  path.join(DEMO, 'userdata', 'bin', 'analysis'),
  path.join(ROOT, 'build-resources', 'analysis'),
].find((candidate) => candidate && fs.existsSync(candidate));

if (!analyzer) {
  console.warn('analyzer not found: tracks will be seeded without BPM, key or beat grid');
}

/** Cover art from Openverse, restricted to CC0 and public domain. */
const coverCache = new Map();
async function coverFor(artist, index) {
  if (coverCache.has(artist)) return coverCache.get(artist);
  const file = path.join(ART, `${artist.replace(/\W+/g, '-').toLowerCase()}.png`);

  let credit = 'generated gradient';
  try {
    const api = new URL('https://api.openverse.org/v1/images/');
    api.searchParams.set('q', COVER_QUERIES[index % COVER_QUERIES.length]);
    api.searchParams.set('license', 'cc0,pdm');
    api.searchParams.set('page_size', '8');
    const body = await (
      await fetch(api, { headers: { 'User-Agent': 'djmanager-demo/1.0' } })
    ).json();

    for (const result of body.results ?? []) {
      if (!result.url || (result.width && result.width < 400)) continue;
      const image = await fetch(result.url, { headers: { 'User-Agent': 'djmanager-demo/1.0' } });
      if (!image.ok) continue;
      const raw = `${file}.source`;
      fs.writeFileSync(raw, Buffer.from(await image.arrayBuffer()));
      execFileSync('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-i',
        raw,
        '-vf',
        'scale=600:600:force_original_aspect_ratio=increase,crop=600:600',
        '-frames:v',
        '1',
        file,
      ]);
      fs.rmSync(raw);
      credit = `${result.title ?? 'untitled'} (${result.license}, ${result.source ?? 'openverse'})`;
      break;
    }
  } catch (error) {
    console.warn(`cover fetch failed for ${artist}: ${error.message}`);
  }

  if (!fs.existsSync(file)) {
    const initials = artist
      .split(/\s+/)
      .map((word) => word[0])
      .join('')
      .toUpperCase()
      .slice(0, 3);
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'gradients=s=600x600:c0=0x10243a:c1=0x2f6f8f:x0=0:y0=0:x1=600:y1=600',
      '-vf',
      `drawtext=text='${initials}':fontcolor=white@0.85:fontsize=190:x=(w-text_w)/2:y=(h-text_h)/2`,
      '-frames:v',
      '1',
      file,
    ]);
  }

  const entry = { file, credit };
  coverCache.set(artist, entry);
  return entry;
}

const { initDB } = await import(`${ROOT}/src/db/migrations.js`);
const { default: db } = await import(`${ROOT}/src/db/database.js`);
const { generateEditorWaveform } = await import(`${ROOT}/src/audio/waveformGenerator.js`);

initDB();
const library = db.prepare('SELECT id FROM libraries ORDER BY id LIMIT 1').get();
// The media server only serves allowlisted roots, so the library root has to be
// the folder the demo audio actually lives in, or playback comes back as 403.
if (library) {
  db.prepare('UPDATE libraries SET root_path = ? WHERE id = ?').run(DOWNLOADS, library.id);
}

const insertTrack = db.prepare(`
  INSERT INTO tracks (
    title, artist, album, year, label, genres, bpm, key_raw, key_camelot,
    loudness, replay_gain, intro_secs, outro_secs, beatgrid, duration, bitrate,
    format, file_path, file_hash, analyzed, rating, comments, library_id,
    waveform_overview, waveform_detail_hires, beatgrid_offset, has_artwork,
    artwork_path, source_url, source_platform, created_at
  ) VALUES (
    @title, @artist, @album, @year, @label, @genres, @bpm, @key_raw, @key_camelot,
    @loudness, @replay_gain, @intro_secs, @outro_secs, @beatgrid, @duration, @bitrate,
    @format, @file_path, @file_hash, @analyzed, @rating, @comments, @library_id,
    @waveform_overview, @waveform_detail_hires, 0, 1,
    @artwork_path, @source_url, 'youtube', @created_at
  )
`);

const ids = [];
for (const [index, track] of tracks.entries()) {
  const cover = await coverFor(track.artist, index);

  // One analyzer run per file, cached next to the audio, so re-seeding is cheap.
  let analysis = null;
  const cachedAnalysis = `${track.audio}.analysis.json`;
  if (fs.existsSync(cachedAnalysis)) {
    analysis = JSON.parse(fs.readFileSync(cachedAnalysis, 'utf8'));
  } else if (analyzer) {
    try {
      const { stdout } = await run(analyzer, ['--json', track.audio], {
        maxBuffer: 64 * 1024 * 1024,
      });
      analysis = JSON.parse(stdout)?.[0] ?? null;
      if (analysis) fs.writeFileSync(cachedAnalysis, JSON.stringify(analysis));
    } catch (error) {
      console.warn(`analysis failed for ${track.title}: ${error.message}`);
    }
  }

  const wave = await generateEditorWaveform(track.audio, 'ffmpeg');
  const info = insertTrack.run({
    title: track.title,
    artist: track.artist,
    album: track.album,
    year: 2025,
    label: '',
    genres: JSON.stringify(['Chiptune']),
    bpm: analysis?.bpm ?? null,
    key_raw: analysis?.key ?? null,
    key_camelot: analysis?.camelot ?? null,
    loudness: analysis?.lufs ?? null,
    replay_gain: analysis?.replayGain ?? null,
    intro_secs: analysis?.introSecs ?? null,
    outro_secs: analysis?.outroSecs ?? null,
    beatgrid: analysis?.beatgrid ? JSON.stringify(analysis.beatgrid) : null,
    duration: track.duration,
    bitrate: 320,
    format: 'mp3',
    file_path: track.audio,
    file_hash: `demo${String(index).padStart(4, '0')}`,
    analyzed: analysis ? 1 : 0,
    rating: (index % 5) + 1,
    comments: '',
    library_id: library?.id ?? null,
    waveform_overview: wave.overview,
    waveform_detail_hires: wave.detailHires,
    artwork_path: cover.file,
    source_url: track.source,
    created_at: Date.now() - index * 3_600_000,
  });

  ids.push(Number(info.lastInsertRowid));
  console.log(
    `  ${index + 1}. ${track.artist} - ${track.title} | ${analysis?.bpm ?? '?'} BPM ${analysis?.camelot ?? ''}`
  );
}

// Synthetic companions, so harmonic filtering has something to show.
for (const [title, artist, album, [f1, f2, f3], bpm] of SYNTH_TRACKS) {
  const file = path.join(SYNTH, `${artist} - ${title}.mp3`);
  const beat = (60 / bpm).toFixed(4);
  const expr = [
    `0.20*sin(2*PI*${f1}*t)`,
    `0.14*sin(2*PI*${f2}*t)`,
    `0.14*sin(2*PI*${f3}*t)`,
    `0.35*sin(2*PI*55*t)*exp(-7*mod(t\\,${beat}))`,
  ].join('+');

  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=exprs=${expr}:s=44100:d=150`,
    '-ac',
    '2',
    '-b:a',
    '320k',
    file,
  ]);

  let analysis = null;
  const cachedAnalysis = `${file}.analysis.json`;
  if (fs.existsSync(cachedAnalysis)) {
    analysis = JSON.parse(fs.readFileSync(cachedAnalysis, 'utf8'));
  } else if (analyzer) {
    try {
      const { stdout } = await run(analyzer, ['--json', file], { maxBuffer: 64 * 1024 * 1024 });
      analysis = JSON.parse(stdout)?.[0] ?? null;
      if (analysis) fs.writeFileSync(cachedAnalysis, JSON.stringify(analysis));
    } catch (error) {
      console.warn(`analysis failed for ${title}: ${error.message}`);
    }
  }

  const wave = await generateEditorWaveform(file, 'ffmpeg');
  const cover = await coverFor(artist, ids.length);
  const info = insertTrack.run({
    title,
    artist,
    album,
    year: 2025,
    label: '',
    genres: JSON.stringify(['Chiptune']),
    bpm: analysis?.bpm ?? bpm,
    key_raw: analysis?.key ?? null,
    key_camelot: analysis?.camelot ?? null,
    loudness: analysis?.lufs ?? null,
    replay_gain: analysis?.replayGain ?? null,
    intro_secs: analysis?.introSecs ?? null,
    outro_secs: analysis?.outroSecs ?? null,
    beatgrid: analysis?.beatgrid ? JSON.stringify(analysis.beatgrid) : null,
    duration: 150,
    bitrate: 320,
    format: 'mp3',
    file_path: file,
    file_hash: `synth${String(ids.length).padStart(4, '0')}`,
    analyzed: analysis ? 1 : 0,
    rating: (ids.length % 5) + 1,
    comments: '',
    library_id: library?.id ?? null,
    waveform_overview: wave.overview,
    waveform_detail_hires: wave.detailHires,
    artwork_path: cover.file,
    source_url: '',
    created_at: Date.now() - ids.length * 3_600_000,
  });

  ids.push(Number(info.lastInsertRowid));
  console.log(
    `  + ${artist} - ${title} | ${analysis?.bpm ?? bpm} BPM ${analysis?.camelot ?? '?'} (${analysis?.key ?? '?'})`
  );
}

const first = ids[0];
if (first) {
  const cueStmt = db.prepare(
    `INSERT INTO cue_points (track_id, position_ms, label, color, hot_cue_index, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const cues = [
    [12_000, 'Intro', '#00b4d8', 0],
    [46_000, 'Drop', '#e5383b', 1],
    [92_000, 'Break', '#ffb703', 2],
    [140_000, 'Outro', '#8338ec', 3],
  ];
  for (const [ms, label, color, hot] of cues) cueStmt.run(first, ms, label, color, hot, Date.now());
}

const insertPlaylist = db.prepare(
  'INSERT INTO playlists (name, color, created_at) VALUES (?, ?, ?)'
);
const insertEntry = db.prepare(
  'INSERT INTO playlist_tracks (playlist_id, track_id, position, date_added) VALUES (?, ?, ?, ?)'
);
PLAYLISTS.forEach(([name, color], playlistIndex) => {
  const playlistId = Number(insertPlaylist.run(name, color, Date.now()).lastInsertRowid);
  ids
    .filter((_, i) => i % PLAYLISTS.length === playlistIndex)
    .forEach((trackId, position) => insertEntry.run(playlistId, trackId, position, Date.now()));
});

console.log(
  `\ntracks: ${ids.length} | playlists: ${PLAYLISTS.length} | covers: ${coverCache.size}`
);
console.log('cover credits:');
for (const [artist, entry] of coverCache) console.log(`  ${artist}: ${entry.credit}`);
console.log(`database: ${process.env.DB_PATH}`);
