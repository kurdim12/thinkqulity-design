/**
 * Hand-written row types mirroring supabase/migrations/0001_init.sql.
 * Kept explicit (rather than generated) so the contract is reviewable in one place.
 */

export type Account = 'personal' | 'academy';
export type ConceptFormat = 'reel' | 'carousel' | 'static' | 'story';
export type Grounding = 'data' | 'hypothesis';
export type ConceptStatus = 'draft' | 'approved' | 'shipped' | 'rejected';
export type BrandStatus = 'seed' | 'live';

/** A single verified fact about the client. Never invented — always carries its source. */
export interface BrandFact {
  key: string;
  value: string;
  source: string;
  label_en?: string;
  label_ar?: string;
}

export interface VoiceExample {
  text: string;
  source_url: string | null;
  engagement: number | null;
  note?: string | null;
}

export interface Palette {
  /** Named swatches, e.g. { primary: '#1F1F1F' }. Null until assets land. */
  swatches: Record<string, string>;
  note?: string | null;
}

export interface Typography {
  arabic_display?: string | null;
  arabic_body?: string | null;
  latin?: string | null;
  note?: string | null;
}

/** One of Ahmad's own documents, read in context and cited by `source`. */
export interface KnowledgeDoc {
  title: string;
  source: string;
  kind: string;
  content: string;
}

/** A file of the client's own creative, in the brand-assets bucket. */
export interface BrandAsset {
  name: string;
  path: string;
  url: string;
  kind: 'creative' | 'document';
  bytes: number;
}

export interface BrandRow {
  id: 1;
  facts: BrandFact[];
  voice_examples: VoiceExample[];
  knowledge: KnowledgeDoc[];
  assets: BrandAsset[];
  palette: Palette | null;
  typography: Typography | null;
  audience_notes: string | null;
  status: BrandStatus;
  updated_at: string;
}

export interface SnapshotStats {
  followers: Record<Account, number | null>;
  avg_engagement: Record<Account, number | null>;
  top_format: Record<Account, string | null>;
  post_count: Record<Account, number>;
  total_engagement: Record<Account, number>;
  diff_vs_prev: SnapshotDiff | null;
}

export interface SnapshotDiff {
  previous_snapshot_id: string;
  previous_taken_on: string;
  followers: Record<Account, number | null>;
  avg_engagement: Record<Account, number | null>;
  post_count: Record<Account, number>;
  new_post_count: number;
}

export interface SnapshotRow {
  id: string;
  taken_on: string;
  stats: SnapshotStats;
  raw_meta: Record<string, unknown> | null;
  created_at: string;
}

export interface PostRow {
  id: string;
  snapshot_id: string;
  account: Account;
  ig_id: string;
  url: string | null;
  caption: string | null;
  media_type: string | null;
  likes: number | null;
  comments: number | null;
  engagement: number;
  posted_at: string | null;
  rank: number | null;
  // --- 0002_v3_ingestion: fields the actor already returned and v1 dropped ---
  video_play_count: number | null;
  video_view_count: number | null;
  video_duration: number | null;
  product_type: string | null;
  location_name: string | null;
  location_id: string | null;
  hashtags: string[] | null;
  mentions: string[] | null;
  first_comment: string | null;
  owner_username: string | null;
  owner_id: string | null;
  is_sponsored: boolean | null;
  dimensions: Record<string, unknown> | null;
  /** The scraper item, untouched. Hard rule 8: raw is sacred. */
  raw: Record<string, unknown> | null;
}

export interface PillarRow {
  id: string;
  name_ar: string;
  name_en: string | null;
  post_count: number;
  avg_engagement: number;
  hook_pattern: string | null;
  example_post_ids: string[] | null;
  generated_from: string | null;
}

/** One filmable beat of a storyboard. See src/lib/agent/features/storyboard.ts. */
export interface Frame {
  order: number;
  scene_beat_ar: string;
  overlay_ar: string;
  shot_direction: string;
  duration_s: number;
  /** A swatch NAME from brand.palette, never a hex value. */
  palette_ref: string | null;
}

