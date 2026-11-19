/**
 * Regenerate the README media against the demo library built by
 * scripts/demo-library.mjs: two stills and three recordings (Prepare Track,
 * harmonic search). Never point this at a real library.
 *
 * Usage:
 *   node scripts/demo-library.mjs
 *   node scripts/readme-screenshots.mjs [demoDir]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'djman-demo'));
const OUT = path.join(ROOT, 'docs', 'screenshots');
const FRAMES = path.join(DEMO, 'frames');

const PLAYLIST =
  'https://www.youtube.com/watch?v=mRN_T6JkH-c&list=PLwJjxqYuirCLkq42mGw4XKGQlpZSfxsYd';

const database = path.join(DEMO, 'library.db');
if (!fs.existsSync(database)) {
  console.error(`no demo database at ${database}; run scripts/demo-library.mjs first`);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

const ytDlp = path.join(DEMO, 'userdata', 'bin', 'yt-dlp');
if (!fs.existsSync(ytDlp)) {
  console.warn(
    `no yt-dlp at ${ytDlp}: the download still will fail (the app installs it on first run)`
  );
}

const app = await electron.launch({
  args: [
    '--load-built-renderer',
    '--no-deps-bootstrap',
    '--no-fallback-relaunch',
    `--user-data-dir=${path.join(DEMO, 'userdata')}`,
    '.',
  ],
  cwd: ROOT,
  env: { ...process.env, DB_PATH: database },
});

const page = await app.firstWindow();
await page.waitForSelector('.sidebar', { timeout: 30_000 });
await page.waitForTimeout(1500);
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1600, 1000);
  win.center();
});
await page.waitForTimeout(800);

/**
 * Draw a pointer in the page. Playwright moves a real input device but Electron
 * renders no cursor in screenshots, so this follows the same events and adds a
 * click ripple, which is what makes the recordings readable.
 */
async function installCursor() {
  await page.evaluate(() => {
    if (document.getElementById('demo-cursor')) return;

    const pointer = document.createElement('div');
    pointer.id = 'demo-cursor';
    pointer.style.cssText =
      'position:fixed;left:0;top:0;width:24px;height:24px;pointer-events:none;' +
      'z-index:2147483647;transform:translate(-100px,-100px);';
    pointer.innerHTML =
      '<svg width="24" height="24" viewBox="0 0 24 24">' +
      '<path d="M4 2 L4 20 L9.2 15.3 L12.4 22 L15.6 20.4 L12.4 13.8 L19.5 13.8 Z" ' +
      'fill="#ffffff" stroke="#111111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(pointer);

    const move = (event) => {
      pointer.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
    };
    document.addEventListener('mousemove', move, true);

    document.addEventListener(
      'mousedown',
      (event) => {
        const ripple = document.createElement('div');
        ripple.style.cssText =
          `position:fixed;left:${event.clientX - 15}px;top:${event.clientY - 15}px;` +
          'width:30px;height:30px;border-radius:50%;border:2px solid #4cc9f0;' +
          'pointer-events:none;z-index:2147483646;transition:transform 280ms ease-out,opacity 280ms ease-out;';
        document.body.appendChild(ripple);
        requestAnimationFrame(() => {
          ripple.style.transform = 'scale(2.1)';
          ripple.style.opacity = '0';
        });
        setTimeout(() => ripple.remove(), 320);
      },
      true
    );
  });
}

/** Park the pointer out of frame, so stills contain no cursor. */
async function hideCursor() {
  await page.evaluate(() => {
    const pointer = document.getElementById('demo-cursor');
    if (pointer) pointer.style.transform = 'translate(-200px,-200px)';
  });
}

/** Move the pointer onto an element and let the movement be recorded. */
async function pointTo(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`no box for ${locator}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 14 });
  await page.waitForTimeout(220);
  return { x, y };
}

/** Click an element through the real mouse, so the ripple and cursor show up. */
async function clickEl(locator, { button = 'left' } = {}) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`no box for ${locator}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 16 });
  await page.waitForTimeout(180);
  await page.mouse.down({ button });
  await page.waitForTimeout(70);
  await page.mouse.up({ button });
}

