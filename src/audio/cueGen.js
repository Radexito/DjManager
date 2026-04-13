/**
 * CueGen — auto-generate cue points from existing track analysis.
 *
 * Inspired by https://github.com/mganss/CueGen but implemented natively
 * using the analysis data already stored by mixxx-analyzer (intro_secs,
 * outro_secs, beatgrid, bpm) — no external .NET runtime required.
 *
 * Generated cues (all assigned as hot cues A–H, indices 0–7):
 *   Hot cue A (index 0) — intro end: first beat after the intro (mix-in point)
 *   Hot cues B–G        — every 32 bars from the intro end (section markers)
 *   Hot cue H (or last) — outro start: last strong beat before the fade/outro
 *
 * Memory cues (hotCueIndex = -1) are NOT used because their PCOB2 binary
 * format is not yet reverse-engineered and they are invisible in Rekordbox.
 */

const HOT_CUE_COLOR = '#ff6b35'; // orange-red, matches Rekordbox default hot cue A
const SECTION_COLOR = '#00b4d8'; // cyan for phrase markers
const OUTRO_COLOR = '#ff9900'; // amber for the outro/mix-out marker

/**
 * Parse beatgrid JSON produced by mixxx-analyzer.
 * Returns array of { positionSecs } objects sorted by time, or null.
 */
function parseBeatgrid(beatgridJson) {
  if (!beatgridJson) return null;
  try {
    const raw = JSON.parse(beatgridJson);
    if (!Array.isArray(raw) || raw.length === 0) return null;
    // mixxx-analyzer produces [{ beat_number, position_seconds, bpm }]
    const beats = raw
      .filter((b) => typeof b.position_seconds === 'number')
      .map((b) => ({ positionSecs: b.position_seconds }))
      .sort((a, b) => a.positionSecs - b.positionSecs);
    return beats.length > 0 ? beats : null;
  } catch {
    return null;
  }
}

/**
 * Find the beat index closest to targetSecs.
 */
function nearestBeatIndex(beats, targetSecs) {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < beats.length; i++) {
    const diff = Math.abs(beats[i].positionSecs - targetSecs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

/**
 * Generate cue points for a track using its stored analysis data.
 *
 * @param {object} track  Row from the tracks table
 * @returns {Array<{positionMs, label, color, hotCueIndex}>}
 */
export function generateCuePoints(track) {
  const duration = track.duration ?? 0;
  if (duration < 10) return []; // too short to be meaningful

  const introSecs = track.intro_secs ?? 0;
  // outro_secs is the absolute position (from track start) where the outro begins
  const outroSecs = track.outro_secs ?? 0;
  const bpm = track.bpm_override ?? track.bpm ?? 0;

  const beats = parseBeatgrid(track.beatgrid);

  // Cues are collected in order and assigned to hot cue slots A–H (0–7).
  // The outro cue is reserved for the last available slot (H if 8+ cues, or
  // whatever slot comes after the phrase markers).
  const raw = []; // { positionMs, label, color }

  // ── Hot cue A: mix-in point (intro end) ────────────────────────────────────
  let introEndSecs = introSecs;
  if (beats && introEndSecs > 0) {
    // Snap to nearest beat after introSecs
    const idx = nearestBeatIndex(beats, introSecs);
    introEndSecs = beats[idx].positionSecs;
  }
  raw.push({
    positionMs: Math.round(introEndSecs * 1000),
    label: 'Mix In',
    color: HOT_CUE_COLOR,
  });

  // outro_secs is absolute — use directly as the cut-off for phrase markers
  const outroStartSecs = outroSecs > 0 ? outroSecs : duration;

  // ── Phrase markers every 32 bars ───────────────────────────────────────────
  if (bpm > 0) {
    const secsPerBar = (60 / bpm) * 4; // 4/4 time
    const phraseSecs = secsPerBar * 32;

    if (beats) {
      // Walk 32-bar intervals using actual beat positions
      const startIdx = nearestBeatIndex(beats, introEndSecs);
      let phraseIdx = startIdx + 128; // 32 bars × 4 beats
      while (phraseIdx < beats.length) {
        const pos = beats[phraseIdx].positionSecs;
        if (pos >= outroStartSecs - 2) break;
        raw.push({
          positionMs: Math.round(pos * 1000),
          label: `Bar ${Math.round((pos - introEndSecs) / secsPerBar) + 1}`,
          color: SECTION_COLOR,
        });
        phraseIdx += 128;
      }
    } else if (phraseSecs > 0) {
      // No beatgrid — use BPM arithmetic
      let pos = introEndSecs + phraseSecs;
      while (pos < outroStartSecs - 2) {
        raw.push({
          positionMs: Math.round(pos * 1000),
          label: `Bar ${Math.round((pos - introEndSecs) / secsPerBar) + 1}`,
          color: SECTION_COLOR,
        });
        pos += phraseSecs;
      }
    }
  }

  // ── Outro start (mix-out point) ─────────────────────────────────────────────
  if (outroSecs > 0 && outroSecs < duration) {
    let mixOutSecs = outroSecs;
    if (beats) {
      const idx = nearestBeatIndex(beats, outroSecs);
      mixOutSecs = beats[idx].positionSecs;
    }
    raw.push({
      positionMs: Math.round(mixOutSecs * 1000),
      label: 'Mix Out',
      color: OUTRO_COLOR,
    });
  }

  // Assign hot cue slots A–H (indices 0–7). Cues beyond index 7 are dropped
  // since memory cue format is not yet supported (see issue #208).
  return raw.slice(0, 8).map((cue, i) => ({ ...cue, hotCueIndex: i }));
}
