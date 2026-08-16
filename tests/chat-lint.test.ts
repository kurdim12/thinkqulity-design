import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ACTION_BUDGET,
  DEFAULT_THRESHOLDS,
  renderStrategistBlocks,
  strategistEvidence,
  strategistValues,
  type StrategistData,
} from '../src/lib/agent/strategist/blocks.ts';
import { claimsLinter } from '../src/lib/brain/law/claims-linter.ts';
import { CLOSE, isSourceKey, OPEN, REDACTED } from '../src/lib/brain/substitute.ts';
import { CHAT_SYSTEM } from '../src/lib/agent/chat/system.ts';
import type {
  ChatToolCallRecord,
  ChatToolResult,
  ChatToolSpec,
  ChatTransport,
  ChatTransportRequest,
  ChatWireMessage,
} from '../src/lib/agent/chat/run.ts';
import type { ChatToolDeps } from '../src/lib/agent/chat/tools.ts';

/* =============================================================== what this ==
 * HARD RULE 16 — chat never renders an unsourced number — is not a prompt line
 * and cannot be. These tests drive the REAL gate in src/lib/agent/chat/run.ts:
 * the real block assembler, the real claims-linter, the real repair-once cycle
 * and the real stripper. One thing is faked and only one:
 *
 *   the model transport. `runAgentChat` takes a `transport`, and the fake below
 *   hands back scripted drafts. That injection is what makes any of this
 *   runnable here at all: there is no OPENROUTER_API_KEY in this repository, so
 *   nothing model-dependent can be EXECUTED — but everything between the draft
 *   and the delivered reply is production code, and that is the part rule 16
 *   lives in.
 *
 * WHAT IS PROVEN HERE, TODAY, WITH NO KEY:
 *   - a number absent from the blocks and the tool results is caught and the
 *     model is asked to repair it EXACTLY once;
 *   - a second violation is not argued with: the number is cut out, the
 *     «رقم غير موثّق — حُذف» chip stands in its place, and law_report says so;
 *   - a reply whose numbers are all sourced is delivered byte-for-byte
 *     untouched — a gate that mangles good replies is worse than no gate;
 *   - Arabic-Indic digits are caught exactly as Western ones are;
 *   - stripping is surgical: the surrounding Arabic, its spacing and its
 *     punctuation survive, asserted against an exact expected string;
 *   - a number sourced by a TOOL RESULT rather than by the blocks passes, so
 *     the lint context is both halves and not just the blocks;
 *   - history is windowed by code truncation — no model call summarises
 *     anything.
 *
 * AND THE TWO DEFECTS THIS FILE WAS EXTENDED TO CLOSE, both replayed as the
 * attacks that were actually executed against the running gate:
 *
 *   - THE MODEL CANNOT WRITE ITS OWN SOURCES. Four tools echo a model-supplied
 *     string back inside their refusal, and all four refusals are free — no
 *     spend, no write — so a model could invent a lookup name containing the
 *     figure it wanted, be refused, and cite the refusal. Each of the four is
 *     replayed here through the REAL executor, and each must end with the
 *     number cut out. The fifth-echo guard is the test that stops this fix
 *     rotting: a tool that declares no sourced values contributes nothing,
 *     so an echo added later fails closed instead of reopening the hole.
 *   - A CLAIM IS SOURCED BY A WHOLE TOKEN, NOT A SUBSTRING. `508` used to lint
 *     clean against `ig_id: 1750899508`. Both the attack and its true-positive
 *     control are here, because a check that stopped finding real numbers
 *     would be a worse bug than the one it replaced.
 *
 * AND THEN v5, in the last section of the file. The gate no longer rests on the
 * linter: the model emits `{{source.key}}` and CODE substitutes the value, so a
 * number the model cannot write is a number it cannot fabricate. What that
 * section proves, with the same injected transport and the same real gate:
 *
 *   - a draft that states NO DIGIT AT ALL comes back with the measured values in
 *     it, byte for byte, and the run says every one of them was written by code;
 *   - the round-3 counter-example — «٨٨<U+034F>٥٠٨», the reason v5 exists — is
 *     cut, AND the claims-linter is shown passing the same text, because an
 *     exploit "closed at the substitution step" is only a claim worth making
 *     where the lint step demonstrably let it through. Three tests assert both
 *     halves;
 *   - a key naming no measurement resolves to NOTHING — not an em-dash, not a
 *     zero, not the key echoed back — including a key the blocks themselves
 *     declared absent by name;
 *   - a unit or a second value welded onto a substituted figure takes the figure
 *     with it, because a magnitude the model assembled is a magnitude the model
 *     chose;
 *   - the prompt in src/lib/agent/chat/system.ts spells the syntax the engine
 *     implements and names keys that really exist, asserted against the engine's
 *     own grammar rather than against a reader's memory.
 *
 * WHAT IS NOT PROVEN HERE:
 *   whether a real model repairs a draft when asked to. That is a claim about a
 *   model and no key is usable in this repository. What is proven is that a
 *   model which does NOT repair cannot get an unsourced number onto a screen.
 *
 *   Nor that a real model will USE the placeholders. It is told to, in the one
 *   documented edit to the verbatim prompt; until it does, its typed figures are
 *   delivered on the OLD guarantee and every one of them is listed in
 *   `substitution.typed`, which is the number that has to fall to zero.
 * ========================================================================= */

/* ---------------------------------------------------------------- loader --
 * Same approach as tests/needs-human.test.ts. `@/*` is a tsconfig alias node
 * does not know, and `@/lib/auth` reaches into next/server. These hooks teach
 * this process the alias rule, resolve extensionless relative imports to their
 * .ts file, and swap exactly one module for a stub.
 * ------------------------------------------------------------------------ */

const SRC = new URL('../src/', import.meta.url).href;

const AUTH_STUB = 'stub:lib-auth';
const DB_STUB = 'stub:lib-supabase-admin';
const AGENT_STUB = 'stub:lib-agent-client';

/**
 * Three stubs, and the last two exist so THE REAL TOOLS can be driven here.
 *
 * The laundering attacks below are replayed through `createChatToolExecutor` —
 * the production executor, the production refusals — because a fake tool that
 * merely resembled a refusal would prove nothing about the tools that were
 * actually exploited. Importing it pulls in the Supabase admin client and the
 * feature registry's model client, neither of which can be constructed in this
 * repository, so both are swapped for stubs exactly as tests/chat-tools.test.ts
 * does. The model client's stub THROWS: no tool on any path below may reach a
 * model, and if one did this would say so rather than hang.
 */
const STUBS: Record<string, string> = {
  '@/lib/auth': AUTH_STUB,
  '@/lib/supabase/admin': DB_STUB,
  '@/lib/agent/client': AGENT_STUB,
};

const STUB_SOURCE: Record<string, string> = {
  [AUTH_STUB]:
    'export class HttpError extends Error {' +
    '  constructor(status, message, hint) {' +
    '    super(message);' +
    '    this.name = "HttpError";' +
    '    this.status = status;' +
    '    this.hint = hint;' +
    '  }' +
    '}',
  [DB_STUB]:
    'export function supabaseAdmin() {' +
    '  throw new Error("chat-lint.test.ts: no tool here may build a database client.");' +
    '}',
  [AGENT_STUB]:
    'export async function runAgentJson() {' +
    '  throw new Error("chat-lint.test.ts: a model call escaped the injected transport.");' +
    '}' +
    'export function modelFor() { return "stub — no model was called"; }' +
    'export function resolveProvider() { return "openrouter"; }',
};

function tsFile(base: string): string | null {
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(fileURLToPath(candidate))) return candidate;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier];
    if (stub) return { url: stub, shortCircuit: true };

    if (specifier.startsWith('@/')) {
      const url = tsFile(new URL(specifier.slice(2), SRC).href);
      if (url) return { url, shortCircuit: true };
    }

    const parent = context.parentURL;
    if (specifier.startsWith('.') && parent?.startsWith('file:') && !/\.[a-z]+$/i.test(specifier)) {
      const url = tsFile(new URL(specifier, parent).href);
      if (url) return { url, shortCircuit: true };
    }

    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = STUB_SOURCE[url];
    if (source) return { format: 'module', shortCircuit: true, source };
    return nextLoad(url, context);
  },
});

