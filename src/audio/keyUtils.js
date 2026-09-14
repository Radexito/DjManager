// Basic Camelot wheel mapping
const camelotMap = {
  C: '8B',
  'C#': '3B',
  Db: '3B',
  D: '10B',
  'D#': '5B',
  Eb: '5B',
  E: '12B',
  F: '7B',
  'F#': '2B',
  Gb: '2B',
  G: '9B',
  'G#': '4B',
  Ab: '4B',
  A: '11B',
  'A#': '6B',
  Bb: '6B',
  B: '1B',
};

// The same wheel for minor keys. The number is the one of the relative major
// (three semitones up), which is why 'F# minor' is 11A and not 2A - the naive
// "same number, letter A" reading of the map above is wrong for any tonic whose
// minor is not its own relative minor.
const camelotMinorMap = {
  C: '5A',
  'C#': '12A',
  Db: '12A',
  D: '7A',
  'D#': '2A',
  Eb: '2A',
  E: '9A',
  F: '4A',
  'F#': '11A',
  Gb: '11A',
  G: '6A',
  'G#': '1A',
  Ab: '1A',
  A: '8A',
  'A#': '3A',
  Bb: '3A',
  B: '10A',
};

export function toCamelot(key, mode = 'major') {
  if (String(mode).toLowerCase().startsWith('min')) return camelotMinorMap[key] ?? null;
  return camelotMap[key] ?? null;
}