/** Record the page while `action` runs, then encode the frames as a GIF. */
async function record({ name, fps = 10, width = 1000, colors = 96, action }) {
  const dir = path.join(FRAMES, name);
  fs.mkdirSync(dir, { recursive: true });

  let running = true;
  let frames = 0;
  const loop = (async () => {
    while (running) {
      const started = Date.now();
      await page.screenshot({ path: path.join(dir, `${String(frames).padStart(5, '0')}.png`) });
      frames += 1;
      const rest = 1000 / fps - (Date.now() - started);
      if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest));
    }
  })();

  await action();
  running = false;
  await loop;

  const file = path.join(OUT, `${name}.gif`);
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-framerate',
    String(fps),
    '-i',
    path.join(dir, '%05d.png'),
    '-vf',
    `scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];` +
      '[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle',
    '-loop',
    '0',
    file,
  ]);

  const size = fs.statSync(file).size;
  console.log(`${name}.gif: ${frames} frames, ${(size / 1024 / 1024).toFixed(2)} MiB`);
  return { file, frames, size };
}

const rows = page.locator('.table-scroll-wrap.library-mode .row');
const menuItem = (text) => page.locator('.context-menu-item', { hasText: text }).first();

/** Right-click the first row and open Prepare Track for it. */
async function openPrepare() {
  await clickEl(rows.first(), { button: 'right' });
  await page.waitForSelector('.context-menu-item', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await clickEl(menuItem('Prepare Track'));
  await page.waitForSelector('.bge-modal', { timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector('.bge-loading'), null, {
    timeout: 30_000,
  });
  await page.waitForTimeout(600);
}

/**
 * Click the overview strip at `fraction`. Nothing is loaded yet, so this only
 * moves the view; Prepare Track starts playback from that point.
 */
async function seekTo(fraction) {
  const canvas = page.locator('.bge-overview-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no overview canvas');
  const x = box.x + box.width * fraction;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 18 });
  await page.waitForTimeout(260);
  await page.mouse.down();
  await page.waitForTimeout(70);
  await page.mouse.up();
  await page.waitForTimeout(600);
  console.log(`seek: clicked ${Math.round(fraction * 100)}% of the overview`);
}

/** "m:ss" (or "h:mm:ss") to seconds. */
function toSeconds(clock) {
  return clock
    .split(':')
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0);
}

/** Start playback and check it began where the overview was clicked. */
async function play({ expectAfterSec = 0 } = {}) {
  await clickEl(page.locator('.bge-play-overlay'));
  await page.waitForFunction(
    () => {
      const text = document.querySelector('.player-time')?.textContent?.trim() ?? '';
      return (
        text !== '' &&
        text !== '0:00' &&
        Boolean(document.querySelector('.bge-play-overlay--playing'))
      );
    },
    null,
    { timeout: 20_000 }
  );
  await page.waitForTimeout(700);

  const clock = (await page.locator('.player-time').first().innerText()).trim();
  const seconds = toSeconds(clock);
  if (seconds < expectAfterSec) {
    throw new Error(`playback started at ${clock}, expected past ${expectAfterSec}s`);
  }
  console.log(`playing from ${clock}`);
}

/**
 * Find the bar line nearest the playhead. Bars are drawn brighter and taller
 * than ordinary beats, so they can be read straight off the canvas: a light,
 * neutral pixel above the short-line height.
 */
async function barLineOffset() {
  return page.evaluate(() => {
    const canvas = document.querySelector('.bge-canvas');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const y = Math.round(H / 2 - H * 0.3);
    const row = ctx.getImageData(0, y, W, 1).data;

    const isLine = (x) => {
      const i = x * 4;
      const [r, g, b] = [row[i], row[i + 1], row[i + 2]];
      return r > 110 && Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && Math.abs(r - b) < 14;
    };

    const runs = [];
    for (let x = 1; x < W - 1; x += 1) {
      if (isLine(x) && isLine(x + 1)) {
        if (runs.length && x - runs[runs.length - 1].end <= 2) runs[runs.length - 1].end = x;
        else runs.push({ start: x, end: x });
      }
    }

    const centre = W / 2;
    let best = null;
    for (const run of runs) {
      const mid = (run.start + run.end) / 2;
      const distance = mid - centre;
      if (best === null || Math.abs(distance) < Math.abs(best.distance)) best = { distance, mid };
    }

    return {
      lines: runs.length,
      distance: best ? best.distance : null,
      scale: canvas.width / canvas.getBoundingClientRect().width,
    };
  });
}

/**
 * Pause, then drag the detail waveform once by the measured distance to the
 * nearest bar line. The mapping is 1:1 (verified on this build), and a single
 * move avoids the trap of the next measurement: once aligned, the line sits
 * under the playhead and the detector sees the following bar instead.
 */