const {
  CHAT_MAX_TOKENS,
  HISTORY_TOKEN_BUDGET,
  UNSOURCED_CHIP,
  lintEvidence,
  runAgentChat,
  stripUnsourcedNumbers,
  windowHistory,
} = await import('../src/lib/agent/chat/run.ts');

const { chatToolSpecs, createChatToolExecutor } = await import(
  '../src/lib/agent/chat/tools.ts'
);

/* --------------------------------------------------------------- fixture -- */

const TODAY = '2026-08-15';
const SNAPSHOT_DAY = '2026-08-14';

/**
 * The four proven figures and nothing else: personal n=190 avg 508, academy
 * n=130 avg 40, with the two totals derived from them (190 x 508 = 96520,
 * 130 x 40 = 5200). Every other block is EMPTY, which is not a convenience —
 * profile_snapshots, comments, post_analyses and decisions really are empty
 * today, so this is the shape the chat surface actually meets.
 */
function chatData(): StrategistData {
  return {
    brand: null,
    guideline: null,
    profiles: { personal: null, academy: null },
    performance: {
      snapshot: { id: 'snap-1', taken_on: SNAPSHOT_DAY },
      accounts: {
        personal: { post_count: 190, total_engagement: 96520, avg_engagement: 508, top_post: null },
        academy: { post_count: 130, total_engagement: 5200, avg_engagement: 40, top_post: null },
      },
      clusters: [],
      timing: [],
      posts_coverage: null,
      duplicates_collapsed: 0,
      analyses_count: null,
    },
    audience: null,
    content: { counts: { draft: 0, approved: 0, shipped: 0, rejected: 0 }, shipped: [] },
    ledger: [],
    meta: {
      today: TODAY,
      period: { from: '2026-08-09', to: TODAY },
      staleness_days: 1,
      action_budget: DEFAULT_ACTION_BUDGET,
      thresholds: DEFAULT_THRESHOLDS,
    },
  };
}

const BLOCKS = renderStrategistBlocks(chatData());

/**
 * The lint context the gate builds from those blocks, reconstructed here so a
 * test can ask what the CLAIMS-LINTER ALONE would have done with a draft. Several
 * tests below turn on that question: an exploit is only proven to be closed at
 * the substitution step if the lint step demonstrably let it through.
 */
const EVIDENCE = strategistEvidence(chatData());

/** Western and Arabic-Indic spellings of one number that is in no source. */
const INVENTED = '777';
const INVENTED_AR = '٧٧٧';

/**
 * The trap only means something if the trap number is genuinely absent. Assert
 * that against the rendered blocks rather than trusting the fixture — a figure
 * added to blocks.ts later that happened to contain "777" would otherwise turn
 * every test below into a vacuous pass.
 */
test('the fixture is a real trap: the invented number appears nowhere in the blocks', () => {
  assert.equal(BLOCKS.includes(INVENTED), false);
  assert.equal(BLOCKS.includes(INVENTED_AR), false);
  // And the sourced figures really are there, or "passes untouched" proves nothing.
  assert.ok(BLOCKS.includes('508'));
  assert.ok(BLOCKS.includes('96520'));
});

/* ------------------------------------------------ the executed attack values --
 *
 * 88123 is the figure the laundering proof used: with `profile_snapshots` EMPTY,
 * the gate delivered "عدد متابعي حساب الأكاديمية 88123" carrying a source key,
 * passed: true, stripped: []. No row in this deployment has ever held it, which
 * is exactly what makes it the right probe.
 *
 * 1750899508 is the Instagram id from the substring proof, and 899 is a slice of
 * its middle — a number that is nowhere in the blocks and is not a quantity
 * anybody measured, but that the old `context.includes()` would have found.
 * ------------------------------------------------------------------------ */

const LAUNDERED = '88123';
const IG_ID = '1750899508';
const INSIDE_IG_ID = '899';

test('the attack values are real traps: none of them is in the blocks', () => {
  assert.equal(BLOCKS.includes(LAUNDERED), false);
  assert.equal(BLOCKS.includes(INSIDE_IG_ID), false);
  assert.equal(BLOCKS.includes(IG_ID), false);
  // And the slice really is a slice, or the substring test proves nothing.
  assert.ok(IG_ID.includes(INSIDE_IG_ID));
});

/* --------------------------------------------------------- the fake database --
 *
 * ONE snapshot and NO posts — the honest state of a filter that matched nothing,
 * and the reason no post figure is invented anywhere in this file. It answers
 * the two reads `search_posts` makes and nothing else; every other table comes
 * back empty, which is what this deployment holds.
 * ------------------------------------------------------------------------ */

interface DbAnswer {
  data: unknown;
  error: { message: string } | null;
}

type DbChain = Promise<DbAnswer> & {
  select: () => DbChain;
  eq: () => DbChain;
  order: () => DbChain;
  limit: () => DbChain;
};

function dbChain(answer: DbAnswer): DbChain {
  const self = Promise.resolve(answer) as DbChain;
  self.select = () => self;
  self.eq = () => self;
  self.order = () => self;
  self.limit = () => self;
  return self;
}

const TABLES: Record<string, DbAnswer> = {
  snapshots: { data: [{ id: 'snap-1', taken_on: SNAPSHOT_DAY }], error: null },
  posts: { data: [], error: null },
};

const fakeDb = {
  from: (table: string) => dbChain(TABLES[table] ?? { data: [], error: null }),
};

/** Stands in for a SupabaseClient at the one call shape these reads use. */
const db = fakeDb as unknown as ChatToolDeps['db'];

/** The production executor, over that database. Nothing about it is faked. */
function realTools(): {
  tools: ChatToolSpec[];
  executeTool: ReturnType<typeof createChatToolExecutor>;
} {
  return {
    tools: chatToolSpecs(),
    executeTool: createChatToolExecutor({ db, quality: 'standard' }),
  };
}

/* ---------------------------------------------------------- the fake model -- */

interface Scripted {
  text: string;
  toolCalls?: ChatToolCallRecord[];
}

interface FakeModel {
  /** Every request the loop made, in order. */
  seen: ChatTransportRequest[];
  transport: ChatTransport;
}

/**
 * Hands back the scripted drafts in order. A call beyond the script throws, so
 * a cycle that retried more than once fails here rather than passing quietly.
 *
 * The token counts are 0 and that zero is real: no request left this process.
 */
function fakeModel(turns: Scripted[]): FakeModel {
  const seen: ChatTransportRequest[] = [];
  let index = 0;

  const transport: ChatTransport = async (request) => {
    seen.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
    const turn = turns[index];
    index += 1;
    if (!turn) {
      throw new Error(
        `the model was called ${index} time(s); this script allows ${turns.length}.`,
      );
    }
    return {
      text: turn.text,
      toolCalls: turn.toolCalls ?? [],
      inputTokens: 0,
      outputTokens: 0,
      refused: false,
    };
  };

  return { seen, transport };
}

function lastUserMessage(request: ChatTransportRequest): ChatWireMessage {
  const users = request.messages.filter((m) => m.role === 'user');
  const last = users[users.length - 1];
  assert.ok(last, 'the request carried a user message');
  return last;
}

/* ================================================================= tests == */

test('an unsourced number is repaired exactly once, and the repair is delivered clean', async () => {
  const model = fakeModel([
    { text: `معدل التفاعل على الحساب الشخصي ${INVENTED} لكل منشور.` },
    { text: 'معدل التفاعل على الحساب الشخصي 508 [performance.personal.avg_engagement].' },
  ]);

  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'كم معدل التفاعل؟',
    quality: 'standard',
    transport: model.transport,
  });

  // One draft, one repair. Never a second repair.
  assert.equal(model.seen.length, 2);
  assert.equal(outcome.calls, 2);
  assert.equal(outcome.law_report.repaired, true);
  assert.equal(outcome.law_report.passed, true);
  assert.deepEqual(outcome.law_report.stripped, []);

  // The repaired draft is delivered verbatim — nothing was cut out of it.
  assert.equal(outcome.reply, 'معدل التفاعل على الحساب الشخصي 508 [performance.personal.avg_engagement].');

  // The model was told what failed, by number, and was given no tools to
  // re-open a lookup with.
  const repair = model.seen[1];
  assert.deepEqual(repair.tools, []);
  assert.match(lastUserMessage(repair).content, new RegExp(INVENTED));
  assert.match(lastUserMessage(repair).content, /Rewrite the reply now/);

  // Two linter runs are on the record: the failure and the pass.
  const checks = outcome.law_report.results;
  assert.equal(checks.length, 2);
  assert.equal(checks[0].check, 'claims-linter');
  assert.equal(checks[0].passed, false);
  assert.equal(checks[1].passed, true);
});

