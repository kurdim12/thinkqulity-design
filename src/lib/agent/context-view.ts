/**
 * The app-wide context blocks: what the model READS, and — separately — what
 * the Law is allowed to treat as PROOF.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 * `renderContextBlocks()` used to be both. Four surfaces — `defineFeature`,
 * /api/compliance, the MCP server and the chat tool executor — handed its
 * output to `runLaw` as `context`, the string the claims-linter traces a number
 * in the output back to. That string JSON-dumps the brand row and six hundred
 * characters of every caption, so every one of these was quotable as a
 * measurement of the client's accounts:
 *
 *   - `posts.caption` — the CLIENT's own text. A caption reading
 *     «عدد المتدربين 88123 متدرب» put 88123 in the lint context, and an agent
 *     could then state 88123 as a measured figure. This is the round-3 attack
 *     through a door that was never closed: it needs no zero-width character,
 *     no digit-shaping trick and no linter bug — the number was simply IN the
 *     evidence, because a caption was being counted as evidence.
 *   - `concepts.hook_ar` and `concepts.title` — text a MODEL wrote, on an
 *     earlier turn, now laundered into proof for a later one.
 *   - `brand.facts[].value` — free text somebody typed into a row.
 *   - `brand.audience_notes`, `pillars.hook_pattern` — the same, unkeyed.
 *   - `<knowledge>` — the client's entire workshop corpus, verbatim.
 *
 * ===========================================================================
 * THE FIX: ONE VIEW, READ TWICE, AND THE BOUNDARY IS THE TYPE
 * ===========================================================================
 * `buildContextView()` is the single object graph that gets rendered. The
 * render JSON-dumps it; the evidence WALKS it and declares every leaf that is a
 * `number` — and nothing else. So:
 *
 *   - the two views cannot drift, because they are the same object;
 *   - a caption is a `string` leaf and is therefore STRUCTURALLY INCAPABLE of
 *     becoming evidence, whatever digits it contains and however they are
 *     spelled. There is no text to match, no Unicode alphabet to enumerate and
 *     no floor to slip under — the question "is this a measurement?" is decided
 *     by the field's TYPE, before any character is looked at;
 *   - a field added to the render later needs no denylist entry: if it is text
 *     it is not evidence, automatically, and if it is a number it is.
 *
 * THE INVARIANT THAT MAKES THAT SOUND, stated so it can be broken loudly rather
 * than quietly: every `number` leaf in this view is a quantity THE SYSTEM
 * measured or computed — an engagement count read from the export, a code-
 * computed average, an age in days. Nothing a model or a human typed arrives
 * here as a number; it arrives as a string, in a caption or a hook or a fact.
 * A future field that renders somebody's free text AS A NUMBER would break the
 * invariant, and belongs in the view as text.
 *
 * `<knowledge>` is deliberately NOT part of the view. It is prose the client
 * wrote, it is rendered for the model because the model needs it, and it is
 * assembled outside the object the evidence is drawn from so that it cannot
 * contribute a leaf of any kind.
 *
 * ===========================================================================
 * WHAT THIS COSTS, STATED RATHER THAN DISCOVERED LATER
 * ===========================================================================
 * A caption or a workshop document that quotes a REAL figure no measurement
 * holds makes that figure unquotable: an agent that repeats it has the number
 * cut out. That is the same trade `measureEvidence()` documents in
 * ./strategist/blocks.ts, made for the same reason — the alternative is that
 * anything ever typed into the account becomes a citable statistic.
 *
 * ===========================================================================
 * PURITY
 * ===========================================================================
 * Nothing here reads the environment, opens a connection or calls a model, and
 * the imports carry explicit `.ts` extensions, so this module runs unchanged
 * under `node --test --experimental-strip-types` — which is the only way the
 * property above could be EXECUTED in this repository rather than asserted.
 * The database read that fills an `AgentContext` lives in ./context.ts, which
 * re-exports everything below so no call site had to move.
 */

import { measureEvidence, type Measure } from './strategist/blocks.ts';
import type {
  Account,
  BrandAsset,
  BrandFact,
  BrandRow,
  BrandStatus,
  ConceptFormat,
  ConceptRow,
  ConceptStatus,
  Grounding,
  Palette,
  PillarRow,
  PostRow,
  SnapshotRow,
  SnapshotStats,
  Typography,
  VoiceExample,
} from '../types/db.ts';

