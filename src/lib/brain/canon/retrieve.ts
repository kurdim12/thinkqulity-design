import { supabaseAdmin } from '@/lib/supabase/admin';
import { cosine, embed, tokenise } from './embed';

/** The tag taxonomy. Chunks carry one or more of these. */
export const CANON_TAGS = [
  'structure',
  'voice',
  'color',
  'typography',
  'layout',
  'logo-usage',
  'social',
  'arabic-specific',
] as const;

export type CanonTag = (typeof CANON_TAGS)[number];

export interface CanonHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  sourceUrl: string | null;
  kind: string;
  licenseNote: string | null;
  tags: string[];
  /** Verbatim. Canon text is quoted, never paraphrased into client output. */
  content: string;
  score: number;
  method: 'vector' | 'lexical';
}

interface ChunkRow {
  id: string;
  document_id: string;
  content: string;
  tags: string[];
  embedding: number[] | string | null;
  canon_documents: {
    title: string;
    source_url: string | null;
    kind: string;
    license_note: string | null;
  } | null;
}

function parseEmbedding(value: number[] | string | null): number[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as number[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Word overlap, used when a chunk has no embedding or dimensions disagree. */
function lexicalScore(query: string, content: string): number {
  const q = new Set(tokenise(query));
  if (q.size === 0) return 0;
  const c = tokenise(content);
  if (c.length === 0) return 0;
  let hits = 0;
  for (const token of new Set(c)) if (q.has(token)) hits += 1;
  return hits / q.size;
}

/**
 * Returns verbatim chunks with their document and source attached.
 *
 * Retrieval only. Canon informs *structure and principle* — what a good
 * guideline contains, how voice sections are usually framed — and its text is
 * quoted with attribution. It never becomes client-facing copy: other brands'
 * content must not end up in Think Quality's guideline.
 */
export async function retrieveCanon(
  query: string,
  options: { tags?: readonly string[]; k?: number } = {},
): Promise<CanonHit[]> {
  const { tags, k = 6 } = options;
  const db = supabaseAdmin();

  let request = db
    .from('canon_chunks')
    .select('id, document_id, content, tags, embedding, canon_documents(title, source_url, kind, license_note)')
    .limit(600);

  if (tags && tags.length > 0) request = request.overlaps('tags', tags as string[]);

  const { data, error } = await request;
  if (error) throw new Error(`Canon retrieval failed: ${error.message}`);

  const rows = (data as unknown as ChunkRow[] | null) ?? [];
  if (rows.length === 0) return [];

  // Embed the query once; fall back to lexical if that is unavailable.
  let queryVector: number[] | null = null;
  try {
    queryVector = (await embed([query]))[0] ?? null;
  } catch {
    queryVector = null;
  }

  const scored = rows.map((row) => {
    const vector = parseEmbedding(row.embedding);
    const usable =
      queryVector !== null && vector !== null && vector.length === queryVector.length;
    return {
      chunkId: row.id,
      documentId: row.document_id,
      documentTitle: row.canon_documents?.title ?? 'Untitled',
      sourceUrl: row.canon_documents?.source_url ?? null,
      kind: row.canon_documents?.kind ?? 'internal',
      licenseNote: row.canon_documents?.license_note ?? null,
      tags: row.tags ?? [],
      content: row.content,
      score:
        usable && queryVector && vector
          ? cosine(queryVector, vector)
          : lexicalScore(query, row.content),
      method: (usable ? 'vector' : 'lexical') as 'vector' | 'lexical',
    };
  });

  return scored
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** Compact block for a prompt — verbatim text, each chunk citable by id. */
export function renderCanonBlock(hits: CanonHit[]): string {
  if (hits.length === 0) {
    return '<canon>[] — nothing ingested. Run: npm run ingest:canon <path|url></canon>';
  }
  const body = hits
    .map(
      (hit) =>
        `--- canon:${hit.chunkId} · ${hit.documentTitle} · tags: ${hit.tags.join(', ')} ---\n${hit.content}`,
    )
    .join('\n\n');
  return `<canon>\n${body}\n</canon>`;
}
