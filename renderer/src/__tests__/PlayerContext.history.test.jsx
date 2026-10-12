import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { PlayerProvider, usePlayer } from '../PlayerContext.jsx';
import {
  HISTORY_MAX,
  HISTORY_STORAGE_KEY,
  appendHistoryEntry,
  loadHistory,
  persistHistory,
} from '../playbackHistory.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function track(id, extra = {}) {
  return {
    id,
    title: `Track ${id}`,
    artist: `Artist ${id}`,
    file_path: `/music/${id}.mp3`,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.api.getMediaPort.mockResolvedValue(19876);
  localStorage.clear();
});

// ── appendHistoryEntry ────────────────────────────────────────────────────────

describe('PlayerContext — appendHistoryEntry (#507)', () => {
  it('prepends the new track (newest first)', () => {
    const next = appendHistoryEntry([track(2), track(1)], track(3));
    expect(next.map((t) => t.id)).toEqual([3, 2, 1]);
  });

  it('does not add a duplicate when the same track starts again back to back', () => {
    const prev = [track(1), track(2)];
    expect(appendHistoryEntry(prev, track(1))).toBe(prev);
  });

  it('still logs the same track again when another track played in between', () => {
    const next = appendHistoryEntry([track(2), track(1)], track(1));
    expect(next.map((t) => t.id)).toEqual([1, 2, 1]);
  });

  it('caps the ring buffer at HISTORY_MAX and drops the oldest entry', () => {
    let history = [];
    for (let id = 1; id <= HISTORY_MAX + 10; id += 1) {
      history = appendHistoryEntry(history, track(id));
    }
    expect(history).toHaveLength(HISTORY_MAX);
    expect(history[0].id).toBe(HISTORY_MAX + 10);
    expect(history.at(-1).id).toBe(11);
  });

  it('ignores entries without an id', () => {
    const prev = [track(1)];
    expect(appendHistoryEntry(prev, null)).toBe(prev);
    expect(appendHistoryEntry(prev, { title: 'no id' })).toBe(prev);
  });
});

// ── persistence ───────────────────────────────────────────────────────────────

describe('PlayerContext — history persistence (#507)', () => {
  it('round-trips through localStorage', () => {
    persistHistory([track(2), track(1)]);
    expect(loadHistory().map((t) => t.id)).toEqual([2, 1]);
  });

  it('returns an empty history when nothing was stored', () => {
    expect(loadHistory()).toEqual([]);
  });

  it('degrades to an empty history on corrupted JSON', () => {
    localStorage.setItem(HISTORY_STORAGE_KEY, '{not json');
    expect(loadHistory()).toEqual([]);
  });

  it('ignores a stored value that is not an array', () => {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({ ids: [1, 2] }));
    expect(loadHistory()).toEqual([]);
  });

  it('does not persist the waveform BLOBs that track rows carry', () => {
    const withBlobs = track(7, {
      waveform_overview: new Uint8Array([1, 2, 3]),
      waveform_detail_hires: new Uint8Array([4, 5, 6]),
    });
    persistHistory([withBlobs]);

    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    expect(raw).not.toContain('waveform_overview');
    expect(raw).not.toContain('waveform_detail_hires');
    const [entry] = loadHistory();
    expect(entry.id).toBe(7);
    expect(entry.file_path).toBe('/music/7.mp3');
    expect(entry.waveform_overview).toBeUndefined();
  });

  it('caps a hydrated history at HISTORY_MAX', () => {
    const many = Array.from({ length: HISTORY_MAX + 5 }, (_, i) => track(i + 1));
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(many));
    expect(loadHistory()).toHaveLength(HISTORY_MAX);
  });
});

// ── provider integration ──────────────────────────────────────────────────────

describe('PlayerProvider — history hydration (#507)', () => {
  it('hydrates the history from localStorage on mount', async () => {
    persistHistory([track(42), track(41)]);

    const { result } = renderHook(() => usePlayer(), { wrapper: PlayerProvider });
    await waitFor(() => expect(result.current).toBeTruthy());

    expect(result.current.history.map((t) => t.id)).toEqual([42, 41]);
  });

  it('starts with an empty history when nothing is stored', async () => {
    const { result } = renderHook(() => usePlayer(), { wrapper: PlayerProvider });
    await waitFor(() => expect(result.current).toBeTruthy());

    expect(result.current.history).toEqual([]);
  });
});
