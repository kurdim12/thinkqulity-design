import type {
  Account,
  BasisRef,
  ClientMeasure,
  ExternalConfidence,
  ExternalFactKind,
  ExternalFactRow,
} from '../types/db.ts';

/* The three unions are DECLARED ONCE, in db.ts beside the row they describe,
 * and re-exported here so a caller of this module never has to import two files
 * to build one fact. Re-export, never redeclare: a second copy of a union is a
 * second thing to forget to widen. */
export type { ClientMeasure, ExternalConfidence, ExternalFactKind };

/**
 * ===========================================================================
 * EXTERNAL KNOWLEDGE IS A DIFFERENT CLASS OF THING — hard rule 21
 * ===========================================================================
 *
 * A follower count read on a website is NOT a follower count. It is a claim
 * somebody published. The two are different kinds of object, and this file
 * exists to make that a fact about the type system rather than a note in a
 * prompt.
 *
 * WHAT A MEASURE IS. `Measure` in src/lib/agent/strategist/blocks.ts and
 * `BasisRef` in src/lib/types/db.ts: a `source_key` naming a value THIS
 * CODEBASE COMPUTED, and that value as text. A source_key is the only thing
 * src/lib/brain/substitute.ts will ever put into a deliverable.
 *
 * WHAT AN EXTERNAL FACT IS. A sentence somebody else wrote, stored verbatim,
 * carrying the URL it was written at and the moment it was read. It has no
 * source_key, it can never acquire one, and `ExternalFact` declares
 * `source_key?: never` so that an object carrying one is not assignable to it —
 * a compile error at the point of construction, not a convention.
 *
 * ---------------------------------------------------------------------------
 * THE GUARANTEE, AND WHY IT IS STRONGER THAN IT LOOKS
 * ---------------------------------------------------------------------------
 * Rule 20 says the model does not type quantities: a figure reaches the screen
 * only when code substitutes a placeholder that names a source key. Rule 21 says
 * an external fact never has a source key. Compose them:
 *
 *     AN EXTERNAL NUMBER CANNOT APPEAR IN A DELIVERABLE AT ALL.
 *
 * Not "is discouraged from". There is no placeholder that resolves to it,
 * because it is not in the value map; and a digit the model types instead is a
 * `bare-quantity` violation in substitute(). Neither rule makes that guarantee
 * alone. Together they make it structurally, and tests/external-facts.test.ts
 * executes exactly that composition against the real engine.
 *
 * WHAT REMAINS SAYABLE, and it is the useful part: that a named source published
 * something, with its URL and its date, in words. "Their directory listing is
 * out of date" is a finding an operator can act on and needs no figure.
 *
 * ---------------------------------------------------------------------------
 * THE RESIDUAL, STATED PLAINLY
 * ---------------------------------------------------------------------------
 * `renderExternalFacts()` shows the model the claim VERBATIM, digits included,
 * because a redacted claim is not the claim and rule 21 says to carry what was
 * published. So the model can SEE an external figure and may waste a draft
 * typing it. It cannot SHIP one — substitute() refuses it.
 *
 * A digit-masker for those claims was considered and REJECTED. It would be a
 * second numeral tokeniser in a codebase whose last three failures all came from
 * two tokenisers that nearly agreed (see the header of
 * src/lib/brain/law/claims-linter.ts). It would buy fewer wasted drafts and
 * would buy nothing at all in safety, because the guarantee above does not
 * depend on it. A convenience is not worth a second alphabet to lose a race
 * against.
 *
 * ---------------------------------------------------------------------------
 * PURITY
 * ---------------------------------------------------------------------------
 * No network, no database, no model, no clock, no environment. The retrieval
 * instant arrives on the `RetrievalEvidence` the fetch produced, and the client
 * identity arrives as an argument — the same discipline blocks.ts follows with
 * today's date. Explicit `.ts` imports, so this module runs unchanged under
 * `node --test --experimental-strip-types`.
 */

/* ===================================================== the two classes ==== */

