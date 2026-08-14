import { hasEnv, optionalEnv, requireEnv } from '@/lib/env';

/**
 * Pluggable embeddings.
 *
 * The default is `local`: a deterministic hashed bag-of-words vector that needs
 * no API key and no network. Its recall is materially worse than a real
 * embedding model — it matches on shared vocabulary, not meaning — but it makes
 * Canon retrieval work and testable today, and switching is one env var plus a
 * re-ingest. The chunk column is an untyped `vector`, so changing provider
 * (and dimension) only requires running ingest again.
 *
 *   EMBEDDING_PROVIDER = local | openai
 *   EMBEDDING_MODEL    = text-embedding-3-small   (openai only)
 */
export type EmbeddingProvider = 'local' | 'openai';

export const LOCAL_DIM = 384;

/** The dimension text-embedding-3-small returns. Declared, never measured here. */
const OPENAI_DEFAULT_DIM = 1536;

const OPENAI_DEFAULT_MODEL = 'text-embedding-3-small';

export interface EmbeddingMode {
  /** What will actually run. */
  provider: EmbeddingProvider;
  /** What EMBEDDING_PROVIDER asked for, which is not always what runs. */
  requested: EmbeddingProvider;
  dimension: number;
  /** Why `provider` is what it is, in one line, for logs and /api/canon. */
  reason: string;
}

/**
 * Resolves the embedder once, so every caller reports the mode that actually
 * runs rather than the one that was asked for.
 *
 * `openai` needs a key. Without one, the request degrades to the keyless local
 * embedder and says so — an app that claims 1536-dimension OpenAI vectors while
 * every embed call throws is worse than one that admits it is running local,
 * because the operator reads the claim and stops looking.
 */
export function embeddingMode(): EmbeddingMode {
  const requested: EmbeddingProvider =
    optionalEnv('EMBEDDING_PROVIDER')?.toLowerCase() === 'openai' ? 'openai' : 'local';

  if (requested === 'openai' && !hasEnv('OPENAI_API_KEY')) {
    return {
      provider: 'local',
      requested,
      dimension: LOCAL_DIM,
      reason: 'EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is not set — fell back to local.',
    };
  }

  if (requested === 'openai') {
    const model = optionalEnv('EMBEDDING_MODEL') ?? OPENAI_DEFAULT_MODEL;
    return {
      provider: 'openai',
      requested,
      dimension: OPENAI_DEFAULT_DIM,
      reason: `EMBEDDING_PROVIDER=openai, key present, model ${model}.`,
    };
  }

  return {
    provider: 'local',
    requested,
    dimension: LOCAL_DIM,
    reason: 'EMBEDDING_PROVIDER unset or local — keyless local embedder.',
  };
}

export function embeddingProvider(): EmbeddingProvider {
  return embeddingMode().provider;
}

export function embeddingDimension(): number {
  return embeddingMode().dimension;
}

/** FNV-1a — small, fast, and stable across runs, which matters for a store. */
function hash(token: string, seed: number): number {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Arabic-aware tokenisation: keep Arabic and Latin words, drop the rest. */
export function tokenise(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter(Boolean);
}

function localEmbed(text: string): number[] {
  const vector = new Array<number>(LOCAL_DIM).fill(0);
  const tokens = tokenise(text);

  for (const token of tokens) {
    // Two hashes per token spreads collisions rather than concentrating them.
    vector[hash(token, 0) % LOCAL_DIM] += 1;
    vector[hash(token, 101) % LOCAL_DIM] += 0.5;
  }

  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? vector : vector.map((v) => v / norm);
}

async function openaiEmbed(texts: string[]): Promise<number[][]> {
  const model = optionalEnv('EMBEDDING_MODEL') ?? OPENAI_DEFAULT_MODEL;
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${requireEnv('OPENAI_API_KEY')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, input: texts }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Embedding request failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  const payload = (await response.json()) as { data: { embedding: number[] }[] };
  return payload.data.map((d) => d.embedding);
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (embeddingProvider() === 'openai') return openaiEmbed(texts);
  return texts.map(localEmbed);
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
