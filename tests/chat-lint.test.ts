import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ACTION_BUDGET,
  DEFAULT_THRESHOLDS,
  renderStrategistBlocks,
  type StrategistData,
} from '../src/lib/agent/strategist/blocks.ts';
import { claimsLinter } from '../src/lib/brain/law/claims-linter.ts';
import type {
  ChatToolCallRecord,
  ChatToolSpec,
  ChatTransport,
  ChatTransportRequest,
  ChatWireMessage,
} from '../src/lib/agent/chat/run.ts';

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
 * WHAT IS NOT PROVEN HERE:
 *   whether a real model repairs a draft when asked to. That is a claim about a
 *   model and no key is usable in this repository. What is proven is that a
 *   model which does NOT repair cannot get an unsourced number onto a screen.
 * ========================================================================= */

/* ---------------------------------------------------------------- loader --
 * Same approach as tests/needs-human.test.ts. `@/*` is a tsconfig alias node
 * does not know, and `@/lib/auth` reaches into next/server. These hooks teach
 * this process the alias rule, resolve extensionless relative imports to their
 * .ts file, and swap exactly one module for a stub.
 * ------------------------------------------------------------------------ */

const SRC = new URL('../src/', import.meta.url).href;

const AUTH_STUB = 'stub:lib-auth';

const STUBS: Record<string, string> = {
  '@/lib/auth': AUTH_STUB,
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
  runAgentChat,
  stripUnsourcedNumbers,
  windowHistory,
} = await import('../src/lib/agent/chat/run.ts');

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

test('the stripper leaves text alone when nothing was flagged', () => {
  const text = 'المعدل 508 لكل منشور، و٥٠٨ بالهندية.';
  assert.deepEqual(stripUnsourcedNumbers(text, []), { text, stripped: [] });
  // A flagged number that is not present changes nothing either.
  assert.deepEqual(stripUnsourcedNumbers(text, ['777']), { text, stripped: [] });
});
