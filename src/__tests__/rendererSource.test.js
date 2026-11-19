import { describe, expect, it } from 'vitest';
import { resolveRendererSource } from '../main/rendererSource.js';

describe('resolveRendererSource', () => {
  it('uses the dev server when it is running', () => {
    expect(resolveRendererSource({ isPackaged: false, devUrlExists: true })).toBe('dev-server');
  });

  it('falls back to the built renderer on a clean checkout', () => {
    // CI and fresh clones have no .dev-url: the file is generated and gitignored.
    expect(resolveRendererSource({ isPackaged: false, devUrlExists: false })).toBe('built');
  });

  it('never uses the dev server in a packaged build', () => {
    expect(resolveRendererSource({ isPackaged: true, devUrlExists: true })).toBe('built');
  });

  it('honours --load-built-renderer', () => {
    expect(
      resolveRendererSource({ isPackaged: false, loadBuiltRenderer: true, devUrlExists: true })
    ).toBe('built');
  });
});
