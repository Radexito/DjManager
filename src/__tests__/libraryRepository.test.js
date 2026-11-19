import { describe, it, expect } from 'vitest';
import {
  listLibraries,
  getLibrary,
  createLibrary,
  renameLibrary,
  getDefaultLibraryId,
  getCurrentLibraryId,
  setCurrentLibraryId,
  setLibraryRootPath,
  setLibraryStorageFormat,
} from '../db/libraryRepository.js';

describe('libraryRepository — migration seed', () => {
  it('seeds exactly one "Default" library on first run, with hashed storage format', () => {
    const libraries = listLibraries();
    expect(libraries.length).toBeGreaterThanOrEqual(1);
    const defaultLib = getLibrary(getDefaultLibraryId());
    expect(defaultLib.name).toBe('Default');
    expect(defaultLib.storage_format).toBe('hashed');
  });

  it('current library falls back to the default library when unset', () => {
    expect(getCurrentLibraryId()).toBe(getDefaultLibraryId());
  });
});

describe('libraryRepository — create/rename', () => {
  it('createLibrary adds a new row with a hashed default format', () => {
    const before = listLibraries().length;
    const lib = createLibrary({ name: 'Gigs USB' });
    expect(lib.name).toBe('Gigs USB');
    expect(lib.storage_format).toBe('hashed');
    expect(listLibraries().length).toBe(before + 1);
  });

  it('createLibrary accepts an explicit readable storage format', () => {
    const lib = createLibrary({ name: 'Readable Lib', storageFormat: 'readable' });
    expect(lib.storage_format).toBe('readable');
  });

  it('renameLibrary updates only the name', () => {
    const lib = createLibrary({ name: 'Original' });
    const renamed = renameLibrary(lib.id, 'Renamed');
    expect(renamed.name).toBe('Renamed');
    expect(getLibrary(lib.id).name).toBe('Renamed');
  });

  it('renameLibrary throws for an unknown id', () => {
    expect(() => renameLibrary(999999, 'x')).toThrow('Library not found.');
  });
});

describe('libraryRepository — current library selection', () => {
  it('setCurrentLibraryId changes getCurrentLibraryId', () => {
    const lib = createLibrary({ name: 'Second' });
    setCurrentLibraryId(lib.id);
    expect(getCurrentLibraryId()).toBe(lib.id);
  });

  it('setCurrentLibraryId throws for an unknown id', () => {
    expect(() => setCurrentLibraryId(999999)).toThrow('Library not found.');
  });
});

describe('libraryRepository — per-library root path and storage format', () => {
  it('setLibraryRootPath only affects the target library', () => {
    const a = createLibrary({ name: 'A' });
    const b = createLibrary({ name: 'B' });
    setLibraryRootPath(a.id, '/custom/path/a');
    expect(getLibrary(a.id).root_path).toBe('/custom/path/a');
    expect(getLibrary(b.id).root_path).toBeNull();
  });

  it('setLibraryStorageFormat only affects the target library', () => {
    const a = createLibrary({ name: 'A' });
    const b = createLibrary({ name: 'B' });
    setLibraryStorageFormat(a.id, 'readable');
    expect(getLibrary(a.id).storage_format).toBe('readable');
    expect(getLibrary(b.id).storage_format).toBe('hashed');
  });

  it('setLibraryStorageFormat rejects an unrecognized format by falling back to hashed', () => {
    const a = createLibrary({ name: 'A' });
    setLibraryStorageFormat(a.id, 'bogus');
    expect(getLibrary(a.id).storage_format).toBe('hashed');
  });
});