export interface AgentContext {
  brand: BrandRow;
  latestSnapshot: SnapshotRow | null;
  topPosts: PostRow[];
  pillars: PillarRow[];
  recentConcepts: ConceptRow[];
}

export const EMPTY_BRAND: BrandRow = {
  id: 1,
  facts: [],
  voice_examples: [],
  knowledge: [],
  assets: [],
  palette: null,
  typography: null,
  audience_notes: null,
  status: 'seed',
  updated_at: new Date(0).toISOString(),
};

export function daysSince(dateIso: string | null | undefined): number | null {
  if (!dateIso) return null;
  const then = new Date(dateIso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
}

/* ================================================================= view === */

/** Names only — a published piece is referenceable without its URL. */
interface AssetView {
  name: string;
  kind: BrandAsset['kind'];
}

interface BrandView {
  status: BrandStatus;
  facts: BrandFact[];
  voice_examples: VoiceExample[];
  palette: Palette | null;
  typography: Typography | null;
  audience_notes: string | null;
  assets: AssetView[];
}

/**
 * The post fields the agent can actually reason about. `caption_excerpt` is
 * TEXT, and being text is exactly what keeps it out of the evidence — see the
 * header.
 */
interface TopPostView {
  id: string;
  account: Account;
  rank: number | null;
  engagement: number;
  likes: number | null;
  comments: number | null;
  media_type: string | null;
  posted_at: string | null;
  url: string | null;
  caption_excerpt: string | null;
}

interface SnapshotView {
  id: string;
  taken_on: string;
  days_old: number | null;
  stats: SnapshotStats;
  top_posts: TopPostView[];
}

interface PillarView {
  name_ar: string;
  name_en: string | null;
  post_count: number;
  avg_engagement: number;
  hook_pattern: string | null;
}

interface ConceptView {
  title: string;
  format: ConceptFormat;
  hook_ar: string;
  status: ConceptStatus;
  grounding: Grounding;
  account: Account;
  shipped_engagement: number | null;
}

/**
 * Everything the blocks render as JSON, as one object. The member names are the
 * block tags, so the render and the evidence walk the same list in the same
 * order and neither has a list of its own to fall out of step with.
 */
export interface ContextView {
  brand: BrandView;
  latest_snapshot: SnapshotView | null;
  pillars: PillarView[];
  recent_concepts: ConceptView[];
}

/** How much of a caption the agent is shown. A long export must not crowd out
 *  the rest of the context. */
export const CAPTION_EXCERPT_CHARS = 600;

export function buildContextView(ctx: AgentContext): ContextView {
  return {
    brand: {
      status: ctx.brand.status,
      facts: ctx.brand.facts,
      voice_examples: ctx.brand.voice_examples,
      palette: ctx.brand.palette,
      typography: ctx.brand.typography,
      audience_notes: ctx.brand.audience_notes,
      // Names only — the agent can reference a specific published piece
      // ("in the style of the الشخصية post") without the URLs eating context.
      assets: (ctx.brand.assets ?? []).map((a) => ({ name: a.name, kind: a.kind })),
    },
    latest_snapshot: ctx.latestSnapshot
      ? {
          id: ctx.latestSnapshot.id,
          taken_on: ctx.latestSnapshot.taken_on,
          days_old: daysSince(ctx.latestSnapshot.taken_on),
          stats: ctx.latestSnapshot.stats,
          top_posts: ctx.topPosts.map((p) => ({
            id: p.id,
            account: p.account,
            rank: p.rank,
            engagement: p.engagement,
            likes: p.likes,
            comments: p.comments,
            media_type: p.media_type,
            posted_at: p.posted_at,
            url: p.url,
            caption_excerpt: p.caption ? p.caption.slice(0, CAPTION_EXCERPT_CHARS) : null,
          })),
        }
      : null,
    pillars: ctx.pillars.map((p) => ({
      name_ar: p.name_ar,
      name_en: p.name_en,
      post_count: p.post_count,
      avg_engagement: p.avg_engagement,
      hook_pattern: p.hook_pattern,
    })),
    recent_concepts: ctx.recentConcepts.map((c) => ({
      title: c.title,
      format: c.format,
      hook_ar: c.hook_ar,
      status: c.status,
      grounding: c.grounding,
      account: c.account,
      shipped_engagement: c.shipped_engagement,
    })),
  };
}

/* =============================================================== render === */

function block(tag: string, body: unknown): string {
  return `<${tag}>\n${JSON.stringify(body, null, 2)}\n</${tag}>`;
}

/**
 * Renders the five context blocks named in the system prompt.
 *
 * WHAT THE MODEL SEES IS UNCHANGED BY THE EVIDENCE WORK, byte for byte, and
 * tests/context-evidence.test.ts asserts that against a frozen copy of the
 * previous implementation. The model still needs the captions, the hooks and
 * the workshop corpus — it cannot match a register it has not been shown. Only
 * what counts as PROOF moved.
 */
export function renderContextBlocks(ctx: AgentContext): string {
  const view = buildContextView(ctx);

  const brand = block('brand', view.brand);

  const snapshot = view.latest_snapshot
    ? block('latest_snapshot', view.latest_snapshot)
    : '<latest_snapshot>null — no engagement export has been ingested yet.</latest_snapshot>';

  const pillars =
    view.pillars.length > 0
      ? block('pillars', view.pillars)
      : '<pillars>[] — pillars are generated by Run Refresh once a snapshot exists.</pillars>';

  const recent =
    view.recent_concepts.length > 0
      ? block('recent_concepts', view.recent_concepts)
      : '<recent_concepts>[] — nothing generated yet.</recent_concepts>';

  /**
   * Ahmad's own material, in full. This corpus is a few thousand tokens against
   * a million-token window, so there is no reason to summarise, embed or
   * fine-tune it — the agent reads all of it every time and cites the source
   * file the same way it cites a snapshot field.
   *
   * ASSEMBLED OUTSIDE THE VIEW, on purpose: it is prose somebody wrote, it can
   * therefore never be a measurement, and keeping it out of the object the
   * evidence walks means that is true by construction rather than by filter.
   */
  const knowledge =
    ctx.brand.knowledge && ctx.brand.knowledge.length > 0
      ? `<knowledge>\n${ctx.brand.knowledge
          .map(
            (doc) =>
              `--- source: ${doc.source} (${doc.kind}) ---\n${doc.content}`,
          )
          .join('\n\n')}\n</knowledge>`
      : '<knowledge>[] — no workshop material loaded. Run: npm run ingest:knowledge</knowledge>';

  return [brand, knowledge, snapshot, pillars, recent].join('\n\n');
}

/* ============================================================= evidence === */

/**
 * The label every declared measure carries. Constant, and free of digits, so it
 * honours `Measure.label`'s contract — a label with a quantity in it would be a
 * second, unguarded way for a number to enter a lint context.
 */
const DECLARED_LABEL = 'a quantity the context blocks rendered under this key';

/**
 * Declares every `number` leaf under `value`, at its dotted path.
 *
 * A non-finite number is NOT declared and is NOT declared as zero (hard rule
 * 2): `JSON.stringify` renders it `null` to the model, and an absence is an
 * absence on both sides.
 *
 * `String(n)` is the same spelling `JSON.stringify` gives a finite number, so
 * the evidence says exactly what the model was shown, character for character.
 */
function declare(value: unknown, path: string, into: Measure[]): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return;
    into.push({ key: path, label: DECLARED_LABEL, value: String(value) });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => declare(item, `${path}.${index + 1}`, into));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
      declare(child, `${path}.${name}`, into);
    }
    return;
  }
  // A string, a boolean, a null: text or a flag, never a measurement. Nothing
  // is declared, and the caption/hook/fact laundering routes close here.
}

/**
 * Every quantity these blocks declare, keyed by where it was rendered.
 *
 * ONE LOOP OVER THE WHOLE VIEW — there is no per-block list here to forget to
 * extend, which is the property that makes a field added to `ContextView` later
 * correct by default in both directions.
 */
export function contextMeasures(ctx: AgentContext): Measure[] {
  const measures: Measure[] = [];
  for (const [tag, member] of Object.entries(buildContextView(ctx))) {
    declare(member, tag, measures);
  }
  return measures;
}

/**
 * THE LINT CONTEXT for anything generated against these blocks: one declared
 * quantity per line, no key, no label, no prose. Pass this to `runLaw` as
 * `context` — never `renderContextBlocks()`.
 *
 * `measureEvidence()` is imported from ./strategist/blocks.ts rather than
 * copied: one function decides what a declared value must LOOK like to be
 * evidence, on this surface and on the strategist's, so the two boundaries
 * cannot come to disagree. It re-applies `wholeQuantity()` to every value,
 * which is a second net under the type check above — a declared value that is
 * not itself one whole quantity does not enter the pool.
 */
export function agentContextEvidence(ctx: AgentContext): string {
  return measureEvidence(contextMeasures(ctx)).join('\n');
}
