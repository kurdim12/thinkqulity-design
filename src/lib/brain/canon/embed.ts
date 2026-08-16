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

/**
 * ===========================================================================
 * THE BOUND ON THIS PATH — hard rule 22, and what it does NOT reach
 * ===========================================================================
 * `openaiEmbed` is a request to a PAID THIRD-PARTY ENDPOINT, and it is reachable
 * from `run_compliance` — a tool a MODEL calls MID-SENTENCE — through
 * retrieveCanon() -> embed(). It had no timeout at all, which is the plainest
 * form of the thing rule 22 names: a hung api.openai.com held the chat turn open
 * for as long as the socket lasted, and nothing in the request could end it.
 *
 * A TIMEOUT IS THE PART THAT BELONGS HERE, and it is now enforced, on the same
 * terms as src/lib/ingest/media.ts and src/lib/web/fetch.ts: one signal, the
 * whole request including the body read, a constant ceiling a caller may lower
 * and cannot raise.
 *
 * ---------------------------------------------------------------------------
 * A LEDGER ROW AND A CAP UNIT DO NOT BELONG HERE, AND THIS IS WHY
 * ---------------------------------------------------------------------------
 * They were tried against the two ledgers that exist and neither one can hold
 * this call without being made to mean something false:
 *
 *   `web_retrievals` (0008) CANNOT RECORD IT. Its `trigger` column is
 *   `check (trigger in ('operator','schedule'))`, and an embedding issued
 *   because a model called a tool mid-sentence is neither. That CHECK is rule 22
 *   itself — 0008 says a third value "would need its own migration, which is the
 *   point at which somebody has to justify it". Writing 'operator' into that
 *   column for a model's own act would be a false row in the one ledger an
 *   auditor trusts, which is the same sin as a false number on a screen. And the
 *   day counter behind it is MAX_FETCHES_PER_DAY — the OPEN-WEB RESEARCH cap. An
 *   embedding taking a unit from it would let a morning of compliance checks
 *   refuse the operator's afternoon research, which is exactly the "two
 *   resources, one ceiling" conflation 0008 rejects for `mcp_cap_days`.
 *
 *   `mcp_reservations` (0005) ALREADY COVERS ONE CALLER AND CANNOT COVER THE
 *   OTHER FROM HERE. src/lib/mcp/tools.ts reserves a unit BEFORE retrieveCanon
 *   precisely because the embedding bills — the comment there says so — so the
 *   MCP path is bounded already. Reserving again inside embed() would
 *   double-charge that path. Reserving only for the chat path would require this
 *   module to know WHO called it, which it cannot see and must not guess.
 *
 * THE RESIDUAL, STATED PLAINLY AND NOT ARGUED AWAY: `run_compliance` in
 * src/lib/agent/chat/tools.ts is in CHAT_TOOL_NAMES, takes no reservation of its
 * own, and reaches this function. So a model that calls it repeatedly inside one
 * chat turn issues one billed embedding per call, bounded now by a 15-second
 * ceiling each and by nothing else. That is a real exposure and the fix is a
 * reservation at that tool's own call site — the same one `check_compliance`
 * already takes, in the file that knows it is a chat tool — not a counter buried
 * in the embedder, which would be a gate that has to know how its callers are
 * configured. It is named here so the next reader finds it written down rather
 * than discovering it.
 */
export const EMBED_TIMEOUT_MS = 15_000;

/** Test seam type. Production never passes one and the global `fetch` is used. */
export type EmbedFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface EmbedOptions {
  /**
   * Lowers EMBED_TIMEOUT_MS for one call. A higher value is CLAMPED DOWN, for
   * MAX_MIRROR_OBJECTS's reason: the constant is a ceiling, not a default, and a
   * bound a caller can talk upwards is a preference.
   */
  readonly timeoutMs?: number;
  /**
   * Test seam, exactly as `MirrorMediaOptions.fetchImpl` is. Production passes
   * nothing. It exists so the timeout can be EXECUTED against a hung endpoint
   * rather than asserted about.
   */
  readonly fetchImpl?: EmbedFetch;
}

/**
 * The ceiling, or a lower one the caller asked for. NEVER a higher one.
 *
 * Exported and pure so the clamp is EXECUTABLE: the interesting case is the one
 * a behavioural test cannot see — that a caller asking for a longer leash gets
 * the ceiling instead — and a rule nothing can reach is not a rule.
 */
export function embedTimeoutMs(requested: number | undefined): number {
  return typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? Math.min(requested, EMBED_TIMEOUT_MS)
    : EMBED_TIMEOUT_MS;
}

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

async function openaiEmbed(texts: string[], opts: EmbedOptions): Promise<number[][]> {
  const model = optionalEnv('EMBEDDING_MODEL') ?? OPENAI_DEFAULT_MODEL;
  const doFetch: EmbedFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  // ONE signal for the whole call, so the body reads below are inside the bound
  // too — a server that answers its status line and then stalls mid-body is the
  // hang a header-only timeout would miss.
  const signal = AbortSignal.timeout(embedTimeoutMs(opts.timeoutMs));

  const response = await doFetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    signal,
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

/**
 * Embeds each text. The local embedder touches no network and ignores `opts`;
 * the openai one is bounded by EMBED_TIMEOUT_MS. See the note beside that
 * constant for what this bound covers and what it deliberately does not.
 */
export async function embed(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (embeddingProvider() === 'openai') return openaiEmbed(texts, opts);
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