/**
 * What a fact needs from the retrieval that produced it.
 *
 * `Retrieval` in ./fetch.ts satisfies this STRUCTURALLY, and that file carries a
 * compile-time assertion saying so, so the coupling is checked without this
 * module importing the network boundary. Typed here rather than imported for
 * the same reason `PostAnalysisRow.computed` is typed structurally in db.ts:
 * this file stays a leaf.
 *
 * `retrieval_id` IS THE POINT. It is the primary key of a row in
 * `web_retrievals` that was written BEFORE the request went out, and
 * `external_facts.retrieval_id` is NOT NULL REFERENCES that table. A fact whose
 * fetch was never ledgered has no id to carry, so "the ledger row is written
 * before the mapping" is enforced by Postgres and by this type, in that order,
 * rather than by a caller remembering the sequence.
 */
export interface RetrievalEvidence {
  readonly retrieval_id: string;
  /** Where the redirect chain actually ended. https, by the fetch guard. */
  readonly final_url: string;
  /** ISO instant. Supplied by the caller of the fetch; no clock is read here. */
  readonly retrieved_at: string;
  /** The page's own title, or null when it carried none. */
  readonly page_title: string | null;
}

/**
 * ONE CLAIM SOMEBODY PUBLISHED.
 *
 * `source_key?: never` is the load-bearing line in this file. It makes three
 * things true at once, all of them checked by the compiler:
 *
 *   1. `{ ..., source_key: 'profiles.academy.followers' }` is NOT assignable to
 *      `ExternalFact` — `string` is not assignable to `undefined`. An external
 *      fact wearing a citation is a compile error where it is written.
 *   2. `ExternalFact` is NOT assignable to `BasisRef`, whose `source_key` is a
 *      required `string`. So an external fact cannot be handed to anything that
 *      takes evidence, including the Law layer's `CitedClaim.basis`.
 *   3. It documents itself. A reader who wonders "where does the key go?" finds
 *      the answer written down as a type: there is not one, and there will not
 *      be one.
 *
 * The compile-time assertions below hold (1) and (2) in place if either type is
 * ever edited.
 */
export interface ExternalFact {
  /** The ledger row this claim came out of. See RetrievalEvidence. */
  readonly retrieval_id: string;
  /** THE CLAIM VERBATIM AS PUBLISHED. Never summarised, rounded or translated. */
  readonly claim: string;
  /** Rule 21: an external fact carries its URL. https, by construction. */
  readonly source_url: string;
  /** The page's own title, or null when it carried none. */
  readonly page_title: string | null;
  /** Rule 21: an external fact carries its retrieval date. ISO instant. */
  readonly retrieved_at: string;
  /** The entity or subject this is filed under. */
  readonly topic: string;
  readonly kind: ExternalFactKind;
  readonly confidence: ExternalConfidence;
  /** True when this is a claim about one of the client's own accounts. */
  readonly about_client: boolean;
  /** Which account, when `about_client`. Null otherwise. */
  readonly client_account: Account | null;
  /** Which measure it purports to be, when it purports to be one. */
  readonly client_measure: ClientMeasure | null;
  /**
   * STRUCTURAL REFUSAL. Not a field: the absence of one, spelled so the compiler
   * enforces it. An external fact has no source key, ever.
   */
  readonly source_key?: never;
}

/* -------- the two shapes must not be assignable to each other ------------- */

type Assert<T extends true> = T;

/** An external fact is not evidence. `BasisRef.source_key` is a required string. */
type _FactIsNotBasis = Assert<ExternalFact extends BasisRef ? false : true>;
/** Nor is the persisted row, which is the shape that actually crosses the wire. */
type _RowIsNotBasis = Assert<ExternalFactRow extends BasisRef ? false : true>;
/** Evidence is not an external fact: it carries no URL and no retrieval date. */
type _BasisIsNotFact = Assert<BasisRef extends ExternalFact ? false : true>;
/** And the field itself is REFUSED, not merely absent. */
type _KeyIsRefused = Assert<{ source_key: string } extends Pick<ExternalFact, 'source_key'> ? false : true>;
/**
 * The in-memory fact and the persisted row are the same claim, so a fact is a
 * row minus the two columns the database mints. If either drifts, this file
 * stops compiling here rather than at whichever insert happens to be wired up —
 * the same guard media.ts uses to keep `ParsedPost` a `MirrorCandidate`.
 */