test('a second violation is stripped, chipped, and reported — never delivered', async () => {
  const model = fakeModel([
    { text: `الفرق ${INVENTED} ضعف.` },
    { text: `ما زال الفرق ${INVENTED} ضعف.` },
  ]);

  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'قدّيش الفرق؟',
    quality: 'standard',
    transport: model.transport,
  });

  assert.equal(model.seen.length, 2, 'exactly one repair was attempted');
  assert.equal(outcome.law_report.repaired, true);
  assert.deepEqual(outcome.law_report.stripped, [INVENTED]);
  assert.ok(outcome.reply.includes(UNSOURCED_CHIP), 'the chip is visible in the delivered text');
  assert.equal(outcome.reply.includes(INVENTED), false, 'the number itself is gone');
  assert.equal(outcome.reply, `ما زال الفرق ${UNSOURCED_CHIP} ضعف.`);

  // The report is populated and survives the round trip into a jsonb column.
  assert.equal(outcome.law_report.passed, true, 'what is delivered passes the linter');
  assert.equal(outcome.law_report.results.length, 3, 'draft, repair, and the post-strip re-lint');
  assert.equal(outcome.law_report.results[0].passed, false);
  assert.equal(outcome.law_report.results[1].passed, false);
  assert.equal(outcome.law_report.results[2].passed, true);
  assert.match(outcome.law_report.results[1].evidence, new RegExp(INVENTED));
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.law_report)), outcome.law_report);
});

test('a reply whose numbers are all sourced passes untouched — no false positive', async () => {
  // 508 in Western digits, 508 again in Arabic-Indic, and 130 — all three are
  // in the blocks, so all three must survive exactly as written.
  const clean =
    'بالأرقام: الشخصي 508 مقابل الأكاديمية ٥٠٨ في القياس نفسه، على 130 منشور [performance.academy.post_count].';
  const model = fakeModel([{ text: clean }]);

  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'اعطيني الأرقام',
    quality: 'standard',
    transport: model.transport,
  });

  assert.equal(model.seen.length, 1, 'a clean draft is never retried');
  assert.equal(outcome.calls, 1);
  assert.equal(outcome.reply, clean, 'byte-for-byte, including the Arabic-Indic digits');
  assert.equal(outcome.law_report.repaired, false);
  assert.deepEqual(outcome.law_report.stripped, []);
  assert.equal(outcome.law_report.passed, true);
  assert.equal(outcome.law_report.results.length, 1);
});

test('Arabic-Indic digits are caught exactly as Western ones are', async () => {
  const arabic = fakeModel([
    { text: `المعدل ${INVENTED_AR} لكل منشور.` },
    { text: `المعدل ${INVENTED_AR} لكل منشور.` },
  ]);
  const western = fakeModel([
    { text: `المعدل ${INVENTED} لكل منشور.` },
    { text: `المعدل ${INVENTED} لكل منشور.` },
  ]);

  const withArabic = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'المعدل؟',
    quality: 'standard',
    transport: arabic.transport,
  });
  const withWestern = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'المعدل؟',
    quality: 'standard',
    transport: western.transport,
  });

  // Same detection, same repair, same strip — the only difference is the script.
  assert.equal(withArabic.law_report.repaired, withWestern.law_report.repaired);
  assert.equal(withArabic.calls, withWestern.calls);
  assert.equal(withArabic.reply, withWestern.reply);
  assert.equal(withArabic.reply, `المعدل ${UNSOURCED_CHIP} لكل منشور.`);

  // What was removed is recorded in the script the model actually wrote it in.
  assert.deepEqual(withArabic.law_report.stripped, [INVENTED_AR]);
  assert.deepEqual(withWestern.law_report.stripped, [INVENTED]);
});

test('stripping is surgical: the surrounding Arabic survives, character for character', async () => {
  const draft = `بالأرقام: معدل الحساب الشخصي 508 مقابل ${INVENTED_AR} للأكاديمية — الفرق كبير، والمصدر [performance.personal.avg_engagement].`;
  const model = fakeModel([{ text: draft }, { text: draft }]);

  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'قارن بين الحسابين',
    quality: 'standard',
    transport: model.transport,
  });

  // The exact string. The sourced 508 stays, the invented figure becomes the
  // chip, and every space, comma, em-dash and bracket around them is unmoved.
  assert.equal(
    outcome.reply,
    `بالأرقام: معدل الحساب الشخصي 508 مقابل ${UNSOURCED_CHIP} للأكاديمية — الفرق كبير، والمصدر [performance.personal.avg_engagement].`,
  );

  // No welded words: the chip has a space either side, as the number did.
  assert.ok(outcome.reply.includes(` ${UNSOURCED_CHIP} `));

  // And the delivered text really does pass the REAL linter. This is the drift
  // detector for METRIC_MIRROR in run.ts: if the linter's own regex changes and
  // the mirror does not follow, the strip stops matching and this fails.
  assert.equal(claimsLinter(outcome.reply, BLOCKS).passed, true);
});

test('a number sourced by a TOOL RESULT passes, so the context is both halves', async () => {
  const TOP_POST = '33176';
  assert.equal(BLOCKS.includes(TOP_POST), false, 'this figure is not in the blocks');

  const getStats: ChatToolSpec = {
    name: 'get_stats',
    description: 'One named, code-defined lookup. No free SQL exists (hard rule 19).',
    parameters: { type: 'object', properties: { lookup: { type: 'string' } }, required: ['lookup'] },
  };

  const call: ChatToolCallRecord = {
    id: 'call_1',
    name: 'get_stats',
    arguments: '{"lookup":"top_post_engagement"}',
  };

  const model = fakeModel([
    { text: '', toolCalls: [call] },
    { text: `أقوى منشور حصد ${TOP_POST} تفاعل [performance.personal.top_post.engagement].` },
  ]);

  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'أقوى منشور؟',
    quality: 'standard',
    tools: [getStats],
    executeTool: async (asked) => {
      assert.equal(asked.name, 'get_stats');
      return {
        content: `[performance.personal.top_post.engagement] = "${TOP_POST}"`,
        // THE DECLARED HALF. `content` is what the model reads; this is what the
        // linter reads, and only this. A tool result that carried the figure in
        // its prose alone would now source nothing — which is the fifth-echo
        // guard further down, asserted here from the passing side.
        sourced: [
          { value: TOP_POST, source_key: 'performance.personal.top_post.engagement' },
        ],
        source_keys: ['performance.personal.top_post.engagement'],
      };
    },
    transport: model.transport,
  });

  assert.equal(outcome.law_report.repaired, false, 'a tool-sourced number is not a violation');
  assert.deepEqual(outcome.law_report.stripped, []);
  assert.ok(outcome.reply.includes(TOP_POST));
  assert.equal(outcome.tools.length, 1);
  assert.equal(outcome.tools[0].call.id, 'call_1');

  // The tool result went back to the model as a tool turn, tied to the call.
  const second = model.seen[1];
  const toolTurn = second.messages.find((m) => m.role === 'tool');
  assert.ok(toolTurn, 'the result was fed back');
  assert.equal(toolTurn.tool_call_id, 'call_1');
  assert.ok(toolTurn.content.includes(TOP_POST));

  // And the blocks were assembled by the ONE assembler, not a chat-only fork.
  assert.equal(model.seen[0].messages[0].content, BLOCKS);
  assert.ok(outcome.source_keys.includes('performance.personal.avg_engagement'));
  assert.equal(model.seen[0].maxTokens, CHAT_MAX_TOKENS);
});

