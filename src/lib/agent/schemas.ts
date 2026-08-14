import { z } from 'zod';

export const conceptFormat = z.enum(['reel', 'carousel', 'static', 'story']);
export const grounding = z.enum(['data', 'hypothesis']);
export const accountSchema = z.enum(['personal', 'academy']);

/** One post concept, exactly as the agent returns it. */
export const agentConceptSchema = z.object({
  title: z.string().min(1),
  pillar: z.string().nullable(),
  format: conceptFormat,
  hook_ar: z.string().min(1),
  caption_ar: z.string().min(1),
  visual_direction: z.string().min(1),
  why: z.string().min(1),
  grounding,
  needs_calibration: z.boolean(),
});

export const conceptsResponseSchema = z.object({
  warnings: z.array(z.string()),
  concepts: z.array(agentConceptSchema).min(1),
});

export const measurementPlanSchema = z.object({
  metrics: z.array(z.string()).min(1),
  pull_method: z.string().min(1),
  when: z.string().min(1),
});

export const campaignResponseSchema = z.object({
  warnings: z.array(z.string()),
  objective: z.string().min(1),
  audience_segment: z.string().min(1),
  pillar_mix: z.array(z.string()),
  cadence: z.string().min(1),
  flagship_concepts: z.array(agentConceptSchema).min(1),
  measurement_plan: measurementPlanSchema,
});

export const reportResponseSchema = z.object({
  warnings: z.array(z.string()),
  body_md: z.string().min(1),
});

/** Gap analysis: what the account is missing, each finding traceable. */
export const gapsResponseSchema = z.object({
  warnings: z.array(z.string()),
  summary_ar: z.string().min(1),
  gaps: z
    .array(
      z.object({
        title_ar: z.string().min(1),
        kind: z.enum(['content', 'format', 'audience', 'positioning', 'consistency', 'conversion']),
        evidence: z.string().min(1),
        grounding,
        severity: z.enum(['high', 'medium', 'low']),
        recommendation_ar: z.string().min(1),
        suggested_pillar: z.string().nullable(),
      }),
    )
    .min(1),
});

export type GapsResponse = z.infer<typeof gapsResponseSchema>;

export const GAPS_SCHEMA_TEXT = `{
  "warnings": ["string"],
  "summary_ar": "string  // two or three sentences, Arabic",
  "gaps": [{
    "title_ar": "string",
    "kind": "content|format|audience|positioning|consistency|conversion",
    "evidence": "string  // cite the snapshot field, pillar or knowledge source this rests on",
    "grounding": "data|hypothesis",
    "severity": "high|medium|low",
    "recommendation_ar": "string",
    "suggested_pillar": "string | null"
  }]
}`;

/** Pillar clustering: the model groups posts, the app does the arithmetic. */
export const pillarClusterSchema = z.object({
  warnings: z.array(z.string()),
  pillars: z
    .array(
      z.object({
        name_ar: z.string().min(1),
        name_en: z.string().nullable(),
        hook_pattern: z.string().nullable(),
        post_ids: z.array(z.string()).min(1),
      }),
    )
    .min(1),
});

export type ConceptsResponse = z.infer<typeof conceptsResponseSchema>;
export type CampaignResponse = z.infer<typeof campaignResponseSchema>;
export type ReportResponse = z.infer<typeof reportResponseSchema>;
export type PillarClusterResponse = z.infer<typeof pillarClusterSchema>;

/** Human-readable schema text pasted into the user message for the model. */
const CONCEPT_ITEM_TEXT = `{
    "title": "string",
    "pillar": "string | null",
    "format": "reel|carousel|static|story",
    "hook_ar": "string",
    "caption_ar": "string",
    "visual_direction": "string",
    "why": "string",
    "grounding": "data|hypothesis",
    "needs_calibration": "boolean"
  }`;

export const CONCEPT_SCHEMA_TEXT = `{
  "warnings": ["string"],
  "concepts": [${CONCEPT_ITEM_TEXT}]
}`;

export const CAMPAIGN_SCHEMA_TEXT = `{
  "warnings": ["string"],
  "objective": "string",
  "audience_segment": "string",
  "pillar_mix": ["string"],
  "cadence": "string",
  "flagship_concepts": [${CONCEPT_ITEM_TEXT}],
  "measurement_plan": {
    "metrics": ["string"],
    "pull_method": "string",
    "when": "string"
  }
}`;

export const REPORT_SCHEMA_TEXT = `{
  "warnings": ["string"],
  "body_md": "string  // the full client report, in Arabic, as markdown"
}`;

export const PILLAR_SCHEMA_TEXT = `{
  "warnings": ["string"],
  "pillars": [{
    "name_ar": "string",
    "name_en": "string | null",
    "hook_pattern": "string | null",
    "post_ids": ["string  // ids copied verbatim from the posts block"]
  }]
}`;