type _FactIsTheRowMinusDbColumns = Assert<
  Omit<ExternalFactRow, 'id' | 'created_at'> extends ExternalFact ? true : false
>;

/* ================================================= the client identity ==== */

/**
 * Who the client IS, for the purposes of the rule-21 check.
 *
 * Handles and any display aliases, per account. Passed in rather than imported:
 * `canonicalHandles()` in src/lib/ingest/handles.ts reads the environment, and a
 * pure module must not. The caller composes them.
 *
 * A blank or empty side is a CONFIGURATION FAULT and throws, because an empty
 * identity silently disables the ratchet — the failure would be a client
 * follower count filed as an ordinary world fact, which is precisely the outcome
 * this file exists to prevent. Hostile DATA never throws here; broken CONFIG
 * always does.
 */
export interface ClientIdentity {
  readonly personal: readonly string[];
  readonly academy: readonly string[];
}

/** Reserved so a caller cannot accidentally build half an identity. */
export function clientIdentity(personal: readonly string[], academy: readonly string[]): ClientIdentity {
  const clean = (names: readonly string[], side: string): string[] => {
    const kept = names.map((name) => name.trim().replace(/^@+/, '').trim()).filter((n) => n.length > 0);
    if (kept.length === 0) {
      throw new Error(
        `clientIdentity: the ${side} side is empty. An empty identity disables the rule 21 check ` +
          'silently, which would file a claim about the client as an ordinary world fact.',
      );
    }
    return kept;
  };
  return { personal: clean(personal, 'personal'), academy: clean(academy, 'academy') };
}

/**
 * Words that mean a claim is about a measure this system takes for itself.
 *
 * Both languages, because both appear on the pages that list these accounts.
 * Order matters only in that the FIRST match wins, and the list is ordered
 * most-specific first so «متابعين» (followers) is not shadowed by a looser word.
 */
const MEASURE_WORDS: ReadonlyArray<readonly [ClientMeasure, readonly string[]]> = [
  ['followers', ['followers', 'follower', 'subscriber', 'متابعين', 'متابعون', 'متابع']],
  ['following', ['following', 'follows', 'يتابع', 'يتابعون']],
  ['post_count', ['posts', 'post count', 'publications', 'منشورات', 'منشور', 'مشاركات']],
  ['engagement', ['engagement', 'engagement rate', 'interaction', 'تفاعل', 'التفاعل']],
  ['verification', ['verified', 'verification', 'blue tick', 'blue check', 'موثق', 'موثوق']],
];

/**
 * The haystack a scan runs against: lowercased, with every FORMAT character and
 * every NON-SPACING MARK removed.
 *
 * That stripping is not cosmetic. «٨٨<U+034F>٥٠٨» is the round-3 exploit and
 * U+034F is `\p{Mn}`; the same trick against a handle — `thinkquality<ZWSP>_
 * academyy` — would slip a client claim past a naive substring test and file it
 * as an ordinary world fact. The claim ITSELF is never touched: this is a
 * working copy for matching, and what is stored stays verbatim.
 */
function haystack(text: string): string {
  return text.toLowerCase().replace(/[\p{Cf}\p{Mn}]/gu, '');
}

export interface ClientClaimScan {
  /** Which account the text names, or null when it names neither. */
  account: Account | null;
  /** Which measure it talks about, or null. Only meaningful with an account. */
  measure: ClientMeasure | null;
  /** The handle or alias that matched, for the operator. Null when none did. */
  matched: string | null;
}

/**
 * Does this text talk about one of the client's own accounts, and about what?
 *
 * A DETECTOR, and it is named as one. It runs over the claim, the page title and
 * the URL together, because a directory page often names the account in its path
 * and not in the sentence. What makes a detector acceptable here — when
 * substitute.ts rejected detectors outright for numbers — is the direction it
 * can fail in: see `externalFact()` below. It can only ever RAISE the flag.
 */