test('a tool that refuses is answered with, not crashed on', async () => {
  const cap: ChatToolSpec = {
    name: 'dispatch_feature',
    description: 'Dispatches a deliverable to the feature that owns it.',
    parameters: { type: 'object', properties: { feature: { type: 'string' } } },
  };

  const model = fakeModel([
    {
      text: '',
      toolCalls: [{ id: 'call_1', name: 'dispatch_feature', arguments: '{"feature":"concepts"}' }],
    },
    { text: 'ما بقدر أطلق التوليد اليوم — انتهى السقف اليومي.' },
  ]);

  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'ولّد أفكار',
    quality: 'standard',
    tools: [cap],
    executeTool: async () => {
      throw new Error('CHAT_DAILY_GENERATION_CAP reached; resets at midnight Asia/Amman.');
    },
    transport: model.transport,
  });

  assert.equal(outcome.tools.length, 1);
  assert.match(outcome.tools[0].result.content, /TOOL ERROR \(dispatch_feature\)/);
  assert.match(outcome.tools[0].result.content, /CHAT_DAILY_GENERATION_CAP/);
  assert.equal(outcome.law_report.passed, true);
  assert.deepEqual(outcome.cards, []);
});

test('an empty reply is a failure when nothing carries the turn, and fine when a card does', async () => {
  const blank = fakeModel([{ text: '   ' }]);
  await assert.rejects(
    runAgentChat({
      data: chatData(),
      history: [],
      message: 'مرحبا',
      quality: 'standard',
      transport: blank.transport,
    }),
    /empty reply/,
  );

  // Rule 17: the card carries the deliverable and the framing line is optional,
  // so a wordless turn that dispatched something is delivered, not refused.
  const dispatch: ChatToolSpec = {
    name: 'dispatch_feature',
    description: 'Dispatches a deliverable to the feature that owns it.',
    parameters: { type: 'object', properties: { feature: { type: 'string' } } },
  };
  const carded = fakeModel([
    {
      text: '',
      toolCalls: [{ id: 'call_1', name: 'dispatch_feature', arguments: '{"feature":"concepts"}' }],
    },
    { text: '' },
  ]);

  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'ولّد أفكار',
    quality: 'standard',
    tools: [dispatch],
    executeTool: async () => ({
      content: 'dispatched: concepts (3 drafts queued for review)',
      card: { kind: 'concepts', status: 'queued' },
    }),
    transport: carded.transport,
  });

  assert.equal(outcome.reply, '');
  assert.deepEqual(outcome.cards, [{ kind: 'concepts', status: 'queued' }]);
  assert.equal(outcome.law_report.passed, true);
});

test('history is windowed by code truncation — nothing is summarised by a model', () => {
  const long = 'ا'.repeat(4000);
  const window = windowHistory(
    [
      { role: 'user', content: long },
      { role: 'assistant', content: long },
      { role: 'user', content: 'آخر سؤال' },
    ],
    // Room for the last turn and a truncated tail of the one before it.
    600,
  );

  assert.equal(window.dropped, 1, 'the oldest turn did not fit');
  assert.equal(window.truncated, true);
  assert.equal(window.turns.length, 2);
  assert.equal(window.turns[1].content, 'آخر سؤال', 'the newest turn is intact');
  assert.ok(window.turns[0].content.startsWith('[…] '), 'the cut is marked');
  assert.ok(window.turns[0].content.length < long.length);

  // The default budget keeps a short conversation whole and untouched.
  const short = [
    { role: 'user' as const, content: 'مرحبا' },
    { role: 'assistant' as const, content: 'أهلاً' },
  ];
  const whole = windowHistory(short, HISTORY_TOKEN_BUDGET);
  assert.deepEqual(whole, { turns: short, dropped: 0, truncated: false });
});

/* ================================================ defect 1: the four echoes ==
 *
 * Each attack is the same three moves, so they are driven by one helper and
 * differ only in the tool call — which is the point: the fix is one rule applied
 * to every tool, not four patches.
 *
 *   1. The model calls a REAL tool with a model-written string carrying 88123.
 *   2. The real refusal comes back, quoting that string. It still does — the
 *      refusal text is good UX and the model should see it.
 *   3. The model cites 88123 with a plausible source key, twice, so the one
 *      repair is spent and the stripper has to act.
 *
 * The assertions are made in both directions on purpose. The refusal MUST still
 * contain the digits (or the attack is not being replayed at all) and the lint
 * evidence MUST NOT (or it is not being stopped).
 * ========================================================================== */

async function laundering(call: ChatToolCallRecord): Promise<{
  refusal: string;
  evidence: string;
  reply: string;
  stripped: string[];
}> {
  const cited = `عدد متابعي حساب الأكاديمية ${LAUNDERED} [profiles.academy.followers].`;
  const model = fakeModel([{ text: '', toolCalls: [call] }, { text: cited }, { text: cited }]);
  const { tools, executeTool } = realTools();

  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'كم عدد المتابعين؟',
    quality: 'standard',
    tools,
    executeTool,
    transport: model.transport,
  });

  assert.equal(outcome.tools.length, 1, 'the tool really ran');
  return {
    refusal: outcome.tools[0].result.content,
    evidence: lintEvidence(outcome.tools[0].result),
    reply: outcome.reply,
    stripped: outcome.law_report.stripped,
  };
}

function assertLaundered(
  outcome: { refusal: string; evidence: string; reply: string; stripped: string[] },
  where: string,
): void {
  assert.ok(
    outcome.refusal.includes(LAUNDERED),
    `${where}: the refusal must still echo the number, or this test is vacuous`,
  );
  assert.equal(
    outcome.evidence.includes(LAUNDERED),
    false,
    `${where}: the echoed number reached the lint context`,
  );
  assert.deepEqual(outcome.stripped, [LAUNDERED], `${where}: the number was not cut out`);
  assert.equal(outcome.reply.includes(LAUNDERED), false, `${where}: the number was delivered`);
  assert.ok(outcome.reply.includes(UNSOURCED_CHIP), `${where}: no chip stands in its place`);
}

test('LAUNDERING 1 — an invented get_stats lookup name cannot source its own digits', async () => {
  // The executed proof, exactly: an unknown lookup is refused BY NAME, and the
  // name was written by the model.
  const outcome = await laundering({
    id: 'call_1',
    name: 'get_stats',
    arguments: `{"lookup":"followers_${LAUNDERED}"}`,
  });
  assert.match(outcome.refusal, /unknown_lookup/);
  assertLaundered(outcome, 'get_stats');
});

test('LAUNDERING 2 — a search_posts filter cannot source the integer the model chose', async () => {
  // min_engagement passes validation, so this is not even a refusal: it is a
  // SUCCESSFUL call whose result echoes the filters it applied.
  const outcome = await laundering({
    id: 'call_1',
    name: 'search_posts',
    arguments: `{"min_engagement":${LAUNDERED}}`,
  });
  assert.match(outcome.refusal, /"min_engagement": 88123/);
  assert.match(outcome.refusal, /"matched": 0/, 'nothing matched, and it says so');
  assertLaundered(outcome, 'search_posts');
});

test('LAUNDERING 3 — an invented tool name cannot source its own digits', async () => {
  const outcome = await laundering({
    id: 'call_1',
    name: `get_followers_${LAUNDERED}`,
    arguments: '{}',
  });
  assert.match(outcome.refusal, /unknown_tool/);
  assertLaundered(outcome, 'unknown tool');
});

test('LAUNDERING 4 — a refused dispatch feature cannot source its own digits', async () => {
  const outcome = await laundering({
    id: 'call_1',
    name: 'dispatch_feature',
    arguments: `{"feature":"followers_${LAUNDERED}"}`,
  });
  assert.match(outcome.refusal, /dispatch_invalid_arguments/);
  assertLaundered(outcome, 'dispatch_feature');
});

