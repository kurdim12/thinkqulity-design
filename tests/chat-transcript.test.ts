import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFigureIndex,
  EXTERNAL_FACTS_KIND,
  hostOf,
  markFigures,
  parseToolPayload,
  readExternalClaims,
  type DeclaredValue,
  type FigureSegment,
} from '../src/lib/chat/transcript.ts';

/**
 * ===========================================================================
 * WHAT A RECEIPT ON A NUMBER IS ALLOWED TO MEAN
 * ===========================================================================
 * The screen puts a tap-to-reveal source key under figures in delivered prose.
 * That mark is a CLAIM ABOUT PROVENANCE shown to an operator, so the failure
 * that matters is not "a true figure went unmarked" — it is "a figure that was
 * not the declared value got a receipt saying it was". Every attack below is
 * that direction, and each one is a spelling of an exploit this project has
 * already been burned by.
 *
 * EVERY INVISIBLE CHARACTER IS WRITTEN AS AN ESCAPE. Hard rule 7 forbids a raw
 * control byte in any file, and a NUL planted in a control has twice produced a
 * false clean scan here. The last test in this file is the CONTROL: it carries
 * the planted positives and no invisible byte, and it asserts that the marking
 * really does find them — so a clean run above cannot be an artefact of a
 * matcher that finds nothing at all.
 */

/** The invisible characters the earlier exploits were spelled with. */
const CGJ = '\u034F'; // COMBINING GRAPHEME JOINER — \p{Mn}. The round-3 door.
const ZWSP = '\u200B'; // ZERO WIDTH SPACE — \p{Cf}.

const AVG: DeclaredValue = {
  source_key: 'performance.personal.avg_engagement',
  value: '508',
  label: 'Average engagement, personal',
  n: 190,
  as_of: '2026-08-14',
};

const SAMPLE: DeclaredValue = {
  source_key: 'performance.personal.avg_engagement.n',
  value: '190',
  label: 'Posts measured',
  n: null,
  as_of: null,
};

const ACADEMY: DeclaredValue = {
  source_key: 'performance.academy.avg_engagement',
  value: '40',
  label: 'Average engagement, academy',
  n: 130,
  as_of: '2026-08-14',
};

function declared(...values: DeclaredValue[]) {
  return buildFigureIndex(values);
}

/** Every segment's text, concatenated. Must always reproduce the input. */
function rebuild(segments: readonly FigureSegment[]): string {
  return segments.map((segment) => segment.text).join('');
}

function keysOf(segments: readonly FigureSegment[]): string[] {
  return segments.flatMap((segment) =>
    segment.kind === 'figure' ? segment.declared.map((entry) => entry.source_key) : [],
  );
}

/* ======================================================== the attacks ===== */

test('the round-3 counter-example gets no receipt: a sub-100 head welded to a real value', () => {
  // «٨٨<CGJ>٥٠٨» renders to the operator as ٨٨٥٠٨. The mark is \p{Mn}, so the
  // digits split into two tokens and the claim floor used to drop the head.
  const text = `المتوسط ٨٨${CGJ}٥٠٨ تفاعل`;
  const marked = markFigures(text, declared(AVG));

  assert.equal(marked.marked, 0, 'nothing in a spliced figure may carry a source key');
  assert.equal(rebuild(marked.segments), text);
});

test('digits welded to a real value are one token and match nothing', () => {
  const marked = markFigures('المتوسط 88508 تفاعل', declared(AVG));
  assert.equal(marked.marked, 0);
  assert.equal(marked.unmarked, 1, 'the whole run is one numeral, and it is not 508');
});

test('a unit the model welded on is inside the comparison, so it breaks it', () => {
  // wholeQuantity('508٪') is '508', which IS evidence — the linter's own
  // whole-token match passes this. Verbatim equality does not.
  const marked = markFigures('نسبة 508٪ من الجمهور', declared(AVG));
  assert.equal(marked.marked, 0, 'a percentage is not the average it was minted from');
  assert.equal(marked.unmarked, 1);
});

test('a value respelled in another digit script was retyped, so it is not marked', () => {
  const marked = markFigures('المتوسط ٥٠٨ تفاعل', declared(AVG));
  assert.equal(marked.marked, 0);
});

test('a zero-width character inside the digits does not smuggle a receipt', () => {
  const marked = markFigures(`المتوسط 5${ZWSP}08 تفاعل`, declared(AVG));
  assert.equal(marked.marked, 0);
});

test('two values shoved together get no receipt, on either half', () => {
  const marked = markFigures('508 40', declared(AVG, ACADEMY));
  assert.equal(marked.marked, 0, 'the screen cannot tell a pair apart, so it certifies neither');
  assert.equal(marked.unmarked, 2);
});

