// renderer/src/__tests__/CuePointsEditor.swap.test.jsx
// Hot cue slot swap confirmation: taking a slot another cue already holds must
// ask before overwriting, and both code paths (deferred local state + IPC) have
// to move both cues.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import CuePointsEditor from '../CuePointsEditor.jsx';

vi.mock('../PlayerContext.jsx', () => ({
  usePlayer: () => ({ currentTime: 0, seek: vi.fn() }),
}));

const HOT_A = {
  id: 1,
  track_id: 7,
  position_ms: 10_000,
  label: 'Intro',
  color: '#ff6b35',
  hot_cue_index: 0,
  enabled: 1,
};
const HOT_B = {
  id: 2,
  track_id: 7,
  position_ms: 30_000,
  label: 'Drop',
  color: '#ff0000',
  hot_cue_index: 1,
  enabled: 1,
};
const MEMORY = {
  id: 3,
  track_id: 7,
  position_ms: 50_000,
  label: 'Sweep',
  color: '#00b4d8',
  hot_cue_index: -1,
  enabled: 1,
};

// In-memory cue table behind the IPC mock, so reload() reflects what was written.
let cues;

beforeEach(() => {
  vi.clearAllMocks();
  cues = [HOT_A, HOT_B].map((c) => ({ ...c }));
  window.api.getCuePoints.mockImplementation(async () => cues.map((c) => ({ ...c })));
  window.api.updateCuePoint.mockImplementation(async (id, update) => {
    const cue = cues.find((c) => c.id === id);
    if (cue && update.hotCueIndex != null) cue.hot_cue_index = update.hotCueIndex;
    return { ok: true };
  });
});

async function renderEditor(props = {}) {
  const utils = render(<CuePointsEditor trackId={7} {...props} />);
  await act(async () => {}); // let the initial getCuePoints resolve
  return utils;
}

const badgeTexts = () => [...document.querySelectorAll('.cpe__badge')].map((el) => el.textContent);

function openPicker(badgeLabel) {
  const badge = [...document.querySelectorAll('.cpe__badge')].find(
    (el) => el.textContent === badgeLabel
  );
  fireEvent.click(badge);
}

function pickType(title) {
  fireEvent.click(screen.getByTitle(title));
}

describe('CuePointsEditor — hot cue slot swap', () => {
  it('applies a free hot cue slot immediately, with no prompt', async () => {
    cues.push({ ...MEMORY });
    await renderEditor();

    openPicker('●');
    pickType('Hot cue C');
    await act(async () => {});

    expect(document.querySelector('.cpe__confirm')).toBeNull();
    expect(window.api.updateCuePoint).toHaveBeenCalledTimes(1);
    expect(window.api.updateCuePoint).toHaveBeenCalledWith(3, { hotCueIndex: 2 });
    expect(badgeTexts()).toEqual(['A', 'B', 'C']);
  });

  it('asks before taking an occupied slot and changes nothing yet', async () => {
    await renderEditor();

    openPicker('B');
    pickType('Hot cue A');

    const confirm = document.querySelector('.cpe__confirm');
    expect(confirm).toBeInTheDocument();
    // Both cues are named by slot letter and label.
    expect(confirm).toHaveTextContent('Hot cue A (Intro) is taken');
    expect(confirm).toHaveTextContent('Hot cue B (Drop) takes Hot cue A');
    expect(confirm).toHaveTextContent('Hot cue A (Intro) takes Hot cue B');
    expect(window.api.updateCuePoint).not.toHaveBeenCalled();
    expect(badgeTexts()).toEqual(['A', 'B']);
  });

  it('swaps both cues when the swap is confirmed', async () => {
    await renderEditor();

    openPicker('B');
    pickType('Hot cue A');
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await act(async () => {});

    expect(window.api.updateCuePoint).toHaveBeenNthCalledWith(1, 2, { hotCueIndex: 0 });
    expect(window.api.updateCuePoint).toHaveBeenNthCalledWith(2, 1, { hotCueIndex: 1 });
    expect(document.querySelector('.cpe__confirm')).toBeNull();
    expect(badgeTexts()).toEqual(['B', 'A']);
  });

  it('leaves both cues unchanged when the swap is cancelled', async () => {
    await renderEditor();

    openPicker('B');
    pickType('Hot cue A');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {});

    expect(window.api.updateCuePoint).not.toHaveBeenCalled();
    expect(document.querySelector('.cpe__confirm')).toBeNull();
    expect(badgeTexts()).toEqual(['A', 'B']);
  });

  it('never asks when the memory cue type is chosen', async () => {
    await renderEditor();

    openPicker('A');
    pickType('Memory cue');
    await act(async () => {});

    expect(document.querySelector('.cpe__confirm')).toBeNull();
    expect(window.api.updateCuePoint).toHaveBeenCalledTimes(1);
    expect(window.api.updateCuePoint).toHaveBeenCalledWith(1, { hotCueIndex: -1 });
  });

  it('turns the previous holder into a memory cue when the edited cue was one', async () => {
    cues.push({ ...MEMORY });
    await renderEditor();

    openPicker('●');
    pickType('Hot cue A');

    expect(document.querySelector('.cpe__confirm')).toHaveTextContent('becomes a memory cue');

    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await act(async () => {});

    expect(window.api.updateCuePoint).toHaveBeenNthCalledWith(1, 3, { hotCueIndex: 0 });
    expect(window.api.updateCuePoint).toHaveBeenNthCalledWith(2, 1, { hotCueIndex: -1 });
    expect(badgeTexts()).toEqual(['●', 'B', 'A']);
  });
});

describe('CuePointsEditor — hot cue slot swap (deferred / Prepare Track path)', () => {
  it('swaps both cues in local state without writing to IPC', async () => {
    const onCuePointsChange = vi.fn();
    await renderEditor({ deferred: true, onCuePointsChange });

    openPicker('B');
    pickType('Hot cue A');
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    await act(async () => {});

    expect(window.api.updateCuePoint).not.toHaveBeenCalled();
    expect(badgeTexts()).toEqual(['B', 'A']);

    const last = onCuePointsChange.mock.calls.at(-1)[0];
    expect(last.map((c) => [c.id, c.hot_cue_index])).toEqual([
      [1, 1],
      [2, 0],
    ]);
  });

  it('asks in deferred mode too, and applies a free slot without asking', async () => {
    cues.push({ ...MEMORY });
    await renderEditor({ deferred: true });

    openPicker('●');
    pickType('Hot cue A');
    expect(document.querySelector('.cpe__confirm')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(badgeTexts()).toEqual(['A', 'B', '●']);

    openPicker('●');
    pickType('Hot cue C');
    expect(document.querySelector('.cpe__confirm')).toBeNull();
    expect(window.api.updateCuePoint).not.toHaveBeenCalled();
    expect(badgeTexts()).toEqual(['A', 'B', 'C']);
  });
});
