// src/__tests__/folderSyncProgress.test.js
// #516 — the folder sync's own counter: a real total, monotonic phases, a
// terminal `done === total` frame and a clearing event. Pure, no fs, no DB.
import { describe, it, expect } from 'vitest';
import {
  createFolderSyncProgress,
  FOLDER_SYNC_PHASES,
  FOLDER_SYNC_PROGRESS_MIN_MS,
} from '../library/folderSyncProgress.js';

/** Injectable clock so the throttle can be tested without waiting. */
function makeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

const collect = () => {
  const events = [];
  const clock = makeClock();
  const progress = createFolderSyncProgress({
    playlistId: 'pl-1',
    emit: (data) => events.push(data),
    now: clock.now,
  });
  return { events, clock, progress };
};

describe('createFolderSyncProgress', () => {
  it('announces the total up front, at zero done', () => {
    const { events, progress } = collect();
    progress.start(118);
    expect(events).toEqual([{ playlistId: 'pl-1', phase: 'linking', done: 0, total: 118 }]);
  });

  it('throttles: steps inside the window stay quiet, the window edge reports', () => {
    const { events, clock, progress } = collect();
    progress.start(3);

    progress.step('/m/a.mp3');
    clock.advance(100);
    progress.step('/m/b.mp3');
    expect(events).toHaveLength(1); // nothing since start

    clock.advance(FOLDER_SYNC_PROGRESS_MIN_MS - 100);
    progress.step('/m/c.mp3');
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      playlistId: 'pl-1',
      phase: 'linking',
      done: 3,
      total: 3,
      file: '/m/c.mp3',
    });
    expect(FOLDER_SYNC_PROGRESS_MIN_MS).toBeGreaterThanOrEqual(500);
    expect(FOLDER_SYNC_PROGRESS_MIN_MS).toBeLessThanOrEqual(750);
  });

  it('never reports more progress than there is work', () => {
    const { events, progress } = collect();
    progress.start(2);
    for (let i = 0; i < 5; i++) progress.step(`/m/${i}.mp3`);
    progress.setPhase('adding');
    for (const event of events) expect(event.done).toBeLessThanOrEqual(event.total);
    expect(events.at(-1)).toEqual({
      playlistId: 'pl-1',
      phase: 'adding',
      done: 2,
      total: 2,
    });
  });

  it('emits linking, adding, done in order, then the clearing event', () => {
    const { events, clock, progress } = collect();
    progress.start(4);
    clock.advance(700);
    progress.step('/m/a.mp3');
    clock.advance(700);
    progress.step('/m/b.mp3');
    progress.setPhase('adding');
    progress.finish();

    const phases = events.filter(Boolean).map((e) => e.phase);
    expect(phases).toEqual(['linking', 'linking', 'linking', 'adding', 'done']);

    const order = phases.map((p) => FOLDER_SYNC_PHASES.indexOf(p));
    expect(order).toEqual([...order].sort((a, b) => a - b));

    const terminal = events.at(-2);
    expect(terminal).toEqual({ playlistId: 'pl-1', phase: 'done', done: 4, total: 4 });
    expect(events.at(-1)).toBeNull(); // the clearing event `export-m3u-progress` uses
  });

  it('leaves nothing on screen: finish() always terminates with a clear', () => {
    const { events, progress } = collect();
    progress.start(9);
    progress.step('/m/a.mp3');
    progress.finish();
    expect(events.at(-1)).toBeNull();
    expect(events.at(-2)).toMatchObject({ phase: 'done', done: 9, total: 9 });
  });

  it('stays silent when the run had nothing to report', () => {
    const { events, progress } = collect();
    progress.finish();
    expect(events).toEqual([]);
  });

  it('ignores an unknown phase and survives a missing emit', () => {
    const { events, clock, progress } = collect();
    progress.start(1);
    progress.setPhase('nonsense');
    clock.advance(700);
    progress.step('/m/a.mp3');
    expect(events.map((e) => e?.phase)).toEqual(['linking', 'linking']);

    const silent = createFolderSyncProgress();
    expect(() => {
      silent.start(2);
      silent.step('a');
      silent.setPhase('adding');
      silent.finish();
    }).not.toThrow();
  });

  it('carries the file on step events only', () => {
    const { events, clock, progress } = collect();
    progress.start(1);
    clock.advance(700);
    progress.step('/m/only.mp3');
    progress.setPhase('adding');
    progress.finish();
    expect(events[0].file).toBeUndefined();
    expect(events[1].file).toBe('/m/only.mp3');
    expect(events[2].file).toBeUndefined();
    expect(events[3].file).toBeUndefined();
  });
});