export interface ConceptRow {
  id: string;
  title: string;
  pillar_id: string | null;
  format: ConceptFormat;
  hook_ar: string;
  caption_ar: string;
  visual_direction: string;
  why: string;
  grounding: Grounding;
  status: ConceptStatus;
  target_week: string | null;
  account: Account;
  shipped_url: string | null;
  shipped_engagement: number | null;
  frames: Frame[] | null;
  created_at: string;
}

export interface MeasurementPlan {
  metrics: string[];
  pull_method: string;
  when: string;
}

export interface CampaignPlan {
  objective: string;
  audience_segment: string;
  pillar_mix: string[];
  cadence: string;
  flagship_concepts: AgentConcept[];
  measurement_plan: MeasurementPlan;
  warnings?: string[];
}

export interface CampaignRow {
  id: string;
  name: string;
  objective: string;
  plan: CampaignPlan;
  status: string;
  created_at: string;
}

export interface ReportRow {
  id: string;
  month: string;
  body_md: string;
  status: string;
  created_at: string;
}

/** The agent's concept shape, before it is persisted (no ids yet). */
export interface AgentConcept {
  title: string;
  pillar: string | null;
  format: ConceptFormat;
  hook_ar: string;
  caption_ar: string;
  visual_direction: string;
  why: string;
  grounding: Grounding;
  needs_calibration: boolean;
}

/* ===========================================================================
 * v3 ingestion — mirrors supabase/migrations/0002_v3_ingestion.sql.
 * =========================================================================== */

export type ScrapeKind = 'posts' | 'profile' | 'comments' | 'monitor';

/**
 * One ledgered scrape run. Written BEFORE the actor is called, so a blocked or
 * failed run leaves a trace with its estimate. `estimated_usd` is null when the
 * actor's published rate could not be verified — null means "not estimated",
 * never "free". See src/lib/ingest/budget.ts.
 */
export interface ScrapeRunRow {
  id: string;
  kind: ScrapeKind;
  actor: string;
  /** The actor input, verbatim. */
  input: Record<string, unknown>;
  estimated_usd: number | null;
  actual_results: number | null;
  /** 'done' | 'blocked' | 'error' by convention; the column has no check. */
  status: string;
  /** Storage path of the complete raw payload. Hard rule 8: raw is sacred. */
  raw_path: string | null;
  created_at: string;
}

/**
 * Profile-level history, one row per account per day. Follower counts live
 * here rather than in snapshots.stats because the post scraper does not
 * reliably return them.
 */
export interface ProfileSnapshotRow {
  id: string;
  account: Account;
  /** ISO date, `YYYY-MM-DD`. Always produced by toIsoDate(). */
  taken_on: string;
  followers: number | null;
  following: number | null;
  posts_count: number | null;
  bio: string | null;
  external_url: string | null;
  is_verified: boolean | null;
  raw: Record<string, unknown>;
}

/**
 * One stored comment. Hard rule 10: commenters are an audience, not targets —
 * `author_handle` exists for dedupe and raw fidelity, and nothing downstream
 * builds a per-commenter profile or tracking surface from it.
 */
export interface CommentRow {
  id: string;
  post_id: string | null;
  ig_comment_id: string;
  author_handle: string | null;
  text_content: string;
  likes: number | null;
  posted_at: string | null;
  raw: Record<string, unknown>;
}

/** A recurring subject in the comment corpus, evidenced by real quotes. */
export interface AudienceTheme {
  label: string;
  /** How many comments fall in this theme. Always shown next to the label. */
  n: number;
  quotes: { text: string; post_id: string; post_url: string | null }[];
  grounding: Grounding;
}

/** A question the audience actually asked, with the post it was asked under. */
export interface AudienceQuestion {
  text: string;
  post_id: string;
  post_url: string | null;
  /** Times this question (or a near-duplicate) was asked. */
  asked_count: number;
}

/**
 * One hour x weekday bucket of the posting-time grid. `avg_engagement` is null
 * when n is 0 — an empty bucket renders as an em-dash, never 0 (hard rule 2).
 */
export interface TimingCell {
  /** 0–23, in the timezone the report was computed in. */
  hour: number;
  /** 0 = Sunday, matching dayjs `.day()`. */
  weekday: number;
  n: number;
  avg_engagement: number | null;
}

