import { afterEach, describe, expect, it } from 'vitest';

import {
  EMBEDDING_FRAME_LENGTH,
  EMBEDDING_WINDOW_SAMPLES,
  ModelInferenceError,
  TAG_WINDOW_SAMPLES,
  danceability,
  embedding,
  genre,
  openSession,
  resetRuntime,
  setRuntimeForTests,
  tagsForWindow,
  trackProfile,
} from '../audio/modelInference.js';

/**
 * A stand in for onnxruntime-node.
 *
 * `calls` records every run so the tests can assert what was actually fed to
 * the models, which is the part that is easy to get wrong silently.
 */
function fakeRuntime(overrides = {}) {
  const calls = [];

  class Tensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }

  const outputs = {
    'embed_model/cnn_embedding.onnx': () => ({
      features: { data: Float32Array.from({ length: 64 }, (_, i) => i), dims: [1, 64] },
      output: { data: Float32Array.from({ length: 50 }, () => 0.25), dims: [1, 50] },
    }),
    'embed_model/model_energy.onnx': () => ({
      danceability: { data: Float32Array.from([0.42]), dims: [1, 1] },
    }),
    'embed_model/norm_before_umap.onnx': (feed) => ({
      normalized_features: { data: feed.input_features.data, dims: [1, 64] },
    }),
    'embed_model/umap_embedder.onnx': () => ({
      dense_6: { data: Float32Array.from([1.5, -2.5]), dims: [1, 2] },
    }),
    'embed_model/norm_after_umap.onnx': (feed) => ({
      normalized_features: { data: feed.input_features.data, dims: [1, 2] },
    }),
    'embed_model/model_genre.onnx': () => ({
      output_label: { data: BigInt64Array.from([7n]), dims: [1] },
    }),
    'detect_cue_model/samplecnn.onnx': () => ({
      tags: { data: Float32Array.from({ length: 50 }, () => 0.5), dims: [1, 50] },
      features: { data: Float32Array.from({ length: 512 }, () => 0.1), dims: [1, 512] },
    }),
    ...overrides,
  };

  const runtime = {
    Tensor,
    InferenceSession: {
      create: async (path) => {
        const key = Object.keys(outputs).find((name) => path.endsWith(name));
        if (!key) throw new Error(`no fake session for ${path}`);
        return {
          run: async (feed, fetches) => {
            calls.push({ model: key, feed, fetches });
            const produced = outputs[key](feed);
            if (fetches) {
              return Object.fromEntries(
                Object.entries(produced).filter(([name]) => fetches.includes(name))
              );
            }
            return produced;
          },
        };
      },
    },
  };
  return { runtime, calls };
}

const pcmOf = (samples) => new Float32Array(samples).fill(0.1);

afterEach(() => {
  resetRuntime();
});

describe('embedding', () => {
  it('refuses a sample rate it was not measured at', async () => {
    setRuntimeForTests(fakeRuntime().runtime);
    await expect(embedding('m', pcmOf(44100), { sampleRate: 22050 })).rejects.toThrow(
      /measured at 44100 Hz/
    );
  });

  it('refuses a frame step that would make the model emit several rows', async () => {
    setRuntimeForTests(fakeRuntime().runtime);
    await expect(embedding('m', pcmOf(44100), { frameStep: 256 })).rejects.toThrow(
      new RegExp(`frameStep must be ${EMBEDDING_FRAME_LENGTH}`)
    );
  });

  it('feeds the frame parameters the model insists on', async () => {
    const { runtime, calls } = fakeRuntime();
    setRuntimeForTests(runtime);
    await embedding('m', pcmOf(44100));
    const call = calls.find((c) => c.model === 'embed_model/cnn_embedding.onnx');
    expect(call.feed.frame_length.data[0]).toBe(BigInt(EMBEDDING_FRAME_LENGTH));
    expect(call.feed.frame_step.data[0]).toBe(BigInt(EMBEDDING_FRAME_LENGTH));
    expect(Array.from(call.feed.pads.data)).toEqual([0n, 0n, 0n, 0n]);
    expect(call.feed.signal.dims).toEqual([1, 44100]);
  });

  it('cuts long audio into windows and averages them', async () => {
    const { runtime, calls } = fakeRuntime();
    setRuntimeForTests(runtime);
    const result = await embedding('m', pcmOf(EMBEDDING_WINDOW_SAMPLES * 2 + 1000));
    expect(result.frames).toBe(3);
    expect(calls.filter((c) => c.model === 'embed_model/cnn_embedding.onnx')).toHaveLength(3);
    expect(result.features).toHaveLength(64);
    expect(result.tags).toHaveLength(50);
    expect(result.perWindow).toHaveLength(3);
  });

  it('reports audio that is shorter than a single frame', async () => {
    setRuntimeForTests(fakeRuntime().runtime);
    await expect(embedding('m', pcmOf(100))).rejects.toThrow(ModelInferenceError);
  });

  it('rejects anything that is not mono float samples', async () => {
    setRuntimeForTests(fakeRuntime().runtime);
    await expect(embedding('m', [0.1, 0.2])).rejects.toThrow(/Float32Array/);
    await expect(embedding('m', new Float32Array(0))).rejects.toThrow(/empty/);
  });
});

