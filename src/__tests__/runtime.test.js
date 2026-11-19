import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowExplorerBase, createRuntime, isExplorerPathAllowed } from '../main/runtime.js';

describe('createRuntime', () => {
  it('starts with no window, no port and no allowed bases', () => {
    expect(createRuntime()).toEqual({
      mainWindow: null,
      mediaServerPort: null,
      activeRecursiveWalker: null,
      explorerAllowedBases: [],
    });
  });

  it('accepts overrides for a test that needs a prepared state', () => {
    const runtime = createRuntime({ mediaServerPort: 4321, explorerAllowedBases: ['/music'] });
    expect(runtime).toEqual({
      mainWindow: null,
      mediaServerPort: 4321,
      activeRecursiveWalker: null,
      explorerAllowedBases: ['/music'],
    });
  });

  it('gives every call its own array', () => {
    const a = createRuntime();
    const b = createRuntime();
    a.explorerAllowedBases.push('/music');
    expect(b.explorerAllowedBases).toEqual([]);
  });
});

describe('allowExplorerBase', () => {
  it('adds a directory once and ignores the duplicate', () => {
    const runtime = createRuntime();
    expect(allowExplorerBase(runtime, '/music')).toBe(true);
    expect(allowExplorerBase(runtime, '/music')).toBe(false);
    expect(runtime.explorerAllowedBases).toEqual(['/music']);
  });

  it('ignores an empty or non-string value instead of poisoning the list', () => {
    const runtime = createRuntime();
    expect(allowExplorerBase(runtime, '')).toBe(false);
    expect(allowExplorerBase(runtime, null)).toBe(false);
    expect(allowExplorerBase(runtime, undefined)).toBe(false);
    expect(runtime.explorerAllowedBases).toEqual([]);
  });

  it('stores the resolved directory, so a base has one identity', () => {
    const runtime = createRuntime();
    expect(allowExplorerBase(runtime, '/music/rock/../jazz')).toBe(true);
    expect(runtime.explorerAllowedBases).toEqual(['/music/jazz']);
  });

  it('treats two spellings of the same directory as one entry', () => {
    const runtime = createRuntime();
    expect(allowExplorerBase(runtime, '/music/rock')).toBe(true);
    expect(allowExplorerBase(runtime, '/music/rock/../rock')).toBe(false);
    expect(runtime.explorerAllowedBases).toEqual(['/music/rock']);
  });
});

describe('isExplorerPathAllowed', () => {
  it('accepts the base itself and anything below it', () => {
    const runtime = createRuntime({ explorerAllowedBases: ['/music'] });
    expect(isExplorerPathAllowed(runtime, '/music')).toBe(true);
    expect(isExplorerPathAllowed(runtime, path.join('/music', 'rock', 'album'))).toBe(true);
  });

  it('rejects a sibling whose name only starts with the base', () => {
    const runtime = createRuntime({ explorerAllowedBases: ['/music'] });
    expect(isExplorerPathAllowed(runtime, '/music2')).toBe(false);
  });

  it('rejects an unrelated path and an empty value', () => {
    const runtime = createRuntime({ explorerAllowedBases: ['/music'] });
    expect(isExplorerPathAllowed(runtime, '/videos')).toBe(false);
    expect(isExplorerPathAllowed(runtime, '')).toBe(false);
  });

  it('handles a base that already ends with a separator', () => {
    const runtime = createRuntime({ explorerAllowedBases: ['/music/'] });
    expect(isExplorerPathAllowed(runtime, '/music/rock')).toBe(true);
  });

  it('rejects a path that escapes the base with ..', () => {
    const runtime = createRuntime({ explorerAllowedBases: ['/music'] });
    expect(isExplorerPathAllowed(runtime, '/music/../etc')).toBe(false);
    expect(isExplorerPathAllowed(runtime, '/music/../music2')).toBe(false);
    expect(isExplorerPathAllowed(runtime, path.join('/music', 'rock', '..', '..', 'etc'))).toBe(
      false
    );
  });

  it('still accepts a path that climbs and comes back inside the base', () => {
    const runtime = createRuntime({ explorerAllowedBases: ['/music'] });
    expect(isExplorerPathAllowed(runtime, path.join('/music', 'rock', '..', 'jazz'))).toBe(true);
  });
});