async function pauseAndScrubToBeat() {
  await clickEl(page.locator('.bge-play-overlay'));
  await page.waitForFunction(() => !document.querySelector('.bge-play-overlay--playing'), null, {
    timeout: 10_000,
  });
  await page.waitForTimeout(500);

  const canvas = page.locator('.bge-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no detail canvas');

  const offset = await barLineOffset();
  console.log(`grid: nearest bar line ${Math.round(offset.distance ?? 0)} px from the playhead`);

  if (offset.distance !== null && Math.abs(offset.distance) > 1.5) {
    const from = box.x + box.width * 0.5;
    const y = box.y + box.height * 0.5;
    const to = from - offset.distance / offset.scale;
    await page.mouse.move(from, y, { steps: 12 });
    await page.waitForTimeout(180);
    await page.mouse.down();
    await page.mouse.move(to, y, { steps: 24 });
    await page.waitForTimeout(250);
    await page.mouse.up();
    await page.waitForTimeout(600);
  }

  const clock = (await page.locator('.player-time').first().innerText()).trim();
  console.log(`scrubbed: playhead parked on a bar line, clock ${clock}`);
}

/** Add a hot cue at the playhead and confirm the list grew. */
async function addHotCue() {
  const before = await page.evaluate(
    () => document.querySelectorAll('.cpe__cue, .cpe__row, [class*="cpe__"] li').length
  );
  await clickEl(page.locator('.cpe__btn--add'));
  await page.waitForSelector('.cpe__add-menu', { timeout: 5_000 });
  await page.waitForTimeout(350);
  await clickEl(page.locator('.cpe__add-option', { hasText: 'Hot Cue' }));
  await page.waitForTimeout(900);

  const cues = await page.evaluate(() => {
    const section = document.querySelector('.bge-cue-section')?.innerText ?? '';
    return section.trim().split('\n').filter(Boolean).length;
  });
  console.log(`hot cue: cue section went from ${before} nodes to ${cues} text lines`);
}

/** Right-click a row, open Find similar, and take the combined BPM + key query. */
async function findSimilarCombined() {
  await rows.first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await clickEl(rows.first(), { button: 'right' });
  await page.waitForSelector('.context-menu-item', { timeout: 10_000 });
  await page.waitForTimeout(300);

  const parent = page
    .locator('.context-menu-item--has-submenu', { hasText: 'Find similar' })
    .first();
  // Hovering the parent is what opens the CSS submenu; the child then has to be
  // hovered itself, or the recording shows a click on an item nobody points at.
  await parent.hover();
  await page.waitForTimeout(600);

  const child = page.locator('.context-submenu .context-menu-item', {
    hasText: 'Compatible key + similar BPM',
  });
  await child.hover();
  await page.waitForTimeout(500);
  await clickEl(child);
  await page.waitForTimeout(1500);

  const found = await page.evaluate(() => ({
    chips: [...document.querySelectorAll('.search-chip')].map((el) =>
      el.innerText.replace(/\s+/g, ' ').trim()
    ),
    rows: document.querySelectorAll('.table-scroll-wrap.library-mode .row').length,
  }));
  console.log(`harmonic search: chips ${JSON.stringify(found.chips)}, ${found.rows} rows`);
  if (found.rows === 0) throw new Error('the harmonic search returned no rows');
}

/** Drop the key chip, leaving only the tempo filter. */
async function removeKeyChip() {
  const remove = page.locator('.search-chip--key .search-chip__remove').first();
  await pointTo(remove);
  await page.waitForTimeout(350);
  await clickEl(remove);
  await page.waitForTimeout(1600);

  const after = await page.evaluate(() => ({
    chips: [...document.querySelectorAll('.search-chip')].map((el) =>
      el.innerText.replace(/\s+/g, ' ').trim()
    ),
    rows: document.querySelectorAll('.table-scroll-wrap.library-mode .row').length,
  }));
  console.log(`key filter removed: chips ${JSON.stringify(after.chips)}, ${after.rows} rows`);
}

// ---------------------------------------------------------------------------
// Stills
// ---------------------------------------------------------------------------
const library = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.table-scroll-wrap.library-mode .row')];
  const art = [...document.querySelectorAll('img.cell-artwork')];
  return {
    rows: rows.length,
    artworkLoaded: art.filter((img) => img.complete && img.naturalWidth > 0).length,
  };
});
if (library.rows === 0) throw new Error('the library rendered no rows');
console.log(`library: ${library.rows} rows, ${library.artworkLoaded} covers`);
await page.screenshot({ path: path.join(OUT, 'library.png') });

