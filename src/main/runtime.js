import path from 'node:path';

/**
 * Shared mutable runtime state, in one place (tor B, step 2).
 *
 * `src/main.js` kept this state in module-scope `let`/`const` bindings, which is
 * why the TIDAL, explorer and USB domains cannot be lifted out yet: a domain
 * module cannot be handed a variable, only a value. A single object can be
 * passed around, and one can be built without booting Electron.
 *
 * Deliberately small: only the state that several domains share. Anything with
 * one owner stays where it is until that owner becomes a module of its own.
 */

export function createRuntime(initial = {}) {
  return {
    mainWindow: null,

    mediaServerPort: null,

    activeRecursiveWalker: null,

    explorerAllowedBases: [],

    ...initial,
  };
}

/**
 * Allow one more directory. The same five lines were repeated in ten handlers,
 * which is exactly the kind of duplication that drifts: one copy ends up with a
 * different guard and nobody notices. Duplicates are ignored.
 *
 * The base is stored resolved. Storing `/music/../etc` verbatim made the entry
 * look like it pointed inside `/music` while every consumer that resolves paths
 * (the media server, the explorer allowlist) saw it as `/etc`. One directory
 * with two identities is how an allowlist stops meaning what it says.
 */
export function allowExplorerBase(runtime, dir) {
  if (typeof dir !== 'string' || dir === '') return false;
  const resolved = path.resolve(dir);
  if (runtime.explorerAllowedBases.includes(resolved)) return false;
  runtime.explorerAllowedBases.push(resolved);
  return true;
}

/**
 * Whether a path is already covered by an allowed base.
 *
 * A prefix check, but on a path boundary: browsing into a subdirectory of an
 * allowed folder must not append another base for every step down the tree, yet
 * `/music2` must not count as covered by `/music`. A plain `startsWith` gets
 * the second case wrong, and the consequence is a directory the user asked to
 * browse that never becomes allowed.
 *
 * Both sides are resolved first. Without that, `/music/../etc` starts with the
 * `/music/` prefix and counts as covered while pointing somewhere else
 * entirely, which is a directory-traversal hole rather than a cosmetic bug.
 */
export function isExplorerPathAllowed(runtime, dirPath) {
  if (typeof dirPath !== 'string' || dirPath === '') return false;
  const target = path.resolve(dirPath);
  return runtime.explorerAllowedBases.some((base) => {
    const resolvedBase = path.resolve(base);
    if (target === resolvedBase) return true;
    const prefix = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
    return target.startsWith(prefix);
  });
}
