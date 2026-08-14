import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { requireEnv, optionalEnv } from '@/lib/env';
import { HttpError } from '@/lib/auth';
import { SYSTEM_PROMPT } from './system';
import type { Quality } from '@/lib/prefs';

export type { Quality };

/**
 * Model tiers behind the header switch. Both IDs are overridable via env so the
 * studio can pin a different generation without a code change.
 */
export function modelFor(quality: Quality): string {
  return quality === 'high'
    ? optionalEnv('ANTHROPIC_MODEL_QUALITY') ?? 'claude-opus-4-8'
    : optionalEnv('ANTHROPIC_MODEL_STANDARD') ?? 'claude-sonnet-4-6';
}

function effortFor(quality: Quality): 'medium' | 'high' {
  return quality === 'high' ? 'high' : 'medium';
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });
  return client;
}

/**
 * Pulls the JSON object out of a model response. The system prompt asks for raw
 * JSON, but a stray ```json fence or a leading sentence shouldn't fail a run.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return candidate;
  return candidate.slice(start, end + 1);
}

export interface AgentRunResult<T> {
  value: T;
  model: string;
  attempts: number;
  usage: { input_tokens: number; output_tokens: number };
}

interface RunArgs<T> {
  /** Fully-assembled user message: context blocks + task + schema. */
  userMessage: string;
  schema: z.ZodType<T>;
  quality: Quality;
  maxTokens?: number;
}

/**
 * One agent call: stream (so long generations don't hit an HTTP timeout),
 * parse, validate against zod, and retry exactly once with the validation
 * error fed back. A second failure is a 502 — we never hand unvalidated
 * model output to the database.
 */
export async function runAgentJson<T>({
  userMessage,
  schema,
  quality,
  maxTokens = 8000,
}: RunArgs<T>): Promise<AgentRunResult<T>> {
  const model = modelFor(quality);
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];

  let usage = { input_tokens: 0, output_tokens: 0 };
  let lastProblem = '';

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const stream = anthropic().messages.stream({
      model,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      thinking: { type: 'adaptive' },
      output_config: { effort: effortFor(quality) },
      messages,
    });

    const message = await stream.finalMessage();
    usage = {
      input_tokens: usage.input_tokens + message.usage.input_tokens,
      output_tokens: usage.output_tokens + message.usage.output_tokens,
    };

    if (message.stop_reason === 'refusal') {
      throw new HttpError(
        502,
        'The model declined this request.',
        'Rephrase the theme or objective and try again.',
      );
    }

    const raw = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (!raw) {
      lastProblem = 'The response contained no text.';
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(extractJson(raw));
      } catch (err) {
        lastProblem = `The response was not valid JSON: ${(err as Error).message}`;
        parsed = undefined;
      }

      if (parsed !== undefined) {
        const result = schema.safeParse(parsed);
        if (result.success) {
          return { value: result.data, model, attempts: attempt, usage };
        }
        lastProblem = result.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
      }
    }

    if (attempt === 1) {
      messages.push({ role: 'assistant', content: raw || '(empty response)' });
      messages.push({
        role: 'user',
        content: `That response failed schema validation: ${lastProblem}\n\nReturn the corrected object now. Output ONLY the JSON object — no prose, no markdown fences.`,
      });
    }
  }

  throw new HttpError(
    502,
    'The agent returned output that does not match the required schema.',
    lastProblem || 'Try again, or switch the model quality toggle in the header.',
  );
}
