import { describe, it, expect, vi } from 'vitest';
import {
  BLIND_MODE_SETTING,
  resolveBlindMode,
  applyBlindMode,
  shouldWriteAnlz,
} from '../usb/blindMode.js';

describe('#258 real DJ mode (blind export)', () => {
  describe('resolveBlindMode', () => {
    it('uses the stored setting when the export passes no explicit value', () => {
      expect(resolveBlindMode(null, () => 'true')).toBe(true);
      expect(resolveBlindMode(undefined, () => 'false')).toBe(false);
      expect(resolveBlindMode(null, () => '')).toBe(false);
    });

    it('lets an explicit export value win over the stored setting', () => {
      const on = vi.fn(() => 'true');
      const off = vi.fn(() => 'false');
      expect(resolveBlindMode(false, on)).toBe(false);
      expect(resolveBlindMode(true, off)).toBe(true);
    });

    it('defaults to off without a settings reader', () => {
      expect(resolveBlindMode(null)).toBe(false);
      expect(resolveBlindMode(undefined, null)).toBe(false);
    });

    it('reads the documented setting key', () => {
      const get = vi.fn(() => 'false');
      resolveBlindMode(null, get);
      expect(get).toHaveBeenCalledWith(BLIND_MODE_SETTING, 'false');
      expect(BLIND_MODE_SETTING).toBe('export_blind_mode');
    });
  });

  describe('applyBlindMode', () => {
    const track = {
      id: 7,
      title: 'Siku Siku Mocz',
      artist: 'Mako',
      bpm: 128,
      key_raw: '9B',
      analyzePath: '/music/a/ANLZ0000.DAT',
      file_path: '/music/a.m4a',
      rating: 4,
    };

    it('passes the track through untouched when blind mode is off', () => {
      expect(applyBlindMode(track, false)).toBe(track);
    });

    it('blanks BPM and the analyse path when blind mode is on', () => {
      const out = applyBlindMode(track, true);
      expect(out.bpm).toBe(0);
      expect(out.analyzePath).toBe('');
    });

    it('keeps everything else a player reads (title, key, cues, rating)', () => {
      const out = applyBlindMode({ ...track, cuePoints: [{ position: 12 }] }, true);
      expect(out.title).toBe('Siku Siku Mocz');
      expect(out.artist).toBe('Mako');
      expect(out.key_raw).toBe('9B');
      expect(out.rating).toBe(4);
      expect(out.cuePoints).toEqual([{ position: 12 }]);
      expect(out.id).toBe(7);
    });

    it('does not mutate the input track', () => {
      applyBlindMode(track, true);
      expect(track.bpm).toBe(128);
      expect(track.analyzePath).toBe('/music/a/ANLZ0000.DAT');
    });
  });

  describe('shouldWriteAnlz', () => {
    it('writes ANLZ normally and skips it in blind mode', () => {
      expect(shouldWriteAnlz(false)).toBe(true);
      expect(shouldWriteAnlz(true)).toBe(false);
    });
  });
});
