import { z } from 'zod';
import { runAgentJson } from '@/lib/agent/client';
import type { Quality } from '@/lib/prefs';
import type { LawReport } from '@/lib/brain/law';
import { renderCanonBlock, type CanonHit } from '@/lib/brain/canon/retrieve';

export const JUDGE_SYSTEM = `You are the Judge inside ThinkQuality Studio. You did not write the
candidate output and you are not its author's advocate. Your only job is to
decide whether it is fit to put in front of a client.

You receive: the candidate output, the results of deterministic Law checks,
retrieved Canon passages, and the brand's own data.

Rules:
- Law results are FACTS, not opinions. A Law violation is a violation; do not
  argue with it, excuse it, or mark it resolved. Restate it as a violation.
- Every violation you raise yourself must cite its source: "law" for a Law
  result, "canon:<chunk_id>" for a retrieved passage, or "brand:<field>" for a
  field in the brand data. A violation you cannot source is not a violation —
  drop it.
- Canon is authority on STRUCTURE and PRINCIPLE only. Never require that client
  output copy another brand's actual content, wording or assets.
- Judge what is in front of you. Do not invent facts about the client, the
  audience, or performance to justify a verdict.
- Arabic register: compare against the brand's real voice examples. If there
  are none, say the register is unverifiable rather than guessing.
- Set needs_human when the call is genuinely a matter of taste, or when you
  cannot verify something that matters.
- Fail is a real option and costs nothing. Passing bad work costs the client.

Return ONLY valid JSON matching the schema in the user message. No markdown,
no text before or after the JSON.`;

export const judgeVerdictSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  score: z.number().int().min(0).max(100),
  violations: z.array(
    z.object({
      rule: z.string().min(1),
      evidence: z.string().min(1),
      source: z.string().min(1),
    }),
  ),
  fixes: z.array(z.string()),
  needs_human: z.boolean(),
});

export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;

const JUDGE_SCHEMA_TEXT = `{
  "verdict": "pass|fail",
  "score": 0-100,
  "violations": [{"rule": "string", "evidence": "string", "source": "law|canon:<chunk_id>|brand:<field>"}],
  "fixes": ["string"],
  "needs_human": false
}`;

export interface JudgeInput {
  /** What is being judged, as the operator would read it. */
  candidate: string;
  lawReport: LawReport;
  canon: CanonHit[];
  /** The brand context blocks the generator was given. */
  brandBlocks: string;
  task: string;
}

/**
 * The Judge runs on a fresh context with its own prompt, and always at the
 * quality tier — a cheap verifier that waves work through is worse than no
 * verifier, because it manufactures confidence.
 */
export async function runJudge(input: JudgeInput): Promise<{
  verdict: JudgeVerdict;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}> {
  const lawSummary = input.lawReport.results
    .map(
      (r) =>
        `- [${r.passed ? 'PASS' : r.severity === 'warning' ? 'WARN' : 'VIOLATION'}] ${r.check}: ${r.evidence}`,
    )
    .join('\n');

  const userMessage = [
    input.brandBlocks,
    '',
    renderCanonBlock(input.canon),
    '',
    '<law_results>',
    lawSummary || '(no checks applied)',
    '</law_results>',
    '',
    '<candidate>',
    input.candidate,
    '</candidate>',
    '',
    '## Task',
    `Judge this ${input.task}.`,
    'Carry every Law VIOLATION into your violations array unchanged, sourced as "law".',
    'Law WARNINGs are heuristics — weigh them, but do not treat them as proof.',
    'Fail if the output would embarrass the studio in front of the client.',
    '',
    '## Response schema',
    JUDGE_SCHEMA_TEXT,
  ].join('\n');

  const run = await runAgentJson({
    userMessage,
    schema: judgeVerdictSchema,
    quality: 'high' as Quality,
    maxTokens: 8000,
    system: JUDGE_SYSTEM,
  });

  return { verdict: run.value, model: run.model, usage: run.usage };
}

/**
 * Law violations are non-negotiable, so they are folded in mechanically rather
 * than trusted to the model. A Judge that "passes" output with a Law violation
 * has its verdict overridden here — the deterministic half wins.
 */
export function reconcile(verdict: JudgeVerdict, lawReport: LawReport): JudgeVerdict {
  if (lawReport.violations.length === 0) return verdict;

  const known = new Set(verdict.violations.map((v) => `${v.rule}|${v.evidence}`));
  const missing = lawReport.violations
    .filter((v) => !known.has(`${v.check}|${v.evidence}`))
    .map((v) => ({ rule: v.check, evidence: v.evidence, source: 'law' }));

  return {
    ...verdict,
    verdict: 'fail',
    violations: [...verdict.violations, ...missing],
    score: Math.min(verdict.score, 40),
  };
}