/**
 * Posting-time patterns computed IN CODE from posted_at x engagement — never
 * asserted by a model (hard rule 11). Every window carries its own n.
 */
export interface TimingReport {
  cells: TimingCell[];
  best_windows: {
    label: string;
    /** Inclusive start hour, exclusive end hour. */
    hours: [number, number];
    n: number;
    avg_engagement: number;
    /** avg_engagement / overall_avg, e.g. 2.1. */
    multiple_vs_overall: number;
  }[];
  overall_avg: number;
  total_n: number;
  account: Account | 'all';
}

/** Aggregate audience findings derived from one scrape run. */
export interface AudienceInsightRow {
  id: string;
  generated_from: string | null;
  themes: AudienceTheme[];
  questions: AudienceQuestion[];
  register_notes: string | null;
  timing: TimingReport | null;
  grounding: Grounding;
  created_at: string;
}

/* ===========================================================================
 * Strategist — mirrors supabase/migrations/0003_strategist.sql.
 *
 * The strategist reads the context blocks assembled by
 * src/lib/agent/strategist/blocks.ts, states what changed, and writes down the
 * decisions it wants judged later. Two properties hold across every type here:
 *
 *   1. Every claim carries its evidence as `BasisRef[]` (hard rule 3), and
 *      every BasisRef names a `source_key` that the blocks actually emitted.
 *   2. No quantity in any of these types is a number. See BasisRef.
 * =========================================================================== */

/**
 * One piece of evidence under a claim: the key of a value the context blocks
 * emitted, and that value.
 *
 * `value` is a STRING, and that is load-bearing rather than incidental. The
 * strategist is forbidden to do arithmetic — every average, delta, ratio and
 * count it is allowed to speak is computed in code and handed to it already
 * finished, paired with a key. Typing `value` as `string` makes the ban
 * structural instead of advisory: a model that returns `{value: 508}` fails
 * validation, `value * 2` does not compile, and there is no silent coercion
 * path by which a quoted figure could be recomputed, rounded or rescaled
 * between the block that measured it and the sentence that states it. The
 * value is pass-through text: it must equal, character for character, the
 * value rendered under `source_key`. That equality is checkable — which is the
 * whole point, and is what the Law check over `collectSourceKeys()` does.
 *
 * It also means a value may be an em-dash, an Arabic-Indic numeral, or a
 * verbatim quote, none of which a numeric type could carry.
 */
export interface BasisRef {
  /** A dotted key emitted by renderStrategistBlocks(), e.g. `profiles.personal.followers`. */
  source_key: string;
  /** The value as rendered under that key, VERBATIM. Never a number type. */
  value: string;
}

export type DecisionKind = 'recommendation' | 'experiment' | 'alert' | 'escalation';

/**
 * A decision is 'open' until someone reads its outcome. There is deliberately
 * no 'closed': a decision nobody judged stays open and stays visible.
 */
export type DecisionStatus = 'open' | 'validated' | 'refuted' | 'superseded';

/**
 * One recommendation, written down BEFORE its result is known, with the
 * evidence it rests on, what would prove it, and the date it is to be judged.
 */
export interface DecisionRow {
  id: string;
  kind: DecisionKind;
  statement_ar: string;
  basis: BasisRef[];
  grounding: Grounding;
  /** What would count as this working — stated in advance, not after. */
  expected_signal: string;
  /** ISO date, `YYYY-MM-DD`. */
  review_after: string;
  status: DecisionStatus;
  /** Null until a human reviews it. Null means "not judged", never "fine". */
  outcome_note: string | null;
  created_at: string;
  // --- 0004_v4_visual: the fence, as columns instead of as prose ---
  /**
   * The ceiling on an experiment — max posts, max spend, max weeks. Both this
   * and `kill_condition` used to be packed into `expected_signal` and parsed
   * back out by two mirrored string splitters that shared no constant and were
   * bound by no test (fencedSignal / splitFencedSignal). A fence routed through
   * prose is a fence no check can reach.
   *
   * Required and nullable, like every other optional-in-meaning field in this
   * contract: a recommendation writes null rather than omitting the key, which
   * keeps "this decision has no cap" a statement rather than a gap. Null means
   * "no cap was stated" — never "unlimited".
   */
  cap: string | null;
  /** The observable that ends the experiment early. Null = none was stated. */
  kill_condition: string | null;
}

