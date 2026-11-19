import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildCrashReport,
  readLogTail,
  renderCrashReport,
  writeCrashReport,
} from '../main/graphics/crashReport.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-report-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Fixed millisecond timestamp used as the crash time in every fixture. */
const NOW = 1_730_000_000_000;

const crash = (at, overrides = {}) => ({
  at,
  type: 'GPU',
  reason: 'crashed',
  exitCode: 139,
  serviceName: '',
  appVersion: '1.0.25',
  electron: '44.5.1',
  os: 'linux',
  kernel: '7.2.14',
  session: 'wayland',
  gpu: {},
  ...overrides,
});

describe('buildCrashReport', () => {
  it('summarizes count, timestamps, types, reasons and exit codes', () => {
    const report = buildCrashReport({
      state: {
        mode: 'auto',
        fallback: null,
        crashes: [crash(NOW), crash(NOW + 1000, { reason: 'killed', exitCode: 137 })],
      },
      environment: { app: '1.0.25', electron: '44.5.1', platform: 'linux', kernel: '7.2.14' },
    });

    expect(report.summary.count).toBe(2);
    expect(report.summary.firstAt).toBe(NOW);
    expect(report.summary.lastAt).toBe(NOW + 1000);
    expect(report.summary.reasons).toEqual(['crashed', 'killed']);
    expect(report.summary.exitCodes).toEqual([139, 137]);
    expect(report.mode).toBe('auto');
  });

  it('says outright that no stack trace exists instead of pretending', () => {
    const report = buildCrashReport({ state: { mode: 'auto', crashes: [] } });
    expect(report.stackTraceAvailable).toBe(false);
    expect(report.stackTraceNote).toMatch(/does not expose stack traces/i);
  });

  it('carries the log tail it was given', () => {
    const report = buildCrashReport({
      state: { mode: 'auto', crashes: [] },
      logTail: 'line one\nline two',
    });
    expect(report.logTail).toBe('line one\nline two');
  });

  it('handles an empty history without pretending there were crashes', () => {
    const report = buildCrashReport({ state: { mode: 'disabled', crashes: [] } });
    expect(report.summary).toEqual({
      count: 0,
      firstAt: null,
      lastAt: null,
      types: [],
      reasons: [],
      exitCodes: [],
    });
  });
});

describe('renderCrashReport', () => {
  it('renders the facts a user can act on', () => {
    const text = renderCrashReport(
      buildCrashReport({
        state: { mode: 'auto', fallback: null, crashes: [crash(NOW)] },
        entry: crash(NOW),
        environment: { app: '1.0.25', electron: '44.5.1', platform: 'linux', kernel: '7.2.14' },
      })
    );

    expect(text).toContain('Graphics crash report');
    expect(text).toContain('Crashes recorded: 1');
    expect(text).toContain('type=GPU');
    expect(text).toContain('Stack trace: not available');
  });

  it('shows the fallback state when one is recorded', () => {
    const text = renderCrashReport(
      buildCrashReport({
        state: {
          mode: 'auto',
          fallback: { active: true, since: NOW, reason: 'gpu-crash-loop', relaunchedAt: NOW },
          crashes: [crash(NOW)],
        },
      })
    );
    expect(text).toMatch(/Fallback: active since/);
    expect(text).toContain('gpu-crash-loop');
  });
});

describe('readLogTail', () => {
  it('reads the newest app log and keeps only the tail', () => {
    fs.writeFileSync(path.join(tmp, 'app-2026-11-01.log'), 'old\n', 'utf8');
    const fresh = path.join(tmp, 'app-2026-11-02.log');
    fs.writeFileSync(
      fresh,
      Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n'),
      'utf8'
    );
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(tmp, 'app-2026-11-01.log'), past, past);

    const tail = readLogTail(tmp, 3);
    expect(tail).toContain('line 9');
    expect(tail).not.toContain('line 0');
    expect(tail).not.toContain('old');
  });

  it('returns an empty string when there are no logs', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-nologs-'));
    try {
      expect(readLogTail(empty)).toBe('');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('returns an empty string for a missing directory', () => {
    expect(readLogTail(path.join(tmp, 'does-not-exist'))).toBe('');
  });
});

describe('writeCrashReport', () => {
  it('writes the report next to the state file', () => {
    const file = path.join(tmp, 'graphics-crash-report.json');
    const written = writeCrashReport(
      file,
      buildCrashReport({ state: { mode: 'auto', crashes: [] } })
    );
    expect(written).toBe(file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).stackTraceAvailable).toBe(false);
  });
});
