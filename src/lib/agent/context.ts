import { supabaseAdmin } from '@/lib/supabase/admin';
import { EMPTY_BRAND, type AgentContext } from './context-view';
import type { BrandRow, PostRow, PillarRow, SnapshotRow, ConceptRow } from '@/lib/types/db';

/**
 * The database read. Everything else that was in this file is now in
 * ./context-view.ts — pure, extension-explicit, and therefore executable under
 * `node --test --experimental-strip-types`, which is what the evidence view it
 * gained needed. Re-exported here so no call site moved.
 *
 * `renderContextBlocks` is what the MODEL reads. `agentContextEvidence` is what
 * the LAW may treat as proof, and they are not the same list — see the header
 * of ./context-view.ts for the laundering routes that distinction closes.
 */
export {
  EMPTY_BRAND,
  daysSince,
  buildContextView,
  renderContextBlocks,
  contextMeasures,
  agentContextEvidence,
  CAPTION_EXCERPT_CHARS,
} from './context-view';
export type { AgentContext, ContextView } from './context-view';

/** Reads everything the agent is allowed to know. Nothing else reaches it. */
export async function loadAgentContext(topPostLimit = 15): Promise<AgentContext> {
  const db = supabaseAdmin();

  const [{ data: brand }, { data: snapshots }] = await Promise.all([
    db.from('brand').select('*').eq('id', 1).maybeSingle(),
    db.from('snapshots').select('*').order('taken_on', { ascending: false }).limit(1),
  ]);

  const latestSnapshot = (snapshots?.[0] as SnapshotRow | undefined) ?? null;

  const [{ data: posts }, { data: pillars }, { data: concepts }] = await Promise.all([
    latestSnapshot
      ? db
          .from('posts')
          .select('*')
          .eq('snapshot_id', latestSnapshot.id)
          .order('rank', { ascending: true })
          .limit(topPostLimit)
      : Promise.resolve({ data: [] as PostRow[] }),
    db.from('pillars').select('*').order('avg_engagement', { ascending: false }),
    db.from('concepts').select('*').order('created_at', { ascending: false }).limit(12),
  ]);

  return {
    brand: (brand as BrandRow | null) ?? EMPTY_BRAND,
    latestSnapshot,
    topPosts: (posts as PostRow[] | null) ?? [],
    pillars: (pillars as PillarRow[] | null) ?? [],
    recentConcepts: (concepts as ConceptRow[] | null) ?? [],
  };
}
