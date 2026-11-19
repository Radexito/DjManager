/**
 * Locate and verify the rekordbox analysis models.
 *
 * The ONNX and TensorFlow files in a rekordbox installation are Pioneer's
 * property, so they are never committed to this repository. `extract-models.py`
 * copies them out of a licensed installation, verifies them against the known
 * hashes and writes `models.manifest.json` next to them. This module is the
 * reading side: it resolves where that directory is, checks that a file is
 * still the one that was copied, and reports which capabilities are available.
 *
 * Nothing here runs inference. Feeding these models needs an ONNX runtime (and,
 * for the beat models, TensorFlow or a conversion), plus the input
 * preprocessing, which is defined by rekordbox's own code.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';

/** Name of the manifest extract-models.py writes next to the model files. */
export const MANIFEST_NAME = 'models.manifest.json';

/** Families shipped with rekordbox, and what each one is for. */
export const MODEL_FAMILIES = {
  detect_beat: {
    kind: 'tensorflow-savedmodel',
    runtime: 'tensorflow',
    purpose: 'beat grid detection, model7 and model8',
  },
  detect_cue_model: {
    kind: 'onnx',
    runtime: 'onnxruntime',
    purpose: 'cue point prediction',
  },
  embed_model: {
    kind: 'onnx',
    runtime: 'onnxruntime',
    purpose: 'track embeddings: cnn, energy, genre, umap normalisation',
  },
};

/** Appended to every "models are missing" error: the command that extracts them. */
const EXTRACT_HINT = 'run: python3 scripts/extract-models.py --source "<rekordbox install>"';

/** Error from the model store, carrying a code that says what is wrong with the models directory. */
export class ModelStoreError extends Error {
  /**
   * @param {string} code - e.g. 'MODELS_MISSING', 'MANIFEST_INVALID', 'MODEL_NOT_FOUND'
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ModelStoreError';
    this.code = code;
  }
}

/**
 * Where the models live when nothing overrides it.
 *
 * Matches the default of extract-models.py so that both ends agree without
 * configuration.
 */
export function defaultModelsDir(env = process.env, platform = osPlatform(), home = homedir()) {
  if (env.DJMANAGER_MODELS_DIR) return env.DJMANAGER_MODELS_DIR;
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return join(base, 'DjManager', 'models');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'DjManager', 'models');
  }
  return join(home, '.local', 'share', 'djmanager', 'models');
}

/** Explicit argument wins, then the environment, then the platform default. */
export function resolveModelsDir(override) {
  if (override) return override;
  return defaultModelsDir();
}

/**
 * Read and check the model manifest: it must exist, be valid JSON and list a
 * `files` array.
 * @param {string} dir - models directory
 * @returns {object} the parsed manifest
 * @throws {ModelStoreError} MODELS_MISSING or MANIFEST_INVALID
 */
function readManifestFile(dir) {
  const path = join(dir, MANIFEST_NAME);
  if (!existsSync(path)) {
    throw new ModelStoreError('MODELS_MISSING', `no ${MANIFEST_NAME} in ${dir}; ${EXTRACT_HINT}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ModelStoreError(
      'MANIFEST_INVALID',
      `${path} is not valid JSON: ${error.message}; ${EXTRACT_HINT}`
    );
  }
  if (!Array.isArray(manifest.files)) {
    throw new ModelStoreError('MANIFEST_INVALID', `${path} has no files array; ${EXTRACT_HINT}`);
  }
  return manifest;
}

/** The manifest written by extract-models.py. */
export function readManifest(dir = resolveModelsDir()) {
  return readManifestFile(dir);
}

/** Every file in the manifest, with its absolute path and whether it exists. */
export function listModels(dir = resolveModelsDir()) {
  const manifest = readManifestFile(dir);
  return manifest.files.map((entry) => ({
    ...entry,
    absolutePath: join(dir, entry.path),
    present: existsSync(join(dir, entry.path)),
  }));
}

/**
 * SHA-256 of a file's contents, uppercase hex, the form the manifest records.
 * @param {string} path
 * @returns {Promise<string>}
 */
function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()));
  });
}

/** Absolute path of one model, checked for existence. */
export function modelPath(dir, relativePath) {
  const root = resolveModelsDir(dir);
  const absolute = join(root, relativePath);
  if (!existsSync(absolute)) {
    throw new ModelStoreError(
      'MODEL_NOT_FOUND',
      `${relativePath} is not in ${root}; ${EXTRACT_HINT}`
    );
  }
  return absolute;
}

/**
 * Compare one file with the hash recorded when it was extracted.
 *
 * Returns the comparison instead of throwing, because a mismatch is data the
 * caller may want to report rather than an exception.
 */
export async function verifyModel(dir, relativePath) {
  const absolute = modelPath(dir, relativePath);
  const manifest = readManifestFile(dir);
  const entry = manifest.files.find((file) => file.path === relativePath);
  if (!entry) {
    throw new ModelStoreError(
      'MODEL_NOT_IN_MANIFEST',
      `${relativePath} exists but is not in ${MANIFEST_NAME}; ${EXTRACT_HINT}`
    );
  }
  const actual = await sha256File(absolute);
  return {
    path: relativePath,
    expected: entry.sha256,
    actual,
    ok: actual === entry.sha256,
    size: statSync(absolute).size,
    sizeMatches: statSync(absolute).size === entry.size,
  };
}

/** Verify every file in the manifest. */
export async function verifyAll(dir = resolveModelsDir()) {
  const manifest = readManifestFile(dir);
  const results = [];
  for (const entry of manifest.files) {
    const absolute = join(dir, entry.path);
    if (!existsSync(absolute)) {
      results.push({
        path: entry.path,
        expected: entry.sha256,
        actual: null,
        ok: false,
        size: 0,
        sizeMatches: false,
      });
      continue;
    }
    const actual = await sha256File(absolute);
    const size = statSync(absolute).size;
    results.push({
      path: entry.path,
      expected: entry.sha256,
      actual,
      ok: actual === entry.sha256,
      size,
      sizeMatches: size === entry.size,
    });
  }
  return {
    ok: results.every((result) => result.ok && result.sizeMatches),
    results,
  };
}

/**
 * Which analysis features the models on disk can support.
 *
 * These are presence checks against the manifest, not a claim that DjManager
 * already runs them.
 */
export function capabilities(dir = resolveModelsDir()) {
  const files = listModels(dir);
  const has = (predicate) => files.some((file) => file.present && predicate(file.path));
  return {
    beatGrid: has((path) => /^detect_beat\/[^/]+\/saved_model\.pb$/.test(path)),
    cuePrediction: has((path) => /^detect_cue_model\/.+\.onnx$/.test(path)),
    embeddings: has((path) => path === 'embed_model/cnn_embedding.onnx'),
    energy: has((path) => path === 'embed_model/model_energy.onnx'),
    genre: has((path) => path === 'embed_model/model_genre.onnx'),
    totalBytes: files.filter((file) => file.present).reduce((sum, file) => sum + file.size, 0),
  };
}
