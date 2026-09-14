// renderer/src/__tests__/PlayerContext.trim.test.jsx
// Playback respecting the per-track trim range (#463).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { PlayerProvider, usePlayer } from '../PlayerContext.jsx';

const TRACK_TRIMMED = {
  id: 1,
  title: 'Trimmed',
  duration: 180,
  file_path: '/music/trimmed.mp3',
  trim_start_ms: 30_000,
  trim_end_ms: 60_000,
};

const TRACK_PLAIN = {
  id: 2,
  title: 'Plain',
  duration: 200,
  file_path: '/music/plain.mp3',
};

function renderProvider() {
  return renderHook(() => usePlayer(), { wrapper: PlayerProvider });
}

/** Render and wait until the media server port is known (play() needs it). */
async function renderReady() {
  const utils = renderProvider();
  await waitFor(() => expect(utils.result.current.mediaPort).toBe(19876));
  return utils;
}

function makePlaying(audio) {
  // jsdom has no media pipeline: force the "element is playing" state the
  // trim-end check reads, and fire the 'play' event the provider listens to.
  Object.defineProperty(audio, 'paused', { configurable: true, get: () => false });
  return act(async () => {
    audio.dispatchEvent(new Event('play'));
  });
}

let playSpy;
let pauseSpy;

beforeEach(() => {
  vi.clearAllMocks();
  window.api.getMediaPort.mockResolvedValue(19876);
  playSpy = vi
    .spyOn(window.HTMLMediaElement.prototype, 'play')
    .mockImplementation(() => Promise.resolve());
  pauseSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  playSpy.mockRestore();
  pauseSpy.mockRestore();
});

