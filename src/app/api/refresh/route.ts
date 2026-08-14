import { NextResponse } from 'next/server';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { readQuality } from '@/lib/prefs.server';
import { runAgentJson } from '@/lib/agent/client';
import { pillarClusterSchema, PILLAR_SCHEMA_TEXT } from '@/lib/agent/schemas';
import { computeDiff, instagramShortcode } from '@/lib/snapshots';
import type {
  BrandFact,
  BrandRow,
  ConceptRow,
  PillarRow,
  PostRow,
  SnapshotRow,
} from '@/lib/types/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** Replaces facts with the same key, keeps everything else, never drops seeds. */
function mergeFacts(existing: BrandFact[], incoming: BrandFact[]): BrandFact[] {
  const byKey = new Map(existing.map((f) => [f.key, f]));
  for (const fact of incoming) byKey.set(fact.key, fact);
  return [...byKey.values()];
}

/**
 * POST /api/refresh
 * 1. diff the latest snapshot against the previous one
 * 2. fold observed numbers into brand.facts (sourced to the snapshot)
 * 3. re-cluster pillars — Claude groups the posts, this code does the maths
 * 4. backfill engagement onto shipped concepts by matching their IG URL
 */
export async function POST() {
  try {
    await requireOperator();
    const quality = await readQuality();
    const db = supabaseAdmin();

    const { data: snapshotRows, error: snapshotError } = await db
      .from('snapshots')
      .select('*')
      .order('taken_on', { ascending: false })
      .limit(2);
    if (snapshotError) throw new Error(`Could not read snapshots: ${snapshotError.message}`);

    const snapshots = (snapshotRows as SnapshotRow[] | null) ?? [];
    const latest = snapshots[0];
    if (!latest) {
      throw new HttpError(
        409,
        'There is no snapshot to refresh from.',
        'Ingest an Apify export on the Data screen first.',
      );
    }
    const previous = snapshots[1] ?? null;

    // ---- 1. Diff -----------------------------------------------------------
    let diff = latest.stats.diff_vs_prev;
    if (previous) {
      const { data: prevIds } = await db.from('posts').select('ig_id').eq('snapshot_id', previous.id);
      const known = new Set((prevIds ?? []).map((r) => (r as { ig_id: string }).ig_id));
      const { data: latestIds } = await db.from('posts').select('ig_id').eq('snapshot_id', latest.id);
      const newCount = ((latestIds ?? []) as { ig_id: string }[]).filter(
        (r) => !known.has(r.ig_id),
      ).length;
      diff = computeDiff(previous, latest.stats, newCount);
      await db
        .from('snapshots')
        .update({ stats: { ...latest.stats, diff_vs_prev: diff } })
        .eq('id', latest.id);
    }

    // ---- 2. Brand facts observed from the data -----------------------------
    const { data: brandRow } = await db.from('brand').select('*').eq('id', 1).maybeSingle();
    const brand = brandRow as BrandRow | null;
    const source = `snapshot-${latest.taken_on}`;
    const observed: BrandFact[] = [];

    for (const account of ['personal', 'academy'] as const) {
      const followers = latest.stats.followers[account];
      const avg = latest.stats.avg_engagement[account];
      const top = latest.stats.top_format[account];
      const count = latest.stats.post_count[account];

      if (followers !== null) {
        observed.push({
          key: `${account}_followers_observed`,
          label_en: `${account} followers (observed)`,
          value: String(followers),
          source,
        });
      }
      if (avg !== null && count > 0) {
        observed.push({
          key: `${account}_avg_engagement_observed`,
          label_en: `${account} avg engagement across ${count} posts`,
          value: String(avg),
          source,
        });
      }
      if (top) {
        observed.push({
          key: `${account}_top_format_observed`,
          label_en: `${account} highest-average format`,
          value: top,
          source,
        });
      }
    }

    if (brand && observed.length > 0) {
      await db
        .from('brand')
        .update({ facts: mergeFacts(brand.facts ?? [], observed), updated_at: new Date().toISOString() })
        .eq('id', 1);
    }

    // ---- 3. Pillars --------------------------------------------------------
    const { data: postRows } = await db
      .from('posts')
      .select('*')
      .eq('snapshot_id', latest.id)
      .order('rank', { ascending: true })
      .limit(40);
    const posts = (postRows as PostRow[] | null) ?? [];

    let pillarsWritten = 0;
    const pillarWarnings: string[] = [];

    if (posts.length >= 3) {
      const postList = posts.map((p) => ({
        id: p.id,
        account: p.account,
        engagement: p.engagement,
        media_type: p.media_type,
        caption_excerpt: p.caption ? p.caption.slice(0, 400) : null,
      }));

      const clustering = await runAgentJson({
        quality,
        maxTokens: 8000,
        schema: pillarClusterSchema,
        userMessage: [
          '<posts_to_cluster>',
          JSON.stringify(postList, null, 2),
          '</posts_to_cluster>',
          '',
          '## Task',
          'Group these posts into 3–6 content pillars by subject and angle.',
          'Every post_ids entry must be an id copied verbatim from the block above; do not invent ids and do not place one post in two pillars.',
          'name_ar is the pillar name in Arabic. hook_pattern describes the recurring opening move, or null if there is no consistent one.',
          'Do NOT compute counts or averages — this application calculates them.',
          '',
          '## Response schema',
          PILLAR_SCHEMA_TEXT,
        ].join('\n'),
      });

      pillarWarnings.push(...clustering.value.warnings);

      const byId = new Map(posts.map((p) => [p.id, p]));
      const computed = clustering.value.pillars
        .map((pillar) => {
          const members = pillar.post_ids
            .map((id) => byId.get(id))
            .filter((p): p is PostRow => p !== undefined);
          if (members.length === 0) return null;
          const total = members.reduce((sum, p) => sum + p.engagement, 0);
          return {
            name_ar: pillar.name_ar,
            name_en: pillar.name_en,
            post_count: members.length,
            avg_engagement: Math.round(total / members.length),
            hook_pattern: pillar.hook_pattern,
            example_post_ids: members.slice(0, 3).map((p) => p.id),
            generated_from: latest.id,
          };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);

      if (computed.length > 0) {
        // Concepts point at pillars; release those references before replacing.
        const { data: oldPillars } = await db.from('pillars').select('id');
        const oldIds = ((oldPillars ?? []) as { id: string }[]).map((p) => p.id);
        if (oldIds.length > 0) {
          await db.from('concepts').update({ pillar_id: null }).in('pillar_id', oldIds);
          await db.from('pillars').delete().in('id', oldIds);
        }
        const { data: inserted, error: pillarError } = await db
          .from('pillars')
          .insert(computed)
          .select('id');
        if (pillarError) throw new Error(`Could not save pillars: ${pillarError.message}`);
        pillarsWritten = ((inserted as PillarRow[] | null) ?? []).length;
      }
    } else {
      pillarWarnings.push(
        'Not enough posts in the latest snapshot to cluster pillars (need at least 3).',
      );
    }

    // ---- 4. Backfill shipped concepts --------------------------------------
    const { data: shippedRows } = await db
      .from('concepts')
      .select('*')
      .eq('status', 'shipped')
      .not('shipped_url', 'is', null);
    const shipped = (shippedRows as ConceptRow[] | null) ?? [];

    const { data: allPostRows } = await db.from('posts').select('*').eq('snapshot_id', latest.id);
    const allPosts = (allPostRows as PostRow[] | null) ?? [];
    const byShortcode = new Map<string, PostRow>();
    for (const post of allPosts) {
      const code = instagramShortcode(post.url);
      if (code) byShortcode.set(code, post);
    }

    let backfilled = 0;
    const unmatched: string[] = [];
    for (const concept of shipped) {
      const code = instagramShortcode(concept.shipped_url);
      const match = code ? byShortcode.get(code) : undefined;
      if (!match) {
        unmatched.push(concept.title);
        continue;
      }
      if (concept.shipped_engagement === match.engagement) continue;
      const { error } = await db
        .from('concepts')
        .update({ shipped_engagement: match.engagement })
        .eq('id', concept.id);
      if (!error) backfilled += 1;
    }

    return NextResponse.json({
      snapshot: { id: latest.id, taken_on: latest.taken_on },
      previous: previous ? { id: previous.id, taken_on: previous.taken_on } : null,
      diff,
      facts_updated: observed.length,
      pillars_written: pillarsWritten,
      pillar_warnings: pillarWarnings,
      shipped: { backfilled, unmatched },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
