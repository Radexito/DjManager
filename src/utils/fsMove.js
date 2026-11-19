import fs from 'fs';

/**
 * Move a file, falling back to copy+delete when the destination is on a
 * different filesystem/drive. `fs.renameSync` is a same-filesystem metadata
 * op and throws EXDEV across drive letters (e.g. relocating a library to an
 * external drive, or converting its storage layout onto a different volume).
 */
export function moveFileSafe(oldPath, newPath) {
  try {
    fs.renameSync(oldPath, newPath);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(oldPath, newPath);
    fs.unlinkSync(oldPath);
  }
}