export function scanClientClaim(text: string, identity: ClientIdentity): ClientClaimScan {
  const hay = haystack(text);

  const sides: ReadonlyArray<readonly [Account, readonly string[]]> = [
    ['personal', identity.personal],
    ['academy', identity.academy],
  ];

  let account: Account | null = null;
  let matched: string | null = null;
  for (const [side, names] of sides) {
    for (const name of names) {
      if (hay.includes(haystack(name))) {
        account = side;
        matched = name;
        break;
      }
    }
    if (account !== null) break;
  }

  let measure: ClientMeasure | null = null;
  for (const [name, words] of MEASURE_WORDS) {
    if (words.some((word) => hay.includes(haystack(word)))) {
      measure = name;
      break;
    }
  }

  return { account, measure, matched };
}

/* ==================================================== building a fact ===== */

/**
 * What a caller hands over. Note what is NOT here: no `source_url`, no
 * `retrieved_at`, no `retrieval_id`. Those three come from the RETRIEVAL and a
 * caller cannot supply, alter or invent them — which is what makes "required"
 * mean something. A caller who has not fetched anything has nothing to pass.
 */
export interface ExternalFactDraft {
  readonly claim: string;
  readonly topic: string;
  readonly kind: ExternalFactKind;
  readonly confidence?: ExternalConfidence;
  /**
   * What the caller BELIEVES this is about. The scan may overrule it upward and
   * can never overrule it downward. Omitted means "a claim about the world".
   */
  readonly about?: { readonly account: Account; readonly measure?: ClientMeasure };
}

export type ExternalFactRefusal =
  /** The draft carried a `source_key`. Refused at runtime as well as at compile time. */
  | 'source-key-present'
  | 'blank-claim'
  | 'blank-topic'
  | 'unretrieved'
  | 'insecure-source';

export type ExternalFactResult =
  | {
      ok: true;
      fact: ExternalFact;
      /** True when the scan raised a flag the caller did not declare. */
      escalated: boolean;
      scan: ClientClaimScan;
    }
  | { ok: false; reason: ExternalFactRefusal; detail: string };

/** Own enumerable `source_key`, whatever the static type claimed. */
function carriesSourceKey(draft: object): boolean {
  return Object.prototype.hasOwnProperty.call(draft, 'source_key');
}

/**
 * Build one external fact from a ledgered retrieval and a draft.
 *
 * ===========================================================================
 * THE RATCHET
 * ===========================================================================
 * `about_client` is `declared OR detected`. A caller may raise it. NOTHING
 * lowers it. That asymmetry is the whole reason a detector is admissible here
 * when substitute.ts refuses one for numbers, and the argument is about failure
 * direction:
 *
 *   * A detector that gates STORAGE fails OPEN. Miss the handle, and the claim
 *     is stored as an ordinary world fact — unmarked, and indistinguishable from
 *     one.
 *   * A detector that only ESCALATES fails toward "stored, unmarked, and still
 *     structurally incapable of becoming a figure", because no external fact of
 *     any kind can mint a source_key. A miss costs a label, not a guarantee.
 *
 * Only the second failure mode is bounded by something other than the
 * detector's accuracy, and that is why this design is store-and-mark.
 *
 * ===========================================================================
 * WHY STORE-AND-MARK RATHER THAN REFUSE OUTRIGHT
 * ===========================================================================
 * The brief asked for the decision and its justification. It is store-and-mark,
 * for three reasons in descending order of weight:
 *
 *   1. THE FAILURE DIRECTION ABOVE. Refusing needs a detector to decide what to
 *      refuse, and a missed refusal puts the claim somewhere else entirely —
 *      an operator's notes, a chat message, a model's context — where none of
 *      this file's guarantees reach it. Marking keeps every claim inside the one
 *      place that is structurally safe.
 *   2. THE ROW IS WORTH HAVING. "This directory publishes X about the academy;
 *      we measure Y" is a real, actionable finding for a brand that cares how it
 *      is perceived, and it is only expressible if X is written down. Refusal
 *      destroys the evidence and guarantees the next operator fetches the same
 *      page again.
 *   3. REFUSAL IS SILENT. A discarded claim leaves nothing behind, so nobody
 *      learns that a source is stale. A `contradicted` row does.
 *
 * What is NOT permitted is any path from such a row to a measurement, and there
 * is none: no source_key, not assignable to BasisRef, and rendered in a block
 * the measure parser cannot read (see renderExternalFacts).
 */
