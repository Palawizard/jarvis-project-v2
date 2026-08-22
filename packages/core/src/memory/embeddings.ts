import { createLogger } from '../logger.js';
import { getConfig, type JarvisConfig } from '../config.js';

const log = createLogger('embeddings');

export interface EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  available(): Promise<boolean>;
  /** Embed documents for storage. Returns L2-normalised vectors. */
  embedPassages(texts: string[]): Promise<Float32Array[]>;
  /** Embed a search query. Some models require an asymmetric prefix. */
  embedQuery(text: string): Promise<Float32Array>;
  status(): EmbeddingStatus;
}

export interface EmbeddingStatus {
  enabled: boolean;
  ready: boolean;
  model: string;
  dim: number;
  error?: string;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  // Vectors are stored L2-normalised, so the dot product is the cosine.
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += (a[i] as number) * (b[i] as number);
  return dot;
}

function normalise(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += (vec[i] as number) ** 2;
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = (vec[i] as number) / norm;
  return out;
}

export function vectorToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToVector(blob: Uint8Array): Float32Array {
  // Copy: the SQLite-owned buffer may not be 4-byte aligned or may be reused.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

/**
 * Local embeddings via Transformers.js (ONNX runtime, CPU).
 *
 * Design constraints from the brief:
 *  - no paid API, no network after first download
 *  - lazy: the model is never loaded until the first embed call
 *  - a failure here must degrade retrieval to lexical-only, never crash it
 */
class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dim = 384; // multilingual-e5-small
  private pipe: unknown;
  private loading: Promise<unknown> | null = null;
  private failed: string | undefined;
  private readonly enabled: boolean;

  constructor(private readonly config: JarvisConfig) {
    this.id = config.memory.embeddingModel;
    this.enabled = config.memory.embeddingsEnabled;
  }

  status(): EmbeddingStatus {
    return {
      enabled: this.enabled,
      ready: Boolean(this.pipe),
      model: this.id,
      dim: this.dim,
      ...(this.failed ? { error: this.failed } : {}),
    };
  }

  async available(): Promise<boolean> {
    if (!this.enabled || this.failed) return false;
    try {
      await this.load();
      return true;
    } catch {
      return false;
    }
  }

  private async load(): Promise<unknown> {
    if (this.pipe) return this.pipe;
    if (this.failed) throw new Error(this.failed);
    this.loading ??= (async () => {
      const t0 = Date.now();
      const mod = await import('@huggingface/transformers');
      // Keep the model cache inside JARVIS_HOME, outside the repo and outside Git.
      mod.env.cacheDir = this.config.modelCacheDir;
      mod.env.allowLocalModels = true;
      const pipe = await mod.pipeline('feature-extraction', this.id, { dtype: 'q8' });
      log.info('embedding model ready', { model: this.id, ms: Date.now() - t0 });
      return pipe;
    })().catch((error: unknown) => {
      this.failed = error instanceof Error ? error.message : String(error);
      this.loading = null;
      log.warn('embedding model unavailable, retrieval falls back to lexical', {
        model: this.id,
        error: this.failed,
      });
      throw error;
    });
    this.pipe = await this.loading;
    return this.pipe;
  }

  private async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.enabled) throw new Error('embeddings disabled by config');
    const pipe = (await this.load()) as (
      input: string[],
      opts: { pooling: 'mean'; normalize: boolean },
    ) => Promise<{ tolist(): number[][] }>;
    const output = await pipe(texts, { pooling: 'mean', normalize: true });
    return output.tolist().map((row) => normalise(Float32Array.from(row)));
  }

  // e5 models are trained asymmetrically: documents get "passage: ", queries "query: ".
  embedPassages(texts: string[]): Promise<Float32Array[]> {
    return this.embed(texts.map((t) => `passage: ${t}`));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [vec] = await this.embed([`query: ${text}`]);
    if (!vec) throw new Error('embedding produced no vector');
    return vec;
  }
}

let singleton: EmbeddingProvider | undefined;

export function getEmbeddingProvider(config: JarvisConfig = getConfig()): EmbeddingProvider {
  singleton ??= new LocalEmbeddingProvider(config);
  return singleton;
}

/** Test seam: swap in a deterministic provider. */
export function setEmbeddingProvider(provider: EmbeddingProvider | undefined): void {
  singleton = provider;
}
