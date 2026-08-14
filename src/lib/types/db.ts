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