describe('PlayerProvider — trim range (#463)', () => {
  it('starts a trimmed track at its trim start', async () => {
    const { result } = await renderReady();

    await act(async () => {
      result.current.play(TRACK_TRIMMED, [TRACK_TRIMMED], 0);
    });

    const audio = result.current.audioRef.current;
    expect(audio.currentTime).toBe(30);
    expect(audio.src).toContain('trimmed.mp3');
    expect(result.current.currentTrack?.id).toBe(1);
  });

  it('starts an untrimmed track at 0', async () => {
    const { result } = await renderReady();

    await act(async () => {
      result.current.play(TRACK_PLAIN, [TRACK_PLAIN], 0);
    });

    expect(result.current.audioRef.current.currentTime).toBe(0);
  });

  it('restarts from the trim start on "previous" instead of 0', async () => {
    const { result } = await renderReady();
    await act(async () => {
      result.current.play(TRACK_TRIMMED, [TRACK_TRIMMED], 0);
    });
    const audio = result.current.audioRef.current;
    audio.currentTime = 50; // > trimStart + 3

    act(() => {
      result.current.prev();
    });

    expect(audio.currentTime).toBe(30);
  });

  it('advances to the next track when the trim end is reached', async () => {
    const { result } = await renderReady();
    const queue = [TRACK_TRIMMED, TRACK_PLAIN];
    await act(async () => {
      result.current.play(queue[0], queue, 0);
    });
    const audio = result.current.audioRef.current;
    await makePlaying(audio);

    // Playhead past the trim end (60 s) — the poll finds it on the next tick
    audio.currentTime = 61;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(result.current.currentTrack?.id).toBe(2);
    expect(result.current.queueIndex).toBe(1);
  });

  it('stops and pauses the element at the trim end of the last track', async () => {
    const { result } = await renderReady();
    await act(async () => {
      result.current.play(TRACK_TRIMMED, [TRACK_TRIMMED], 0);
    });
    const audio = result.current.audioRef.current;
    await makePlaying(audio);
    pauseSpy.mockClear();

    audio.currentTime = 61;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(result.current.isPlaying).toBe(false);
    expect(pauseSpy).toHaveBeenCalled();
  });

  it('does not advance while the playhead is still inside the range', async () => {
    const { result } = await renderReady();
    await act(async () => {
      result.current.play(TRACK_TRIMMED, [TRACK_TRIMMED], 0);
    });
    const audio = result.current.audioRef.current;
    await makePlaying(audio);

    audio.currentTime = 45; // inside 30-60 s
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(result.current.currentTrack?.id).toBe(1);
    expect(result.current.isPlaying).toBe(true);
  });

  it('keeps playing when the user seeks past the trim end (audition outside the range)', async () => {
    const { result } = await renderReady();
    await act(async () => {
      result.current.play(TRACK_TRIMMED, [TRACK_TRIMMED], 0);
    });
    const audio = result.current.audioRef.current;
    await makePlaying(audio);

    act(() => {
      result.current.seek(90); // outro beyond the trim end — deliberate override
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(result.current.currentTrack?.id).toBe(1);
    expect(result.current.isPlaying).toBe(true);
    expect(audio.currentTime).toBe(90);
  });

  it('re-arms the trim stop when seeking back inside the range', async () => {
    const { result } = await renderReady();
    await act(async () => {
      result.current.play(TRACK_TRIMMED, [TRACK_TRIMMED], 0);
    });
    const audio = result.current.audioRef.current;
    await makePlaying(audio);

    act(() => {
      result.current.seek(90);
    });
    act(() => {
      result.current.seek(35); // back inside
    });
    audio.currentTime = 61;

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(result.current.isPlaying).toBe(false);
  });

  it('does not stop an untrimmed track at the old trim end', async () => {
    const { result } = await renderReady();
    await act(async () => {
      result.current.play(TRACK_PLAIN, [TRACK_PLAIN], 0);
    });
    const audio = result.current.audioRef.current;
    await makePlaying(audio);

    audio.currentTime = 61;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(result.current.isPlaying).toBe(true);
  });

  it('repeats a trimmed track from its trim start', async () => {
    const { result } = await renderReady();
    await act(async () => {
      result.current.play(TRACK_TRIMMED, [TRACK_TRIMMED], 0);
    });
    act(() => {
      result.current.cycleRepeat(); // none -> all
      result.current.cycleRepeat(); // all -> one
    });

    const audio = result.current.audioRef.current;
    await makePlaying(audio);
    audio.currentTime = 61;

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(result.current.currentTrack?.id).toBe(1);
    expect(audio.currentTime).toBe(30);
  });

  it('arms the trim stop when a trim is applied to the playing track (#463 follow-up)', async () => {
    const { result } = await renderReady();
    const queue = [TRACK_PLAIN, TRACK_TRIMMED];
    await act(async () => {
      result.current.play(queue[0], queue, 0);
    });
    const audio = result.current.audioRef.current;
    await makePlaying(audio);

    // Prepare Track → Apply patches the playing row. The track had no trim when
    // playback started, so the stop has to arm on the patch, not only on the next
    // play — otherwise OUT is ignored and the track runs to the end of the file.
    act(() => {
      result.current.patchCurrentTrack(2, { trim_start_ms: 10_000, trim_end_ms: 20_000 });
    });

    audio.currentTime = 21;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(result.current.currentTrack?.id).toBe(1);
    expect(result.current.queueIndex).toBe(1);
  });

  it('arms the stop when the trim is applied while the track is paused', async () => {
    const { result } = await renderReady();
    const queue = [TRACK_PLAIN, TRACK_TRIMMED];
    await act(async () => {
      result.current.play(queue[0], queue, 0);
    });
    const audio = result.current.audioRef.current;
    // Paused: the element is loaded but not running (the user stopped it to edit).
    Object.defineProperty(audio, 'paused', { configurable: true, get: () => true });

    act(() => {
      result.current.patchCurrentTrack(2, { trim_start_ms: 10_000, trim_end_ms: 20_000 });
    });

    // Pressing play again has to honour the range that was just saved, without
    // restarting the track first.
    Object.defineProperty(audio, 'paused', { configurable: true, get: () => false });
    audio.currentTime = 21;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(result.current.currentTrack?.id).toBe(1);
    expect(result.current.queueIndex).toBe(1);
  });

  it('does not arm anything when the patched trim is unchanged', async () => {
    const { result } = await renderReady();
    await act(async () => {
      result.current.play(TRACK_TRIMMED, [TRACK_TRIMMED], 0);
    });
    const audio = result.current.audioRef.current;
    await makePlaying(audio);

    // Auditioning outside the range disarms the stop…
    act(() => {
      result.current.seek(90);
    });
    // …and an unrelated patch carrying the SAME trim must not re-arm it.
    act(() => {
      result.current.patchCurrentTrack(1, { bpm_override: 128 });
    });
    audio.currentTime = 61;

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(result.current.isPlaying).toBe(true);
    expect(result.current.currentTrack?.id).toBe(1);
  });
});