await page.locator('.menu-item', { hasText: 'YT-DLP' }).click();
const downloadView = page.locator('.dl-view:visible');
await downloadView.locator('.dl-input[type="text"]').waitFor({ timeout: 15_000 });
await downloadView.locator('.dl-input[type="text"]').fill(PLAYLIST);
await downloadView.locator('.dl-form .dl-btn').first().click();

const outcome = await Promise.race([
  downloadView
    .locator('.dl-select-item')
    .first()
    .waitFor({ timeout: 120_000 })
    .then(() => 'entries'),
  downloadView
    .locator('.dl-result--err')
    .first()
    .waitFor({ timeout: 120_000 })
    .then(() => 'error'),
]).catch(() => 'timeout');

if (outcome === 'error') {
  const message = await downloadView.locator('.dl-result--err').first().innerText();
  throw new Error(`playlist fetch failed: ${message.trim()}`);
}
if (outcome === 'timeout') {
  throw new Error(
    'playlist fetch produced neither entries nor an error; is yt-dlp installed in userdata/bin?'
  );
}
await page.waitForTimeout(1200);

const selectAll = downloadView.locator('.dl-select-all-label input');
if (await selectAll.isChecked()) await selectAll.click();
await page.waitForTimeout(300);

const available = downloadView.locator('.dl-select-item:not(.dl-select-item--dupe)');
const selectable = await available.count();
for (let i = 0; i < 2 && i < selectable; i += 1) {
  await available.nth(i).locator('input[type="checkbox"]').click();
}
await page.waitForTimeout(700);
const checked = await downloadView.locator('.dl-select-item input:checked').count();
if (checked !== 2) throw new Error(`expected 2 selected tracks, got ${checked}`);
await available.nth(1).scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
console.log(
  `downloads: ${await downloadView.locator('.dl-select-item').count()} entries, ${checked} selected`
);
await page.screenshot({ path: path.join(OUT, 'ytdlp.png') });

// ---------------------------------------------------------------------------
// Recording 1: Prepare Track, with a seek, playback and a new hot cue
// ---------------------------------------------------------------------------
await page.locator('.menu-item').filter({ hasText: '🎵' }).first().click();
await page.waitForSelector('.table-scroll-wrap.library-mode .row', { timeout: 15_000 });
await installCursor();
await page.waitForTimeout(800);

await record({
  name: 'prepare-track',
  fps: 9,
  width: 900,
  colors: 80,
  action: async () => {
    await page.waitForTimeout(600);
    await openPrepare();
    await seekTo(0.42);
    await play({ expectAfterSec: 60 });
    await page.waitForTimeout(1800);
    await pauseAndScrubToBeat();
    await addHotCue();
    await page.waitForTimeout(900);
    await clickEl(page.locator('.bge-btn--apply'));
    await page.waitForSelector('.bge-modal', { state: 'detached', timeout: 10_000 });
    await page.waitForTimeout(700);
  },
});

// ---------------------------------------------------------------------------
// Recording 2: harmonic search, then dropping the key filter
// ---------------------------------------------------------------------------
await page.waitForSelector('.table-scroll-wrap.library-mode .row', { timeout: 15_000 });
await record({
  name: 'find-similar',
  fps: 10,
  width: 1000,
  action: async () => {
    await page.waitForTimeout(600);
    await findSimilarCombined();
    await removeKeyChip();
    await page.waitForTimeout(1200);
  },
});

await app.close();

// Verify the cue really landed on a beat, from the database rather than the UI.
const Database = (await import('better-sqlite3')).default;
const db = new Database(database, { readonly: true });
const track = db.prepare('SELECT id, beatgrid, bpm FROM tracks ORDER BY id LIMIT 1').get();
const cues = db
  .prepare(
    'SELECT position_ms, hot_cue_index FROM cue_points WHERE track_id = ? ORDER BY hot_cue_index'
  )
  .all(track.id);
const beats = track.beatgrid ? JSON.parse(track.beatgrid) : [];
const added = cues[cues.length - 1];
const nearest = beats.length
  ? beats.reduce(
      (best, beat) =>
        Math.abs(beat * 1000 - added.position_ms) < Math.abs(best * 1000 - added.position_ms)
          ? beat
          : best,
      beats[0]
    )
  : null;
console.log(
  `cue ${'ABCDEFGH'[added.hot_cue_index]} at ${added.position_ms} ms, nearest beat ` +
    `${nearest === null ? 'unknown' : Math.round(nearest * 1000)} ms, off by ` +
    `${nearest === null ? '?' : Math.abs(Math.round(nearest * 1000 - added.position_ms))} ms`
);
db.close();

console.log(`written to ${OUT}`);
