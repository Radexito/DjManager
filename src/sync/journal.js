import fs from 'node:fs';
import path from 'node:path';

import { journalPath, journalsDir } from './paths.js';

/**
 * The durable record of one sync job.
 *
 * Append-only JSON lines, one line per event, written with fsync before the
 * caller continues. Anything that decides what happened to the medium reads
 * this file: the next job after a crash, the tests that kill the process
 * between stages, and a person trying to explain a failed sync from the stick
 * alone. A torn last line is discarded on read, which is exactly the event that
 * was still in flight.
 *
 * Event names and their fields are documented in docs/sync-journal.md.
 */

const TERMINAL_EVENTS = new Set(['committed', 'failed', 'abandoned']);

/** Parse one journal file, skipping unreadable lines. */
export function readJournalFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') events.push(parsed);
    } catch {
      // a crash can leave the last line half written; that event did not happen
    }
  }
  return events;
}

/** Events of one job, oldest first. */
export function readJournal(usbRoot, jobId) {
  return readJournalFile(journalPath(usbRoot, jobId));
}

/**
 * Every journal on the medium, with its events.
 * @returns {Array<{jobId: string, file: string, events: object[], mtimeMs: number}>}
 */
export function listJournals(usbRoot) {
  const dir = journalsDir(usbRoot);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => {
      const file = path.join(dir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        /* raced with a cleanup, treat as oldest */
      }
      return {
        jobId: name.replace(/\.jsonl$/, ''),
        file,
        events: readJournalFile(file),
        mtimeMs,
      };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** Whether a job reached a terminal event. */
export function isFinished(events) {
  return events.some((event) => TERMINAL_EVENTS.has(event.event));
}

/** Whether the job started and never reached a terminal event. */
export function isUnfinished(events) {
  return events.length > 0 && !isFinished(events);
}

/**
 * The fingerprint of the last committed job, whatever job wrote it.
 * This is what makes "no changes, do not touch the device" decidable by a read.
 */
export function lastCommit(usbRoot) {
  let best = null;
  for (const journal of listJournals(usbRoot)) {
    for (const event of journal.events) {
      if (event.event !== 'committed') continue;
      if (!best || Number(event.at) >= Number(best.at)) {
        best = { ...event, jobId: journal.jobId };
      }
    }
  }
  return best;
}

/** Jobs that started and never reached a terminal event. */
export function unfinishedJobs(usbRoot) {
  return listJournals(usbRoot)
    .filter((journal) => isUnfinished(journal.events))
    .map((journal) => ({ jobId: journal.jobId, events: journal.events }));
}

/** One job's journal, opened for appending with the sequence continued. */
export class SyncJournal {
  /**
   * @param {object} options
   * @param {string} options.usbRoot mount point
   * @param {string} options.jobId
   * @param {function(): number} [options.now]
   */
  constructor({ usbRoot, jobId, now = Date.now }) {
    this.usbRoot = usbRoot;
    this.jobId = jobId;
    this.now = now;
    this.file = journalPath(usbRoot, jobId);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const existing = readJournalFile(this.file);
    this.seq = existing.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0);
  }

  /** Append one event and make it durable before returning. */
  append(event, data = {}) {
    this.seq += 1;
    const entry = { seq: this.seq, at: this.now(), jobId: this.jobId, event, ...data };
    const line = `${JSON.stringify(entry)}\n`;
    const fd = fs.openSync(this.file, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return entry;
  }
}