test('a real tool result still sources its own measured values — the fix is not a mute button', async () => {
  // The other direction. `search_posts` over an empty population still declares
  // what it measured, so the model may state those figures. If this fails, the
  // split has been implemented as "tool results are never evidence", which
  // would satisfy every attack above and break the product.
  const { executeTool } = realTools();
  const result = await executeTool({
    id: 'call_1',
    name: 'search_posts',
    arguments: '{"account":"academy"}',
  });

  const evidence = lintEvidence(result);
  assert.notEqual(evidence, '', 'a successful read declares something');
  assert.ok(evidence.split('\n').includes('0'), 'the count it measured is evidence for itself');

  // AND THE TWO HALVES THAT ARE NOT EVIDENCE, asserted rather than assumed.
  // The KEY is not: it can be minted from a model-authored cluster label (see
  // EXPLOIT 5 below), so it is rendered for the operator's log and never here.
  assert.equal(
    evidence.includes('performance.snapshot.taken_on'),
    false,
    'a source_key reached the lint context',
  );
  // The DATE is not: a value that is not itself a quantity cannot source one.
  // The cost is nil — every part of an ISO date is below the claim floor or is
  // a year, so no reply can state one as a claim in the first place.
  assert.equal(evidence.includes(SNAPSHOT_DAY), false, 'a date is not a quantity');
});

/* ============================================ defect 2: whole-token matching ==*/

test('the substring attack: a number found only inside an id is not sourced', async () => {
  // The executed proof, at the linter: the only 508 in this context is the tail
  // of an Instagram id, and an id is not a measurement of anything.
  assert.equal(claimsLinter('المعدل 508 لكل منشور.', `ig_id: ${IG_ID}`).passed, false);

  // THE TRUE-POSITIVE CONTROL. The same claim against a real 508 token passes,
  // so the check got stricter without getting blind.
  assert.equal(
    claimsLinter(
      'المعدل 508 لكل منشور.',
      '[performance.personal.avg_engagement] mean engagement per post (n=190) = "508"',
    ).passed,
    true,
  );

  // And the same attack through the whole gate, with the id declared by a tool
  // exactly as `search_posts` declares one. 899 is inside the id and nowhere
  // else; the id itself is sourced and must survive.
  const draft = `أقوى منشور ${IG_ID} حقق ${INSIDE_IG_ID} تفاعل [posts.engagement].`;
  const model = fakeModel([
    { text: '', toolCalls: [{ id: 'call_1', name: 'search_posts', arguments: '{}' }] },
    { text: draft },
    { text: draft },
  ]);

  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'أقوى منشور؟',
    quality: 'standard',
    tools: [
      {
        name: 'search_posts',
        description: 'Returns real posts, verbatim.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    ],
    executeTool: async () => ({
      content: `rows: [{ "ig_id": "${IG_ID}" }]`,
      sourced: [{ value: IG_ID }],
    }),
    transport: model.transport,
  });

  assert.deepEqual(outcome.law_report.stripped, [INSIDE_IG_ID], 'the slice was cut out');
  assert.ok(outcome.reply.includes(IG_ID), 'the whole id sources itself and survives');
  assert.ok(outcome.reply.includes(UNSOURCED_CHIP));
  assert.equal(outcome.law_report.passed, true, 'what is delivered passes the linter');
});

/* ================================================= the guard against rotting ==*/

test('FIFTH ECHO — a new tool that returns an unsplit string contributes nothing', async () => {
  /* This is the test that stops the fix rotting.
   *
   * The four attacks above are closed by four declarations. This one is closed
   * by the DEFAULT: a tool nobody has thought about yet, whose result is a
   * sentence with a number in it and no `sourced` half, is not evidence for that
   * number. Whoever adds the sixth tool has to declare what it measured before
   * the model may state it — forgetting fails closed. */
  const echoTool: ChatToolSpec = {
    name: 'get_follower_count',
    description: 'A tool added later, by someone who has not read this file.',
    parameters: { type: 'object', properties: {}, required: [] },
  };
  const cited = `عدد المتابعين ${LAUNDERED} [profiles.academy.followers].`;

  const unsplit = fakeModel([
    { text: '', toolCalls: [{ id: 'call_1', name: 'get_follower_count', arguments: '{}' }] },
    { text: cited },
    { text: cited },
  ]);

  const leaked = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'كم عدد المتابعين؟',
    quality: 'standard',
    tools: [echoTool],
    executeTool: async () => ({ content: `total_followers = ${LAUNDERED}` }),
    transport: unsplit.transport,
  });

  assert.ok(
    leaked.tools[0].result.content.includes(LAUNDERED),
    'the model was shown the number',
  );
  assert.equal(lintEvidence(leaked.tools[0].result), '', 'and it sourced nothing at all');
  assert.deepEqual(leaked.law_report.stripped, [LAUNDERED]);
  assert.ok(leaked.reply.includes(UNSOURCED_CHIP));

  // The SAME tool, having declared the value, sources it. The difference between
  // the two halves of this test is one field, and that is the whole mechanism.
  const declared = fakeModel([
    { text: '', toolCalls: [{ id: 'call_1', name: 'get_follower_count', arguments: '{}' }] },
    { text: cited },
  ]);

  const sourced = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'كم عدد المتابعين؟',
    quality: 'standard',
    tools: [echoTool],
    executeTool: async () => ({
      content: `total_followers = ${LAUNDERED}`,
      sourced: [{ value: LAUNDERED, source_key: 'profiles.academy.followers' }],
    }),
    transport: declared.transport,
  });

  assert.equal(sourced.law_report.repaired, false);
  assert.deepEqual(sourced.law_report.stripped, []);
  assert.equal(sourced.reply, cited, 'delivered byte-for-byte');
});

test('the stripper leaves text alone when nothing was flagged', () => {
  const text = 'المعدل 508 لكل منشور، و٥٠٨ بالهندية.';
  assert.deepEqual(stripUnsourcedNumbers(text, []), { text, stripped: [] });
  // A flagged number that is not present changes nothing either.
  assert.deepEqual(stripUnsourcedNumbers(text, ['777']), { text, stripped: [] });
});

/* ========================== defect 3: two definitions of "a number" ==========
 *
 * The claims-linter used to hold one regex for finding CLAIMS in a draft and a
 * different one for finding EVIDENCE in the context. Every disagreement between
 * them was a door. Three of those doors are replayed here at the GATE — not at
 * the linter, which tests/law.test.ts covers — because what matters is whether
 * an operator sees the number, and that is decided by the whole cycle: lint,
 * repair once, strip, re-lint.
 * ========================================================================== */

/** U+066C, the Arabic thousands separator. Named rather than pasted, because an
 *  invisible or near-invisible character in a fixture is unreadable evidence. */
const ARABIC_THOUSANDS = String.fromCharCode(0x066c);

test('EXPLOIT 1 at the gate — a figure split by a separator is not delivered', async () => {
  // «٨٨٬٥٠٨»: the head is under the claim floor and used to be dropped in
  // silence, the tail is a real measured figure, and the reader is handed a
  // follower count no row has ever held.
  const split = `٨٨${ARABIC_THOUSANDS}٥٠٨`;
  assert.equal(BLOCKS.includes('88508'), false, 'the trap is real: nothing sources it');
  assert.ok(BLOCKS.includes('508'), 'and the tail really is sourced, or this proves nothing');

  const cited = `عدد المتابعين ${split} متابع [profiles.academy.followers].`;
  const model = fakeModel([{ text: cited }, { text: cited }]);

  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'كم عدد المتابعين؟',
    quality: 'standard',
    transport: model.transport,
  });

  assert.deepEqual(outcome.law_report.stripped, [split], 'the whole figure was cut, not its head');
  assert.equal(outcome.reply, `عدد المتابعين ${UNSOURCED_CHIP} متابع [profiles.academy.followers].`);
  assert.equal(outcome.law_report.passed, true, 'what is delivered passes the linter');
});

