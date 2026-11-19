/**
 * CueGen — auto-generate cue points from existing track analysis.
 *
 * Inspired by https://github.com/mganss/CueGen but implemented natively
 * using the analysis data already stored by mixxx-analyzer (intro_secs,
 * outro_secs, beatgrid, bpm) — no external .NET runtime required.
 *
 * Generated cues (all assigned as hot cues A–P, indices 0–15):
 *   Hot cue A (index 0)  — intro end: first beat after the intro (mix-in point)
 *   Hot cues B–O         — every 32 bars from the intro end (section markers)
 *   Hot cue P (or last)  — outro start: last strong beat before the fade/outro
 *
 * Memory cues (hotCueIndex = -1) are NOT auto-generated here — this
 * generator only produces hot cues A-P. Manually-added memory cues (e.g.
 * via the Prepare Track dialog) are accepted by the data model, but memory
 * cue export is currently disabled — see "Known Issues" in CLAUDE.md and
 * anlzWriter.js's buildPcobSections()/buildPco2Sections().
 */

const HOT_CUE_COLOR = '#ff0000';
/** Colour of the generated 32-bar section markers; a key of PIONEER_PALETTE in anlzWriter.js. */
const SECTION_COLOR = '#00b4d8';
/** Colour of the generated mix-out cue at the start of the outro; a key of PIONEER_PALETTE in anlzWriter.js. */
const OUTRO_COLOR = '#ff9900';

/**
 * Parse beatgrid JSON produced by mixxx-analyzer.
 * Returns array of { positionSecs } objects sorted by time, or null.
 */
function parseBeatgrid(beatgridJson) {
  if (!beatgridJson) return null;
  try {
    const raw = JSON.parse(beatgridJson);
    if (!Array.isArray(raw) || raw.length === 0) return null;
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
  if (duration < 10) return [];

  const introSecs = track.intro_secs ?? 0;
  const outroSecs = track.outro_secs ?? 0;
  const bpm = track.bpm_override ?? track.bpm ?? 0;

  const beats = parseBeatgrid(track.beatgrid);

  const raw = [];

  let introEndSecs = introSecs;
  if (beats && introEndSecs > 0) {
    const idx = nearestBeatIndex(beats, introSecs);
    introEndSecs = beats[idx].positionSecs;
  }
  raw.push({
    positionMs: Math.round(introEndSecs * 1000),
    label: 'Mix In',
    color: HOT_CUE_COLOR,
  });

  const outroStartSecs = outroSecs > 0 ? outroSecs : duration;

  if (bpm > 0) {
    const secsPerBar = (60 / bpm) * 4;
    const phraseSecs = secsPerBar * 32;

    if (beats) {
      const startIdx = nearestBeatIndex(beats, introEndSecs);
      let phraseIdx = startIdx + 128;
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

  return raw.slice(0, 16).map((cue, i) => ({ ...cue, hotCueIndex: i }));
}
