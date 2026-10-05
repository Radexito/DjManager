// src/__tests__/folderSyncConcurrency.test.js
// #516 — the bounded-concurrency runner that makes the link phase of a
// folder-tracked playlist sync overlap its ffprobe calls. Pure, no fs, no DB.
import { describe, it, expect, vi } from 'vitest';
import { mapWithConcurrency, DEFAULT_MAP_CONCURRENCY } from '../library/concurrency.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrency', () => {
  it('never runs more than `limit` workers at once, and visits each item once', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const visited = [];
    let active = 0;
    let peak = 0;

    const { results, errors, ok } = await mapWithConcurrency(
      items,
      async (item) => {
        active++;
        peak = Math.max(peak, active);
        await sleep(1);
        active--;
        visited.push(item);
        return item * 2;
      },
      { limit: 4 }
    );

    expect(peak).toBe(4); // hits the cap without exceeding it
    expect(active).toBe(0);
    expect(visited.sort((a, b) => a - b)).toEqual(items); // exactly once each
    expect(errors).toEqual([]);
    expect(ok).toBe(20);
    // Results are indexed like the input even though they settled out of order.
    expect(results).toEqual(items.map((i) => i * 2));
  });

  it('is actually faster than sequential: 16 x 20 ms at limit 4 lands in about a quarter', async () => {
    const items = Array.from({ length: 16 }, (_, i) => i);
    const startedAt = Date.now();
    await mapWithConcurrency(items, () => sleep(20), { limit: 4 });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(items.length * 20 - 100); // 320 ms sequential
  });

  it('keeps results in the input order even when they settle in reverse', async () => {
    const items = ['slow', 'medium', 'fast'];
    const delays = { slow: 24, medium: 12, fast: 1 };
    const { results } = await mapWithConcurrency(
      items,
      async (item) => {
        await sleep(delays[item]);
        return `${item}:done`;
      },
      { limit: 3 }
    );
    expect(results).toEqual(['slow:done', 'medium:done', 'fast:done']);
  });

  it('keeps going when one file fails, and reports which one', async () => {
    const settled = [];
    const { results, errors, ok } = await mapWithConcurrency(
      [1, 2, 3, 4, 5],
      async (n) => {
        if (n === 3) throw new Error('ffprobe: no such file');
        return `ok-${n}`;
      },
      {
        limit: 2,
        onSettled: (item, result, index) => settled.push({ item, result, index }),
      }
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].item).toBe(3);
    expect(errors[0].index).toBe(2);
    expect(errors[0].error.message).toBe('ffprobe: no such file');
    expect(ok).toBe(4);
    // The failure did not abandon the items behind it.
    expect(results).toEqual(['ok-1', 'ok-2', undefined, 'ok-4', 'ok-5']);
    expect(settled.map((s) => s.item).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(settled.find((s) => s.item === 3).result).toBeUndefined();
  });

  it('captures a worker that throws synchronously', async () => {
    const { results, errors, ok } = await mapWithConcurrency(
      ['a', 'b'],
      (item) => {
        if (item === 'a') throw new Error('sync boom');
        return item;
      },
      { limit: 2 }
    );

    expect(errors.map((e) => e.item)).toEqual(['a']);
    expect(results).toEqual([undefined, 'b']);
    expect(ok).toBe(1);
  });

  it('processes duplicate values once per position', async () => {
    const worker = vi.fn(async (item) => item);
    const { results } = await mapWithConcurrency(['x', 'x', 'x'], worker, { limit: 4 });
    expect(worker).toHaveBeenCalledTimes(3);
    expect(results).toEqual(['x', 'x', 'x']);
  });

  it('handles an empty list without calling the worker', async () => {
    const worker = vi.fn();
    const { results, errors, ok } = await mapWithConcurrency([], worker, { limit: 4 });
    expect(worker).not.toHaveBeenCalled();
    expect(results).toEqual([]);
    expect(errors).toEqual([]);
    expect(ok).toBe(0);
  });

  it('clamps a limit larger than the list, and defaults to the analysis width', async () => {
    const items = [1, 2, 3];
    let active = 0;
    let peak = 0;
    const { results } = await mapWithConcurrency(
      items,
      async (n) => {
        active++;
        peak = Math.max(peak, active);
        await sleep(1);
        active--;
        return n;
      },
      { limit: 100 }
    );
    expect(peak).toBe(3);
    expect(results).toEqual(items);

    // No explicit limit → the same width the analysis queue uses.
    expect(DEFAULT_MAP_CONCURRENCY).toBe(4);
    const counts = [];
    await mapWithConcurrency(
      Array.from({ length: 12 }, (_, i) => i),
      async (n) => {
        counts.push(n);
        return n;
      }
    );
    expect(counts.sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });
});
