/**
 * Run rekordbox's analysis models through onnxruntime.
 *
 * The models themselves are Pioneer's property and are extracted from a
 * licensed installation (see scripts/extract-models.py), so
 * this module never assumes they are present: every entry point takes the
 * models directory and reports a ModelInferenceError when something is missing.
 *
 * What is verified, and how:
 *
 *   - `frame_length` must be 512 for cnn_embedding. Other values fail inside the
 *     model's own mel filterbank with a MatMul dimension mismatch: the matrix is
 *     built for 257 frequency bins.
 *   - `frame_step` must equal `frame_length`. With any overlap the model emits
 *     more than one row and its own final dense layer fails with
 *     `GEMM: Dimension mismatch, W: {50,64} K: <64 * rows>`, because it wants a
 *     single 64 wide vector. With step 512 a signal of 0.5 s and one of 25 s both
 *     give exactly one row.
 *   - Long audio is therefore cut into EMBEDDING_WINDOW_SAMPLES windows: 25 s
 *     worked in the measurement, 30 s did not, so 20 s leaves room.
 *   - cnn_embedding returns `features` 64 wide, which is exactly what
 *     model_energy, norm_before_umap and umap_embedder take as input. That is
 *     what makes the chain below possible at all.
 *   - model_energy outputs a tensor literally named `danceability`.
 *
 * What is NOT verified, and is therefore explicit in the API:
 *
 *   - how rekordbox aggregates the per-frame features into one vector. We take
 *     the mean over frames. Another reduction (max, last frame, concatenation)
 *     would give different numbers.
 *   - the order of the 66 genre features. `featureOrder` defaults to the
 *     embedding followed by the 2D projection because that is 64 + 2; the model
 *     does not say which comes first.
 *
 * Audio must already be 44.1 kHz mono float32 in [-1, 1]; this module does not
 * resample, because a wrong resampler silently changes every number.
 */

export const EMBEDDING_FRAME_LENGTH = 512;
/** Hop between embedding windows in samples; one frame length, so the windows do not overlap. */
export const EMBEDDING_FRAME_STEP = 512;
/** 20 s at 44.1 kHz; see the note above about where the model starts to fail. */
export const EMBEDDING_WINDOW_SAMPLES = 20 * 44100;
export const TAG_WINDOW_SAMPLES = 59049;
/** Rate the embedding model was measured at; audio is not resampled here, so it must already be at this rate. */
export const EMBEDDING_SAMPLE_RATE = 44100;

