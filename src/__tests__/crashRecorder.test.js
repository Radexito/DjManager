import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CRASH_HISTORY_LIMIT,
  defaultGraphicsState,
  graphicsConfigPath,
  graphicsReportPath,
  readGraphicsState,
  writeGraphicsState,
} from '../main/graphics/graphicsConfig.js';
import {
  FALLBACK_THRESHOLD,
  FALLBACK_WINDOW_MS,
  appendCrash,
  buildCrashEntry,
  isExternalTermination,
  isRelevantCrash,
  markFallback,
  recordCrash,
  shouldFallback,
} from '../main/graphics/crashRecorder.js';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'djman-graphics-'));
afterAll(() => fs.rmSync(userData, { recursive: true, force: true }));

/** Fixed millisecond timestamp used as the crash time in every fixture. */
const NOW = 1_730_000_000_000;

/** Builds a crash-history entry, defaulting to a GPU crash with exit code 139. */
function entry(at, overrides = {}) {
  return { at, type: 'GPU', reason: 'crashed', exitCode: 139, serviceName: '', ...overrides };
}

describe('isExternalTermination', () => {
  it('flags a SIGTERM from outside', () => {
    expect(isExternalTermination({ reason: 'killed', exitCode: 15 })).toBe(true);
  });

  it('does not flag a real crash or an OOM kill', () => {
    expect(isExternalTermination({ reason: 'crashed', exitCode: 133 })).toBe(false);
    expect(isExternalTermination({ reason: 'killed', exitCode: 9 })).toBe(false);
    expect(isExternalTermination(null)).toBe(false);
  });

  it('keeps SIGTERM out of the relevant-crash set', () => {
    expect(
      isRelevantCrash({
        type: 'Utility',
        serviceName: 'network.mojom.NetworkService',
        reason: 'killed',
        exitCode: 15,
      })
    ).toBe(false);
    expect(isRelevantCrash({ type: 'GPU', reason: 'killed', exitCode: 15 })).toBe(false);
  });
});

describe('isRelevantCrash', () => {
  it('accepts GPU crashes', () => {
    expect(isRelevantCrash({ type: 'GPU', reason: 'crashed' })).toBe(true);
  });

  it('accepts the network service, which arrives as Utility with a serviceName', () => {
    expect(isRelevantCrash({ type: 'Utility', serviceName: 'network.mojom.NetworkService' })).toBe(
      true
    );
  });

  it('accepts a renderer that died, because it leaves the window blank', () => {
    expect(isRelevantCrash({ type: 'Renderer', reason: 'crashed', exitCode: 139 })).toBe(true);
    expect(isRelevantCrash({ type: 'Renderer', reason: 'oom', exitCode: 5 })).toBe(true);
  });

  it('ignores a renderer that ended on purpose', () => {
    expect(isRelevantCrash({ type: 'Renderer', reason: 'clean-exit', exitCode: 0 })).toBe(false);
  });

  it('ignores other utility processes and unrelated process types', () => {
    expect(isRelevantCrash({ type: 'Utility', serviceName: 'audio.mojom.AudioService' })).toBe(
      false
    );
    expect(isRelevantCrash({ type: 'Tab', reason: 'crashed' })).toBe(false);
    expect(isRelevantCrash({ type: 'Browser', reason: 'crashed' })).toBe(false);
  });

  it('has no opinion on a missing event', () => {
    expect(isRelevantCrash(null)).toBe(false);
    expect(isRelevantCrash(undefined)).toBe(false);
  });
});

describe('buildCrashEntry', () => {
  it('carries the facts Electron actually provides', () => {
    const built = buildCrashEntry({
      details: { type: 'GPU', reason: 'crashed', exitCode: 139, serviceName: '' },
      now: NOW,
      platform: 'linux',
      env: { XDG_SESSION_TYPE: 'wayland' },
      versions: { app: '1.0.25', electron: '44.5.1', os: 'linux', kernel: '7.2.14' },
      gpu: { info: { auxAttributes: {} } },
    });

    expect(built).toMatchObject({
      at: NOW,
      type: 'GPU',
      reason: 'crashed',
      exitCode: 139,
      appVersion: '1.0.25',
      electron: '44.5.1',
      os: 'linux',
      kernel: '7.2.14',
      session: 'wayland',
    });
    expect(built.gpu).toEqual({ info: { auxAttributes: {} } });
  });

  it('degrades missing fields instead of throwing', () => {
    const built = buildCrashEntry({ details: { type: 'GPU' }, now: NOW });
    expect(built.reason).toBe('');
    expect(built.exitCode).toBeNull();
    expect(built.serviceName).toBe('');
    expect(built.gpu).toEqual({});
  });
});

describe('appendCrash', () => {
  it('keeps the newest entries and drops the oldest past the limit', () => {
    let state = defaultGraphicsState();
    for (let index = 0; index < CRASH_HISTORY_LIMIT + 5; index += 1) {
      state = appendCrash(state, entry(NOW + index));
    }
    expect(state.crashes).toHaveLength(CRASH_HISTORY_LIMIT);
    expect(state.crashes[state.crashes.length - 1].at).toBe(NOW + CRASH_HISTORY_LIMIT + 4);
    expect(state.crashes[0].at).toBe(NOW + 5);
  });

  it('does not mutate the state it was given', () => {
    const state = defaultGraphicsState();
    const next = appendCrash(state, entry(NOW));
    expect(state.crashes).toHaveLength(0);
    expect(next.crashes).toHaveLength(1);
  });
});

