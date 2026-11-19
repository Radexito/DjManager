import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MANIFEST_NAME,
  MODEL_FAMILIES,
  ModelStoreError,
  capabilities,
  defaultModelsDir,
  listModels,
  modelPath,
  readManifest,
  resolveModelsDir,
  verifyAll,
  verifyModel,
} from '../audio/modelStore.js';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex').toUpperCase();

/** A models directory shaped like the one extract-models.py writes. */
function writeFakeModels(root) {
  const files = [
    { path: 'detect_beat/model7/saved_model.pb', body: Buffer.from('not really a graph') },
    { path: 'embed_model/cnn_embedding.onnx', body: Buffer.from('\x08\x07onnx-ish') },
    { path: 'embed_model/model_energy.onnx', body: Buffer.from('\x08\x07energy') },
    { path: 'detect_cue_model/samplecnn.onnx', body: Buffer.from('\x08\x0cwaveform') },
  ];
  const entries = [];
  for (const file of files) {
    const absolute = join(root, file.path);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, file.body);
    entries.push({
      path: file.path,
      size: file.body.length,
      sha256: sha256(file.body),
      kind: MODEL_FAMILIES[file.path.split('/')[0]].kind,
      runtime: MODEL_FAMILIES[file.path.split('/')[0]].runtime,
    });
  }
  writeFileSync(
    join(root, MANIFEST_NAME),
    JSON.stringify({ format: 1, source: { root: '/somewhere' }, files: entries }, null, 2)
  );
  return entries;
}

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'djman-models-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('defaultModelsDir', () => {
  it('honours DJMANAGER_MODELS_DIR before anything platform specific', () => {
    const dir = defaultModelsDir({ DJMANAGER_MODELS_DIR: '/opt/models' }, 'linux', '/home/x');
    expect(dir).toBe('/opt/models');
  });

  it('uses the per platform data directory when the environment is empty', () => {
    expect(defaultModelsDir({}, 'win32', 'C:\\Users\\x')).toMatch(/DjManager[\\/]models$/);
    expect(defaultModelsDir({}, 'darwin', '/Users/x')).toBe(
      '/Users/x/Library/Application Support/DjManager/models'
    );
    expect(defaultModelsDir({}, 'linux', '/home/x')).toBe('/home/x/.local/share/djmanager/models');
  });

  it('on Windows it prefers LOCALAPPDATA when it is set', () => {
    const dir = defaultModelsDir({ LOCALAPPDATA: 'D:\\Local' }, 'win32', 'C:\\Users\\x');
    expect(dir).toMatch(/^D:\\Local/);
  });
});

describe('resolveModelsDir', () => {
  it('lets an explicit argument win over the environment', () => {
    process.env.DJMANAGER_MODELS_DIR = '/from/env';
    try {
      expect(resolveModelsDir('/from/arg')).toBe('/from/arg');
      expect(resolveModelsDir()).toBe('/from/env');
    } finally {
      delete process.env.DJMANAGER_MODELS_DIR;
    }
  });
});

describe('manifest reading', () => {
  it('explains how to get the models when the manifest is missing', () => {
    expect(() => readManifest(root)).toThrow(ModelStoreError);
    try {
      readManifest(root);
    } catch (error) {
      expect(error.code).toBe('MODELS_MISSING');
      expect(error.message).toContain('extract-models.py');
    }
  });

  it('reports a manifest that is not JSON instead of throwing a parser error', () => {
    writeFileSync(join(root, MANIFEST_NAME), '{');
    expect(() => readManifest(root)).toThrow(/not valid JSON/);
  });

  it('lists every file with an absolute path and a presence flag', () => {
    writeFakeModels(root);
    const files = listModels(root);
    expect(files).toHaveLength(4);
    expect(files[0].absolutePath.startsWith(root)).toBe(true);
    expect(files.every((file) => file.present)).toBe(true);
  });
});

describe('verification', () => {
  it('accepts a file whose hash still matches the manifest', async () => {
    const entries = writeFakeModels(root);
    const result = await verifyModel(root, entries[0].path);
    expect(result.ok).toBe(true);
    expect(result.sizeMatches).toBe(true);
    expect(result.actual).toBe(entries[0].sha256);
  });

  it('catches a file that changed after extraction', async () => {
    const entries = writeFakeModels(root);
    writeFileSync(join(root, entries[1].path), 'tampered');
    const result = await verifyModel(root, entries[1].path);
    expect(result.ok).toBe(false);
    expect(result.expected).toBe(entries[1].sha256);
    expect(result.actual).not.toBe(entries[1].sha256);
  });

  it('says so when a file is present but not in the manifest', async () => {
    writeFakeModels(root);
    writeFileSync(join(root, 'embed_model/extra.onnx'), 'x');
    await expect(verifyModel(root, 'embed_model/extra.onnx')).rejects.toThrow(
      /not in models.manifest.json/
    );
  });

  it('fails the whole set when one file is missing', async () => {
    const entries = writeFakeModels(root);
    rmSync(join(root, entries[2].path));
    const report = await verifyAll(root);
    expect(report.ok).toBe(false);
    expect(report.results.find((r) => r.path === entries[2].path).ok).toBe(false);
  });
});

describe('modelPath', () => {
  it('returns an absolute path for a model that exists', () => {
    const entries = writeFakeModels(root);
    expect(modelPath(root, entries[0].path)).toBe(join(root, entries[0].path));
  });

  it('throws with the extraction hint when the model is absent', () => {
    writeFakeModels(root);
    expect(() => modelPath(root, 'detect_beat/model9/saved_model.pb')).toThrow(/extract-models.py/);
  });
});

describe('capabilities', () => {
  it('reports what the files on disk can support', () => {
    writeFakeModels(root);
    const caps = capabilities(root);
    expect(caps).toMatchObject({
      beatGrid: true,
      cuePrediction: true,
      embeddings: true,
      energy: true,
      genre: false,
    });
    expect(caps.totalBytes).toBeGreaterThan(0);
  });

  it('turns everything off when the files are gone', () => {
    const entries = writeFakeModels(root);
    for (const entry of entries) rmSync(join(root, entry.path));
    const caps = capabilities(root);
    expect(caps.beatGrid).toBe(false);
    expect(caps.embeddings).toBe(false);
    expect(caps.totalBytes).toBe(0);
  });
});
