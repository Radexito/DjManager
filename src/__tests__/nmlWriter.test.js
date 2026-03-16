import { describe, it, expect, afterEach } from 'vitest';
import { writeNml } from '../audio/nmlWriter.js';
import { readFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const OUT = join(tmpdir(), `nmlWriter-test-${Date.now()}.nml`);

afterEach(() => {
  if (existsSync(OUT)) unlinkSync(OUT);
});

const sampleTrack = {
  id: 1,
  title: 'Test Track',
  artist: 'Test Artist',
  album: 'Test Album',
  file_path: '/music/Test Artist/Test Track.mp3',
  format: 'mp3',
  bitrate: 320,
  duration: 240.5,
  bpm: 128.0,
  bpm_override: null,
  key_raw: 'Am',
  key_camelot: '8A',
  loudness: -6.5,
  replay_gain: null,
  intro_secs: 8.0,
  outro_secs: null,
  genres: '["Tech House"]',
  label: 'Test Label',
  comments: 'A comment',
  rating: 4,
  analyzed: 1,
};

const samplePlaylist = {
  name: 'My Playlist',
  track_ids: [1],
};

describe('nmlWriter', () => {
  it('writes a valid NML file', () => {
    writeNml({ tracks: [sampleTrack], playlists: [samplePlaylist] }, OUT);
    expect(existsSync(OUT)).toBe(true);
    const xml = readFileSync(OUT, 'utf8');
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<NML VERSION="19">');
  });

  it('includes HEAD with Native Instruments company', () => {
    writeNml({ tracks: [sampleTrack], playlists: [] }, OUT);
    const xml = readFileSync(OUT, 'utf8');
    expect(xml).toContain('COMPANY="www.native-instruments.com"');
    expect(xml).toContain('PROGRAM="Traktor"');
  });

  it('writes COLLECTION with correct ENTRIES count', () => {
    writeNml({ tracks: [sampleTrack], playlists: [] }, OUT);
    const xml = readFileSync(OUT, 'utf8');
    expect(xml).toContain('COLLECTION ENTRIES="1"');
  });

  it('writes ENTRY with TITLE and ARTIST', () => {
    writeNml({ tracks: [sampleTrack], playlists: [] }, OUT);
    const xml = readFileSync(OUT, 'utf8');
    expect(xml).toContain('TITLE="Test Track"');
    expect(xml).toContain('ARTIST="Test Artist"');
  });

  it('writes LOCATION with encoded DIR and FILE', () => {
    writeNml({ tracks: [sampleTrack], playlists: [] }, OUT);
    const xml = readFileSync(OUT, 'utf8');
    expect(xml).toContain('FILE="Test Track.mp3"');
    expect(xml).toContain('<LOCATION');
  });

  it('writes TEMPO with BPM', () => {
    writeNml({ tracks: [sampleTrack], playlists: [] }, OUT);
    const xml = readFileSync(OUT, 'utf8');
    expect(xml).toContain('BPM="128.000000"');
  });

  it('uses bpm_override when set', () => {
    const track = { ...sampleTrack, bpm_override: 130.5 };
    writeNml({ tracks: [track], playlists: [] }, OUT);
    const xml = readFileSync(OUT, 'utf8');
    expect(xml).toContain('BPM="130.500000"');
  });

  it('writes MUSICAL_KEY for known Camelot key', () => {
    // 8A = Am minor = value 21
    writeNml({ tracks: [sampleTrack], playlists: [] }, OUT);
    const xml = readFileSync(OUT, 'utf8');
    expect(xml).toContain('<MUSICAL_KEY VALUE="21"');
  });

  it('omits MUSICAL_KEY when key_camelot is unknown', () => {
    const track = { ...sampleTrack, key_camelot: null };
    writeNml({ tracks: [track], playlists: [] }, OUT);
    const xml = readFileSync(OUT, 'utf8');
    expect(xml).not.toContain('<MUSICAL_KEY');
  });

  it('writes INFO with GENRE from genres array', () => {
    writeNml({ tracks: [sampleTrack], playlists: [] }, OUT);
    const xml = readFileSync(OUT, 'utf8');
    expect(xml).toContain('GENRE="Tech House"');
  });

  it('writes LOUDNESS element', () => {
    writeNml({ tracks: [sampleTrack], playlists: [] }, OUT);
    const xml = readFileSync(OUT, 'utf8');
    expect(xml).toContain('<LOUDNESS');
    expect(xml).toContain('PEAK_DB="-6.5"');
  });

  it('writes AutoGrid CUE_V2 using intro_secs', () => {
    writeNml({ tracks: [sampleTrack], playlists: [] }, OUT);
    const xml = readFileSync(OUT, 'utf8');
    expect(xml).toContain('NAME="AutoGrid"');
    expect(xml).toContain('TYPE="4"');
    // 8.0 seconds * 1000 = 8000 ms
    expect(xml).toContain('START="8000.000000"');
  });

  it('defaults AutoGrid to 0ms when no intro_secs', () => {
    const track = { ...sampleTrack, intro_secs: null };
    writeNml({ tracks: [track], playlists: [] }, OUT);
    const xml = readFileSync(OUT, 'utf8');
    expect(xml).toContain('START="0.000000"');
  });

  it('writes PLAYLISTS section with $ROOT folder', () => {
    writeNml({ tracks: [sampleTrack], playlists: [samplePlaylist] }, OUT);
    const xml = readFileSync(OUT, 'utf8');
    expect(xml).toContain('<PLAYLISTS>');
    expect(xml).toContain('NAME="$ROOT"');
    expect(xml).toContain('NAME="My Playlist"');
    expect(xml).toContain('TYPE="PLAYLIST"');
  });

  it('writes PRIMARYKEY entry in playlist', () => {
    writeNml({ tracks: [sampleTrack], playlists: [samplePlaylist] }, OUT);
    const xml = readFileSync(OUT, 'utf8');
    expect(xml).toContain('<PRIMARYKEY TYPE="TRACK"');
  });

  it('handles empty playlists section', () => {
    writeNml({ tracks: [sampleTrack], playlists: [] }, OUT);
    const xml = readFileSync(OUT, 'utf8');
    expect(xml).toContain('<PLAYLISTS>');
    expect(xml).toContain('COUNT="0"');
  });

  it('escapes XML special characters in title', () => {
    const track = { ...sampleTrack, title: 'Rock & Roll <Live>', artist: '"The" Band' };
    writeNml({ tracks: [track], playlists: [] }, OUT);
    const xml = readFileSync(OUT, 'utf8');
    expect(xml).toContain('Rock &amp; Roll &lt;Live&gt;');
    expect(xml).toContain('&quot;The&quot; Band');
  });

  it('writes multiple tracks', () => {
    const track2 = { ...sampleTrack, id: 2, title: 'Second Track' };
    writeNml({ tracks: [sampleTrack, track2], playlists: [] }, OUT);
    const xml = readFileSync(OUT, 'utf8');
    expect(xml).toContain('COLLECTION ENTRIES="2"');
    expect(xml).toContain('Test Track');
    expect(xml).toContain('Second Track');
  });

  it('handles missing optional fields gracefully', () => {
    const minimal = { id: 99, title: 'Minimal', file_path: '/music/minimal.mp3' };
    expect(() => writeNml({ tracks: [minimal], playlists: [] }, OUT)).not.toThrow();
    const xml = readFileSync(OUT, 'utf8');
    expect(xml).toContain('TITLE="Minimal"');
  });
});