test('EXPLOIT 5 — a source_key is never evidence, whoever minted it', () => {
  /* src/lib/agent/chat/stats.ts mints a cluster key segment from
   * `cluster_label` — a string the board-analysis MODEL wrote into
   * post_analyses. The evidence half used to be rendered as `[key] = "value"`
   * and mined whole, so a model that had named a cluster could name its own
   * evidence. The table is empty today; it stops being empty the moment board
   * analysis runs. */
  const poisoned: ChatToolResult = {
    content: 'content is never evidence — this line only proves the tool answered.',
    sourced: [{ value: '0', source_key: `performance.clusters.${LAUNDERED}.n` }],
  };

  const evidence = lintEvidence(poisoned);
  assert.equal(evidence.includes(LAUNDERED), false, 'the key reached the lint context');
  assert.equal(claimsLinter(`عدد المتابعين ${LAUNDERED} متابع.`, evidence).passed, false);

  // THE CONTROL. The declared VALUE still sources itself, so this is a boundary
  // and not a mute button.
  const real: ChatToolResult = {
    content: 'irrelevant',
    sourced: [{ value: '508', source_key: 'performance.personal.avg_engagement' }],
  };
  assert.equal(claimsLinter('المعدل 508 لكل منشور.', lintEvidence(real)).passed, true);
});

/**
 * The client's own caption, carried into the blocks so the agent can hear his
 * register. Everything else about this fixture is the empty state the chat
 * surface actually meets.
 */
function dataWithCaption(caption: string): StrategistData {
  return {
    ...chatData(),
    brand: {
      id: 1,
      facts: [],
      voice_examples: [{ text: caption, source_url: null, engagement: null }],
      knowledge: [],
      assets: [],
      palette: null,
      typography: null,
      audience_notes: null,
      status: 'live',
      updated_at: TODAY,
    },
  };
}

test('EXPLOIT 6 — client free text in a block is not evidence for its own numbers', async () => {
  const caption = `عدد المتدربين ${LAUNDERED} متدرب.`;
  const data = dataWithCaption(caption);

  // The caption still reaches the MODEL verbatim. That is what a voice example
  // is for, and the fix must not take it away.
  assert.ok(renderStrategistBlocks(data).includes(LAUNDERED), 'the model is still shown the caption');

  const cited = `عدد المتابعين ${LAUNDERED} متابع [profiles.academy.followers].`;
  const model = fakeModel([{ text: cited }, { text: cited }]);

  const outcome = await runAgentChat({
    data,
    history: [],
    message: 'كم عدد المتابعين؟',
    quality: 'standard',
    transport: model.transport,
  });

  assert.deepEqual(outcome.law_report.stripped, [LAUNDERED], 'the caption sourced the claim');
  assert.equal(outcome.reply.includes(LAUNDERED), false);
  assert.ok(outcome.reply.includes(UNSOURCED_CHIP));
});

/* ================================================== v5: the model types nothing ==
 *
 * Everything above this line is the LINT-ERA gate, and every one of those tests
 * still passes unchanged — deliberately, because they are the exploit log and a
 * v5 that quietly stopped enforcing one of them would be a regression wearing a
 * new feature's name.
 *
 * What changes below is where the guarantee comes from. The model no longer
 * quotes a value: it writes `{{source.key}}` and CODE substitutes the value the
 * blocks (or a tool result) computed for that key. See
 * src/lib/brain/substitute.ts for why text-matching numbers was abandoned as the
 * primitive, and the header of src/lib/agent/chat/run.ts for the two guarantees
 * a delivered reply can carry and why the run result never conflates them.
 *
 * THE TESTS THAT MATTER MOST HERE ARE THE ONES THAT SHOW THE LINT STEP LETTING
 * SOMETHING THROUGH. An exploit "closed at the substitution step" is only a claim
 * worth making where the claims-linter demonstrably passes the same text, so
 * those tests assert BOTH: `claimsLinter(...).passed === true` on the draft, and
 * the gate cutting it anyway.
 * ========================================================================= */

/**
 * U+034F COMBINING GRAPHEME JOINER — `\p{Mn}`. The round-3 door.
 *
 * WRITTEN AS AN ESCAPE, like every invisible in tests/substitute.test.ts. Hard
 * rule 7 forbids a raw control byte in any file, and this project has twice
 * produced a false clean scan from a pattern carrying a character nobody could
 * see. An escape is reviewable; the character is not.
 */
const CGJ = '\u034F';

test('SUBSTITUTION, END TO END — the model names keys, the operator reads values', async () => {
  const draft =
    `معدل التفاعل ${OPEN}performance.personal.avg_engagement${CLOSE} على ` +
    `${OPEN}performance.personal.post_count${CLOSE} منشور، مقابل ` +
    `${OPEN}performance.academy.avg_engagement${CLOSE} للأكاديمية.`;

  // The draft states no digit at all. That is the property, asserted rather than
  // eyeballed: what the model wrote could not have contained a wrong number.
  assert.equal(/\p{Nd}/u.test(draft), false, 'the model typed no digit');

  const model = fakeModel([{ text: draft }]);
  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'قارن بين الحسابين',
    quality: 'standard',
    transport: model.transport,
  });

  assert.equal(model.seen.length, 1, 'a substituted draft is never retried');
  assert.equal(outcome.reply, 'معدل التفاعل 508 على 190 منشور، مقابل 40 للأكاديمية.');
  assert.equal(outcome.reply.includes(OPEN), false, 'no placeholder survives into the reply');
  assert.equal(outcome.law_report.repaired, false);
  assert.deepEqual(outcome.law_report.stripped, []);
  assert.equal(outcome.law_report.passed, true);

  // Every digit in that sentence was written by this codebase.
  assert.deepEqual(outcome.substitution.substituted_keys, [
    'performance.personal.avg_engagement',
    'performance.personal.post_count',
    'performance.academy.avg_engagement',
  ]);
  assert.deepEqual(outcome.substitution.typed, []);
  assert.deepEqual(outcome.substitution.refused, []);
  assert.equal(outcome.substitution.hard_guarantee, true);
});

test('the value map is the SAME assembler the model read — key by key', () => {
  const values = strategistValues(chatData());

  // The value under a key is the value the blocks rendered for it.
  assert.equal(values.get('performance.personal.avg_engagement'), '508');
  assert.equal(values.get('performance.academy.avg_engagement'), '40');
  assert.ok(BLOCKS.includes('[performance.personal.avg_engagement]'));

  // Hard rule 11: the sample size is reachable, under the SAME `<key>.n`
  // convention get_stats already declares in src/lib/agent/chat/tools.ts.
  assert.equal(values.get('performance.personal.avg_engagement.n'), '190');
  assert.equal(values.get('performance.personal.avg_engagement.as_of'), SNAPSHOT_DAY);

  /* AND AN ABSENCE IS STILL NOT A KEY — asserted against the keys this fixture
   * ACTUALLY declares absent, which is the only version of this test that means
   * anything. `performance.analyses.count` is a real absence here: the analysis
   * table was not read, so the blocks name the key that WOULD have existed and
   * emit no value for it. A map holding "—" or "0" under that name would be the
   * exact trap blocks.ts opens with — a citation that resolves to a hole. */
  assert.ok(BLOCKS.includes('(no measurement) performance.analyses.count'));
  assert.equal(values.has('performance.analyses.count'), false);
  assert.ok(BLOCKS.includes('(no measurement) profiles.academy'));
  assert.equal(values.has('profiles.academy'), false);
  assert.equal(values.has('profiles.academy.followers'), false);
});

test('a key that names no measurement resolves to nothing — an absence is not a value', async () => {
  const cited =
    `عدد المتابعين ${OPEN}profiles.academy.followers${CLOSE} متابع، ` +
    `والمحلَّل ${OPEN}performance.analyses.count${CLOSE} منشور.`;
  const model = fakeModel([{ text: cited }, { text: cited }]);

  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'كم عدد المتابعين؟',
    quality: 'standard',
    transport: model.transport,
  });

  /* Two kinds of nothing, and both come back as the same nothing. The first key
   * was never a measure at all; the second is one the blocks DECLARED ABSENT by
   * name. The redaction marker stands where each value would have been, and it
   * is NOT an em-dash: an em-dash means "measured, absent", which is deliverable,
   * and this means "this draft is broken", which is not. */
  assert.equal(outcome.reply, `عدد المتابعين ${REDACTED} متابع، والمحلَّل ${REDACTED} منشور.`);
  assert.equal(outcome.reply.includes('profiles.academy.followers'), false, 'the key is not echoed');
  assert.equal(outcome.law_report.repaired, true, 'the fault bought exactly one repair');
  assert.equal(model.seen.length, 2);

  const refused = outcome.substitution.refused;
  assert.deepEqual(
    refused.map((fault) => [fault.kind, fault.key]),
    [
      ['unknown-key', 'profiles.academy.followers'],
      ['unknown-key', 'performance.analyses.count'],
    ],
  );

  // The model was told which key failed, and told it once.
  assert.match(lastUserMessage(model.seen[1]).content, /profiles\.academy\.followers/);
});