/**
 * Whether the period actually contained anything. 'quiet' is a real answer and
 * is stored as one: a week with no movement produces a short honest digest
 * rather than a padded one.
 */
export type DigestStatus = 'material' | 'quiet';

/** ISO dates, inclusive. */
export interface StrategistPeriod {
  from: string;
  to: string;
}

/**
 * One movement between two DATED measurements. A delta only exists when both
 * ends were measured — a single measurement produces no delta at all, rather
 * than a delta against an assumed zero (hard rule 2). `basis` therefore carries
 * both ends and the computed difference, all as text.
 */
export interface StrategistDelta {
  label_ar: string;
  direction: 'up' | 'down' | 'flat';
  basis: BasisRef[];
  grounding: Grounding;
}

/** A win or a concern: one sentence, its evidence, and how well grounded it is. */
export interface StrategistFinding {
  statement_ar: string;
  basis: BasisRef[];
  grounding: Grounding;
}

/**
 * The strategist correcting itself. A past decision that the data has since
 * contradicted is named here in the same digest that supersedes it — being
 * wrong in public is the mechanism, not a failure of it.
 */
export interface StrategistCorrection {
  /** The decision being corrected, when there is one on the ledger. */
  decision_id: string | null;
  what_was_said_ar: string;
  what_is_true_ar: string;
  basis: BasisRef[];
}

/** A decision as the agent proposes it, before it is persisted and has an id. */
export interface ProposedDecision {
  kind: DecisionKind;
  statement_ar: string;
  basis: BasisRef[];
  grounding: Grounding;
  expected_signal: string;
  /** ISO date, `YYYY-MM-DD`. */
  review_after: string;
}

/**
 * One thing a human is being asked to do. Capped by the action budget in the
 * `<meta>` block (default 3) — a list of twelve actions is a list nobody does.
 */
export interface StrategistAction {
  do_ar: string;
  owner: 'operator' | 'client';
  /** ISO date, or null when the action is not time-boxed. */
  by_date: string | null;
  /**
   * Index into `StrategistPayload.decisions`, or null when the action stands
   * alone. An index rather than an id because a proposed decision has no id
   * until it is persisted.
   */
  decision_index: number | null;
}

/**
 * The strategist's full output contract, stored verbatim in `digests.payload`.
 * Every list may be empty — an empty `wins` is an honest answer and is not
 * filled in to look complete.
 */
export interface StrategistPayload {
  period: StrategistPeriod;
  status: DigestStatus;
  /** One line, Arabic, no invented figures. */
  headline_ar: string;
  deltas: StrategistDelta[];
  wins: StrategistFinding[];
  concerns: StrategistFinding[];
  corrections: StrategistCorrection[];
  decisions: ProposedDecision[];
  actions: StrategistAction[];
  /**
   * True when the run must not be sent without a human reading it first. The
   * reason belongs in `operator_notes`.
   */
  needs_human: boolean;
  /** What the client would actually receive. Arabic, client-facing register. */
  client_digest_ar: string;
  /** For the operator only — caveats, gaps, what to scrape next. Never sent. */
  operator_notes: string[];
}

/** One stored strategist run. `sent` only ever moves when a human sends it. */
export interface DigestRow {
  id: string;
  period_from: string;
  period_to: string;
  status: DigestStatus;
  payload: StrategistPayload;
  client_digest_ar: string;
  sent: boolean;
  created_at: string;
}

/* ===========================================================================
 * v4 visual — mirrors supabase/migrations/0004_v4_visual.sql.
 *
 * The vision layer TRANSCRIBES and CLASSIFIES images that already exist. Hard
 * rule 13: describing is not generating. No type here, and nothing that
 * consumes one, produces or edits an image — `storage_path` points at a mirror
 * of the client's own post, and `text_in_image_ar` is what the image says, not
 * what someone thinks it should say.
 * =========================================================================== */

