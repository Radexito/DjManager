import { useState, useEffect, useCallback } from 'react';
import './TrackDetails.css';
import AutoTaggerModal from './AutoTaggerModal.jsx';
import { usePlayer } from './PlayerContext.jsx';
import { artworkUrl } from './artworkUrl.js';
import RatingStars from './RatingStars.jsx';

const EDITABLE_FIELDS = [
  { key: 'title', label: 'Title', type: 'text', bulkSupported: false },
  { key: 'artist', label: 'Artist', type: 'text', bulkSupported: true },
  { key: 'album', label: 'Album', type: 'text', bulkSupported: true },
  { key: 'year', label: 'Year', type: 'number', bulkSupported: true },
  { key: 'genres', label: 'Genres', type: 'genres', bulkSupported: true },
  { key: 'label', label: 'Label', type: 'text', bulkSupported: true },
  { key: 'rating', label: 'Rating', type: 'rating', bulkSupported: true },
  { key: 'user_tags', label: 'Tags', type: 'tags', bulkSupported: true },
  { key: 'comments', label: 'Comments', type: 'textarea', bulkSupported: true },
];

function formatDuration(secs) {
  if (secs == null) return '—';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function trackToForm(track) {
  return {
    title: track.title ?? '',
    artist: track.artist ?? '',
    album: track.album ?? '',
    year: track.year != null ? String(track.year) : '',
    genres: JSON.parse(track.genres ?? '[]').join(', '),
    label: track.label ?? '',
    rating: track.rating ?? 0,
    user_tags: track.user_tags ?? '',
    comments: track.comments ?? '',
  };
}

// For bulk mode: start with empty form; only filled fields are applied on save.
const EMPTY_BULK_FORM = {
  title: '',
  artist: '',
  album: '',
  year: '',
  genres: '',
  label: '',
  rating: null, // null = "don't change"
  user_tags: '',
  comments: '',
};

export default function TrackDetails({
  track, // single mode: track object
  tracks, // bulk mode: array of track objects (takes precedence when set)
  onSave,
  onCancel,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}) {
  const isBulk = Array.isArray(tracks) && tracks.length > 1;
  const { mediaPort } = usePlayer() ?? {};
  const [form, setForm] = useState(() => (isBulk ? EMPTY_BULK_FORM : trackToForm(track)));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [showAutoTagger, setShowAutoTagger] = useState(false);
  const [artworkPath, setArtworkPath] = useState(() => track?.artwork_path ?? null);

  // Reset form when track/tracks changes
  useEffect(() => {
    setForm(isBulk ? EMPTY_BULK_FORM : trackToForm(track));
    setArtworkPath(track?.artwork_path ?? null);
    setDirty(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBulk ? tracks.map((t) => t.id).join(',') : track?.id]);

  const handleChange = useCallback((key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      if (isBulk) {
        // Only apply fields that the user actually filled in.
        const genreArray = form.genres
          .split(',')
          .map((g) => g.trim())
          .filter(Boolean);
        const data = {};
        if (form.artist.trim() !== '') data.artist = form.artist.trim();
        if (form.album.trim() !== '') data.album = form.album.trim();
        if (form.year.trim() !== '') data.year = parseInt(form.year, 10) || null;
        if (form.genres.trim() !== '') data.genres = JSON.stringify(genreArray);
        if (form.label.trim() !== '') data.label = form.label.trim();
        if (form.rating !== null) data.rating = form.rating;
        if (form.user_tags.trim() !== '') data.user_tags = form.user_tags.trim();
        if (form.comments.trim() !== '') data.comments = form.comments.trim();
        if (Object.keys(data).length === 0) {
          setSaving(false);
          return;
        }
        await Promise.all(tracks.map((t) => window.api.updateTrack(t.id, data)));
        onSave(tracks.map((t) => ({ ...t, ...data })));
        setDirty(false);
      } else {
        const genreArray = form.genres
          .split(',')
          .map((g) => g.trim())
          .filter(Boolean);
        const data = {
          title: form.title.trim() || track.title,
          artist: form.artist,
          album: form.album,
          year: form.year !== '' ? parseInt(form.year, 10) || null : null,
          genres: JSON.stringify(genreArray),
          label: form.label,
          rating: form.rating,
          user_tags: form.user_tags,
          comments: form.comments,
        };
        await window.api.updateTrack(track.id, data);
        onSave({ ...track, ...data });
        setDirty(false);
      }
    } catch (e) {
      setError(e.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [form, track, tracks, isBulk, onSave]);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === 'Escape') onCancel();
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (dirty) handleSave();
      }
    },
    [onCancel, dirty, handleSave]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const visibleFields = isBulk ? EDITABLE_FIELDS.filter((f) => f.bulkSupported) : EDITABLE_FIELDS;

  return (
    <div className="track-details">
      <div className="track-details__header">
        <span className="track-details__title">
          {isBulk ? `Edit ${tracks.length} Tracks` : 'Track Details'}
        </span>
        <button className="track-details__close" onClick={onCancel} title="Close (Esc)">
          ✕
        </button>
      </div>

      {!isBulk && (
        <div className="track-details__cover">
          {artworkUrl(artworkPath, mediaPort) ? (
            <img
              className="track-details__cover-img"
              src={artworkUrl(artworkPath, mediaPort)}
              alt="Cover art"
              draggable={false}
            />
          ) : (
            <div className="track-details__cover-placeholder">♪</div>
          )}
        </div>
      )}

      {isBulk && (
        <div className="track-details__bulk-hint">
          Leave a field blank to keep each track's existing value.
        </div>
      )}

      <div className="track-details__fields">
        {visibleFields.map(({ key, label, type }) => (
          <label key={key} className="track-details__field">
            <span className="track-details__label">{label}</span>
            {type === 'rating' ? (
              <RatingStars
                value={form.rating ?? 0}
                onChange={(val) => handleChange('rating', val)}
              />
            ) : type === 'tags' ? (
              <input
                className="track-details__input"
                type="text"
                value={form[key]}
                placeholder={isBulk ? 'Leave blank to keep existing' : 'e.g. dark, peak-hour, 90s'}
                onChange={(e) => handleChange(key, e.target.value)}
              />
            ) : type === 'textarea' ? (
              <textarea
                className="track-details__input track-details__input--textarea"
                value={form[key]}
                placeholder={isBulk ? 'Leave blank to keep existing' : ''}
                onChange={(e) => handleChange(key, e.target.value)}
              />
            ) : (
              <input
                className="track-details__input"
                type={type === 'number' ? 'number' : 'text'}
                value={form[key]}
                placeholder={isBulk ? 'Leave blank to keep existing' : ''}
                onChange={(e) => handleChange(key, e.target.value)}
              />
            )}
          </label>
        ))}
      </div>

      {!isBulk && (
        <div className="track-details__info">
          <div className="track-details__info-header">
            <span className="track-details__info-title">Track Info</span>
            <button
              className="track-details__autotag-btn"
              onClick={() => setShowAutoTagger(true)}
              title="Fetch metadata from MusicBrainz or Discogs"
            >
              🔍 Auto-tag
            </button>
          </div>
          <div className="track-details__info-row">
            <span>BPM</span>
            <span>
              {track.bpm_override ?? track.bpm ?? '—'}
              {track.bpm_override != null ? ' *' : ''}
            </span>
          </div>
          <div className="track-details__info-row">
            <span>Key</span>
            <span>{track.key_camelot ?? track.key_raw ?? '—'}</span>
          </div>
          <div className="track-details__info-row">
            <span>Loudness</span>
            <span>{track.loudness != null ? `${track.loudness} LUFS` : '—'}</span>
          </div>
          <div className="track-details__info-row">
            <span>Duration</span>
            <span>{formatDuration(track.duration)}</span>
          </div>
          <div className="track-details__info-row">
            <span>Format</span>
            <span>{track.format ?? '—'}</span>
          </div>
          <div className="track-details__info-row">
            <span>Bitrate</span>
            <span>{track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : '—'}</span>
          </div>
        </div>
      )}

      {error && <div className="track-details__error">{error}</div>}

      <div className="track-details__actions">
        <div className="track-details__nav">
          {!isBulk && (
            <>
              <button
                className="track-details__btn track-details__btn--nav"
                onClick={onPrev}
                disabled={!hasPrev}
                title="Previous track"
              >
                ‹ Prev
              </button>
              <button
                className="track-details__btn track-details__btn--nav"
                onClick={onNext}
                disabled={!hasNext}
                title="Next track"
              >
                Next ›
              </button>
            </>
          )}
        </div>
        <div className="track-details__save-group">
          <button className="track-details__btn track-details__btn--cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="track-details__btn track-details__btn--save"
            onClick={handleSave}
            disabled={!dirty || saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {showAutoTagger && (
        <AutoTaggerModal
          track={track}
          onClose={() => setShowAutoTagger(false)}
          onApply={async (update) => {
            // Merge result into form fields (convert genres array → comma string)
            const merged = { ...form };
            if (update.title != null) merged.title = update.title;
            if (update.artist != null) merged.artist = update.artist;
            if (update.album != null) merged.album = update.album;
            if (update.label != null) merged.label = update.label;
            if (update.year != null) merged.year = String(update.year);
            if (update.genres != null) {
              try {
                merged.genres = JSON.parse(update.genres).join(', ');
              } catch {
                merged.genres = update.genres;
              }
            }
            setForm(merged);
            setDirty(true);
            setShowAutoTagger(false);
            // Download and save cover art if selected
            if (update.coverUrl && track?.id) {
              const res = await window.api.fetchArtworkUrl({
                trackId: track.id,
                url: update.coverUrl,
              });
              if (res.ok) setArtworkPath(res.artwork_path);
            }
          }}
        />
      )}
    </div>
  );
}
