import { optionalEnv, requireEnv } from '@/lib/env';

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

export function embeddingProvider(): EmbeddingProvider {
  return optionalEnv('EMBEDDING_PROVIDER')?.toLowerCase() === 'openai' ? 'openai' : 'local';
}

export function embeddingDimension(): number {
  return embeddingProvider() === 'openai' ? 1536 : LOCAL_DIM;
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
  const model = optionalEnv('EMBEDDING_MODEL') ?? 'text-embedding-3-small';
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