/**
 * One colour measured out of an image, with how much of the image it covers.
 *
 * `share` is a number, and unlike everywhere else in this file that is safe:
 * it is counted in code over decoded pixels, never asked of a model. A model
 * that could return a share could return 0.42 for an image it never opened; a
 * counter cannot. Contrast BasisRef.value, which is a string precisely because
 * a model does hand it over.
 */
export interface DominantColor {
  /** Lowercase `#rrggbb`. */
  hex: string;
  /** Fraction of sampled pixels, 0–1 (not a percentage). Computed in code. */
  share: number;
}

/**
 * Whether the image is on-palette. 'warn' is a real middle answer — some brand
 * colour present but not the primary — and is not rounded to either side.
 */
export type PaletteVerdict = 'pass' | 'warn' | 'fail';

/**
 * The image's colours checked against `brand.palette`.
 *
 * Both lists hold swatch NAMES from `Palette.swatches`, never hex values —
 * the same rule `Frame.palette_ref` follows. The hexes actually found live in
 * `VisualFeatureRow.dominant_colors`, so nothing is stated twice and the two
 * can be read side by side: what the brand defines, and what the image used.
 */
export interface PaletteMatch {
  /** Brand swatch names this image does use. */
  matched: string[];
  /** Brand swatch names this image does not use. */
  unmatched: string[];
  verdict: PaletteVerdict;
}

/**
 * What one post's image contains, transcribed and classified.
 *
 * Keyed on `ig_id`, NOT on a `posts.id`. `posts` is UNIQUE (snapshot_id,
 * ig_id) — one row per post per snapshot — so keying on the scrape row would
 * describe the same unchanged image once per scrape, at model cost each time.
 * The image belongs to the post, so the key is the post's own Instagram id and
 * the database enforces it.
 *
 * Every column except `ig_id`, `account` and `grounding` is nullable, and the
 * nulls are load-bearing (hard rule 2): null means "not determined", never
 * "no" and never zero. `has_face: null` is an image nobody has read yet;
 * `has_face: false` is an image someone read and found no face in.
 */
export interface VisualFeatureRow {
  id: string;
  /** The post's Instagram id — stable across every snapshot. Unique. */
  ig_id: string;
  account: Account;
  /**
   * Where the mirrored image lives. Null means "not mirrored", never "no
   * image": `posts.raw` is null for every row stored before that column
   * existed, so those media URLs are expired and there is nothing to fetch
   * until a refresh scrape runs.
   */
  storage_path: string | null;
  has_face: boolean | null;
  /** How much of the frame the face occupies, as a classified band. */
  face_prominence: string | null;
  /** Text READ OFF the image, verbatim. Render with dir="auto". */
  text_in_image_ar: string | null;
  /** How much of the frame is text, as a classified band. */
  text_coverage: string | null;
  logo_present: boolean | null;
  dominant_colors: DominantColor[] | null;
  palette_match: PaletteMatch | null;
  composition_tags: string[] | null;
  /** The model that read the image. Null until one has. */
  model: string | null;
  grounding: Grounding;
  created_at: string;
}

/**
 * One stored board analysis. The table predates this file (it was created by
 * the v2 design-brain migration, which lives in the project's migration
 * history rather than in supabase/migrations/); this type is written down here
 * because 0004 adds a column to it and five call sites were each declaring
 * their own shape.
 *
 * `post_id` references `posts.id` — a scrape ROW — and `ig_id` is the post
 * itself, backfilled by 0004 from that same join. Both are kept: `post_id`
 * records WHICH observation was read and against which population the
 * comparatives in `computed` were frozen; `ig_id` is what survives the next
 * scrape, so analysis already paid for stays attached to the post the board
 * actually shows. `ig_id` is nullable because a row whose post was deleted
 * cannot be resolved, and an unresolvable id is left visible as null rather
 * than guessed.
 */