describe('danceability', () => {
  it('returns the tensor the model calls danceability', async () => {
    const { runtime, calls } = fakeRuntime();
    setRuntimeForTests(runtime);
    const value = await danceability('m', new Float32Array(64).fill(0.3));
    expect(value).toBeCloseTo(0.42);
    expect(calls[0].feed.input_features.dims).toEqual([1, 64]);
  });

  it('refuses a feature vector of the wrong width', async () => {
    setRuntimeForTests(fakeRuntime().runtime);
    await expect(danceability('m', new Float32Array(63))).rejects.toThrow(/expected 64 features/);
  });
});

describe('genre', () => {
  it('builds 66 features and only fetches the label tensor', async () => {
    const { runtime, calls } = fakeRuntime();
    setRuntimeForTests(runtime);
    const result = await genre('m', new Float32Array(64).fill(0.5));
    expect(result.label).toBe(7);
    expect(result.probabilityAvailable).toBe(false);
    const genreCall = calls.find((c) => c.model === 'embed_model/model_genre.onnx');
    expect(genreCall.feed.input_features.dims).toEqual([1, 66]);
    expect(genreCall.fetches).toEqual(['output_label']);
  });

  it('puts the embedding first by default and the projection first on request', async () => {
    const seen = [];
    const base = fakeRuntime();
    const runtime = base.runtime;
    const originalCreate = runtime.InferenceSession.create;
    runtime.InferenceSession.create = async (path) => {
      const session = await originalCreate(path);
      if (!path.endsWith('model_genre.onnx')) return session;
      return {
        run: async (feed) => {
          seen.push(Array.from(feed.input_features.data));
          return { output_label: { data: BigInt64Array.from([1n]), dims: [1] } };
        },
      };
    };
    setRuntimeForTests(runtime);
    const features = new Float32Array(64);
    for (let i = 0; i < 64; i += 1) features[i] = i + 1;

    await genre('m', features, { featureOrder: 'embedding-first' });
    await genre('m', features, { featureOrder: 'projection-first' });

    expect(seen[0].slice(0, 3)).toEqual([1, 2, 3]);
    expect(seen[0].slice(64)).toEqual([1.5, -2.5]);
    expect(seen[1].slice(0, 2)).toEqual([1.5, -2.5]);
    expect(seen[1].slice(2, 5)).toEqual([1, 2, 3]);
  });
});

describe('tagsForWindow', () => {
  it('insists on exactly the window the model was trained for', async () => {
    setRuntimeForTests(fakeRuntime().runtime);
    await expect(tagsForWindow('m', pcmOf(TAG_WINDOW_SAMPLES - 1))).rejects.toThrow(
      new RegExp(`exactly ${TAG_WINDOW_SAMPLES}`)
    );
    const result = await tagsForWindow('m', pcmOf(TAG_WINDOW_SAMPLES));
    expect(result.tags).toHaveLength(50);
    expect(result.features).toHaveLength(512);
  });
});

describe('trackProfile', () => {
  it('returns the whole chain, with per window genre votes', async () => {
    setRuntimeForTests(fakeRuntime().runtime);
    const profile = await trackProfile('m', pcmOf(EMBEDDING_WINDOW_SAMPLES + 5000));
    expect(profile.danceability).toBeCloseTo(0.42);
    expect(profile.genre).toBe(7);
    expect(profile.genreVotes).toHaveLength(2);
    expect(profile.genreMajority).toBe(7);
    expect(profile.genreMajorityShare).toBe(1);
    expect(profile.frames).toBe(2);
    expect(profile.frameLength).toBe(EMBEDDING_FRAME_LENGTH);
    expect(profile.projection).toEqual([1.5, -2.5]);
  });
});

describe('openSession', () => {
  it('caches a session per model path', async () => {
    let created = 0;
    const { runtime } = fakeRuntime();
    const originalCreate = runtime.InferenceSession.create;
    runtime.InferenceSession.create = async (path) => {
      created += 1;
      return originalCreate(path);
    };
    setRuntimeForTests(runtime);
    await openSession('dir-a', 'embed_model/model_energy.onnx');
    await openSession('dir-a', 'embed_model/model_energy.onnx');
    await openSession('dir-b', 'embed_model/model_energy.onnx');
    expect(created).toBe(2);
  });

  it('reports a model file that cannot be opened', async () => {
    setRuntimeForTests(fakeRuntime().runtime);
    await expect(openSession('dir', 'embed_model/nope.onnx')).rejects.toThrow(/cannot load/);
  });
});