export function externalFact(
  retrieval: RetrievalEvidence,
  draft: ExternalFactDraft,
  identity: ClientIdentity,
): ExternalFactResult {
  /* RUNTIME, not only compile time. A draft that crossed a JSON boundary, came
   * off a model, or was read back out of a database has no type at all — and
   * `source_key?: never` is erased at runtime. This is the same check the type
   * makes, made again where the type is gone. */
  if (carriesSourceKey(draft)) {
    return {
      ok: false,
      reason: 'source-key-present',
      detail:
        'This draft carries a source_key. A source_key names a value THIS codebase computed, and a ' +
        'claim read off a web page was not computed here. External knowledge carries a source_url ' +
        'and a retrieved_at instead, and it can never carry both.',
    };
  }

  const claim = draft.claim.trim();
  if (claim.length === 0) {
    return { ok: false, reason: 'blank-claim', detail: 'A claim with no text is not a claim.' };
  }

  const topic = draft.topic.trim();
  if (topic.length === 0) {
    return {
      ok: false,
      reason: 'blank-topic',
      detail: 'A fact filed under no topic cannot be retrieved for a context, so it may as well not exist.',
    };
  }

  /* Rule 21: source_url and retrieved_at are REQUIRED, and required means the
   * fact cannot exist without them — not that a validator complains later. */
  const sourceUrl = retrieval.final_url.trim();
  const retrievedAt = retrieval.retrieved_at.trim();
  if (retrieval.retrieval_id.trim().length === 0 || sourceUrl.length === 0 || retrievedAt.length === 0) {
    return {
      ok: false,
      reason: 'unretrieved',
      detail:
        'A fact needs a ledgered retrieval: its id, the URL it ended at, and the instant it was read. ' +
        'One of the three is missing, which means no fetch was ledgered and no claim may be filed.',
    };
  }
  if (!sourceUrl.startsWith('https://')) {
    return {
      ok: false,
      reason: 'insecure-source',
      detail: `A source URL must be https. This retrieval ended at ${JSON.stringify(sourceUrl)}.`,
    };
  }

  /* -- the ratchet ------------------------------------------------------- */

  const scan = scanClientClaim(
    [claim, retrieval.page_title ?? '', sourceUrl, topic].join('\n'),
    identity,
  );

  const declared = draft.about ?? null;
  const aboutClient = declared !== null || scan.account !== null;
  const account: Account | null = declared?.account ?? scan.account;
  // A measure is named when either side names one. `client_measure` is only
  // meaningful inside the flagged case, and the migration's pairing constraint
  // refuses it outside one.
  const measure: ClientMeasure | null = aboutClient
    ? (declared?.measure ?? scan.measure)
    : null;

  return {
    ok: true,
    escalated: declared === null && scan.account !== null,
    scan,
    fact: {
      retrieval_id: retrieval.retrieval_id,
      claim,
      source_url: sourceUrl,
      page_title: retrieval.page_title,
      retrieved_at: retrievedAt,
      topic,
      kind: draft.kind,
      confidence: draft.confidence ?? 'unverified',
      about_client: aboutClient,
      client_account: aboutClient ? account : null,
      client_measure: measure,
    },
  };
}

/**
 * The `external_facts` insert payload for one fact.
 *
 * Column-shaped and nothing more. It exists so the one place that knows the
 * column names is this file, next to the type — and so a reviewer can see that
 * no `source_key` is written, because there is nowhere to write one.
 */
export function externalFactRow(fact: ExternalFact): Record<string, string | boolean | null> {
  return {
    retrieval_id: fact.retrieval_id,
    claim: fact.claim,
    source_url: fact.source_url,
    page_title: fact.page_title,
    retrieved_at: fact.retrieved_at,
    topic: fact.topic,
    kind: fact.kind,
    confidence: fact.confidence,
    about_client: fact.about_client,
    client_account: fact.client_account,
    client_measure: fact.client_measure,
  };
}

/* ======================================================== the renderer ==== */