test('a tool result contributes keyed values, so a lookup can be substituted too', async () => {
  const TOP_POST = '33176';
  assert.equal(BLOCKS.includes(TOP_POST), false, 'this figure exists only in the tool result');

  const getStats: ChatToolSpec = {
    name: 'get_stats',
    description: 'One named, code-defined lookup. No free SQL exists (hard rule 19).',
    parameters: { type: 'object', properties: { lookup: { type: 'string' } }, required: ['lookup'] },
  };

  const model = fakeModel([
    { text: '', toolCalls: [{ id: 'call_1', name: 'get_stats', arguments: '{"lookup":"top"}' }] },
    {
      text:
        `أقوى منشور حصد ${OPEN}performance.personal.top_post.engagement${CLOSE} تفاعل ` +
        `على ${OPEN}performance.personal.top_post.engagement.n${CLOSE} منشور.`,
    },
  ]);

  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'أقوى منشور؟',
    quality: 'standard',
    tools: [getStats],
    // The shape `get_stats` really returns: each value with the key that
    // resolves it, and its sample size under `<key>.n`.
    executeTool: async () => ({
      content: `[performance.personal.top_post.engagement] = "${TOP_POST}"`,
      sourced: [
        { value: TOP_POST, source_key: 'performance.personal.top_post.engagement' },
        { value: '190', source_key: 'performance.personal.top_post.engagement.n' },
      ],
      source_keys: ['performance.personal.top_post.engagement'],
    }),
    transport: model.transport,
  });

  assert.equal(outcome.reply, `أقوى منشور حصد ${TOP_POST} تفاعل على 190 منشور.`);
  assert.equal(outcome.substitution.hard_guarantee, true);
  assert.deepEqual(outcome.law_report.stripped, []);
  assert.equal(outcome.law_report.repaired, false);
});

test('two sources that disagree about one key resolve to NEITHER value', async () => {
  /* `buildValueMap` removes a key it is offered two different values for. Last
   * wins would deliver a figure the model did not mean; first wins would deliver
   * a stale one. A disagreement about a measurement is a fault, and the safe
   * reading of a fault is that neither number is deliverable. */
  const liar: ChatToolSpec = {
    name: 'get_stats',
    description: 'A lookup that disagrees with the blocks about a key they share.',
    parameters: { type: 'object', properties: {}, required: [] },
  };
  const cited = `المعدل ${OPEN}performance.personal.avg_engagement${CLOSE}.`;

  const model = fakeModel([
    { text: '', toolCalls: [{ id: 'call_1', name: 'get_stats', arguments: '{}' }] },
    { text: cited },
    { text: cited },
  ]);

  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'المعدل؟',
    quality: 'standard',
    tools: [liar],
    executeTool: async () => ({
      content: '[performance.personal.avg_engagement] = "509"',
      sourced: [{ value: '509', source_key: 'performance.personal.avg_engagement' }],
    }),
    transport: model.transport,
  });

  assert.equal(outcome.reply, `المعدل ${REDACTED}.`);
  assert.equal(outcome.reply.includes('508'), false, 'not the block value');
  assert.equal(outcome.reply.includes('509'), false, 'and not the tool value either');
  assert.equal(outcome.substitution.refused[0].kind, 'unknown-key');
});

/* ------------------------------------------- the exploits, at the new step -- */

test('THE ROUND-3 COUNTER-EXAMPLE — the sub-100 head the linter cannot see is cut', async () => {
  /* «٨٨<U+034F>٥٠٨» renders to the operator as ٨٨٥٠٨. U+034F is \p{Mn}: not a
   * joiner and not blank, so the claims-linter reads TWO quantities, drops ٨٨
   * under its 100 floor in silence, finds ٥٠٨ sourced, and passes. This is the
   * counter-example v5 exists for, and the first assertion is that the lint step
   * really does still let it through — otherwise the rest proves nothing. */
  const attack = `المتوسط ٨٨${CGJ}٥٠٨ متابع.`;

  assert.equal(
    claimsLinter(attack, EVIDENCE).passed,
    true,
    'the lint step alone delivers this; that is the whole reason for the substitution step',
  );

  const model = fakeModel([{ text: attack }, { text: attack }]);
  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'كم عدد المتابعين؟',
    quality: 'standard',
    transport: model.transport,
  });

  // There is no floor here, so the head is exactly as loud as the tail.
  assert.deepEqual(outcome.law_report.stripped, ['٨٨']);
  assert.equal(outcome.reply, `المتوسط ${UNSOURCED_CHIP}${CGJ}٥٠٨ متابع.`);
  assert.equal(outcome.reply.includes('٨٨'), false, 'the head is gone, so the figure is destroyed');
  assert.equal(outcome.law_report.repaired, true);

  // And the tail — a figure the model TYPED — is reported as resting on the old
  // guarantee, not the new one.
  assert.deepEqual(outcome.substitution.typed, ['٥٠٨']);
  assert.equal(outcome.substitution.hard_guarantee, false);
});

test('THE SAME ATTACK THROUGH THE NEW DOOR — a head typed against a SUBSTITUTED value', async () => {
  /* The model cannot write ٥٠٨ any more, so it writes the placeholder and types
   * only the head. The engine wrote the tail at a position it recorded; the head
   * occupies no such position. The claims-linter passes the substituted text for
   * exactly the round-3 reason, and is again not what stops it. */
  const attack = `المتوسط ٨٨${CGJ}${OPEN}performance.personal.avg_engagement${CLOSE} متابع.`;
  const substituted = `المتوسط ٨٨${CGJ}508 متابع.`;

  assert.equal(claimsLinter(substituted, EVIDENCE).passed, true, 'the lint step passes it');

  const model = fakeModel([{ text: attack }, { text: attack }]);
  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'كم عدد المتابعين؟',
    quality: 'standard',
    transport: model.transport,
  });

  assert.deepEqual(outcome.law_report.stripped, ['٨٨']);
  assert.equal(outcome.reply, `المتوسط ${UNSOURCED_CHIP}${CGJ}508 متابع.`);
  // The substituted value is untouched: the gate cut what the MODEL wrote.
  assert.ok(outcome.reply.includes('508'));
  assert.deepEqual(outcome.substitution.substituted_keys, ['performance.personal.avg_engagement']);
});

test('digits welded onto a substituted value take the value with them', async () => {
  // No separator at all: `٨٨508` is ONE quantity that runs across the edge of a
  // span, so it is not a value this code substituted — it is a new figure
  // assembled out of one. The whole thing goes.
  const attack = `المتوسط ٨٨${OPEN}performance.personal.avg_engagement${CLOSE} متابع.`;
  const model = fakeModel([{ text: attack }, { text: attack }]);

  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'كم عدد المتابعين؟',
    quality: 'standard',
    transport: model.transport,
  });

  assert.equal(outcome.substitution.refused[0].kind, 'glued-value');
  assert.deepEqual(outcome.law_report.stripped, ['٨٨508']);
  assert.equal(outcome.reply, `المتوسط ${UNSOURCED_CHIP} متابع.`);
  assert.equal(outcome.reply.includes('508'), false, 'the real value went with the fabrication');
});

