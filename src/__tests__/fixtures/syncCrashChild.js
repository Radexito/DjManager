/**
 * A real sync job in a child process, built to be killed.
 *
 * The crash test spawns this script with a kill point. The script does the same
 * thing the export does, minus audio encoding: stage a track, stage a database,
 * publish it, commit. `process.kill(process.pid, 'SIGKILL')` at a named point is
 * the scripted interruption the acceptance criteria ask for: no cleanup runs, no
 * finally block, exactly like a pulled cable or a task manager kill.
 *
 * Usage: node syncCrashChild.js <usbRoot> <killPoint>
 * killPoint: none | plan | copy-staged | database-staged | publish-first | publish-all
 */
import fs from 'node:fs';
import path from 'node:path';

import { readLibrary } from '../../usb/pioneer/formats/pdbRead.js';
import { writePdb } from '../../usb/pioneer/formats/pdb.js';
import { startJob } from '../../sync/job.js';

const [usbRoot, killPoint = 'none'] = process.argv.slice(2);

function kill(point) {
  if (killPoint !== point) return;
  process.kill(process.pid, 'SIGKILL');
}

function tracks(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: 100 + index,
    title: `Track ${index + 1}`,
    artist: 'Artist',
    album: 'Album',
    duration: 120,
    bpm: 124,
    key_raw: '8A',
    file_path: `/Contents/t${index}.mp3`,
    track_number: index + 1,
    year: '2026',
    label: 'Label',
    genres: ['House'],
    file_size: 1_000,
    bitrate: 320_000,
    sample_rate: 44_100,
    bit_depth: 16,
    comments: '',
    rating: 0,
  }));
}

const started = startJob({
  usbRoot,
  trigger: 'test',
  fingerprint: 'child-fingerprint',
  onPhase: (phase) => {
    kill(phase);
  },
});
if (!started.ok) {
  console.error(`busy: ${started.reason}`);
  process.exit(3);
}

const job = started.job;
try {
  job.enter('copy', { pct: 5, msg: 'copying' });
  job.stageBuffer('Contents/t0.mp3', Buffer.from('audio-0'));
  kill('copy-staged');
  job.commitArtifact('Contents/t0.mp3');
  job.stageBuffer('Contents/t1.mp3', Buffer.from('audio-1'));
  job.commitArtifact('Contents/t1.mp3');

  job.enter('database', { pct: 70, msg: 'database' });
  writePdb(
    {
      usbRoot,
      tracks: tracks(2),
      playlists: [{ id: 1, name: 'Crash set', track_ids: [100, 101] }],
    },
    job.stagePath('PIONEER/rekordbox/export.pdb')
  );
  kill('database-staged');

  const entry = {
    ...job.describeStaged('PIONEER/rekordbox/export.pdb'),
    verify: (abs) => {
      if (readLibrary(fs.readFileSync(abs)).tracks.length !== 2) {
        throw new Error('staged database does not carry two tracks');
      }
    },
  };
  job.publish([entry], {
    onFilePublished: () => kill('publish-first'),
  });
  kill('publish-all');

  job.commit({ fingerprint: 'child-fingerprint', summary: { trackCount: 2 } });
  job.release();
  console.log(JSON.stringify({ ok: true, jobId: job.id, path: path.join(usbRoot) }));
} catch (err) {
  job.fail(err);
  job.release();
  console.error(err.message);
  process.exit(1);
}
