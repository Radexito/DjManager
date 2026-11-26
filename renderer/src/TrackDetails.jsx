import { useState, useEffect, useCallback, useRef } from 'react';
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

/** Format a duration in seconds as m:ss, or an em dash when unknown. */
function formatDuration(secs) {
  if (secs == null) return '—';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Turn a cover art download failure into a message for the user, hiding the
 * generic "fetch failed" text behind a readable explanation.
 *
 * @param {string} [error] Error message from the main process.
 * @returns {string} Message to display.
 */
function formatCoverArtDownloadError(error) {
  const message = error?.trim?.() || '';
  if (!message || message === 'unknown error' || message === 'fetch failed') {
    return 'Failed to download cover art. The selected image could not be fetched.';
  }
  return `Failed to download cover art: ${message}`;
}

/**
 * Map a track to the editable form values, turning the stored genre JSON and
 * nulls into strings/zeros the inputs can hold.
 *
 * @param {object} track Track to edit.
 * @returns {object} Form state.
 */
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

const EMPTY_BULK_FORM = {
  title: '',
  artist: '',
  album: '',
  year: '',
  genres: '',
  label: '',
  rating: null,
  user_tags: '',
  comments: '',
};

/**
 * Track editor. Edits one track, or several at once when a multi-selection is
 * passed: bulk mode only writes the fields that were filled in, leaving the rest
 * untouched.
 *
 * @param {object} track Track being edited (the first of the selection).
 * @param {object[]} [tracks] Whole selection; more than one entry switches to bulk
 *   editing.
 * @param {(saved: object|object[]) => void} onSave Receives the updated track, or the
 *   updated array in bulk mode.
 * @param {() => void} onCancel Discards the edits.
 * @param {() => void} onPrev Moves to the previous track in the list.
 * @param {() => void} onNext Moves to the next track in the list.
 * @param {boolean} hasPrev Whether a previous track exists.
 * @param {boolean} hasNext Whether a next track exists.
 * @param {boolean} pinned Whether the dialog is pinned open while browsing.
 * @param {() => void} onTogglePin Toggles the pinned state.
 * @param {(dirty: boolean) => void} onDirtyChange Reports unsaved changes to the parent.
 */
export default function TrackDetails({
  track,
  tracks,
  onSave,
  saveTrack,
  onCancel,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  pinned,
  onTogglePin,
  onDirtyChange,
}) {
  const isBulk = Array.isArray(tracks) && tracks.length > 1;
  const { mediaPort } = usePlayer() ?? {};
  const [form, setForm] = useState(() => (isBulk ? EMPTY_BULK_FORM : trackToForm(track)));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [showAutoTagger, setShowAutoTagger] = useState(false);
  const [artworkPath, setArtworkPath] = useState(() => track?.artwork_path ?? null);
  const [libraries, setLibraries] = useState([]);
  const [moveTargetId, setMoveTargetId] = useState('');
  const [locationBusy, setLocationBusy] = useState(false);
  const [locationError, setLocationError] = useState(null);
  // What the panel was opened with, so a save can say which fields the user
  // actually touched instead of sending every field every time.
  const initialFormRef = useRef(null);

  useEffect(() => {
    const next = isBulk ? EMPTY_BULK_FORM : trackToForm(track);
    initialFormRef.current = next;
    setForm(next);
    setArtworkPath(track?.artwork_path ?? null);
    setDirty(false);
    setError(null);
    setMoveTargetId('');
    setLocationError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBulk ? tracks.map((t) => t.id).join(',') : track?.id]);

  useEffect(() => {
    if (!isBulk) window.api.listLibraries().then(setLibraries);
  }, [isBulk]);

  const handleCopyPath = useCallback(() => {
    if (track?.file_path) navigator.clipboard.writeText(track.file_path).catch(() => {});
  }, [track]);

  const handleBrowseRelink = useCallback(async () => {
    setLocationBusy(true);
    setLocationError(null);
    try {
      const res = await window.api.remapTrack(track.id, track.file_path);
      if (res.ok) onSave({ ...track, file_path: res.newPath });
    } catch (e) {
      setLocationError(e.message ?? 'Relink failed');
    } finally {
      setLocationBusy(false);
    }
  }, [track, onSave]);

  const handleMoveToLibrary = useCallback(
    async (targetLibraryId) => {
      if (!targetLibraryId) return;
      setLocationBusy(true);
      setLocationError(null);
      try {
        const res = await window.api.moveTrackToLibrary(track.id, Number(targetLibraryId));
        if (res.ok) {
          onSave({
            ...track,
            library_id: Number(targetLibraryId),
            is_linked: 0,
            ...(res.newPath ? { file_path: res.newPath } : {}),
          });
          setMoveTargetId('');
        }
      } catch (e) {
        setLocationError(e.message ?? 'Move failed');
      } finally {
        setLocationBusy(false);
      }
    },
    [track, onSave]
  );

  const currentLibraryName = track?.is_linked
    ? null
    : (libraries.find((l) => l.id === track?.library_id)?.name ?? (track?.library_id ? '—' : null));
  const otherLibraries = libraries.filter((l) => l.id !== track?.library_id);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const handleChange = useCallback((key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      if (isBulk) {
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
        const initial = initialFormRef.current ?? {};
        const changed = Object.keys(data).filter(
          (key) => String(data[key] ?? '') !== String(initial[key] ?? '')
        );
        if (saveTrack) await saveTrack(track.id, data, changed);
        else await window.api.updateTrack(track.id, data);
        onSave({ ...track, ...data });
        setDirty(false);
      }
    } catch (e) {
      setError(e.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [form, track, tracks, isBulk, onSave, saveTrack]);

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
        {!isBulk && onTogglePin && (
          <button
            className={`track-details__pin${pinned ? ' track-details__pin--active' : ''}`}
            onClick={onTogglePin}
            title={
              pinned
                ? 'Unpin — resume following the row selection'
                : 'Pin — keep this track open regardless of selection'
            }
          >
            {pinned ? '📌 Pinned' : '📌'}
          </button>
        )}
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

      {!isBulk && (
        <div className="track-details__info">
          <div className="track-details__info-header">
            <span className="track-details__info-title">Location</span>
          </div>
          <div className="track-details__location-row">
            <input
              className="track-details__input track-details__path-input"
              type="text"
              readOnly
              value={track.file_path ?? ''}
              title={track.file_path ?? ''}
              onFocus={(e) => e.target.select()}
            />
            <button
              className="track-details__btn track-details__btn--small"
              onClick={handleCopyPath}
              title="Copy path"
            >
              Copy
            </button>
            {track.is_linked && (
              <button
                className="track-details__btn track-details__btn--small"
                onClick={handleBrowseRelink}
                disabled={locationBusy}
                title="Point this track at a different file"
              >
                Browse…
              </button>
            )}
          </div>
          <div className="track-details__location-row">
            <span className="track-details__label">Library</span>
            {!track.is_linked && <span>{currentLibraryName ?? '—'}</span>}
            {track.is_linked ? (
              libraries.length > 0 && (
                <>
                  <select
                    className="track-details__select"
                    value={moveTargetId || String(track.library_id ?? '')}
                    onChange={(e) => setMoveTargetId(e.target.value)}
                    disabled={locationBusy}
                  >
                    {libraries.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="track-details__btn track-details__btn--small"
                    onClick={() => handleMoveToLibrary(moveTargetId || track.library_id)}
                    disabled={locationBusy}
                    title="Copy this linked file into the selected library, making it a managed track"
                  >
                    Import into library
                  </button>
                </>
              )
            ) : otherLibraries.length > 0 ? (
              <>
                <select
                  className="track-details__select"
                  value={moveTargetId}
                  onChange={(e) => setMoveTargetId(e.target.value)}
                  disabled={locationBusy}
                >
                  <option value="">Move to…</option>
                  {otherLibraries.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
                <button
                  className="track-details__btn track-details__btn--small"
                  onClick={() => handleMoveToLibrary(moveTargetId)}
                  disabled={!moveTargetId || locationBusy}
                >
                  Move
                </button>
              </>
            ) : null}
          </div>
          {locationError && <div className="track-details__error">{locationError}</div>}
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
            setShowAutoTagger(false);
            setSaving(true);
            setError(null);
            try {
              const data = {};
              if (update.title != null) data.title = update.title;
              if (update.artist != null) data.artist = update.artist;
              if (update.album != null) data.album = update.album;
              if (update.label != null) data.label = update.label;
              if (update.year != null) data.year = update.year;
              if (update.genres != null) data.genres = update.genres;

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

              if (Object.keys(data).length > 0) {
                await window.api.updateTrack(track.id, data);
                onSave({ ...track, ...data });
              }

              if (update.coverUrl && track?.id) {
                try {
                  const res = await window.api.fetchArtworkUrl({
                    trackId: track.id,
                    url: update.coverUrl,
                  });
                  if (res.ok) {
                    setArtworkPath(res.artwork_path);
                    onSave({ ...track, ...data, artwork_path: res.artwork_path, has_artwork: 1 });
                  } else {
                    setError(formatCoverArtDownloadError(res.error));
                  }
                } catch (err) {
                  setError(formatCoverArtDownloadError(err?.message));
                }
              }
            } catch (e) {
              setError(e.message ?? 'Auto-tag apply failed');
            } finally {
              setSaving(false);
            }
          }}
        />
      )}
    </div>
  );
}
