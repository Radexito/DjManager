import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TrackDetails from '../TrackDetails.jsx';

const SAMPLE_TRACK = {
  id: 1,
  title: 'Test Track',
  artist: 'Test Artist',
  album: 'Test Album',
  year: 2022,
  genres: '["Techno"]',
  label: 'Some Label',
  comments: '',
  bpm: 128,
  bpm_override: null,
  key_camelot: '8a',
  key_raw: 'Am',
  loudness: -8,
  duration: 185,
  format: 'mp3',
  bitrate: 320000,
};

const SAMPLE_TRACK_2 = {
  ...SAMPLE_TRACK,
  id: 2,
  title: 'Second Track',
  file_hash: 'def456',
};

describe('TrackDetails — single mode', () => {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  const onPrev = vi.fn();
  const onNext = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    window.api.updateTrack.mockResolvedValue({});
  });

  it('renders "Track Details" header', () => {
    render(
      <TrackDetails
        track={SAMPLE_TRACK}
        onSave={onSave}
        onCancel={onCancel}
        onPrev={onPrev}
        onNext={onNext}
        hasPrev={false}
        hasNext={true}
      />
    );
    expect(screen.getByText('Track Details')).toBeInTheDocument();
  });

  it('pre-fills Title field with track title', () => {
    render(
      <TrackDetails
        track={SAMPLE_TRACK}
        onSave={onSave}
        onCancel={onCancel}
        onPrev={onPrev}
        onNext={onNext}
        hasPrev={false}
        hasNext={false}
      />
    );
    expect(screen.getByDisplayValue('Test Track')).toBeInTheDocument();
  });

  it('shows Prev and Next navigation buttons', () => {
    render(
      <TrackDetails
        track={SAMPLE_TRACK}
        onSave={onSave}
        onCancel={onCancel}
        onPrev={onPrev}
        onNext={onNext}
        hasPrev={true}
        hasNext={true}
      />
    );
    expect(screen.getByTitle('Previous track')).toBeInTheDocument();
    expect(screen.getByTitle('Next track')).toBeInTheDocument();
  });

  it('disables Prev when hasPrev=false', () => {
    render(
      <TrackDetails
        track={SAMPLE_TRACK}
        onSave={onSave}
        onCancel={onCancel}
        onPrev={onPrev}
        onNext={onNext}
        hasPrev={false}
        hasNext={true}
      />
    );
    expect(screen.getByTitle('Previous track')).toBeDisabled();
    expect(screen.getByTitle('Next track')).not.toBeDisabled();
  });

  it('shows read-only info section with BPM, Key, Bitrate', () => {
    render(
      <TrackDetails
        track={SAMPLE_TRACK}
        onSave={onSave}
        onCancel={onCancel}
        onPrev={onPrev}
        onNext={onNext}
        hasPrev={false}
        hasNext={false}
      />
    );
    expect(screen.getByText('BPM')).toBeInTheDocument();
    expect(screen.getByText('Key')).toBeInTheDocument();
    expect(screen.getByText('Bitrate')).toBeInTheDocument();
    expect(screen.getByText('320 kbps')).toBeInTheDocument();
  });

  it('calls onCancel when Cancel is clicked', () => {
    render(
      <TrackDetails
        track={SAMPLE_TRACK}
        onSave={onSave}
        onCancel={onCancel}
        onPrev={onPrev}
        onNext={onNext}
        hasPrev={false}
        hasNext={false}
      />
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('save button is disabled when form is clean', () => {
    render(
      <TrackDetails
        track={SAMPLE_TRACK}
        onSave={onSave}
        onCancel={onCancel}
        onPrev={onPrev}
        onNext={onNext}
        hasPrev={false}
        hasNext={false}
      />
    );
    expect(screen.getByText('Save')).toBeDisabled();
  });

  it('enables Save and calls updateTrack when field is changed and saved', async () => {
    render(
      <TrackDetails
        track={SAMPLE_TRACK}
        onSave={onSave}
        onCancel={onCancel}
        onPrev={onPrev}
        onNext={onNext}
        hasPrev={false}
        hasNext={false}
      />
    );
    fireEvent.change(screen.getByDisplayValue('Test Artist'), { target: { value: 'New Artist' } });
    const saveBtn = screen.getByText('Save');
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);
    await waitFor(() =>
      expect(window.api.updateTrack).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ artist: 'New Artist' })
      )
    );
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe('TrackDetails — bulk mode', () => {
  const onSave = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    window.api.updateTrack.mockResolvedValue({});
  });

  it('shows "Edit 2 Tracks" header', () => {
    render(
      <TrackDetails tracks={[SAMPLE_TRACK, SAMPLE_TRACK_2]} onSave={onSave} onCancel={onCancel} />
    );
    expect(screen.getByText('Edit 2 Tracks')).toBeInTheDocument();
  });

  it('shows bulk hint text', () => {
    render(
      <TrackDetails tracks={[SAMPLE_TRACK, SAMPLE_TRACK_2]} onSave={onSave} onCancel={onCancel} />
    );
    expect(screen.getByText(/Leave a field blank/i)).toBeInTheDocument();
  });

  it('does not render Title field in bulk mode', () => {
    render(
      <TrackDetails tracks={[SAMPLE_TRACK, SAMPLE_TRACK_2]} onSave={onSave} onCancel={onCancel} />
    );
    expect(screen.queryByText('Title')).not.toBeInTheDocument();
  });

  it('hides Prev/Next navigation in bulk mode', () => {
    render(
      <TrackDetails tracks={[SAMPLE_TRACK, SAMPLE_TRACK_2]} onSave={onSave} onCancel={onCancel} />
    );
    expect(screen.queryByTitle('Previous track')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Next track')).not.toBeInTheDocument();
  });

  it('hides read-only info section in bulk mode', () => {
    render(
      <TrackDetails tracks={[SAMPLE_TRACK, SAMPLE_TRACK_2]} onSave={onSave} onCancel={onCancel} />
    );
    expect(screen.queryByText('BPM')).not.toBeInTheDocument();
    expect(screen.queryByText('Bitrate')).not.toBeInTheDocument();
  });

  it('calls updateTrack for each track on save with only filled fields', async () => {
    render(
      <TrackDetails tracks={[SAMPLE_TRACK, SAMPLE_TRACK_2]} onSave={onSave} onCancel={onCancel} />
    );
    // Fill in Album, leave Artist blank
    const inputs = screen.getAllByPlaceholderText('Leave blank to keep existing');
    // Artist is first bulk-supported field
    fireEvent.change(inputs[1], { target: { value: 'VA' } }); // Album field (index 1)
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(window.api.updateTrack).toHaveBeenCalledTimes(2));
    // Both calls should include album but NOT artist (left blank)
    expect(window.api.updateTrack).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ album: 'VA' })
    );
    expect(window.api.updateTrack).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ album: 'VA' })
    );
    expect(window.api.updateTrack).toHaveBeenCalledWith(
      1,
      expect.not.objectContaining({ artist: expect.anything() })
    );
  });

  it('does not call updateTrack if all fields left blank', async () => {
    render(
      <TrackDetails tracks={[SAMPLE_TRACK, SAMPLE_TRACK_2]} onSave={onSave} onCancel={onCancel} />
    );
    // Make form dirty by typing then clearing
    const inputs = screen.getAllByPlaceholderText('Leave blank to keep existing');
    fireEvent.change(inputs[0], { target: { value: 'x' } });
    fireEvent.change(inputs[0], { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(window.api.updateTrack).not.toHaveBeenCalled());
  });
});