test('a receipt never lands on one piece of a date', () => {
  // 190 is a real declared value; 2026-08-14 merely contains digits. An earlier
  // draft of this module marked the day-of-month of an unrelated date.
  const withDay: DeclaredValue = { ...SAMPLE, value: '14' };
  const marked = markFigures('اللقطة بتاريخ 2026-08-14', declared(withDay));
  assert.equal(marked.marked, 0);
  assert.equal(marked.unmarked, 3, 'three numerals, none of them a measurement');
});

test('a receipt never lands on one piece of a clock time', () => {
  const hour: DeclaredValue = { ...SAMPLE, value: '30' };
  const marked = markFigures('الساعة 14:30', declared(hour));
  assert.equal(marked.marked, 0);
});

test('a figure glued to a word is a fragment and is not marked', () => {
  const marked = markFigures('reel508 حقق تفاعلاً', declared(AVG));
  assert.equal(marked.marked, 0);
});

/* ==================================================== what may be marked == */

test('a value delivered verbatim carries its key', () => {
  const text = 'متوسط تفاعل الحساب الشخصي 508 على المنشور.';
  const marked = markFigures(text, declared(AVG));

  assert.equal(marked.marked, 1);
  assert.equal(marked.unmarked, 0);
  assert.deepEqual(keysOf(marked.segments), ['performance.personal.avg_engagement']);
  assert.equal(rebuild(marked.segments), text, 'the screen decorates the reply, never edits it');
});

test('a sample size declared under its own key is marked in its own right', () => {
  const text = 'متوسط 508 على 190 منشوراً.';
  const marked = markFigures(text, declared(AVG, SAMPLE));
  assert.equal(marked.marked, 2);
  assert.deepEqual(keysOf(marked.segments), [
    'performance.personal.avg_engagement',
    'performance.personal.avg_engagement.n',
  ]);
  assert.equal(rebuild(marked.segments), text);
});

test('one value declared by two keys shows both, because the screen cannot pick', () => {
  const twin: DeclaredValue = { ...ACADEMY, source_key: 'audience.academy.median_comments' };
  const marked = markFigures('الرقم 40 هنا.', declared(ACADEMY, twin));
  assert.equal(marked.marked, 1);
  assert.deepEqual(keysOf(marked.segments), [
    'performance.academy.avg_engagement',
    'audience.academy.median_comments',
  ]);
});

test('the same key declared twice is not two keys', () => {
  const marked = markFigures('الرقم 40 هنا.', declared(ACADEMY, { ...ACADEMY }));
  assert.deepEqual(keysOf(marked.segments), ['performance.academy.avg_engagement']);
});

test('a declared value that is not a quantity can never mint a receipt', () => {
  // A snapshot date and an ig_id are declared under keys too. Neither is a
  // measurement, and digits inside them must not become one.
  const snapshot: DeclaredValue = {
    source_key: 'performance.snapshot.taken_on',
    value: '2026-08-14',
    label: null,
    n: null,
    as_of: null,
  };
  assert.equal(buildFigureIndex([snapshot]).size, 0);
  assert.equal(markFigures('قياس بتاريخ 2026-08-14', declared(snapshot)).marked, 0);
});

test('an empty index marks nothing and still reproduces the text', () => {
  const text = 'لا قياس محفوظ — 508 و190 و40.';
  const marked = markFigures(text, declared());
  assert.equal(marked.marked, 0);
  assert.equal(rebuild(marked.segments), text);
});

test('a reply with no digits produces one prose segment', () => {
  const text = 'لا يوجد قياس لعدد المتابعين على هذا التثبيت.';
  const marked = markFigures(text, declared(AVG));
  assert.deepEqual(marked.segments, [{ kind: 'text', text }]);
  assert.equal(marked.unmarked, 0);
});

test('an unresolved placeholder and the redaction marker pass through untouched', () => {
  const text = 'المتوسط {{performance.personal.avg_engagement}} و[?] هنا.';
  const marked = markFigures(text, declared(AVG));
  assert.equal(marked.marked, 0, 'a placeholder is not a figure');
  assert.equal(rebuild(marked.segments), text);
});

test('the strip chip is a boundary, and the figure beside it still reads verbatim', () => {
  const text = 'المتوسط «رقم غير موثّق — حُذف» مقابل 508 تفاعل.';
  const marked = markFigures(text, declared(AVG));
  assert.equal(marked.marked, 1);
  assert.equal(rebuild(marked.segments), text, 'the chip survives the partition intact');
});

/* ================================================== external knowledge ==== */

const RETRIEVED = {
  claim: 'The academy lists 12,400 followers on its directory page.',
  source_url: 'https://example.org/directory/think-quality',
  page_title: 'Amman training directories',
  retrieved_at: '2026-08-16T09:00:00.000Z',
  topic: 'think quality academy',
  kind: 'statistic',
  confidence: 'unverified',
  about_client: true,
  client_account: 'academy',
  client_measure: 'followers',
};

