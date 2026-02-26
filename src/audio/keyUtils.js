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

export function toCamelot(key, mode = 'major') {
  const base = camelotMap[key];
  if (!base) return null;

  const number = base.slice(0, -1);
  return `${number}${mode === 'minor' ? 'A' : 'B'}`;
}
