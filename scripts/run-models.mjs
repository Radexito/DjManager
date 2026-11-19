#!/usr/bin/env node
/**
 * Run the rekordbox analysis models on real audio.
 *
 * Decodes with ffmpeg to 44.1 kHz mono float32, then runs the chain that
 * src/audio/modelInference.js describes. Needs the models extracted:
 *
 *   python3 scripts/extract-models.py
 *   node scripts/run-models.mjs track.mp3 [--seconds 60]
 *   node scripts/run-models.mjs a.mp3 b.mp3 --order projection-first
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultModelsDir } from '../src/audio/modelStore.js';
import { trackProfile, EMBEDDING_SAMPLE_RATE } from '../src/audio/modelInference.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Prints the command line to stderr and exits with the given code. */
function usage(exitCode = 1) {
  process.stderr.write(
    'usage: run-models.mjs <audio file> [more files] [--seconds N] [--order embedding-first|projection-first]\n'
  );
  process.exit(exitCode);
}

/** Parses audio paths plus the `--seconds` and `--order` flags, exiting on bad input. */
function parseArgs(argv) {
  const files = [];
  let seconds = 60;
  let order = 'embedding-first';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--seconds') {
      seconds = Number(argv[(i += 1)]);
    } else if (arg === '--order') {
      order = argv[(i += 1)];
    } else if (arg === '--help' || arg === '-h') {
      usage(0);
    } else if (arg.startsWith('-')) {
      usage();
    } else {
      files.push(arg);
    }
  }
  if (!files.length) usage();
  if (!['embedding-first', 'projection-first'].includes(order)) usage();
  if (!Number.isFinite(seconds) || seconds <= 0) usage();
  return { files, seconds, order };
}

/** Decode with ffmpeg straight into a Float32Array of mono samples. */
function decode(path, seconds) {
  return new Promise((resolvePromise, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-v',
      'error',
      '-t',
      String(seconds),
      '-i',
      path,
      '-ac',
      '1',
      '-ar',
      String(EMBEDDING_SAMPLE_RATE),
      '-f',
      'f32le',
      '-',
    ]);
    const chunks = [];
    let stderr = '';
    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 300)}`));
        return;
      }
      const buffer = Buffer.concat(chunks);
      const samples = new Float32Array(buffer.length / 4);
      for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readFloatLE(i * 4);
      resolvePromise(samples);
    });
  });
}

const topEntries = (values, count) =>
  values
    .map((value, index) => [index, value])
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([index, value]) => `${index}:${value.toFixed(3)}`)
    .join(' ');

const { files, seconds, order } = parseArgs(process.argv.slice(2));
const modelsDir = resolve(process.env.DJMANAGER_MODELS_DIR || defaultModelsDir());

if (!existsSync(join(modelsDir, 'models.manifest.json'))) {
  process.stderr.write(
    `no models in ${modelsDir}\nrun: python3 ${join(here, 'extract-models.py')} --dest ${modelsDir}\n`
  );
  process.exit(1);
}

process.stdout.write(`models: ${modelsDir}\n`);
for (const file of files) {
  const pcm = await decode(file, seconds);
  const started = Date.now();
  const profile = await trackProfile(modelsDir, pcm, { featureOrder: order });
  const elapsed = Date.now() - started;
  process.stdout.write(
    [
      `\n${file}`,
      `  decoded        ${(pcm.length / EMBEDDING_SAMPLE_RATE).toFixed(1)} s at ${EMBEDDING_SAMPLE_RATE} Hz`,
      `  frames         ${profile.frames} (frame_length ${profile.frameLength}, step ${profile.frameStep})`,
      `  danceability   ${profile.danceability.toFixed(4)}`,
      `  genre          ${profile.genre} (${order})`,
      `  genre per window ${profile.genreVotes.join(' ')}  majority ${profile.genreMajority} ` +
        `(${Math.round(profile.genreMajorityShare * 100)}% of ${profile.genreVotes.length})`,
      `  umap           ${profile.projection.map((v) => v.toFixed(3)).join(', ')}`,
      `  tags (top 6)   ${topEntries(profile.tags, 6)}`,
      `  inferred in    ${elapsed} ms`,
    ].join('\n')
  );
}