test('an external claim wearing a source key is refused at the last mile', () => {
  const reading = readExternalClaims({ facts: [{ ...RETRIEVED, source_key: 'profiles.academy.followers' }] });
  assert.equal(reading.claims.length, 0, 'it must never render as a fact');
  assert.equal(reading.refused.length, 1);
  assert.equal(reading.refused[0].reason, 'source-key-present');
});

test('a null source key is still a field that should not exist', () => {
  const reading = readExternalClaims({ facts: [{ ...RETRIEVED, source_key: null }] });
  assert.equal(reading.refused[0]?.reason, 'source-key-present');
});

test('a claim without its URL or its retrieval instant is not external knowledge', () => {
  const { source_url: _dropped, ...noUrl } = RETRIEVED;
  const { retrieved_at: _also, ...noDate } = RETRIEVED;
  const reading = readExternalClaims({ facts: [noUrl, noDate] });
  assert.equal(reading.claims.length, 0);
  assert.deepEqual(
    reading.refused.map((entry) => entry.reason),
    ['unretrieved', 'unretrieved'],
  );
});

test('an http source is refused', () => {
  const reading = readExternalClaims({
    facts: [{ ...RETRIEVED, source_url: 'http://example.org/directory' }],
  });
  assert.equal(reading.refused[0]?.reason, 'insecure-source');
});

test('a well-formed claim is read whole, and keeps its client flag', () => {
  const reading = readExternalClaims({ facts: [RETRIEVED] });
  assert.equal(reading.refused.length, 0);
  assert.equal(reading.claims.length, 1);
  const fact = reading.claims[0];
  assert.equal(fact.claim, RETRIEVED.claim);
  assert.equal(fact.about_client, true);
  assert.equal(fact.client_measure, 'followers');
  assert.equal(hostOf(fact.source_url), 'example.org');
});

test('about_client is false only when the payload says so, never by omission of the flag', () => {
  const { about_client: _dropped, ...noFlag } = RETRIEVED;
  const reading = readExternalClaims({ facts: [noFlag] });
  assert.equal(reading.claims[0]?.about_client, false, 'absent reads as false, and the row says so');
});

test('a payload with no facts array reads as no external knowledge, not as a failure', () => {
  assert.deepEqual(readExternalClaims({ tool: 'get_external_facts' }), { claims: [], refused: [] });
});

test('hostOf never guesses', () => {
  assert.equal(hostOf('not a url'), null);
  assert.equal(hostOf('https://EXAMPLE.org/x'), 'example.org');
});

test('the payload marker is one string, shared with the tool that writes it', () => {
  assert.equal(EXTERNAL_FACTS_KIND, 'external_facts');
});

test('a tool row that is not JSON parses to null rather than throwing', () => {
  assert.equal(parseToolPayload('TOOL ERROR (get_stats): the read failed.'), null);
  assert.equal(parseToolPayload('[1,2,3]'), null, 'an array is not a payload');
  assert.deepEqual(parseToolPayload('{"tool":"get_stats"}'), { tool: 'get_stats' });
});

/* ============================================================= the control = */

test('CONTROL: the planted positives are actually found', () => {
  /**
   * Every assertion above is a negative — "this does not get a receipt" — and a
   * matcher that matched nothing at all would pass all of them. This is the one
   * test that would fail if the marking were dead. It carries three planted
   * positives, in Arabic prose, with NO invisible character anywhere in it.
   *
   * The guard below tests \p{Cf} and the two exploit characters BY NAME, and
   * deliberately NOT \p{Mn}: the tanween in this very sentence is \p{Mn} and it is
   * perfectly visible. That is round 3 in miniature — \p{Mn} never meant
   * invisible, which is why enumerating invisible characters was abandoned as
   * a guarantee in the first place.
   */
  const text = 'الشخصي 508 على 190 منشوراً، والأكاديمية 40. الفارق حقيقي.';
  assert.ok(!/\p{Cf}/u.test(text), 'no format character hides in the control');
  assert.ok(!text.includes(CGJ) && !text.includes(ZWSP), 'nor either exploit character');

  const marked = markFigures(text, declared(AVG, SAMPLE, ACADEMY));

  assert.equal(marked.marked, 3, 'three planted values, three receipts');
  assert.equal(marked.unmarked, 0);
  assert.deepEqual(keysOf(marked.segments), [
    'performance.personal.avg_engagement',
    'performance.personal.avg_engagement.n',
    'performance.academy.avg_engagement',
  ]);
  assert.equal(rebuild(marked.segments), text);
  assert.deepEqual(
    marked.segments.filter((segment) => segment.kind === 'figure').map((segment) => segment.text),
    ['508', '190', '40'],
  );
});