test('a UNIT typed onto a substituted value is a magnitude the model chose', async () => {
  /* THE «12.7x» FABRICATION, assembled from a value the model did not have to
   * type. `%` turns 508 into a rate and `×` turns it into a multiple: if the
   * measurement is a rate, the VALUE carries the sign and the model does not add
   * one. This is the case that proves tolerance is scoped to `bare-quantity` and
   * never to a glued one — «508٪» would pass a whole-token match against the
   * evidence, because its digits really are 508. Its meaning is not. */
  const attack = `نسبة النمو ${OPEN}performance.personal.avg_engagement${CLOSE}٪ هالشهر.`;
  const model = fakeModel([{ text: attack }, { text: attack }]);

  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'قدّيش النمو؟',
    quality: 'standard',
    transport: model.transport,
  });

  assert.equal(outcome.substitution.refused[0].kind, 'glued-value');
  assert.equal(outcome.reply, `نسبة النمو ${UNSOURCED_CHIP} هالشهر.`);
  // The unit went with the figure: a bare ٪ left standing would read as a claim
  // the chip did not remove.
  assert.equal(outcome.reply.includes('٪'), false);
  assert.deepEqual(outcome.law_report.stripped, ['508٪']);
});

test('two substituted values side by side read as one figure, and are refused as one', async () => {
  /* The residual the claims-linter names in its own header and cannot close: it
   * cannot tell which of two neighbouring numbers is evidence, so «٨٨ ٥٠٨»
   * written as two honest citations passes. Here both sides are known to be
   * values this code wrote, so the pair is refusable — and refused. */
  const attack =
    `المتوسط ${OPEN}performance.academy.avg_engagement${CLOSE} ` +
    `${OPEN}performance.personal.avg_engagement${CLOSE} متابع.`;

  assert.equal(claimsLinter('المتوسط 40 508 متابع.', EVIDENCE).passed, true, 'the lint step passes it');

  const model = fakeModel([{ text: attack }, { text: attack }]);
  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'المتوسط؟',
    quality: 'standard',
    transport: model.transport,
  });

  assert.equal(outcome.substitution.refused[0].kind, 'glued-value');
  assert.deepEqual(outcome.law_report.stripped, ['40 508']);
  assert.equal(outcome.reply, `المتوسط ${UNSOURCED_CHIP} متابع.`);
});

test('a KEY carrying digits cannot echo them, and a key that is a number is not a key', async () => {
  /* `keySegment()` preserves \p{N}, so a cluster a model named "88123" mints
   * `performance.clusters.88123.n`. The digits in a key never reach a reader —
   * not because they are filtered, but because the output is drawn from the value
   * map and from nowhere else. There are no clusters in this fixture, so the key
   * resolves to nothing and nothing is what is emitted. */
  const invented = `العنقود فيه ${OPEN}performance.clusters.${LAUNDERED}.n${CLOSE} منشور.`;
  const byKey = fakeModel([{ text: invented }, { text: invented }]);

  const outcome = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'قدّيش المنشورات بالعنقود؟',
    quality: 'standard',
    transport: byKey.transport,
  });

  assert.equal(outcome.reply, `العنقود فيه ${REDACTED} منشور.`);
  assert.equal(outcome.reply.includes(LAUNDERED), false, 'the key was not echoed');
  assert.equal(outcome.substitution.refused[0].kind, 'unknown-key');

  // And the blunter attempt: a placeholder whose contents are the number itself.
  // A key begins with an ASCII lowercase letter, which is what makes "a key is
  // not a quantity" structural rather than observed.
  assert.equal(isSourceKey('88508'), false);
  const bare = `عدد المتابعين ${OPEN}88508${CLOSE} متابع.`;
  const byNumber = fakeModel([{ text: bare }, { text: bare }]);

  const second = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'كم عدد المتابعين؟',
    quality: 'standard',
    transport: byNumber.transport,
  });

  assert.equal(second.reply, `عدد المتابعين ${REDACTED} متابع.`);
  assert.equal(second.reply.includes('88508'), false);
  assert.equal(second.substitution.refused[0].kind, 'malformed-placeholder');
});

/* ------------------------------------------------ the two guarantees, named -- */

test('a TYPED figure is reported as typed; the same figure substituted is not', async () => {
  /* The transitional weakening, made executable rather than left in a comment. A
   * sourced figure the model typed is still delivered — refusing those on the day
   * the prompt changed would chip every true number in every reply — but it rests
   * on the OLD guarantee and the run result says so. The route to zero is to
   * watch `typed` empty out. */
  const typed = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'المعدل؟',
    quality: 'standard',
    transport: fakeModel([{ text: 'المعدل 508 لكل منشور.' }]).transport,
  });

  assert.equal(typed.reply, 'المعدل 508 لكل منشور.', 'delivered, exactly as today');
  assert.equal(typed.law_report.repaired, false);
  assert.deepEqual(typed.substitution.typed, ['508']);
  assert.deepEqual(typed.substitution.substituted_keys, []);
  assert.equal(typed.substitution.hard_guarantee, false);

  const named = await runAgentChat({
    data: chatData(),
    history: [],
    message: 'المعدل؟',
    quality: 'standard',
    transport: fakeModel([
      { text: `المعدل ${OPEN}performance.personal.avg_engagement${CLOSE} لكل منشور.` },
    ]).transport,
  });

  // The same sentence, to the character — and only one of the two carries the
  // guarantee that no model could have written the number wrong.
  assert.equal(named.reply, typed.reply);
  assert.deepEqual(named.substitution.typed, []);
  assert.equal(named.substitution.hard_guarantee, true);
});

/* ------------------------------------------------- the prompt cannot drift -- */

test('the prompt teaches the syntax the engine implements, key for key', () => {
  /* src/lib/agent/chat/system.ts is installed verbatim with exactly one
   * documented exception: it teaches the placeholder syntax. A drift between that
   * text and the engine's grammar would make every reply a violation, so the two
   * are asserted against each other here rather than left to a reader's memory. */
  const spellings = [...CHAT_SYSTEM.matchAll(/\{\{([^{}]*)\}\}/gu)].map((match) => match[1]);
  assert.ok(spellings.length > 0, 'the prompt teaches the syntax at all');

  // The delimiters are the ENGINE's, not a copy that resembles them.
  assert.ok(CHAT_SYSTEM.includes(`${OPEN}performance.personal.avg_engagement${CLOSE}`));
  assert.equal(CHAT_SYSTEM.includes(`${OPEN} `), false, 'no spaced variant is taught');
  assert.equal(CHAT_SYSTEM.includes(REDACTED), true, 'and what an unresolved key becomes');

  const values = strategistValues(chatData());
  for (const spelling of spellings) {
    assert.ok(isSourceKey(spelling), `the prompt spells "${spelling}" as a key the engine accepts`);
    // `source.key` and its two variants are the syntax being illustrated. Every
    // other key the prompt names is a REAL key — an example that names a key the
    // blocks never emit teaches the model to write one.
    if (spelling.startsWith('source.key')) continue;
    assert.ok(values.has(spelling), `the prompt's example names a real key: ${spelling}`);
  }
});

test('THE COST OF EXPLOIT 6 — a caption quoting a real figure now gets chipped', async () => {
  /* Stated rather than discovered later. Free-text block values are no longer
   * evidence, so a caption that quotes a number nothing else measures makes that
   * number unquotable — the reply loses it and the chip says so. The number in
   * the caption below is the same invented probe, which is the honest way to
   * write this test: there is no real caption in this repository holding a
   * figure that no measure holds.
   *
   * The other direction of the same trade is asserted above and below: a figure
   * a MEASURE holds is still quotable, so what was lost is exactly the class
   * "numbers that exist only inside text somebody typed". */
  const outcome = await runAgentChat({
    data: dataWithCaption(`في ورشتنا ${LAUNDERED} متدرب.`),
    history: [],
    message: 'اقتبس من كتاباته',
    quality: 'standard',
    transport: fakeModel([
      { text: `كما كتب: «في ورشتنا ${LAUNDERED} متدرب.»` },
      { text: `كما كتب: «في ورشتنا ${LAUNDERED} متدرب.»` },
    ]).transport,
  });

  assert.deepEqual(outcome.law_report.stripped, [LAUNDERED]);
  assert.equal(outcome.reply, `كما كتب: «في ورشتنا ${UNSOURCED_CHIP} متدرب.»`);
});