describe('shouldFallback', () => {
  it('needs two relevant crashes inside the window', () => {
    const state = { ...defaultGraphicsState(), crashes: [entry(NOW - 1000)] };
    expect(shouldFallback(state, { now: NOW })).toBe(false);
    expect(
      shouldFallback({ ...state, crashes: [...state.crashes, entry(NOW)] }, { now: NOW })
    ).toBe(true);
  });

  it('ignores crashes older than the window', () => {
    const state = {
      ...defaultGraphicsState(),
      crashes: [entry(NOW - FALLBACK_WINDOW_MS - 1), entry(NOW)],
    };
    expect(shouldFallback(state, { now: NOW })).toBe(false);
  });

  it('never overrides an explicit "enabled" choice', () => {
    const state = {
      mode: 'enabled',
      fallback: null,
      crashes: [entry(NOW - 1), entry(NOW)],
    };
    expect(shouldFallback(state, { now: NOW })).toBe(false);
  });

  it('does not ask for a second fallback once one is active', () => {
    const state = {
      ...defaultGraphicsState(),
      fallback: { active: true, since: NOW - 10, reason: 'gpu-crash-loop', relaunchedAt: NOW - 10 },
      crashes: [entry(NOW - 1), entry(NOW)],
    };
    expect(shouldFallback(state, { now: NOW })).toBe(false);
  });

  it('exposes the documented threshold and window', () => {
    expect(FALLBACK_THRESHOLD).toBe(2);
    expect(FALLBACK_WINDOW_MS).toBe(300_000);
  });
});

describe('recordCrash', () => {
  it('ignores an irrelevant crash and returns the same state', () => {
    const state = defaultGraphicsState();
    const result = recordCrash(state, { details: { type: 'Tab', reason: 'crashed' }, now: NOW });
    expect(result.entry).toBeNull();
    expect(result.state).toBe(state);
    expect(result.fallbackNow).toBe(false);
  });

  it('markFallback freezes the decision and blocks a second fallback', () => {
    const state = {
      ...defaultGraphicsState(),
      crashes: [entry(NOW - 1000), entry(NOW)],
    };
    const marked = markFallback(state, { now: NOW });

    expect(marked.fallback).toEqual({
      active: true,
      since: NOW,
      reason: 'gpu-crash-loop',
      relaunchedAt: NOW,
    });
    expect(shouldFallback(marked, { now: NOW + 1 })).toBe(false);
  });

  it('appends a relevant crash and reports the threshold crossing', () => {
    const state = { ...defaultGraphicsState(), crashes: [entry(NOW - 1000)] };
    const result = recordCrash(state, {
      details: { type: 'GPU', reason: 'crashed', exitCode: 139 },
      now: NOW,
    });
    expect(result.entry).not.toBeNull();
    expect(result.state.crashes).toHaveLength(2);
    expect(result.fallbackNow).toBe(true);
  });
});

describe('graphics state on disk', () => {
  beforeEach(() => {
    fs.rmSync(graphicsConfigPath(userData), { force: true });
  });

  it('returns defaults when the file does not exist', () => {
    expect(readGraphicsState(userData)).toEqual(defaultGraphicsState());
  });

  it('round-trips mode, fallback and crashes', () => {
    const state = {
      mode: 'disabled',
      fallback: { active: true, since: NOW, reason: 'gpu-crash-loop', relaunchedAt: NOW + 5 },
      crashes: [
        buildCrashEntry({ details: { type: 'GPU', reason: 'crashed', exitCode: 139 }, now: NOW }),
      ],
      reportPath: 'graphics-crash-report.json',
    };
    expect(writeGraphicsState(userData, state)).toBe(true);
    expect(readGraphicsState(userData)).toEqual(state);
  });

  it('writes atomically and leaves no temp file behind', () => {
    writeGraphicsState(userData, { ...defaultGraphicsState(), mode: 'enabled' });
    const leftovers = fs.readdirSync(userData).filter((name) => name.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('treats corrupt JSON as "no state" instead of failing the launch', () => {
    fs.writeFileSync(graphicsConfigPath(userData), '{not json', 'utf8');
    expect(readGraphicsState(userData)).toEqual(defaultGraphicsState());
  });

  it('drops unknown crash fields but keeps known ones', () => {
    fs.writeFileSync(
      graphicsConfigPath(userData),
      JSON.stringify({
        mode: 'auto',
        crashes: [{ at: NOW, type: 'GPU', reason: 'crashed', unknownField: 'x' }],
      }),
      'utf8'
    );
    const state = readGraphicsState(userData);
    expect(state.crashes[0]).toMatchObject({ at: NOW, type: 'GPU' });
    expect(state.crashes[0]).not.toHaveProperty('unknownField');
  });

  it('points the report at the user data directory', () => {
    expect(graphicsReportPath(userData)).toBe(path.join(userData, 'graphics-crash-report.json'));
  });
});