/**
 * ===========================================================================
 * THE RENDERED FORM, AND THE COLLISION IT HAD TO AVOID
 * ===========================================================================
 * The measure grammar in src/lib/agent/strategist/blocks.ts is
 *
 *     [some.source.key] label (n=..., as_of=...) = "the value"
 *
 * and `parseRenderedMeasures()` in src/lib/brain/law/source-keys.ts reads it
 * back with `/^\[([^\]]+)\].*?= ("(?:[^"\\]|\\.)*")$/`. THAT PARSER RUNS OVER
 * WHATEVER TEXT IT IS GIVEN. A rendered external line that began with `[` and
 * ended with `= "..."` would be parsed as a measure, and a model could then cite
 * it as a source_key that "resolves" — a web page's number, wearing a receipt.
 *
 * So the form below is chosen to be unparseable as a measure, not merely to look
 * different: no line starts with `[`, and no line ends with `= "..."`. The test
 * for that assertion runs the REAL `parseRenderedMeasures()` over this output
 * and requires the result to be empty, rather than re-stating the regex.
 *
 * Every claim also wears the words "published elsewhere, unverified" on its own
 * line, and every flagged claim wears a warning naming the measure it purports
 * to be and saying that this system measures that itself.
 */

/** Opens the block. Prose here CONTAINS NO DIGITS, by the same rule blocks.ts follows. */
const EXTERNAL_CONTRACT = [
  '<external_contract>',
  'Nothing in this block is a measurement. Every line below is a claim someone else published on the open web, stored word for word, with the address it was published at and the moment it was read.',
  'No line here has a source key. Nothing here can be substituted into a deliverable, so you may not state any figure that appears here, in any script or spelling.',
  'You may say that a named source published something, and name the source and the date it was read. Say it as a claim, never as a measurement of these accounts.',
  'Where a claim is marked as being about one of these accounts, this system measures that itself. The page may be stale, wrong, or about someone else. It is never the answer.',
  '</external_contract>',
].join('\n');

/** One line per field, none of them shaped like a measure. */
function renderFact(fact: ExternalFact): string {
  const lines = [`(published elsewhere, unverified) topic=${fact.topic} kind=${fact.kind} confidence=${fact.confidence}`];

  if (fact.about_client) {
    const measure = fact.client_measure === null ? 'unnamed' : fact.client_measure;
    lines.push(
      `  ABOUT OUR OWN ACCOUNT (${fact.client_account ?? 'unnamed'}), purporting to be: ${measure}. ` +
        'This system measures that itself; a page claiming otherwise is at best stale, and may not be used as that measure.',
    );
  }

  // `claim:` and the quotes, but never `= "..."`, so the measure parser cannot
  // read this line. dir="auto" belongs on whatever renders it (hard rule 5).
  lines.push(`  claim: ${JSON.stringify(fact.claim)}`);
  lines.push(`  source: ${fact.source_url}`);
  lines.push(`  retrieved: ${fact.retrieved_at}`);
  if (fact.page_title !== null) lines.push(`  page title: ${JSON.stringify(fact.page_title)}`);

  return lines.join('\n');
}

/**
 * The external-knowledge block, as a model reads it.
 *
 * Flagged claims are rendered FIRST and together, so the loudest thing in the
 * block is the class of claim most likely to be misread. An empty list renders
 * the contract and says nothing was retrieved — an honest empty block, not an
 * omitted one, because a missing block reads as "nothing was looked up" and an
 * empty one reads as "we looked and there is nothing", which are different.
 */
export function renderExternalFacts(facts: readonly ExternalFact[]): string {
  if (facts.length === 0) {
    return [
      EXTERNAL_CONTRACT,
      '<external_knowledge>',
      '(nothing retrieved) No external page has been read for this context, so the web says nothing here. That is not the same as the web saying nothing.',
      '</external_knowledge>',
    ].join('\n');
  }

  const flagged = facts.filter((fact) => fact.about_client);
  const world = facts.filter((fact) => !fact.about_client);

  return [
    EXTERNAL_CONTRACT,
    '<external_knowledge>',
    ...[...flagged, ...world].map(renderFact),
    '</external_knowledge>',
  ].join('\n');
}

/**
 * Every claim about the client's own accounts, for the operator's review screen.
 *
 * Separate from the renderer because these two audiences want opposite things: a
 * model needs the flagged rows buried in a contract that forbids using them, and
 * an operator needs exactly the flagged rows and nothing else.
 */
export function clientClaims(facts: readonly ExternalFact[]): ExternalFact[] {
  return facts.filter((fact) => fact.about_client);
}