/** Error from the inference layer, carrying a code the caller can branch on. */
export class ModelInferenceError extends Error {
  /**
   * @param {string} code - stable identifier, e.g. 'RUNTIME_MISSING'
   * @param {string} message
   * @param {Error} [cause] - the underlying error, when there is one
   */
  constructor(code, message, cause) {
    super(message);
    this.name = 'ModelInferenceError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/** The loaded onnxruntime-node module, once loaded. */
let runtime = null;
/** The in-flight import of the runtime, shared so the module is only loaded once. */
let runtimeLoader = null;

/** Replace the ONNX runtime implementation. Accepts anything shaped like onnxruntime-node. */
export function setRuntimeForTests(fakeRuntime) {
  runtime = fakeRuntime;
  runtimeLoader = null;
}

/** Drop the cached runtime and every cached session. */
export function resetRuntime() {
  runtime = null;
  runtimeLoader = null;
  sessions.clear();
}

/**
 * Load onnxruntime-node the first time it is needed and keep it. A missing
 * package becomes a RUNTIME_MISSING error instead of a module resolution failure.
 * @returns {Promise<object>} the runtime module
 */
function loadRuntime() {
  if (runtime) return Promise.resolve(runtime);
  if (!runtimeLoader) {
    runtimeLoader = import('onnxruntime-node')
      .then((module) => {
        runtime = module;
        return module;
      })
      .catch((error) => {
        runtimeLoader = null;
        throw new ModelInferenceError(
          'RUNTIME_MISSING',
          'onnxruntime-node is not installed; run npm install (it is a dependency of DjManager)',
          error
        );
      });
  }
  return runtimeLoader;
}

const sessions = new Map();

/** Load and cache an ONNX session for one model file. */
export async function openSession(modelsDir, relativePath) {
  const key = `${modelsDir}::${relativePath}`;
  if (sessions.has(key)) return sessions.get(key);
  const ort = await loadRuntime();
  const path = `${modelsDir}/${relativePath}`;
  try {
    const session = await ort.InferenceSession.create(path, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
    sessions.set(key, session);
    return session;
  } catch (error) {
    throw new ModelInferenceError(
      'MODEL_UNREADABLE',
      `cannot load ${relativePath} from ${modelsDir}: ${error.message}`,
      error
    );
  }
}

/**
 * Wrap float32 samples in an ONNX tensor of the given shape.
 * @param {object} ort - the runtime module
 * @param {Float32Array|number[]} data
 * @param {number[]} dims
 * @returns {object} tensor
 */
function floatTensor(ort, data, dims) {
  return new ort.Tensor(
    'float32',
    data instanceof Float32Array ? data : Float32Array.from(data),
    dims
  );
}

/**
 * Wrap numbers as a 1-D int64 tensor, the form the models take ids in.
 * @param {object} ort - the runtime module
 * @param {number[]} values
 * @returns {object} tensor
 */
function int64Tensor(ort, values) {
  return new ort.Tensor('int64', BigInt64Array.from(values.map((v) => BigInt(v))), [values.length]);
}

/** Mean of every row of a [rows, width] tensor output. */
export function meanOverFrames(data, rows, width) {
  const out = new Float32Array(width);
  if (rows === 0) return out;
  for (let r = 0; r < rows; r += 1) {
    const offset = r * width;
    for (let c = 0; c < width; c += 1) out[c] += data[offset + c];
  }
  for (let c = 0; c < width; c += 1) out[c] /= rows;
  return out;
}

/**
 * Refuse audio this module cannot handle: anything but a non-empty Float32Array
 * of mono samples already at EMBEDDING_SAMPLE_RATE.
 * @param {Float32Array} pcm
 * @param {number} sampleRate
 * @throws {ModelInferenceError} BAD_PCM or BAD_SAMPLE_RATE
 */
function assertMonoPcm(pcm, sampleRate) {
  if (!(pcm instanceof Float32Array)) {
    throw new ModelInferenceError('BAD_PCM', 'pcm must be a Float32Array of mono samples');
  }
  if (pcm.length === 0) {
    throw new ModelInferenceError('BAD_PCM', 'pcm is empty');
  }
  if (sampleRate !== EMBEDDING_SAMPLE_RATE) {
    throw new ModelInferenceError(
      'BAD_SAMPLE_RATE',
      `the embedding model was measured at ${EMBEDDING_SAMPLE_RATE} Hz, got ${sampleRate}; resample first`
    );
  }
}

/**
 * One 64 wide embedding (plus the 50 tag outputs) for a whole track.
 *
 * `frameStep` is exposed because rekordbox's own value is not known yet; the
 * default of 256 is half the frame length, the usual choice.
 */
export async function embedding(modelsDir, pcm, options = {}) {
  const {
    sampleRate = EMBEDDING_SAMPLE_RATE,
    frameStep = EMBEDDING_FRAME_STEP,
    windowSamples = EMBEDDING_WINDOW_SAMPLES,
  } = options;
  assertMonoPcm(pcm, sampleRate);
  if (frameStep !== EMBEDDING_FRAME_LENGTH) {
    throw new ModelInferenceError(
      'BAD_FRAME_STEP',
      `frameStep must be ${EMBEDDING_FRAME_LENGTH}: with any other value the model emits ` +
        'several rows and its final dense layer fails'
    );
  }
  if (!Number.isInteger(windowSamples) || windowSamples < EMBEDDING_FRAME_LENGTH) {
    throw new ModelInferenceError(
      'BAD_WINDOW',
      `windowSamples must be at least ${EMBEDDING_FRAME_LENGTH}`
    );
  }
  const ort = await loadRuntime();
  const session = await openSession(modelsDir, 'embed_model/cnn_embedding.onnx');

  const features = new Float32Array(64);
  const tags = new Float32Array(50);
  const perWindow = [];
  let totalSamples = 0;

  for (let start = 0; start < pcm.length; start += windowSamples) {
    const window = pcm.subarray(start, Math.min(start + windowSamples, pcm.length));
    if (window.length < EMBEDDING_FRAME_LENGTH) break;
    const output = await session.run({
      signal: floatTensor(ort, window, [1, window.length]),
      frame_step: int64Tensor(ort, [frameStep]),
      frame_length: int64Tensor(ort, [EMBEDDING_FRAME_LENGTH]),
      pads: int64Tensor(ort, [0, 0, 0, 0]),
    });
    const rows = output.features.dims[0];
    const width = output.features.dims[1];
    if (rows !== 1 || width !== 64) {
      throw new ModelInferenceError(
        'UNEXPECTED_SHAPE',
        `cnn_embedding returned features${JSON.stringify(output.features.dims)}, expected [1, 64]`
      );
    }
    const weight = window.length;
    for (let c = 0; c < 64; c += 1) features[c] += output.features.data[c] * weight;
    for (let c = 0; c < 50; c += 1) tags[c] += output.output.data[c] * weight;
    perWindow.push({
      features: Float32Array.from(output.features.data),
      tags: Float32Array.from(output.output.data),
      samples: weight,
    });
    totalSamples += weight;
  }

  if (perWindow.length === 0) {
    throw new ModelInferenceError(
      'BAD_PCM',
      `pcm is shorter than one window (${EMBEDDING_FRAME_LENGTH} samples)`
    );
  }
  for (let c = 0; c < 64; c += 1) features[c] /= totalSamples;
  for (let c = 0; c < 50; c += 1) tags[c] /= totalSamples;

  return {
    features,
    width: 64,
    frames: perWindow.length,
    tags,
    perWindow,
    frameStep,
    frameLength: EMBEDDING_FRAME_LENGTH,
    windowSamples,
    samplesUsed: totalSamples,
  };
}

/** Danceability in [0, 1] from a 64 wide embedding. */
export async function danceability(modelsDir, features) {
  if (!features || features.length !== 64) {
    throw new ModelInferenceError('BAD_FEATURES', `expected 64 features, got ${features?.length}`);
  }
  const ort = await loadRuntime();
  const session = await openSession(modelsDir, 'embed_model/model_energy.onnx');
  const output = await session.run({ input_features: floatTensor(ort, features, [1, 64]) });
  const tensor = output.danceability;
  return tensor.data[0];
}

/**
 * Genre label and probability from a 64 wide embedding.
 *
 * The genre model takes 66 features: the 64 wide embedding plus the 2D UMAP
 * projection. Which half comes first is not stated by the model, so
 * `featureOrder` exists and defaults to 'embedding-first'.
 */
export async function genre(modelsDir, features, options = {}) {
  if (!features || features.length !== 64) {
    throw new ModelInferenceError('BAD_FEATURES', `expected 64 features, got ${features?.length}`);
  }
  const { featureOrder = 'embedding-first' } = options;
  const ort = await loadRuntime();
  const normalized = await runNormalizer(
    ort,
    modelsDir,
    'embed_model/norm_before_umap.onnx',
    features
  );
  const session = await openSession(modelsDir, 'embed_model/umap_embedder.onnx');
  const umapOut = await session.run({ input_1: floatTensor(ort, normalized, [1, 64]) });
  const projected = await runNormalizer(
    ort,
    modelsDir,
    'embed_model/norm_after_umap.onnx',
    umapOut.dense_6.data
  );
  const merged = new Float32Array(66);
  if (featureOrder === 'projection-first') {
    merged.set(projected, 0);
    merged.set(normalized, 2);
  } else {
    merged.set(normalized, 0);
    merged.set(projected, 64);
  }
  const genreSession = await openSession(modelsDir, 'embed_model/model_genre.onnx');
  const output = await genreSession.run({ input_features: floatTensor(ort, merged, [1, 66]) }, [
    'output_label',
  ]);
  return {
    label: Number(output.output_label.data[0]),
    probabilityAvailable: false,
    projection: Array.from(projected),
    featureOrder,
  };
}

/**
 * Run one of the normaliser models over a feature vector: the UMAP one takes the
 * 2-D projection, the others the 64 embedding values.
 * @param {object} ort - the runtime module
 * @param {string} modelsDir
 * @param {string} relativePath - model file, e.g. 'embed_model/norm_after_umap.onnx'
 * @param {Float32Array|number[]} features
 * @returns {Promise<Float32Array>} normalized features
 */
async function runNormalizer(ort, modelsDir, relativePath, features) {
  const session = await openSession(modelsDir, relativePath);
  const width = relativePath.includes('after_umap') ? 2 : 64;
  const output = await session.run({
    input_features: floatTensor(ort, features, [1, width]),
  });
  return output.normalized_features.data;
}

/** The 50 tag outputs of samplecnn for one 59049 sample window. */
export async function tagsForWindow(modelsDir, pcm) {
  if (!(pcm instanceof Float32Array) || pcm.length !== TAG_WINDOW_SAMPLES) {
    throw new ModelInferenceError(
      'BAD_WINDOW',
      `samplecnn takes exactly ${TAG_WINDOW_SAMPLES} samples, got ${pcm?.length}`
    );
  }
  const ort = await loadRuntime();
  const session = await openSession(modelsDir, 'detect_cue_model/samplecnn.onnx');
  const output = await session.run({ waveform: floatTensor(ort, pcm, [1, TAG_WINDOW_SAMPLES]) });
  return { tags: Array.from(output.tags.data), features: Array.from(output.features.data) };
}

/** Everything above, in the order the models chain. */
export async function trackProfile(modelsDir, pcm, options = {}) {
  const embed = await embedding(modelsDir, pcm, options);
  const [dance, genreResult] = await Promise.all([
    danceability(modelsDir, embed.features),
    genre(modelsDir, embed.features, options),
  ]);
  const votes = [];
  for (const windowFeatures of embed.perWindow) {
    votes.push((await genre(modelsDir, windowFeatures.features, options)).label);
  }
  const counts = new Map();
  for (const label of votes) counts.set(label, (counts.get(label) ?? 0) + 1);
  const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return {
    danceability: dance,
    genre: genreResult.label,
    genreVotes: votes,
    genreMajority: majority[0],
    genreMajorityShare: votes.length ? majority[1] / votes.length : 0,
    genreOrder: genreResult.featureOrder,
    projection: genreResult.projection,
    frames: embed.frames,
    frameStep: embed.frameStep,
    frameLength: embed.frameLength,
    features: Array.from(embed.features),
    tags: Array.from(embed.tags),
  };
}
