import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { requireEnv } from '@/lib/env';
import { HttpError } from '@/lib/auth';
import type { Quality } from '@/lib/prefs';
import { SYSTEM_PROMPT } from './system';
import { effortFor, modelFor, providerKeyName, resolveProvider, type Provider } from './provider';

export type { Quality };
export { modelFor, resolveProvider };

/** Wall-clock ceiling for one generation, below the route's maxDuration. */
const REQUEST_TIMEOUT_MS = 280_000;

let anthropicClient: Anthropic | null = null;
function anthropic(): Anthropic {
  // Only reached when resolveProvider() actually picked 'anthropic' — callers
  // gate on that before calling callAnthropic(). Guarded again here so the key
  // this throws about always matches the provider that was really resolved,
  // and an OpenRouter default never surfaces an ANTHROPIC_API_KEY error.
  const provider = resolveProvider();
  if (provider !== 'anthropic') {
    throw new Error(
      `anthropic() was called while the resolved provider is "${provider}" — this is a bug, not a missing key.`,
    );
  }
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: requireEnv(providerKeyName(provider)) });
  return anthropicClient;
}

/**
 * Pulls the JSON object out of a model response. The system prompt asks for raw
 * JSON, but a stray ```json fence or a leading sentence shouldn't fail a run —
 * and models differ in how literally they take "no markdown".
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

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

interface RawCompletion {
  text: string;
  inputTokens: number;
  outputTokens: number;
  refused: boolean;
}

/* -------------------------------------------------------------- anthropic -- */

async function callAnthropic(
  model: string,
  quality: Quality,
  turns: Turn[],
  maxTokens: number,
  system: string,
): Promise<RawCompletion> {
  // Streamed so a long generation can't trip an HTTP idle timeout.
  const stream = anthropic().messages.stream({
    model,
    max_tokens: maxTokens,
    system,
    thinking: { type: 'adaptive' },
    output_config: { effort: effortFor(quality) },
    messages: turns.map((t) => ({ role: t.role, content: t.content })),
  });

  const message = await stream.finalMessage();

  return {
    text: message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim(),
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    refused: message.stop_reason === 'refusal',
  };
}

/* ------------------------------------------------------------- openrouter -- */

interface OpenRouterResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: number };
}

async function callOpenRouter(
  model: string,
  quality: Quality,
  turns: Turn[],
  maxTokens: number,
  system: string,
): Promise<RawCompletion> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${requireEnv('OPENROUTER_API_KEY')}`,
        'content-type': 'application/json',
        // Optional attribution headers OpenRouter uses for its dashboards.
        'x-title': 'ThinkQuality Studio',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        // Models that don't support reasoning ignore this rather than erroring.
        reasoning: { effort: effortFor(quality) },
        messages: [
          { role: 'system', content: system },
          ...turns.map((t) => ({ role: t.role, content: t.content })),
        ],
      }),
    });

    const payload = (await response.json().catch(() => null)) as OpenRouterResponse | null;

    if (!response.ok) {
      throw new HttpError(
        502,
        `OpenRouter returned ${response.status}: ${payload?.error?.message ?? response.statusText}`,
        `Check the model id "${model}" is spelled exactly as listed on openrouter.ai/models, and that the key has credit.`,
      );
    }

    if (payload?.error) {
      throw new HttpError(502, `OpenRouter error: ${payload.error.message ?? 'unknown'}`);
    }

    const choice = payload?.choices?.[0];

    return {
      text: (choice?.message?.content ?? '').trim(),
      inputTokens: payload?.usage?.prompt_tokens ?? 0,
      outputTokens: payload?.usage?.completion_tokens ?? 0,
      refused: choice?.finish_reason === 'content_filter',
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new HttpError(
        504,
        'The model took too long to respond.',
        'Try the standard tier, or a smaller request.',
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ run --- */

export interface AgentRunResult<T> {
  value: T;
  model: string;
  provider: Provider;
  attempts: number;
  usage: { input_tokens: number; output_tokens: number };
}

interface RunArgs<T> {
  /** Fully-assembled user message: context blocks + task + schema. */
  userMessage: string;
  schema: z.ZodType<T>;
  quality: Quality;
  maxTokens?: number;
  /** Overrides the agent prompt. The Judge runs with its own, on fresh context. */
  system?: string;
}

/**
 * One agent call: send, parse, validate against zod, and retry exactly once
 * with the validation error fed back. A second failure is a 502 — we never
 * hand unvalidated model output to the database.
 *
 * Provider-agnostic on purpose: the honesty contract lives in the system
 * prompt and the schema, not in whose API answers.
 */
export async function runAgentJson<T>({
  userMessage,
  schema,
  quality,
  maxTokens = 12000,
  system = SYSTEM_PROMPT,
}: RunArgs<T>): Promise<AgentRunResult<T>> {
  const provider = resolveProvider();
  const model = modelFor(quality, provider);
  const turns: Turn[] = [{ role: 'user', content: userMessage }];

  // Fail early and clearly rather than deep inside an SDK call. Named for the
  // provider that was actually resolved (MissingEnvError.key), so an
  // OpenRouter default never surfaces an ANTHROPIC_API_KEY error.
  requireEnv(providerKeyName(provider));

  let usage = { input_tokens: 0, output_tokens: 0 };
  let lastProblem = '';

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const completion =
      provider === 'openrouter'
        ? await callOpenRouter(model, quality, turns, maxTokens, system)
        : await callAnthropic(model, quality, turns, maxTokens, system);

    usage = {
      input_tokens: usage.input_tokens + completion.inputTokens,
      output_tokens: usage.output_tokens + completion.outputTokens,
    };

    if (completion.refused) {
      throw new HttpError(
        502,
        'The model declined this request.',
        'Rephrase the theme or objective and try again.',
      );
    }

    if (!completion.text) {
      lastProblem = 'The response contained no text.';
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(extractJson(completion.text));
      } catch (err) {
        lastProblem = `The response was not valid JSON: ${(err as Error).message}`;
        parsed = undefined;
      }

      if (parsed !== undefined) {
        const result = schema.safeParse(parsed);
        if (result.success) {
          return { value: result.data, model, provider, attempts: attempt, usage };
        }
        lastProblem = result.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
      }
    }

    if (attempt === 1) {
      turns.push({ role: 'assistant', content: completion.text || '(empty response)' });
      turns.push({
        role: 'user',
        content: `That response failed schema validation: ${lastProblem}\n\nReturn the corrected object now. Output ONLY the JSON object — no prose, no markdown fences.`,
      });
    }
  }

  throw new HttpError(
    502,
    `The agent (${model}) returned output that does not match the required schema.`,
    lastProblem || 'Try again, or switch the model quality toggle in the header.',
  );
}