export interface PostAnalysisRow {
  id: string;
  post_id: string | null;
  /**
   * The comparatives, computed in code before the model was called — in
   * practice `ComputedAnalysis` from src/lib/board/compute.ts (vs_account_avg,
   * vs_format_avg, percentile, days_old). Typed structurally rather than by
   * import so this file stays a leaf with no dependencies.
   */
  computed: Record<string, number | null>;
  cluster_label: string | null;
  explanation: string | null;
  grounding: Grounding;
  model: string | null;
  /** The post's Instagram id. See the note above. Added by 0004_v4_visual. */
  ig_id: string | null;
  created_at: string;
}

/* ===========================================================================
 * 0006_chat — the chat transcript.
 *
 * The chat surface is a WINDOW and a DISPATCHER (hard rule 17): it answers from
 * the strategist's blocks and from named lookups, and it hands every deliverable
 * to the feature that already owns it. So no row below holds a deliverable. A
 * card is a REFERENCE to what a dispatch produced; the artefact itself lives in
 * `concepts`, `campaigns`, `reports`, `brand_guidelines` or `digests`, behind
 * that feature's own Law → Judge gate.
 *
 * The other half of the contract is hard rule 16: an assistant turn is buffered
 * server-side, linted against the blocks it was given AND the tool results it
 * received, and only then delivered. `law_report` is that lint, stored with the
 * turn, so a reply that had a number stripped can say so afterwards from the row
 * alone. A turn with no report is a turn nothing gated — worth being able to
 * find.
 * ========================================================================= */

export type ChatRole = 'user' | 'assistant' | 'tool';

export interface ConversationRow {
  id: string;
  /** Null until the thread has enough in it to be named. Never a placeholder. */
  title: string | null;
  created_at: string;
}

/**
 * One tool call the model asked for, recorded as the transport reported it.
 *
 * `arguments` stays a STRING — the raw JSON the model emitted, not a parsed
 * object. Two reasons, and the second is the one that matters: a re-serialised
 * object is not what the model said, and an argument string that failed to parse
 * is exactly the thing an audit trail must keep rather than discard.
 */
export interface ChatToolCallRecord {
  id: string;
  name: string;
  arguments: string;
}

/**
 * One Law check as it is stored. Structurally identical to `LawResult` in
 * src/lib/brain/law/types.ts and deliberately NOT imported from it — this file
 * is a leaf with no dependencies, the same reason `PostAnalysisRow.computed` is
 * typed structurally.
 */
export interface ChatLawResultRow {
  check: string;
  passed: boolean;
  evidence: string;
  severity: 'violation' | 'warning';
}

/**
 * What the gate did to this reply.
 *
 * `stripped` is non-empty ONLY in the last-resort case: a draft that was linted,
 * repaired once, and still stated a number nothing sourced. Those numbers were
 * removed from the delivered text and replaced with a visible marker. An empty
 * array means nothing was removed — which is the ordinary case, and is not the
 * same as `passed: false`.
 */
export interface ChatLawReportRow {
  /** Whether the DELIVERED text passes the linter. False should be unreachable. */
  passed: boolean;
  /** True when the first draft violated and a second was asked for. */
  repaired: boolean;
  /** Numbers removed from the delivered text, verbatim as the draft wrote them. */
  stripped: string[];
  /** Every check that ran, in order, including the ones that passed. */
  results: ChatLawResultRow[];
}

/**
 * One turn.
 *
 * `content` is NOT NULL and defaults to '': an assistant turn that dispatched a
 * card and said nothing is an empty string, not an unknown one. Nullable text
 * would make "said nothing" and "was never recorded" indistinguishable.
 *
 * `est_usd` is null when no published per-token rate has been verified for the
 * model that answered (hard rule 15). Null means unpriced and says so; it never
 * means free, and it is never rendered as 0.
 */
export interface ChatMessageRow {
  id: string;
  conversation_id: string;
  role: ChatRole;
  content: string;
  /** References to dispatched deliverables. Never the deliverable itself. */
  cards: Record<string, unknown>[] | null;
  /** Present on an assistant turn that called tools; null on one that did not. */
  tool_calls: ChatToolCallRecord[] | null;
  /** Present on every delivered assistant turn. Null on user and tool rows. */
  law_report: ChatLawReportRow | null;
  /** Null = unpriced, never free. See the note above. */
  est_usd: number | null;
  created_at: string;
}
