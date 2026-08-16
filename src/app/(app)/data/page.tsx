'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Popconfirm,
  Segmented,
  Skeleton,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { UploadFile } from 'antd/es/upload/interface';
import dayjs, { type Dayjs } from 'dayjs';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { apiGet, apiUpload, apiSend, describeError } from '@/lib/client/api';
import {
  PageHeader,
  EmptyState,
  ErrorState,
  LoadingBlock,
  ArabicText,
  WarningList,
} from '@/components/ui';
import {
  formatDate,
  formatDateTime,
  formatNumber,
  formatSignedNumber,
  toIsoDate,
} from '@/lib/date';
import type {
  Account,
  PillarRow,
  PostRow,
  ProfileSnapshotRow,
  ScrapeRunRow,
  SnapshotDiff,
  SnapshotRow,
} from '@/lib/types/db';

interface SnapshotsResponse {
  snapshots: SnapshotRow[];
  pillars: PillarRow[];
}

interface PostsResponse {
  posts: PostRow[];
}

interface IngestCounts {
  posts: number;
  personal: number;
  academy: number;
  new_since_previous: number;
  duplicates_skipped: number;
  unroutable_skipped: number;
}

interface IngestResponse {
  snapshot: SnapshotRow;
  counts: IngestCounts;
  files: string[];
  /**
   * One readable line per skip reason, from the shared parser. Declared here
   * because `apiUpload` casts the payload without validating it — an undeclared
   * field type-checks perfectly and is silently dropped, which is exactly how a
   * scrape once lost twelve items without saying so.
   */
  warnings: string[];
}

interface RefreshResponse {
  snapshot: { id: string; taken_on: string };
  previous: { id: string; taken_on: string } | null;
  diff: SnapshotDiff | null;
  facts_updated: number;
  pillars_written: number;
  pillar_warnings: string[];
  shipped: { backfilled: number; unmatched: string[] };
}

/* ------------------------------------------------- automated scrape shapes -- */

/** Mirrors the `estimate` block every scrape route returns. */
interface ScrapeEstimateInfo {
  actor: string;
  result_count: number;
  /** Null when the actor has no verified rate — "not estimated", never "free". */
  usd: number | null;
  rate_per_1000: number | null;
}

/** Mirrors the `budget` block. `allowed: false` is what disables a run button. */
interface ScrapeBudgetInfo {
  budget_usd: number | null;
  allowed: boolean;
  reason: string | null;
  shortfall_usd: number | null;
}

interface ProfileDeltaInfo {
  previous_taken_on: string;
  days_between: number | null;
  followers: number | null;
  following: number | null;
  posts_count: number | null;
}

interface ProfileAccountHistory {
  latest: ProfileSnapshotRow | null;
  previous: ProfileSnapshotRow | null;
  delta: ProfileDeltaInfo | null;
}

interface ProfileInfoResponse {
  handles: Record<Account, string>;
  estimate: ScrapeEstimateInfo;
  budget: ScrapeBudgetInfo;
  accounts: Record<Account, ProfileAccountHistory>;
}

interface ProfileRunResponse {
  run_id: string;
  taken_on: string;
  results: number;
  saved: number;
  handles_seen: string[];
  warnings: string[];
  accounts: Record<Account, ProfileAccountHistory>;
}

/**
 * The read that `candidates_scanned` was ranked over.
 *
 * `truncated` means the query filled its cap, so posts beyond it were never
 * ranked: the scope — and therefore the estimate priced off it — describes a
 * PREFIX of the account, not the whole of it. Rule 9 makes that worth rendering
 * rather than storing: an estimate computed off a wrong population is a wrong
 * number, and the only way to tell is to be shown the population.
 */
interface CommentsScanInfo {
  /** Scrape rows the query returned, before the re-scrape collapse. */
  rows_fetched: number;
  limit: number;
  truncated: boolean;
  duplicates_collapsed: number;
  snapshots_seen: number;
}

interface CommentsScopeInfo {
  target_post_count: number;
  top_n: number;
  per_post: number;
  only_uncovered: boolean;
  already_covered: number;
  /** Ids the caller named that cannot be scraped — reported, never dropped. */
  missing_post_ids: string[];
  /** Distinct POSTS the scope was ranked over, after the re-scrape collapse. */
  candidates_scanned: number;
  scan: CommentsScanInfo;
}

/**
 * Comments that were scraped — and paid for — and then NOT stored.
 *
 * Every field here is a real loss, which is exactly why they are rendered
 * instead of being counted into a variable nobody reads. `over_cap` and
 * `unmatched_post` are the two that cost money and leave no row behind.
 */
interface CommentsSkipped {
  /** The same (post_id, ig_comment_id) twice — the table's unique key. */
  duplicates: number;
  missing_id: number;
  missing_text: number;
  unrecognised: number;
  /** Kept by the parser with no post to hang on, so never inserted at all. */
  unmatched_post: number;
  /** Past this run's per-post cap, newest-first: bought, then discarded. */
  over_cap: number;
}

/** The same counts read out of an untyped pipeline payload: absent reads null. */
type CommentsSkippedView = { [K in keyof CommentsSkipped]: number | null };

/**
 * The part of a scope one renderer needs, with every count nullable so the same
 * block serves the typed pre-flight and the loosely-read pipeline payload. A
 * `CommentsScopeInfo` is assignable to it; a payload missing a field reads null
 * and renders an em-dash rather than a zero.
 */
interface CommentsScopeView {
  target_post_count: number | null;
  already_covered: number | null;
  candidates_scanned: number | null;
  missing_post_ids: string[];
  scan: {
    rows_fetched: number | null;
    limit: number | null;
    truncated: boolean | null;
    duplicates_collapsed: number | null;
    snapshots_seen: number | null;
  } | null;
}

interface CommentsInfoResponse {
  scope: CommentsScopeInfo;
  estimate: ScrapeEstimateInfo;
  budget: ScrapeBudgetInfo;
  /** Null when the count could not be read — renders as an em-dash, not 0. */
  corpus: { comments_stored: number | null };
}

/** `started: false` is a normal outcome (nothing in scope), not an error. */
type CommentsStartResponse =
  | {
      started: true;
      run_id: string;
      apify_run_id: string;
      status: string;
      scope: CommentsScopeInfo;
      estimate: ScrapeEstimateInfo;
      budget: ScrapeBudgetInfo;
    }
  | { started: false; reason: string; scope: CommentsScopeInfo };

interface CommentsPollResponse {
  apify_run_id: string;
  status: string;
  item_count: number | null;
  usage_usd: number | null;
  done: boolean;
}

interface CommentsImportResponse {
  run_id: string;
  results: number;
  saved: number;
  posts_covered: number;
  per_post_cap: number;
  /** Scraped and not stored. `results - saved` is not the whole story. */
  skipped: CommentsSkipped;
  warnings: string[];
  usage_usd: number | null;
  corpus: { comments_stored: number | null };
}

/* ----------------------------------------------------- monitor pipeline -- */

/**
 * /api/monitor is a chain, not a call. Every response carries `next`: the exact
 * request to make after it, so no single call is long enough to time out and a
 * failure loses one step rather than the run. This screen *follows* that chain
 * instead of re-implementing the order — the route owns the pipeline, the
 * screen owns showing it.
 *
 * The per-step payloads differ (a poll, a snapshot, a delegated route's body),
 * so they are read defensively through the helpers below rather than asserted
 * into one shape that does not exist.
 */
type JsonRecord = Record<string, unknown>;

type MonitorStage = 'posts' | 'import' | 'profile' | 'comments' | 'comments-import' | 'analyze';

type StageState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

interface StageProgress {
  state: StageState;
  /** Numbers live in JSX so each one can be wrapped in `.tq-num` (rule 5). */
  detail: ReactNode | null;
  /**
   * Verbatim lines the step reported about what it dropped or could not do.
   * A one-line `detail` cannot hold them, and a step that lost twelve items to
   * a silent scrape failure has to be able to say so on the screen that ran it.
   */
  warnings: string[];
  /** A structured block only some steps have: the mirror, the comment losses. */
  disclosure: ReactNode | null;
}

/**
 * The media mirror, exactly as /api/monitor's import step reports it.
 *
 * Three outcomes have to stay distinguishable on screen, and only one of them
 * is "fine":
 *   enabled === null   the pass could not be attempted at all
 *   enabled === false  MIRROR_MEDIA is off, so nothing was tried
 *   enabled === true   it ran, and every count below is a measurement
 * Printing "0 mirrored" for the first two would read as "it ran and found
 * nothing to do" — the precise silent failure this block exists to prevent —
 * so a count with no pass behind it stays null and renders as an em-dash.
 */
interface MirrorInfo {
  enabled: boolean | null;
  reason: string | null;
  scan: { rows_fetched: number | null; limit: number | null; truncated: boolean | null } | null;
  posts_without_raw: number | null;
  considered: number | null;
  mirrored: number | null;
  already_mirrored: number | null;
  skipped_total: number | null;
  failed_total: number | null;
  index_complete: boolean | null;
  /** A failure inside the pass, which stopped it early. */
  pass_error: string | null;
  /** A failure around the pass: the read-back, or the ledger write. */
  error: string | null;
  warnings: string[];
}

interface MonitorNextCall {
  step: string;
  route: string;
  method: 'GET' | 'POST';
  query: Record<string, string>;
  body: JsonRecord | null;
}

/**
 * GET /api/monitor — the whole plan and what it would cost, spending nothing.
 * A stage whose pre-flight route errored arrives as `ok: false` with no
 * estimate: that is "not priced", which renders as an em-dash, never as $0.00.
 */
interface MonitorPlanResponse {
  handles: Record<Account, string>;
  steps: {
    posts: {
      profiles: string[];
      limit: number;
      estimate: ScrapeEstimateInfo;
      budget: ScrapeBudgetInfo;
    };
    profile: {
      ok: boolean;
      estimate?: ScrapeEstimateInfo;
      budget?: ScrapeBudgetInfo;
      error?: string;
    };
    comments: {
      ok: boolean;
      scope?: CommentsScopeInfo;
      estimate?: ScrapeEstimateInfo;
      budget?: ScrapeBudgetInfo;
      error?: string;
    };
    analyze: {
      ok: boolean;
      total?: number;
      analyzed?: number;
      remaining?: number;
      /**
       * Model spend, not Apify spend — the CostCeiling /api/board/analyze GET
       * returns, spread into this step by /api/monitor's plan.
       *
       * It used to be a bare `estimate_usd: number | null` and this screen read
       * it as one. The analyse route replaced that flat number with a ceiling
       * that carries its own derivation, and the field this screen reads
       * silently stopped existing: src/lib/client/api.ts:36 is `payload as T`,
       * so an absent field is `undefined` at runtime and nothing at compile
       * time. The analysis line of the pipeline estimate rendered an em-dash on
       * every load, and — worse — the run total below simply left the model
       * spend out of the sum while still presenting itself as the total. Rule 9
       * is estimate before spend; a total that quietly omits a priced stage is
       * the wrong number.
       */
      estimate?: {
        /** Null when no published rate has been verified for the model. */
        usd: number | null;
        /** Why `usd` is null, in the route's own words. Null when it is not. */
        unpriced_reason: string | null;
      };
      error?: string;
    };
  };
}

/** One priced line of the plan. `usd: null` means not priced, not free. */
interface MonitorEstimateRow {
  key: MonitorStage;
  label: string;
  usd: number | null;
  note: string | null;
}

interface ScrapeRunsResponse {
  runs: ScrapeRunRow[];
  count: number;
  limit: number;
  totals: {
    estimated_usd: number | null;
    runs_with_estimate: number;
    runs_without_estimate: number;
    actual_results: number | null;
    runs_with_result_count: number;
  };
}

/** One rendered line of the profile series. */
interface ProfileHistoryRow {
  key: string;
  account: Account;
  measurement: 'latest' | 'previous';
  taken_on: string;
  followers: number | null;
  following: number | null;
  posts_count: number | null;
}

type CommentsPhase = 'idle' | 'starting' | 'polling' | 'importing';

const ACCOUNTS: Account[] = ['personal', 'academy'];

/** The comment actor runs for minutes, so the poll is paced in seconds. */
const COMMENTS_POLL_MS = 5_000;
const COMMENTS_POLL_MAX_ATTEMPTS = 120;

/** The only route this screen will follow a `next` instruction to. */
const MONITOR_ROUTE = '/api/monitor';
const MONITOR_POLL_MS = 5_000;
/** A ceiling on the chain, so a stuck actor cannot poll forever. */
const MONITOR_MAX_CALLS = 300;

const MONITOR_STAGES: MonitorStage[] = [
  'posts',
  'import',
  'profile',
  'comments',
  'comments-import',
  'analyze',
];

const STAGE_COLORS: Record<StageState, string> = {
  pending: 'default',
  running: 'blue',
  done: 'green',
  skipped: 'gold',
  failed: 'red',
};

/**
 * `skipped` is written by /api/monitor when the analyse step runs without a
 * model key: the posts, profile and comments are still ingested, and the skip
 * is ledgered so "why is nothing analysed?" has an answer in the table.
 */
const STATUS_COLORS: Record<string, string> = {
  done: 'green',
  running: 'blue',
  blocked: 'red',
  error: 'red',
  skipped: 'gold',
  empty: 'default',
};

/* --------------------------------------------- reading a step's payload -- */

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function readRecord(source: JsonRecord | null, key: string): JsonRecord | null {
  return source === null ? null : asRecord(source[key]);
}

function readString(source: JsonRecord | null, key: string): string | null {
  if (source === null) return null;
  const raw = source[key];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

/** Absent, null or unparseable all read as null — never as 0 (rule 2). */
function readNumber(source: JsonRecord | null, key: string): number | null {
  if (source === null) return null;
  const raw = source[key];
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Null when the key is absent, which is how a poll is told from a start. */
function readBoolean(source: JsonRecord | null, key: string): boolean | null {
  if (source === null) return null;
  const raw = source[key];
  return typeof raw === 'boolean' ? raw : null;
}

/** The strings actually present. Never pads, never invents an entry. */
function readStringArray(source: JsonRecord | null, key: string): string[] {
  if (source === null) return [];
  const raw = source[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

/**
 * A total over several counts, or null. One missing part makes the whole
 * unknown: summing what happens to be present would print a total that is
 * quietly short, which is the same lie as printing 0 for "not measured".
 */
function sumOrNull(source: JsonRecord | null, keys: string[]): number | null {
  if (source === null) return null;
  let total = 0;
  for (const key of keys) {
    const value = readNumber(source, key);
    if (value === null) return null;
    total += value;
  }
  return total;
}

/** The `mirror` block of an import response, or null when it carried none. */
function readMirror(res: JsonRecord): MirrorInfo | null {
  const m = readRecord(res, 'mirror');
  if (m === null) return null;

  const scan = readRecord(m, 'scan');
  const skipped = readRecord(m, 'skipped');
  const failed = readRecord(m, 'failed');

  return {
    enabled: readBoolean(m, 'enabled'),
    reason: readString(m, 'reason'),
    scan:
      scan === null
        ? null
        : {
            rows_fetched: readNumber(scan, 'rows_fetched'),
            limit: readNumber(scan, 'limit'),
            truncated: readBoolean(scan, 'truncated'),
          },
    posts_without_raw: readNumber(m, 'posts_without_raw'),
    considered: readNumber(m, 'considered'),
    mirrored: readNumber(m, 'mirrored'),
    already_mirrored: readNumber(m, 'already_mirrored'),
    skipped_total: sumOrNull(skipped, ['no_media_url', 'untrusted_host', 'unsafe_id', 'over_cap']),
    failed_total: sumOrNull(failed, ['download', 'not_image', 'too_large', 'upload']),
    index_complete: readBoolean(m, 'index_complete'),
    pass_error: readString(m, 'pass_error'),
    error: readString(m, 'error'),
    warnings: readStringArray(m, 'warnings'),
  };
}

/** The `skipped` block of a comment import, read defensively. */
function readCommentsSkipped(source: JsonRecord | null): CommentsSkippedView | null {
  const s = readRecord(source, 'skipped');
  if (s === null) return null;
  return {
    duplicates: readNumber(s, 'duplicates'),
    missing_id: readNumber(s, 'missing_id'),
    missing_text: readNumber(s, 'missing_text'),
    unrecognised: readNumber(s, 'unrecognised'),
    unmatched_post: readNumber(s, 'unmatched_post'),
    over_cap: readNumber(s, 'over_cap'),
  };
}

/**
 * The comment scope as a pipeline payload carries it. Read field by field so a
 * response that predates one of them renders an em-dash instead of throwing.
 */
function readCommentsScope(source: JsonRecord | null): CommentsScopeView | null {
  const s = readRecord(source, 'scope');
  if (s === null) return null;
  const scan = readRecord(s, 'scan');
  return {
    target_post_count: readNumber(s, 'target_post_count'),
    already_covered: readNumber(s, 'already_covered'),
    candidates_scanned: readNumber(s, 'candidates_scanned'),
    missing_post_ids: readStringArray(s, 'missing_post_ids'),
    scan:
      scan === null
        ? null
        : {
            rows_fetched: readNumber(scan, 'rows_fetched'),
            limit: readNumber(scan, 'limit'),
            truncated: readBoolean(scan, 'truncated'),
            duplicates_collapsed: readNumber(scan, 'duplicates_collapsed'),
            snapshots_seen: readNumber(scan, 'snapshots_seen'),
          },
  };
}

function toStage(step: string | null): MonitorStage | null {
  return step !== null && (MONITOR_STAGES as string[]).includes(step)
    ? (step as MonitorStage)
    : null;
}

/**
 * Parses the `next` instruction. Absent or null means the chain is finished.
 * A `route` other than /api/monitor is refused rather than followed: this
 * driver exists to walk one pipeline, not to be pointed anywhere.
 */
function parseNext(value: unknown): MonitorNextCall | null {
  const record = asRecord(value);
  if (record === null) return null;

  const route = readString(record, 'route');
  const method = readString(record, 'method');
  if (route !== MONITOR_ROUTE) {
    throw new Error(`The pipeline asked for ${route ?? 'no route'}, not ${MONITOR_ROUTE}.`);
  }
  if (method !== 'GET' && method !== 'POST') {
    throw new Error(`The pipeline asked for method ${method ?? 'none'}.`);
  }

  const query: Record<string, string> = {};
  const rawQuery = readRecord(record, 'query');
  if (rawQuery !== null) {
    for (const [key, raw] of Object.entries(rawQuery)) {
      if (typeof raw === 'string') query[key] = raw;
      else if (typeof raw === 'number' && Number.isFinite(raw)) query[key] = String(raw);
    }
  }

  return {
    step: readString(record, 'step') ?? '',
    route,
    method,
    query,
    body: readRecord(record, 'body'),
  };
}

function monitorUrl(call: MonitorNextCall): string {
  const query = new URLSearchParams(call.query).toString();
  return query.length > 0 ? `${call.route}?${query}` : call.route;
}

/** One stage line. Warnings and disclosure default to "nothing was reported". */
function progress(
  state: StageState,
  detail: ReactNode | null,
  extra?: { warnings?: string[]; disclosure?: ReactNode | null },
): StageProgress {
  return {
    state,
    detail,
    warnings: extra?.warnings ?? [],
    disclosure: extra?.disclosure ?? null,
  };
}

function freshStages(): Record<MonitorStage, StageProgress> {
  return {
    posts: progress('pending', null),
    import: progress('pending', null),
    profile: progress('pending', null),
    comments: progress('pending', null),
    'comments-import': progress('pending', null),
    analyze: progress('pending', null),
  };
}

/**
 * USD, or an em-dash when there is no number. A missing estimate is never
 * printed as $0.00 — "not estimated" and "free" are different facts (rule 2).
 */
function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `$${value.toFixed(2)}`;
}

/** Postgres `numeric` can arrive as a string; anything unreadable stays null. */
function toNumberOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The rows /api/profile actually returns: the latest measurement per account
 * and the one before it. Nothing is interpolated between them.
 */
function profileHistoryRows(info: ProfileInfoResponse | null): ProfileHistoryRow[] {
  if (!info) return [];
  const rows: ProfileHistoryRow[] = [];

  for (const account of ACCOUNTS) {
    const history = info.accounts[account];
    if (!history) continue;
    const entries = [
      ['latest', history.latest],
      ['previous', history.previous],
    ] as const;
    for (const [measurement, row] of entries) {
      if (!row) continue;
      rows.push({
        key: row.id,
        account,
        measurement,
        taken_on: row.taken_on,
        followers: row.followers,
        following: row.following,
        posts_count: row.posts_count,
      });
    }
  }

  return rows;
}

export default function DataPage() {
  const { t, tt, isRTL } = useLocale();
  const { message, notification } = App.useApp();

  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [pillars, setPillars] = useState<PillarRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);

  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [takenOn, setTakenOn] = useState<Dayjs>(dayjs());
  const [ingesting, setIngesting] = useState<boolean>(false);
  /** What the last hand upload dropped. Cleared when a new one starts, so a
   *  stale list can never be read as describing the current snapshot. */
  const [ingestWarnings, setIngestWarnings] = useState<string[]>([]);
  const draggerRef = useRef<HTMLDivElement | null>(null);

  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [refreshResult, setRefreshResult] = useState<RefreshResponse | null>(null);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);

  const [postsCache, setPostsCache] = useState<Record<string, PostRow[]>>({});
  const [postsLoading, setPostsLoading] = useState<Record<string, boolean>>({});
  const [segmentByRow, setSegmentByRow] = useState<Record<string, Account | 'all'>>({});

  const scrapeRef = useRef<HTMLDivElement | null>(null);

  const [scrapeRuns, setScrapeRuns] = useState<ScrapeRunsResponse | null>(null);
  const [scrapeRunsLoading, setScrapeRunsLoading] = useState<boolean>(true);
  const [scrapeRunsError, setScrapeRunsError] = useState<{
    message: string;
    hint: string | null;
  } | null>(null);

  const [profileInfo, setProfileInfo] = useState<ProfileInfoResponse | null>(null);
  const [profileInfoLoading, setProfileInfoLoading] = useState<boolean>(true);
  const [profileInfoError, setProfileInfoError] = useState<{
    message: string;
    hint: string | null;
  } | null>(null);
  const [profileRunning, setProfileRunning] = useState<boolean>(false);
  const [profileWarnings, setProfileWarnings] = useState<string[]>([]);

  const [commentsInfo, setCommentsInfo] = useState<CommentsInfoResponse | null>(null);
  const [commentsInfoLoading, setCommentsInfoLoading] = useState<boolean>(true);
  const [commentsInfoError, setCommentsInfoError] = useState<{
    message: string;
    hint: string | null;
  } | null>(null);
  const [commentsPhase, setCommentsPhase] = useState<CommentsPhase>('idle');
  const [commentsRunStatus, setCommentsRunStatus] = useState<string | null>(null);
  const [commentsWarnings, setCommentsWarnings] = useState<string[]>([]);
  /** What the last import scraped and did not store. Null until one has run. */
  const [commentsSkipped, setCommentsSkipped] = useState<CommentsSkipped | null>(null);

  const [monitorPlan, setMonitorPlan] = useState<MonitorPlanResponse | null>(null);
  const [monitorPlanLoading, setMonitorPlanLoading] = useState<boolean>(true);
  const [monitorPlanError, setMonitorPlanError] = useState<{
    message: string;
    hint: string | null;
  } | null>(null);
  const [monitorRunning, setMonitorRunning] = useState<boolean>(false);
  const [monitorStages, setMonitorStages] = useState<Record<MonitorStage, StageProgress>>(
    freshStages(),
  );
  const [monitorStarted, setMonitorStarted] = useState<boolean>(false);

  const loadSnapshots = () => {
    setLoading(true);
    setError(null);
    apiGet<SnapshotsResponse>('/api/snapshots')
      .then((res) => {
        setSnapshots(res.snapshots);
        setPillars(res.pillars);
      })
      .catch((err: unknown) => setError(describeError(err)))
      .finally(() => setLoading(false));
  };

  /**
   * The scrape ledger. Every run is written to it before its actor is called,
   * so this is also where a blocked run's estimate shows up.
   */
  const loadScrapeRuns = () => {
    setScrapeRunsLoading(true);
    setScrapeRunsError(null);
    apiGet<ScrapeRunsResponse>('/api/scrape-runs')
      .then((res) => setScrapeRuns(res))
      .catch((err: unknown) => setScrapeRunsError(describeError(err)))
      .finally(() => setScrapeRunsLoading(false));
  };

  /** Pre-flight only: GET spends nothing, it just prices the run. */
  const loadProfileInfo = () => {
    setProfileInfoLoading(true);
    setProfileInfoError(null);
    apiGet<ProfileInfoResponse>('/api/profile')
      .then((res) => setProfileInfo(res))
      .catch((err: unknown) => setProfileInfoError(describeError(err)))
      .finally(() => setProfileInfoLoading(false));
  };

  const loadCommentsInfo = () => {
    setCommentsInfoLoading(true);
    setCommentsInfoError(null);
    apiGet<CommentsInfoResponse>('/api/comments')
      .then((res) => setCommentsInfo(res))
      .catch((err: unknown) => setCommentsInfoError(describeError(err)))
      .finally(() => setCommentsInfoLoading(false));
  };

  /**
   * The whole pipeline priced in one read. Every figure comes from a route that
   * only reads — no actor is started and no model is called — so the estimate
   * is on screen before the operator commits to any of it (rule 9).
   */
  const loadMonitorPlan = () => {
    setMonitorPlanLoading(true);
    setMonitorPlanError(null);
    apiGet<MonitorPlanResponse>(MONITOR_ROUTE)
      .then((res) => setMonitorPlan(res))
      .catch((err: unknown) => setMonitorPlanError(describeError(err)))
      .finally(() => setMonitorPlanLoading(false));
  };

  useEffect(() => {
    loadSnapshots();
    loadScrapeRuns();
    loadProfileInfo();
    loadCommentsInfo();
    loadMonitorPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleIngest = () => {
    if (fileList.length === 0) return;
    const form = new FormData();
    for (const file of fileList) {
      if (file.originFileObj) {
        form.append('files', file.originFileObj);
      }
    }
    form.append('taken_on', toIsoDate(takenOn));
    setIngesting(true);
    setIngestWarnings([]);
    apiUpload<IngestResponse>('/api/ingest', form)
      .then((res) => {
        notification.success({
          message: tt('تم رفع اللقطة', 'Snapshot ingested'),
          description: tt(
            `منشورات: ${res.counts.posts} · شخصي: ${res.counts.personal} · أكاديمية: ${res.counts.academy} · جديدة منذ السابقة: ${res.counts.new_since_previous} · تكرارات محذوفة: ${res.counts.duplicates_skipped} · غير موجهة: ${res.counts.unroutable_skipped}`,
            `Posts: ${res.counts.posts} · Personal: ${res.counts.personal} · Academy: ${res.counts.academy} · New since previous: ${res.counts.new_since_previous} · Duplicates skipped: ${res.counts.duplicates_skipped} · Unroutable skipped: ${res.counts.unroutable_skipped}`,
          ),
        });
        setIngestWarnings(res.warnings);
        setFileList([]);
        loadSnapshots();
      })
      .catch((err: unknown) => {
        const desc = describeError(err);
        notification.error({
          message: desc.message,
          description: desc.hint ?? undefined,
        });
      })
      .finally(() => setIngesting(false));
  };

  const handleRefresh = () => {
    setRefreshing(true);
    apiSend<RefreshResponse>('/api/refresh', 'POST')
      .then((res) => {
        setRefreshResult(res);
        setDrawerOpen(true);
        loadSnapshots();
      })
      .catch((err: unknown) => {
        const desc = describeError(err);
        notification.error({
          message: desc.message,
          description: desc.hint ?? undefined,
        });
      })
      .finally(() => setRefreshing(false));
  };

  const loadPostsFor = (snapshotId: string) => {
    if (postsCache[snapshotId] || postsLoading[snapshotId]) return;
    setPostsLoading((prev) => ({ ...prev, [snapshotId]: true }));
    apiGet<PostsResponse>(`/api/snapshots/${snapshotId}/posts`)
      .then((res) => {
        setPostsCache((prev) => ({ ...prev, [snapshotId]: res.posts }));
      })
      .catch((err: unknown) => {
        const desc = describeError(err);
        message.error(desc.message);
      })
      .finally(() => {
        setPostsLoading((prev) => ({ ...prev, [snapshotId]: false }));
      });
  };

  const scrollToDragger = () => {
    draggerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const scrollToScrapes = () => {
    scrapeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  /**
   * The profile scrape. Two results, one per canonical handle, so the route
   * runs it synchronously. The estimate is already on screen before this fires
   * (rule 9) and the button is disabled whenever the guard says no.
   */
  const handleProfileScrape = async () => {
    setProfileRunning(true);
    setProfileWarnings([]);
    try {
      const res = await apiSend<ProfileRunResponse>('/api/profile', 'POST');
      setProfileWarnings(res.warnings);
      notification.success({
        message: tt('تم تحديث الملف الشخصي', 'Profile refreshed'),
        description: tt(
          `نتائج: ${res.results} · صفوف محفوظة: ${res.saved} · تاريخ القياس: ${res.taken_on}`,
          `Results: ${res.results} · Rows saved: ${res.saved} · Taken on: ${res.taken_on}`,
        ),
      });
    } catch (err: unknown) {
      const desc = describeError(err);
      notification.error({ message: desc.message, description: desc.hint ?? undefined });
    } finally {
      setProfileRunning(false);
      loadProfileInfo();
      loadScrapeRuns();
    }
  };

  /**
   * The comment scrape: start → poll → import, the three steps the route
   * exposes. It is split that way because the top-N × per-post result count is
   * far more than one request should hold open.
   */
  const handleCommentsScrape = async () => {
    setCommentsWarnings([]);
    setCommentsSkipped(null);
    setCommentsRunStatus(null);
    setCommentsPhase('starting');
    try {
      const started = await apiSend<CommentsStartResponse>('/api/comments', 'POST', {
        action: 'start',
      });

      if (!started.started) {
        // Nothing in scope is a normal outcome, not a failure: no actor was
        // started and no ledger row was written.
        notification.info({
          message: tt('لم يبدأ أي استخراج', 'Nothing was started'),
          description: started.reason,
        });
        return;
      }

      setCommentsPhase('polling');
      setCommentsRunStatus(started.status);

      let poll: CommentsPollResponse | null = null;
      for (let attempt = 0; attempt < COMMENTS_POLL_MAX_ATTEMPTS; attempt += 1) {
        await wait(COMMENTS_POLL_MS);
        poll = await apiGet<CommentsPollResponse>(
          `/api/comments?runId=${encodeURIComponent(started.apify_run_id)}`,
        );
        setCommentsRunStatus(poll.status);
        if (poll.done) break;
      }

      if (poll === null || !poll.done) {
        notification.warning({
          message: tt('ما زال التشغيل جارياً', 'The run is still going'),
          description: tt(
            'توقّف الاستطلاع قبل انتهاء التشغيل. لم يُستورد شيء — أعد المحاولة لاحقاً من نفس التشغيل.',
            'Polling stopped before the run finished. Nothing was imported — the run is still on Apify.',
          ),
        });
        return;
      }

      if (poll.status !== 'SUCCEEDED') {
        notification.error({
          message: tt('انتهى التشغيل بحالة غير ناجحة', 'The run did not succeed'),
          description: `${poll.status} — ${tt('لم يُستورد شيء.', 'nothing was imported.')}`,
        });
        return;
      }

      setCommentsPhase('importing');
      const imported = await apiSend<CommentsImportResponse>('/api/comments', 'POST', {
        action: 'import',
        runId: started.apify_run_id,
        ledgerId: started.run_id,
        // The scope's own per-post cap travels with the run: falling back to the
        // default would discard comments that were already paid for.
        perPost: started.scope.per_post,
      });

      setCommentsWarnings(imported.warnings);
      // Scraped-and-discarded is not visible in `results` or `saved`, and it is
      // the loss this project keeps legislating against — so it is kept and
      // rendered rather than left in the response body.
      setCommentsSkipped(imported.skipped);
      notification.success({
        message: tt('تم استيراد التعليقات', 'Comments imported'),
        description: tt(
          `نتائج: ${imported.results} · محفوظة: ${imported.saved} · منشورات مغطاة: ${imported.posts_covered}`,
          `Results: ${imported.results} · Saved: ${imported.saved} · Posts covered: ${imported.posts_covered}`,
        ),
      });
    } catch (err: unknown) {
      const desc = describeError(err);
      notification.error({ message: desc.message, description: desc.hint ?? undefined });
    } finally {
      setCommentsPhase('idle');
      loadCommentsInfo();
      loadScrapeRuns();
    }
  };

  /* ------------------------------------------------- the monitor pipeline -- */

  const num = (value: number | null): ReactNode => (
    <span className="tq-num">{formatNumber(value)}</span>
  );

  /**
   * WHY THE ARABIC ORDINALS ARE ARABIC-INDIC AND THE METRICS ARE NOT.
   *
   * The app already draws this line and draws it consistently, so this file
   * follows it rather than inventing a third rule:
   *   - A bare number inside Arabic PROSE is Arabic-Indic. dashboard/page.tsx
   *     ('أعلى ٥ منشورات', '٤٥ يومًا'), campaigns/page.tsx ('٦ أسابيع') and
   *     login/LoginForm.tsx ('٦ أرقام') all do this. The stage ordinals below
   *     are that: prose, not measurement.
   *   - A MEASUREMENT is Latin-digit wherever it appears, which is what
   *     formatNumber() enforces ("Numbers stay Latin-digit everywhere: they are
   *     metrics, not prose", src/lib/date.ts) and why every count on this
   *     screen goes through `num()` into `.tq-num`. board/page.tsx's 'أعلى 10%'
   *     is that same class — a percentage — not a counter-example to the above.
   * So: ordinals stay Arabic-Indic here, and no digit in this file is written
   * into an Arabic string unless it is prose.
   */
  const stageLabel = (stage: MonitorStage): string => {
    switch (stage) {
      case 'posts':
        return tt('١ · استخراج المنشورات', '1 · Scrape posts');
      case 'import':
        return tt('٢ · بناء اللقطة', '2 · Build the snapshot');
      case 'profile':
        return tt('٣ · لقطة الملف الشخصي', '3 · Profile snapshot');
      case 'comments':
        return tt('٤ · استخراج التعليقات', '4 · Scrape comments');
      case 'comments-import':
        return tt('٥ · استيراد التعليقات', '5 · Import comments');
      case 'analyze':
        return tt('٦ · تحليل الجديد', '6 · Analyse what is new');
    }
  };

  const stageStateLabel = (state: StageState): string => {
    switch (state) {
      case 'pending':
        return tt('بالانتظار', 'Pending');
      case 'running':
        return tt('جارٍ', 'Running');
      case 'done':
        return tt('تم', 'Done');
      case 'skipped':
        return tt('متخطّى', 'Skipped');
      case 'failed':
        return tt('أخفق', 'Failed');
    }
  };

  /** A total, or null the moment one part of it is unknown. */
  const totalOrNull = (values: (number | null)[]): number | null => {
    let total = 0;
    for (const value of values) {
      if (value === null) return null;
      total += value;
    }
    return total;
  };

  /* --------------------------------------- what a step lost, on the screen -- */

  /**
   * The media mirror's outcome.
   *
   * The pass is DEFAULT-OFF, so "it did not run" and "it ran and mirrored
   * nothing" must not look alike: the first renders em-dashes and names the
   * flag, the second renders a zero it actually measured. A screen that showed
   * `0` for both would let a mirror failing on two hundred downloads pass for a
   * quiet, successful no-op — and until now no screen said either.
   */
  const renderMirror = (mirror: MirrorInfo): ReactNode => {
    const stateTag =
      mirror.enabled === null ? (
        <Tag color="red">{tt('تعذّر تنفيذه', 'Could not be attempted')}</Tag>
      ) : mirror.enabled ? (
        <Tag color="green">{tt('شُغِّل', 'Ran')}</Tag>
      ) : (
        <Tag color="gold">{tt('لم يُشغَّل — النسخ مطفأ', 'Did not run — the mirror is off')}</Tag>
      );

    const failures: string[] = [];
    if (mirror.pass_error !== null) {
      failures.push(`${tt('داخل المرور', 'Inside the pass')}: ${mirror.pass_error}`);
    }
    if (mirror.error !== null) {
      failures.push(`${tt('حول المرور', 'Around the pass')}: ${mirror.error}`);
    }

    return (
      <div style={{ marginBlockStart: 8 }}>
        <Descriptions
          size="small"
          column={{ xs: 1, sm: 2, lg: 3 }}
          title={tt('نسخ الوسائط', 'Media mirror')}
        >
          <Descriptions.Item label={tt('الحالة', 'Outcome')}>{stateTag}</Descriptions.Item>
          <Descriptions.Item label={tt('مرشّحة', 'Considered')}>
            {num(mirror.considered)}
          </Descriptions.Item>
          <Descriptions.Item label={tt('نُسخت', 'Mirrored')}>{num(mirror.mirrored)}</Descriptions.Item>
          <Descriptions.Item label={tt('كانت منسوخة', 'Already mirrored')}>
            {num(mirror.already_mirrored)}
          </Descriptions.Item>
          <Descriptions.Item label={tt('أخفقت', 'Failed')}>
            {num(mirror.failed_total)}
          </Descriptions.Item>
          <Descriptions.Item label={tt('تُخطّيت', 'Skipped')}>
            {num(mirror.skipped_total)}
          </Descriptions.Item>
          <Descriptions.Item label={tt('صفوف بلا حمولة خام', 'Rows with no raw payload')}>
            {num(mirror.posts_without_raw)}
          </Descriptions.Item>
        </Descriptions>

        {mirror.reason === null ? null : (
          <div dir="auto" className="tq-muted" style={{ fontSize: 12, marginBlockEnd: 8 }}>
            {mirror.reason}
          </div>
        )}

        {mirror.posts_without_raw !== null && mirror.posts_without_raw > 0 ? (
          <div dir="auto" className="tq-muted" style={{ fontSize: 12, marginBlockEnd: 8 }}>
            {tt(
              'صفوف بلا حمولة خام لا تحمل رابط صورة، فلم يُحاول نسخها: ',
              'Rows stored with no raw payload carry no thumbnail URL, so none was attempted: ',
            )}
            {num(mirror.posts_without_raw)}
          </div>
        ) : null}

        {mirror.index_complete === false ? (
          <div dir="auto" className="tq-muted" style={{ fontSize: 12, marginBlockEnd: 8 }}>
            {tt(
              'لم يُقرأ فهرس ما هو منسوخ بالكامل، فقد يُعاد تنزيل ملف موجود — إهدار، لا خطأ.',
              'The listing of what is already mirrored was incomplete, so an object it already has may be downloaded again — wasteful, never wrong.',
            )}
          </div>
        ) : null}

        {mirror.scan?.truncated === true ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBlockEnd: 8 }}
            message={tt('قراءة مقتطعة للمنشورات', 'The post read was truncated')}
            description={
              <>
                {tt('بلغت قراءة منشورات اللقطة سقفها البالغ ', "The read-back of the snapshot's posts filled its cap of ")}
                {num(mirror.scan.limit)}
                {tt(
                  ' صف، فما بعده لم يُعرض على النسخ أصلاً.',
                  ' rows, so nothing beyond it was ever offered to the mirror.',
                )}
              </>
            }
          />
        ) : null}

        {failures.length > 0 ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBlockEnd: 8 }}
            message={tt('أخفق نسخ الوسائط', 'The media mirror failed')}
            description={
              <>
                <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                  {failures.map((line, i) => (
                    <li key={i} dir="auto">
                      {line}
                    </li>
                  ))}
                </ul>
                <div>
                  {tt(
                    'المنشورات واللقطة محفوظة — النسخ يجري بعد إغلاق الاستيراد ولا يمكنه إبطاله.',
                    'The posts and the snapshot are stored: the mirror runs after the import is closed and cannot undo it.',
                  )}
                </div>
              </>
            }
          />
        ) : null}

        <WarningList warnings={mirror.warnings} />
      </div>
    );
  };

  /**
   * The population a comment scope was ranked over.
   *
   * Rule 9 is why this is on screen and not only in the response: an estimate
   * priced off a prefix of the account is a wrong number, and `truncated` is
   * the only thing that says the ranking saw a prefix.
   */
  const renderScopeCoverage = (scope: CommentsScopeView): ReactNode => (
    <>
      <Descriptions size="small" column={{ xs: 1, sm: 2 }} style={{ marginBlockEnd: 8 }}>
        <Descriptions.Item label={tt('منشورات رُتِّبت للاختيار', 'Posts ranked to choose from')}>
          {num(scope.candidates_scanned)}
        </Descriptions.Item>
        <Descriptions.Item label={tt('صفوف قُرئت', 'Scrape rows read')}>
          {num(scope.scan?.rows_fetched ?? null)}
        </Descriptions.Item>
        <Descriptions.Item label={tt('إعادات سحب مدموجة', 'Re-scrapes collapsed')}>
          {num(scope.scan?.duplicates_collapsed ?? null)}
        </Descriptions.Item>
        <Descriptions.Item label={tt('لقطات مرئية', 'Snapshots seen')}>
          {num(scope.scan?.snapshots_seen ?? null)}
        </Descriptions.Item>
      </Descriptions>

      {scope.scan?.truncated === true ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBlockEnd: 8 }}
          message={tt('النطاق مبنيّ على جزء من الحساب', 'The scope was built from part of the account')}
          description={
            <>
              {tt('بلغت قراءة المنشورات سقفها البالغ ', 'The post read filled its cap of ')}
              {num(scope.scan.limit)}
              {tt(
                ' صف، فما بعده لم يدخل الترتيب — والتقدير أعلاه مُسعَّر على هذا الجزء وحده.',
                ' rows, so nothing beyond it entered the ranking — and the estimate above is priced on that prefix alone.',
              )}
            </>
          }
        />
      ) : null}

      {scope.missing_post_ids.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBlockEnd: 8 }}
          message={
            <>
              {tt('منشورات مطلوبة لا يمكن استخراجها', 'Requested posts that cannot be scraped')}:{' '}
              {num(scope.missing_post_ids.length)}
            </>
          }
          description={
            <>
              <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                {scope.missing_post_ids.map((id) => (
                  <li key={id} dir="auto">
                    {id}
                  </li>
                ))}
              </ul>
              <div>
                {tt(
                  'إمّا أنها خارج نافذة المرشّحين أو بلا رابط دائم يُعطى للمشغّل.',
                  'Either outside the candidate window, or with no permalink to give the actor.',
                )}
              </div>
            </>
          }
        />
      ) : null}
    </>
  );

  /**
   * Comments that were scraped and then not stored.
   *
   * `results` minus `saved` does not say this: those two hide WHICH loss
   * happened, and two of these — `over_cap` and `unmatched_post` — are comments
   * the run paid Apify for and dropped on the floor.
   */
  const renderCommentsLoss = (skipped: CommentsSkippedView): ReactNode => (
    <div style={{ marginBlockStart: 8 }}>
      <Descriptions
        size="small"
        column={{ xs: 1, sm: 2, lg: 3 }}
        title={tt('تعليقات لم تُخزَّن', 'Comments not stored')}
      >
        <Descriptions.Item label={tt('الإجمالي', 'Total')}>
          {num(
            totalOrNull([
              skipped.duplicates,
              skipped.missing_id,
              skipped.missing_text,
              skipped.unrecognised,
              skipped.unmatched_post,
              skipped.over_cap,
            ]),
          )}
        </Descriptions.Item>
        <Descriptions.Item label={tt('فوق السقف لكل منشور', 'Over the per-post cap')}>
          {num(skipped.over_cap)}
        </Descriptions.Item>
        <Descriptions.Item label={tt('بلا منشور مطابق', 'No matching post')}>
          {num(skipped.unmatched_post)}
        </Descriptions.Item>
        <Descriptions.Item label={tt('مكرّرة', 'Duplicates')}>
          {num(skipped.duplicates)}
        </Descriptions.Item>
        <Descriptions.Item label={tt('بلا معرّف', 'No comment id')}>
          {num(skipped.missing_id)}
        </Descriptions.Item>
        <Descriptions.Item label={tt('بلا نص', 'No text')}>
          {num(skipped.missing_text)}
        </Descriptions.Item>
        <Descriptions.Item label={tt('غير معروفة الشكل', 'Not recognisable')}>
          {num(skipped.unrecognised)}
        </Descriptions.Item>
      </Descriptions>
      <div dir="auto" className="tq-muted" style={{ fontSize: 12 }}>
        {tt(
          'هذه تعليقات دُفع ثمنها ولم تصل الجدول. حمولتها الكاملة في التخزين، فما ينقصه منشور مطابق يمكن إعادة معالجته لاحقاً بلا تكلفة.',
          'These were paid for and never reached the table. Their complete payload is in storage, so the ones missing a post can be re-processed later at no cost.',
        )}
      </div>
    </div>
  );

  /**
   * Turns one step's response into a line of progress. Nothing here invents a
   * number: a count the payload does not carry renders as an em-dash.
   *
   * A step also gets to report what it LOST. `warnings` and the disclosure
   * block below are the difference between "the run finished" and "the run
   * finished, and here is what it dropped on the way" — a production scrape
   * once silently lost twelve items, which is why the warnings exist at all.
   */
  const describeStep = (stage: MonitorStage, res: JsonRecord): StageProgress => {
    const httpStatus = readNumber(res, 'status');
    const failedHint = (payload: JsonRecord | null): ReactNode => (
      <>
        {readString(payload, 'error') ?? tt('أخفقت الخطوة.', 'The step failed.')}
        {httpStatus === null ? null : <> · HTTP {num(httpStatus)}</>}
      </>
    );

    switch (stage) {
      case 'posts':
      case 'comments': {
        // A poll response is the one that carries `done`; the start response
        // that opened the step does not.
        const done = readBoolean(res, 'done');
        if (done !== null) {
          const runStatus = readString(res, 'status');
          const items = readNumber(res, 'item_count');
          return progress(
            done ? (runStatus === 'SUCCEEDED' ? 'done' : 'failed') : 'running',
            <>
              {runStatus ?? '—'} · {tt('عناصر', 'items')}: {num(items)}
            </>,
          );
        }

        if (stage === 'posts') {
          const runStatus = readString(res, 'status');
          const estimate = readRecord(res, 'estimate');
          return progress(
            'running',
            <>
              {runStatus ?? '—'} · {tt('مُقدَّرة بـ', 'priced at')}{' '}
              <span className="tq-num">{formatUsd(readNumber(estimate, 'usd'))}</span>
            </>,
          );
        }

        // The comment step's start: delegated to /api/comments, which refuses
        // itself when nothing is uncovered or the budget says no. Either way it
        // reports the scope it decided on, and that scope is what the estimate
        // was priced against — so it is shown on both outcomes, not just one.
        const payload = readRecord(res, 'comments');
        const scope = readCommentsScope(payload);
        const scopeBlock = scope === null ? null : renderScopeCoverage(scope);

        if (readBoolean(res, 'ok') !== true) {
          return progress('failed', failedHint(payload), { disclosure: scopeBlock });
        }
        if (readBoolean(res, 'started') !== true) {
          return progress(
            'skipped',
            readString(payload, 'reason') ?? tt('لا شيء ضمن النطاق.', 'Nothing was in scope.'),
            { disclosure: scopeBlock },
          );
        }
        return progress('running', readString(payload, 'status') ?? '—', {
          disclosure: scopeBlock,
        });
      }

      case 'import': {
        const counts = readRecord(res, 'counts');
        // `...result` is spread into this response, so createSnapshotFrom's
        // warnings are right here — one readable line per skip reason.
        const warnings = readStringArray(res, 'warnings');
        const mirror = readMirror(res);
        return progress(
          'done',
          <>
            {tt('عناصر', 'items')}: {num(readNumber(res, 'results'))} ·{' '}
            {tt('منشورات', 'posts')}: {num(readNumber(counts, 'posts'))} ·{' '}
            {tt('جديدة منذ السابقة', 'new since previous')}:{' '}
            {num(readNumber(counts, 'new_since_previous'))}
          </>,
          { warnings, disclosure: mirror === null ? null : renderMirror(mirror) },
        );
      }

      case 'profile': {
        const payload = readRecord(res, 'profile');
        if (readBoolean(res, 'ok') !== true) {
          return progress('failed', failedHint(payload), {
            warnings: readStringArray(payload, 'warnings'),
          });
        }
        return progress(
          'done',
          <>
            {tt('نتائج', 'results')}: {num(readNumber(payload, 'results'))} ·{' '}
            {tt('صفوف محفوظة', 'rows saved')}: {num(readNumber(payload, 'saved'))}
          </>,
          { warnings: readStringArray(payload, 'warnings') },
        );
      }

      case 'comments-import': {
        const payload = readRecord(res, 'comments');
        const warnings = readStringArray(payload, 'warnings');
        const skipped = readCommentsSkipped(payload);
        const lossBlock = skipped === null ? null : renderCommentsLoss(skipped);

        if (readBoolean(res, 'ok') !== true) {
          return progress('failed', failedHint(payload), { warnings, disclosure: lossBlock });
        }
        return progress(
          'done',
          <>
            {tt('محفوظة', 'saved')}: {num(readNumber(payload, 'saved'))} ·{' '}
            {tt('منشورات مغطاة', 'posts covered')}:{' '}
            {num(readNumber(payload, 'posts_covered'))}
          </>,
          { warnings, disclosure: lossBlock },
        );
      }

      case 'analyze': {
        const skipped = readString(res, 'skipped_reason');
        if (skipped !== null) return progress('skipped', skipped);

        const payload = readRecord(res, 'analyze');
        const warnings = readStringArray(payload, 'warnings');
        if (readBoolean(res, 'ran') !== true) {
          return progress('failed', failedHint(payload), { warnings });
        }
        return progress(
          readBoolean(res, 'done') === true ? 'done' : 'running',
          <>
            {tt('محلَّلة', 'analysed')}: {num(readNumber(payload, 'analyzed'))} ·{' '}
            {tt('متبقٍ', 'remaining')}: {num(readNumber(payload, 'remaining'))}
          </>,
          { warnings },
        );
      }
    }
  };

  /**
   * One operator gesture, the whole v3 pipeline: posts → snapshot → profile →
   * comments → analyse. The order is not hard-coded here — each response says
   * what to call next and this follows it, so the route stays the single owner
   * of the sequence and a step added there needs no change on this screen.
   *
   * The two cards below remain: an operator who wants only a cheap profile
   * refresh should not have to buy a full run to get one.
   */
  const handleMonitorRun = async () => {
    const stages = freshStages();
    setMonitorStages({ ...stages });
    setMonitorStarted(true);
    setMonitorRunning(true);

    const mark = (stage: MonitorStage, step: StageProgress) => {
      stages[stage] = step;
      setMonitorStages({ ...stages });
    };

    /**
     * Once the chain has stopped, a stage still reading "pending" would suggest
     * it is about to run. It is not: the pipeline never got to it — either an
     * earlier step ended the chain or nothing routed to it.
     */
    const sweepUnreached = () => {
      for (const stage of MONITOR_STAGES) {
        if (stages[stage].state === 'pending') {
          stages[stage] = progress(
            'skipped',
            tt('لم تُستدعَ في هذا التشغيل.', 'Not reached in this run.'),
          );
        }
      }
      setMonitorStages({ ...stages });
    };

    // The chain's first link. Every later one comes from the route itself.
    let call: MonitorNextCall | null = {
      step: 'posts',
      route: MONITOR_ROUTE,
      method: 'POST',
      query: {},
      body: { action: 'start' },
    };
    let current: MonitorStage | null = null;
    let calls = 0;

    try {
      while (call !== null) {
        if (calls >= MONITOR_MAX_CALLS) {
          throw new Error(
            tt(
              `توقّف المسار بعد ${MONITOR_MAX_CALLS} استدعاءً دون أن ينتهي. لم يُلغَ أي تشغيل على Apify.`,
              `The pipeline stopped after ${MONITOR_MAX_CALLS} calls without finishing. Nothing was cancelled on Apify.`,
            ),
          );
        }
        calls += 1;

        const stage = toStage(call.step);
        if (stage !== null) {
          current = stage;
          if (stages[stage].state === 'pending') mark(stage, progress('running', null));
        }

        // The only GET in this chain is a poll, so it is always paced.
        if (call.method === 'GET') await wait(MONITOR_POLL_MS);

        const raw: unknown =
          call.method === 'GET'
            ? await apiGet<unknown>(monitorUrl(call))
            : await apiSend<unknown>(call.route, 'POST', call.body ?? {});

        const res = asRecord(raw);
        if (res === null) throw new Error('The pipeline returned a body that is not an object.');

        const reported = toStage(readString(res, 'step')) ?? stage;
        if (reported !== null) {
          current = reported;
          mark(reported, describeStep(reported, res));
        }

        call = parseNext(res['next']);
      }

      sweepUnreached();

      const failed = MONITOR_STAGES.filter((s) => stages[s].state === 'failed');
      const finished = MONITOR_STAGES.filter((s) => stages[s].state === 'done');
      const skipped = MONITOR_STAGES.filter((s) => stages[s].state === 'skipped');
      // A run can succeed at every stage and still have lost items on the way.
      // The toast is the only thing an operator is guaranteed to look at, so it
      // says how many lines are waiting below rather than letting a green
      // "complete" stand in for "nothing went wrong".
      const noted = MONITOR_STAGES.reduce((sum, s) => sum + stages[s].warnings.length, 0);
      const notedLine = tt(
        noted > 0 ? ` · ملاحظات مسجَّلة: ${noted} (أسفل الخطوات)` : '',
        noted > 0 ? ` · warnings reported: ${noted} (listed under the stages)` : '',
      );

      if (failed.length > 0) {
        notification.warning({
          message: tt('انتهى المسار مع إخفاقات', 'The pipeline finished with failures'),
          description: tt(
            `أخفقت: ${failed.join(' · ')} — ما اكتمل قبلها محفوظ.${notedLine}`,
            `Failed: ${failed.join(' · ')} — everything that completed before them is stored.${notedLine}`,
          ),
        });
      } else {
        notification.success({
          message: tt('اكتمل تشغيل المراقبة', 'Monitor run complete'),
          description: tt(
            `خطوات مكتملة: ${finished.length}/${MONITOR_STAGES.length} · متخطّاة: ${skipped.length}${notedLine}`,
            `Stages completed: ${finished.length}/${MONITOR_STAGES.length} · skipped: ${skipped.length}${notedLine}`,
          ),
        });
      }
    } catch (err: unknown) {
      const desc = describeError(err);
      if (current !== null) {
        // The stage may already have reported warnings or a disclosure before
        // the throw; keeping them is the point of surfacing them at all.
        const before = stages[current];
        mark(
          current,
          progress(
            'failed',
            <>
              {desc.message}
              {desc.hint === null ? null : <> · {desc.hint}</>}
            </>,
            { warnings: before.warnings, disclosure: before.disclosure },
          ),
        );
      }
      sweepUnreached();
      notification.error({ message: desc.message, description: desc.hint ?? undefined });
    } finally {
      setMonitorRunning(false);
      loadSnapshots();
      loadScrapeRuns();
      loadProfileInfo();
      loadCommentsInfo();
      loadMonitorPlan();
    }
  };

  const columns: ColumnsType<SnapshotRow> = [
    {
      title: tt('التاريخ', 'Taken on'),
      dataIndex: 'taken_on',
      key: 'taken_on',
      render: (value: string) => formatDate(value, isRTL ? 'ar' : 'en'),
    },
    {
      title: tt('إجمالي المنشورات', 'Total posts'),
      key: 'post_count_total',
      render: (_: unknown, row: SnapshotRow) => (
        <span className="tq-num">{row.stats.post_count.personal + row.stats.post_count.academy}</span>
      ),
    },
    {
      title: tt('متوسط التفاعل (شخصي)', 'Avg engagement (personal)'),
      key: 'avg_engagement_personal',
      render: (_: unknown, row: SnapshotRow) => (
        <span className="tq-num">{row.stats.avg_engagement.personal ?? '—'}</span>
      ),
    },
    {
      title: tt('متوسط التفاعل (أكاديمية)', 'Avg engagement (academy)'),
      key: 'avg_engagement_academy',
      render: (_: unknown, row: SnapshotRow) => (
        <span className="tq-num">{row.stats.avg_engagement.academy ?? '—'}</span>
      ),
    },
    {
      title: tt('المتابعون (شخصي)', 'Followers (personal)'),
      key: 'followers_personal',
      render: (_: unknown, row: SnapshotRow) => (
        <span className="tq-num">{row.stats.followers.personal ?? '—'}</span>
      ),
    },
    {
      title: tt('المتابعون (أكاديمية)', 'Followers (academy)'),
      key: 'followers_academy',
      render: (_: unknown, row: SnapshotRow) => (
        <span className="tq-num">{row.stats.followers.academy ?? '—'}</span>
      ),
    },
    {
      title: tt('أفضل تنسيق (شخصي)', 'Top format (personal)'),
      key: 'top_format_personal',
      render: (_: unknown, row: SnapshotRow) => row.stats.top_format.personal ?? '—',
    },
    {
      title: tt('أفضل تنسيق (أكاديمية)', 'Top format (academy)'),
      key: 'top_format_academy',
      render: (_: unknown, row: SnapshotRow) => row.stats.top_format.academy ?? '—',
    },
    {
      title: tt('تاريخ الإنشاء', 'Created at'),
      dataIndex: 'created_at',
      key: 'created_at',
      render: (value: string) => formatDateTime(value, isRTL ? 'ar' : 'en'),
    },
  ];

  const renderExpandedRow = (row: SnapshotRow) => {
    const posts = postsCache[row.id];
    const isLoading = postsLoading[row.id];
    if (isLoading || !posts) {
      return <Skeleton active paragraph={{ rows: 3 }} />;
    }

    const segment = segmentByRow[row.id] ?? 'all';
    const filteredPosts = segment === 'all' ? posts : posts.filter((p) => p.account === segment);

    const mediaTypes = Array.from(
      new Set(posts.map((p) => p.media_type).filter((v): v is string => v !== null)),
    );

    const innerColumns: ColumnsType<PostRow> = [
      {
        title: tt('الترتيب', 'Rank'),
        dataIndex: 'rank',
        key: 'rank',
        render: (value: number | null) => <span className="tq-num">{value ?? '—'}</span>,
      },
      {
        title: t.common.account,
        dataIndex: 'account',
        key: 'account',
        render: (value: Account) => (value === 'personal' ? t.common.personal : t.common.academy),
      },
      {
        title: tt('نوع الوسائط', 'Media type'),
        dataIndex: 'media_type',
        key: 'media_type',
        filters: mediaTypes.map((mt) => ({ text: mt, value: mt })),
        onFilter: (value, record) => record.media_type === value,
        render: (value: string | null) => value ?? '—',
      },
      {
        title: tt('الإعجابات', 'Likes'),
        dataIndex: 'likes',
        key: 'likes',
        render: (value: number | null) => <span className="tq-num">{value ?? '—'}</span>,
      },
      {
        title: tt('التعليقات', 'Comments'),
        dataIndex: 'comments',
        key: 'comments',
        render: (value: number | null) => <span className="tq-num">{value ?? '—'}</span>,
      },
      {
        title: tt('التفاعل', 'Engagement'),
        dataIndex: 'engagement',
        key: 'engagement',
        render: (value: number) => <span className="tq-num">{value}</span>,
      },
      {
        title: tt('تاريخ النشر', 'Posted at'),
        dataIndex: 'posted_at',
        key: 'posted_at',
        render: (value: string | null) => formatDate(value, isRTL ? 'ar' : 'en'),
      },
      {
        title: tt('مقتطف التعليق', 'Caption excerpt'),
        dataIndex: 'caption',
        key: 'caption',
        render: (value: string | null) =>
          value ? (
            <span dir="auto" className="tq-ar">
              {value.length > 80 ? `${value.slice(0, 80)}…` : value}
            </span>
          ) : (
            '—'
          ),
      },
      {
        title: '',
        key: 'open',
        render: (_: unknown, record: PostRow) =>
          record.url ? (
            <a href={record.url} target="_blank" rel="noreferrer">
              {tt('فتح', 'Open')}
            </a>
          ) : null,
      },
    ];

    return (
      <div>
        <Segmented
          style={{ marginBlockEnd: 12 }}
          value={segment}
          onChange={(value) =>
            setSegmentByRow((prev) => ({ ...prev, [row.id]: value as Account | 'all' }))
          }
          options={[
            { label: tt('الكل', 'All'), value: 'all' },
            { label: t.common.personal, value: 'personal' },
            { label: t.common.academy, value: 'academy' },
          ]}
        />
        <Table<PostRow>
          size="small"
          rowKey="id"
          columns={innerColumns}
          dataSource={filteredPosts}
          pagination={false}
          scroll={{ x: true }}
        />
      </div>
    );
  };

  /**
   * The ledger. Estimate and actual sit next to each other on purpose: a
   * blocked run carries an estimate and no results, and a run that came back
   * light is visible against what it was priced at.
   */
  const scrapeRunColumns: ColumnsType<ScrapeRunRow> = [
    {
      title: tt('النوع', 'Kind'),
      dataIndex: 'kind',
      key: 'kind',
      render: (value: string) => <Tag>{value}</Tag>,
    },
    {
      title: tt('المشغّل', 'Actor'),
      dataIndex: 'actor',
      key: 'actor',
      render: (value: string) => <span dir="auto">{value}</span>,
    },
    {
      title: tt('التقدير قبل التشغيل', 'Estimated before the run'),
      key: 'estimated_usd',
      render: (_: unknown, row: ScrapeRunRow) => (
        <span className="tq-num">{formatUsd(toNumberOrNull(row.estimated_usd))}</span>
      ),
    },
    {
      title: tt('النتائج الفعلية', 'Results returned'),
      key: 'actual_results',
      render: (_: unknown, row: ScrapeRunRow) => (
        <span className="tq-num">{formatNumber(toNumberOrNull(row.actual_results))}</span>
      ),
    },
    {
      title: tt('الحالة', 'Status'),
      dataIndex: 'status',
      key: 'status',
      render: (value: string) => <Tag color={STATUS_COLORS[value] ?? 'default'}>{value}</Tag>,
    },
    {
      title: tt('وقت التسجيل', 'Created at'),
      dataIndex: 'created_at',
      key: 'created_at',
      render: (value: string) => formatDateTime(value, isRTL ? 'ar' : 'en'),
    },
  ];

  const profileHistoryColumns: ColumnsType<ProfileHistoryRow> = [
    {
      title: t.common.account,
      dataIndex: 'account',
      key: 'account',
      render: (value: Account) => (value === 'personal' ? t.common.personal : t.common.academy),
    },
    {
      title: tt('القياس', 'Measurement'),
      dataIndex: 'measurement',
      key: 'measurement',
      render: (value: 'latest' | 'previous') => (
        <Tag color={value === 'latest' ? 'green' : 'default'}>
          {value === 'latest' ? tt('الأحدث', 'Latest') : tt('السابق', 'Previous')}
        </Tag>
      ),
    },
    {
      title: tt('التاريخ', 'Taken on'),
      dataIndex: 'taken_on',
      key: 'taken_on',
      render: (value: string) => formatDate(value, isRTL ? 'ar' : 'en'),
    },
    {
      title: tt('المتابعون', 'Followers'),
      dataIndex: 'followers',
      key: 'followers',
      render: (value: number | null) => <span className="tq-num">{formatNumber(value)}</span>,
    },
    {
      title: tt('يتابع', 'Following'),
      dataIndex: 'following',
      key: 'following',
      render: (value: number | null) => <span className="tq-num">{formatNumber(value)}</span>,
    },
    {
      title: tt('عدد المنشورات', 'Posts'),
      dataIndex: 'posts_count',
      key: 'posts_count',
      render: (value: number | null) => <span className="tq-num">{formatNumber(value)}</span>,
    },
  ];

  const historyRows = profileHistoryRows(profileInfo);

  /** A stage that could not be priced says so; it never contributes a zero. */
  const stepNote = (
    ok: boolean,
    error: string | undefined,
    budget: ScrapeBudgetInfo | undefined,
  ): string | null => {
    if (!ok) {
      return error ?? tt('تعذّر تسعير هذه الخطوة.', 'This stage could not be priced.');
    }
    if (budget !== undefined && !budget.allowed) {
      return budget.reason ?? tt('محجوبة بحارس الميزانية.', 'Blocked by the budget guard.');
    }
    return null;
  };

  /**
   * The whole run, stage by stage, before a credit is spent. Nulls are counted
   * rather than summed: "not priced" and "free" are different facts (rule 2).
   */
  const monitorEstimateRows: MonitorEstimateRow[] =
    monitorPlan === null
      ? []
      : [
          {
            key: 'posts',
            label: tt('منشورات (Apify)', 'Posts (Apify)'),
            usd: monitorPlan.steps.posts.estimate.usd,
            note: stepNote(true, undefined, monitorPlan.steps.posts.budget),
          },
          {
            key: 'profile',
            label: tt('الملف الشخصي (Apify)', 'Profile (Apify)'),
            usd: monitorPlan.steps.profile.estimate?.usd ?? null,
            note: stepNote(
              monitorPlan.steps.profile.ok,
              monitorPlan.steps.profile.error,
              monitorPlan.steps.profile.budget,
            ),
          },
          {
            key: 'comments',
            label: tt('التعليقات (Apify)', 'Comments (Apify)'),
            usd: monitorPlan.steps.comments.estimate?.usd ?? null,
            note: stepNote(
              monitorPlan.steps.comments.ok,
              monitorPlan.steps.comments.error,
              monitorPlan.steps.comments.budget,
            ),
          },
          {
            key: 'analyze',
            label: tt('التحليل (نموذج)', 'Analysis (model)'),
            usd: monitorPlan.steps.analyze.estimate?.usd ?? null,
            // An unpriced model is a different fact from a failed stage, and the
            // route already says which: `unpriced_reason` names the model it
            // has no verified rate for. Without it this line is an em-dash with
            // no note beside it — indistinguishable, on screen, from free.
            note:
              stepNote(
                monitorPlan.steps.analyze.ok,
                monitorPlan.steps.analyze.error,
                undefined,
              ) ?? (monitorPlan.steps.analyze.estimate?.unpriced_reason ?? null),
          },
        ];

  const monitorPricedUsd = monitorEstimateRows
    .map((row) => row.usd)
    .filter((usd): usd is number => usd !== null);
  const monitorTotalUsd =
    monitorPricedUsd.length > 0
      ? Number(monitorPricedUsd.reduce((sum, usd) => sum + usd, 0).toFixed(2))
      : null;
  const monitorNotPriced = monitorEstimateRows.length - monitorPricedUsd.length;

  const monitorEstimateColumns: ColumnsType<MonitorEstimateRow> = [
    {
      title: tt('الخطوة', 'Stage'),
      dataIndex: 'label',
      key: 'label',
    },
    {
      title: tt('التكلفة التقديرية', 'Estimated cost'),
      key: 'usd',
      render: (_: unknown, row: MonitorEstimateRow) => (
        <span className="tq-num">{formatUsd(row.usd)}</span>
      ),
    },
    {
      title: tt('ملاحظة', 'Note'),
      key: 'note',
      render: (_: unknown, row: MonitorEstimateRow) =>
        row.note === null ? '—' : <span dir="auto">{row.note}</span>,
    },
  ];

  /** The pre-flight numbers. Always on screen before a run button is offered. */
  const renderEstimate = (estimate: ScrapeEstimateInfo, budget: ScrapeBudgetInfo) => (
    <Descriptions size="small" column={1} style={{ marginBlockEnd: 12 }}>
      <Descriptions.Item label={tt('المشغّل', 'Actor')}>
        <span dir="auto">{estimate.actor}</span>
      </Descriptions.Item>
      <Descriptions.Item label={tt('عدد النتائج المتوقّع', 'Results priced')}>
        <span className="tq-num">{formatNumber(estimate.result_count)}</span>
      </Descriptions.Item>
      <Descriptions.Item label={tt('السعر لكل 1,000', 'Rate per 1,000')}>
        <span className="tq-num">{formatUsd(estimate.rate_per_1000)}</span>
      </Descriptions.Item>
      <Descriptions.Item label={tt('التكلفة التقديرية', 'Estimated cost')}>
        <span className="tq-num">{formatUsd(estimate.usd)}</span>
      </Descriptions.Item>
      <Descriptions.Item label={tt('سقف الميزانية', 'Budget ceiling')}>
        <span className="tq-num">{formatUsd(budget.budget_usd)}</span>
      </Descriptions.Item>
    </Descriptions>
  );

  /** Why the run is refused, verbatim from the guard — it carries the numbers. */
  const renderBlocked = (budget: ScrapeBudgetInfo) =>
    budget.allowed ? null : (
      <Alert
        type="error"
        showIcon
        style={{ marginBlockEnd: 12 }}
        message={tt('محجوب قبل الإنفاق', 'Blocked before spending')}
        description={
          <>
            <div>{budget.reason ?? tt('حجبه حارس الميزانية.', 'Blocked by the budget guard.')}</div>
            {budget.shortfall_usd !== null ? (
              <div>
                {tt('الفارق فوق السقف', 'Over the ceiling by')}:{' '}
                <span className="tq-num">{formatUsd(budget.shortfall_usd)}</span>
              </div>
            ) : null}
          </>
        }
      />
    );

  const refreshButton = (
    <Popconfirm
      title={tt('تشغيل التحديث؟', 'Run refresh?')}
      description={tt(
        'سيعيد حساب الفروق، ويحدّث حقائق العلامة، ويعيد توليد المحاور، ويكمل تفاعل الأفكار المنشورة.',
        'Recomputes the diff, updates brand facts, regenerates pillars, and backfills engagement on shipped concepts.',
      )}
      onConfirm={handleRefresh}
      okText={t.common.save}
      cancelText={t.common.cancel}
    >
      <Button type="primary" loading={refreshing}>
        {tt('تشغيل التحديث', 'Run Refresh')}
      </Button>
    </Popconfirm>
  );

  if (loading) {
    return (
      <div className="tq-page">
        <PageHeader title={t.nav.data} extra={refreshButton} />
        <LoadingBlock />
      </div>
    );
  }

  if (error) {
    return (
      <div className="tq-page">
        <PageHeader title={t.nav.data} extra={refreshButton} />
        <ErrorState error={error.message} hint={error.hint} onRetry={loadSnapshots} />
      </div>
    );
  }

  return (
    <div className="tq-page">
      <PageHeader
        title={t.nav.data}
        subtitle={tt(
          'غرفة المحرّك: من أين تأتي كل الأرقام، وما كلفة كل عملية استخراج، وماذا عاد منها فعلاً.',
          'The engine room: where every figure comes from, what each scrape costs, and what actually came back.',
        )}
        extra={refreshButton}
      />

      <Card title={tt('رفع تصدير', 'Upload export')} style={{ marginBlockEnd: 16 }}>
        <div ref={draggerRef}>
        <Upload.Dragger
          multiple
          accept=".json,application/json"
          beforeUpload={() => false}
          fileList={fileList}
          onChange={(info) => setFileList(info.fileList)}
        >
          <p>{tt('اسحب ملفات JSON هنا أو انقر للاختيار', 'Drag JSON files here or click to select')}</p>
        </Upload.Dragger>
        <Typography.Text type="secondary" style={{ display: 'block', marginBlockStart: 8 }}>
          {tt(
            'يقبل ملفات JSON من Apify Instagram scraper. تُدمج الملفات، وتُزال التكرارات حسب معرّف المنشور، ويُوجَّه كل منشور إلى حسابه حسب اسم المستخدم.',
            'Accepts Apify Instagram-scraper JSON. Files are merged, duplicates dropped by post id, and each post routed to its account by owner username.',
          )}
        </Typography.Text>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBlockStart: 16 }}>
          <DatePicker value={takenOn} onChange={(value) => setTakenOn(value ?? dayjs())} allowClear={false} />
          <Button type="primary" disabled={fileList.length === 0} loading={ingesting} onClick={handleIngest}>
            {tt('استيراد', 'Ingest')}
          </Button>
        </div>
        {ingestWarnings.length > 0 ? (
          <div style={{ marginBlockStart: 12 }}>
            <WarningList warnings={ingestWarnings} />
          </div>
        ) : null}
        </div>
      </Card>

      <Card title={tt('استخراج آلي', 'Automated scrapes')} style={{ marginBlockEnd: 16 }}>
        <div ref={scrapeRef}>
          <Typography.Text type="secondary" style={{ display: 'block', marginBlockEnd: 12 }}>
            {tt(
              'تُحسب التكلفة قبل أي تشغيل: عدد النتائج × سعر المشغّل لكل 1,000. إذا تجاوز التقدير سقف APIFY_BUDGET_USD يُعطَّل الزر ويُذكر السبب — ولا يُستدعى المشغّل أصلاً.',
              'Cost is computed before anything runs: result count × the actor rate per 1,000. Over the APIFY_BUDGET_USD ceiling the button is disabled with its reason, and the actor is never called.',
            )}
          </Typography.Text>

          <Card
            type="inner"
            size="small"
            title={tt('تشغيل المراقبة (المسار الكامل)', 'Run monitor (the full pipeline)')}
            style={{ marginBlockEnd: 16 }}
          >
            <Typography.Text
              type="secondary"
              style={{ display: 'block', fontSize: 12, marginBlockEnd: 12 }}
            >
              {tt(
                'ست خطوات بضغطة واحدة: منشورات ← لقطة ← ملف شخصي ← تعليقات ← استيراد ← تحليل الجديد. كل استجابة تُحدّد الاستدعاء التالي وهذه الشاشة تتبعه، ويُسجَّل كل تشغيل في السجل أدناه. الزرّان التاليان يبقيان كما هما: من أراد تحديث الملف الشخصي وحده لا يلزمه شراء تشغيل كامل.',
                'Six stages in one gesture: posts → snapshot → profile → comments → import → analyse what is new. Each response names the next call and this screen follows it, and every run is written to the ledger below. The two actions underneath stay as they are: wanting only a cheap profile refresh should not require buying a full run.',
              )}
            </Typography.Text>

            {monitorPlanLoading ? (
              <LoadingBlock rows={3} />
            ) : monitorPlanError ? (
              <ErrorState
                error={monitorPlanError.message}
                hint={monitorPlanError.hint}
                onRetry={loadMonitorPlan}
              />
            ) : monitorPlan ? (
              <>
                <div dir="auto" className="tq-muted" style={{ fontSize: 12, marginBlockEnd: 12 }}>
                  {`@${monitorPlan.handles.personal} · @${monitorPlan.handles.academy}`}
                  {' · '}
                  {tt('حدّ المنشورات لكل حساب', 'Post limit per profile')}:{' '}
                  <span className="tq-num">{formatNumber(monitorPlan.steps.posts.limit)}</span>
                </div>

                <Table<MonitorEstimateRow>
                  rowKey="key"
                  size="small"
                  pagination={false}
                  scroll={{ x: true }}
                  columns={monitorEstimateColumns}
                  dataSource={monitorEstimateRows}
                  style={{ marginBlockEnd: 12 }}
                />

                <div className="tq-muted" style={{ fontSize: 12, marginBlockEnd: 12 }}>
                  {tt(
                    'الإجمالي التقديري (Apify + النموذج)',
                    'Estimated total (Apify + model)',
                  )}
                  : <span className="tq-num">{formatUsd(monitorTotalUsd)}</span>
                  {' · '}
                  {tt('خطوات بلا تسعير', 'stages not priced')}:{' '}
                  <span className="tq-num">{formatNumber(monitorNotPriced)}</span>
                  {monitorNotPriced > 0
                    ? ` — ${tt(
                        'الخطوة غير المسعّرة لا تُحتسب صفراً؛ التقدير أدناه ناقص بمقدارها.',
                        'an unpriced stage is not counted as zero — the total above is short by whatever it costs.',
                      )}`
                    : ''}
                </div>

                {/* The comment line of the estimate above is priced on this
                    population. Rule 9: an estimate computed off the wrong
                    population is a wrong number, so the population is shown
                    next to the price rather than left inside the response. */}
                {monitorPlan.steps.comments.scope ? (
                  <div style={{ marginBlockEnd: 12 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {tt(
                        'ما سُعِّرت عليه خطوة التعليقات',
                        'What the comment stage was priced against',
                      )}
                    </Typography.Text>
                    {renderScopeCoverage(monitorPlan.steps.comments.scope)}
                  </div>
                ) : null}

                {monitorPlan.steps.analyze.ok ? (
                  <div className="tq-muted" style={{ fontSize: 12, marginBlockEnd: 12 }}>
                    {tt('منشورات محلَّلة', 'Posts analysed')}:{' '}
                    <span className="tq-num">
                      {formatNumber(monitorPlan.steps.analyze.analyzed ?? null)}
                    </span>
                    {' / '}
                    <span className="tq-num">
                      {formatNumber(monitorPlan.steps.analyze.total ?? null)}
                    </span>
                    {' · '}
                    {tt('بانتظار التحليل', 'awaiting analysis')}:{' '}
                    <span className="tq-num">
                      {formatNumber(monitorPlan.steps.analyze.remaining ?? null)}
                    </span>
                  </div>
                ) : null}

                {renderBlocked(monitorPlan.steps.posts.budget)}

                <Popconfirm
                  title={tt('تشغيل المراقبة كاملة؟', 'Run the full monitor?')}
                  description={
                    <span>
                      {tt('الإجمالي التقديري', 'Estimated total')}:{' '}
                      <span className="tq-num">{formatUsd(monitorTotalUsd)}</span>
                      {' · '}
                      {tt('خطوات بلا تسعير', 'stages not priced')}:{' '}
                      <span className="tq-num">{formatNumber(monitorNotPriced)}</span>
                    </span>
                  }
                  onConfirm={() => void handleMonitorRun()}
                  okText={tt('تشغيل', 'Run')}
                  cancelText={t.common.cancel}
                  disabled={!monitorPlan.steps.posts.budget.allowed}
                >
                  <Button
                    type="primary"
                    loading={monitorRunning}
                    disabled={!monitorPlan.steps.posts.budget.allowed}
                  >
                    {tt('تشغيل المراقبة', 'Run monitor')}
                  </Button>
                </Popconfirm>

                {monitorStarted ? (
                  <div style={{ marginBlockStart: 16 }}>
                    {MONITOR_STAGES.map((stage) => {
                      const step = monitorStages[stage];
                      return (
                        <div key={stage} style={{ marginBlockEnd: 12 }}>
                          <div
                            style={{
                              display: 'flex',
                              gap: 8,
                              flexWrap: 'wrap',
                              alignItems: 'baseline',
                            }}
                          >
                            <Tag color={STAGE_COLORS[step.state]} style={{ marginInlineEnd: 0 }}>
                              {stageStateLabel(step.state)}
                            </Tag>
                            <span>{stageLabel(stage)}</span>
                            {step.detail === null ? null : (
                              <span dir="auto" className="tq-muted" style={{ fontSize: 12 }}>
                                {step.detail}
                              </span>
                            )}
                          </div>

                          {/* What the step dropped, indented under the step that
                              dropped it. Rendered here rather than pooled at the
                              bottom so a warning cannot be read against the
                              wrong stage. */}
                          {step.warnings.length > 0 || step.disclosure !== null ? (
                            <div style={{ marginInlineStart: 12, marginBlockStart: 6 }}>
                              <WarningList warnings={step.warnings} />
                              {step.disclosure}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </>
            ) : null}
          </Card>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <Card
              type="inner"
              size="small"
              title={tt('لقطة الملف الشخصي', 'Profile snapshot')}
              style={{ flex: '1 1 340px' }}
            >
              {profileInfoLoading ? (
                <LoadingBlock rows={2} />
              ) : profileInfoError ? (
                <ErrorState
                  error={profileInfoError.message}
                  hint={profileInfoError.hint}
                  onRetry={loadProfileInfo}
                />
              ) : profileInfo ? (
                <>
                  <Typography.Text
                    type="secondary"
                    style={{ display: 'block', fontSize: 12, marginBlockEnd: 8 }}
                  >
                    {tt(
                      'عدّاد المتابعين غير موجود في تصدير المنشورات — هذه العملية هي مصدره الوحيد.',
                      'Follower counts are not in the post export — this scrape is their only source.',
                    )}
                  </Typography.Text>
                  <div dir="auto" className="tq-muted" style={{ fontSize: 12, marginBlockEnd: 12 }}>
                    {`@${profileInfo.handles.personal} · @${profileInfo.handles.academy}`}
                  </div>

                  {renderEstimate(profileInfo.estimate, profileInfo.budget)}
                  {renderBlocked(profileInfo.budget)}

                  <Popconfirm
                    title={tt('تشغيل استخراج الملف الشخصي؟', 'Run the profile scrape?')}
                    description={
                      <span>
                        {tt('التكلفة التقديرية', 'Estimated cost')}:{' '}
                        <span className="tq-num">{formatUsd(profileInfo.estimate.usd)}</span>
                        {' · '}
                        {tt('عدد النتائج', 'results')}:{' '}
                        <span className="tq-num">
                          {formatNumber(profileInfo.estimate.result_count)}
                        </span>
                      </span>
                    }
                    onConfirm={() => void handleProfileScrape()}
                    okText={tt('تشغيل', 'Run')}
                    cancelText={t.common.cancel}
                    disabled={!profileInfo.budget.allowed}
                  >
                    <Button
                      type="primary"
                      loading={profileRunning}
                      disabled={!profileInfo.budget.allowed}
                    >
                      {tt('تشغيل استخراج الملف', 'Run profile scrape')}
                    </Button>
                  </Popconfirm>

                  {profileWarnings.length > 0 ? (
                    <div style={{ marginBlockStart: 12 }}>
                      <WarningList warnings={profileWarnings} />
                    </div>
                  ) : null}
                </>
              ) : null}
            </Card>

            <Card
              type="inner"
              size="small"
              title={tt('استخراج التعليقات', 'Comment scrape')}
              style={{ flex: '1 1 340px' }}
            >
              {commentsInfoLoading ? (
                <LoadingBlock rows={2} />
              ) : commentsInfoError ? (
                <ErrorState
                  error={commentsInfoError.message}
                  hint={commentsInfoError.hint}
                  onRetry={loadCommentsInfo}
                />
              ) : commentsInfo ? (
                <>
                  <Typography.Text
                    type="secondary"
                    style={{ display: 'block', fontSize: 12, marginBlockEnd: 8 }}
                  >
                    {tt(
                      'التعليقات تُقرأ كجمهور لا كأفراد: مواضيع وأسئلة ونبرة وتوقيت على مستوى المجموع.',
                      'Comments are read as an audience, never per person: themes, questions, register and timing in aggregate.',
                    )}
                  </Typography.Text>

                  <Descriptions size="small" column={1} style={{ marginBlockEnd: 12 }}>
                    <Descriptions.Item label={tt('منشورات في النطاق', 'Posts in scope')}>
                      <span className="tq-num">
                        {formatNumber(commentsInfo.scope.target_post_count)}
                      </span>
                    </Descriptions.Item>
                    <Descriptions.Item label={tt('حد التعليقات لكل منشور', 'Comments per post')}>
                      <span className="tq-num">{formatNumber(commentsInfo.scope.per_post)}</span>
                    </Descriptions.Item>
                    <Descriptions.Item label={tt('مغطّاة مسبقاً', 'Already covered')}>
                      <span className="tq-num">
                        {formatNumber(commentsInfo.scope.already_covered)}
                      </span>
                    </Descriptions.Item>
                    <Descriptions.Item label={tt('تعليقات مخزَّنة', 'Comments stored')}>
                      <span className="tq-num">
                        {formatNumber(commentsInfo.corpus.comments_stored)}
                      </span>
                    </Descriptions.Item>
                  </Descriptions>

                  {/* The population the top-N was chosen out of, and whether the
                      read that produced it was a prefix of the account. */}
                  {renderScopeCoverage(commentsInfo.scope)}

                  {renderEstimate(commentsInfo.estimate, commentsInfo.budget)}
                  {renderBlocked(commentsInfo.budget)}

                  <Popconfirm
                    title={tt('تشغيل استخراج التعليقات؟', 'Run the comment scrape?')}
                    description={
                      <span>
                        {tt('التكلفة التقديرية', 'Estimated cost')}:{' '}
                        <span className="tq-num">{formatUsd(commentsInfo.estimate.usd)}</span>
                        {' · '}
                        {tt('عدد النتائج', 'results')}:{' '}
                        <span className="tq-num">
                          {formatNumber(commentsInfo.estimate.result_count)}
                        </span>
                      </span>
                    }
                    onConfirm={() => void handleCommentsScrape()}
                    okText={tt('تشغيل', 'Run')}
                    cancelText={t.common.cancel}
                    disabled={!commentsInfo.budget.allowed}
                  >
                    <Button
                      type="primary"
                      loading={commentsPhase !== 'idle'}
                      disabled={!commentsInfo.budget.allowed}
                    >
                      {tt('تشغيل استخراج التعليقات', 'Run comment scrape')}
                    </Button>
                  </Popconfirm>

                  {commentsPhase !== 'idle' ? (
                    <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 8 }}>
                      {commentsPhase === 'starting'
                        ? tt('جارٍ بدء التشغيل…', 'Starting the run…')
                        : commentsPhase === 'polling'
                          ? tt('بانتظار انتهاء التشغيل…', 'Waiting for the run to finish…')
                          : tt('جارٍ استيراد النتائج…', 'Importing the results…')}
                      {commentsRunStatus ? ` · ${commentsRunStatus}` : ''}
                    </div>
                  ) : null}

                  {commentsWarnings.length > 0 ? (
                    <div style={{ marginBlockStart: 12 }}>
                      <WarningList warnings={commentsWarnings} />
                    </div>
                  ) : null}

                  {commentsSkipped === null ? null : renderCommentsLoss(commentsSkipped)}
                </>
              ) : null}
            </Card>
          </div>
        </div>
      </Card>

      {snapshots.length === 0 ? (
        <EmptyState
          title={tt('لا لقطات بعد', 'No snapshots yet')}
          description={tt(
            'اللقطة هي حساب أحمد في لحظة واحدة: منشوراته وتفاعلها ووقت نشرها. كل شيء آخر في هذا المنتج يُحسب من هنا.',
            'A snapshot is the account frozen at one moment — the posts, their engagement, when they went up. Everything else in this product is computed from these.',
          )}
          hint={tt(
            'رفع تصدير Apify مجاني؛ الاستخراج الآلي هو ما يُحتسب.',
            'Ingesting an Apify export costs nothing. The scrape actions are what get billed.',
          )}
          actionLabel={tt('ارفع أول تصدير', 'Ingest the first export')}
          onAction={scrollToDragger}
        />
      ) : (
        <Table<SnapshotRow>
          rowKey="id"
          size="small"
          scroll={{ x: true }}
          columns={columns}
          dataSource={snapshots}
          style={{ marginBlockEnd: 16 }}
          expandable={{
            onExpand: (expanded, row) => {
              if (expanded) loadPostsFor(row.id);
            },
            expandedRowRender: renderExpandedRow,
          }}
        />
      )}

      <Card title={tt('سجل عمليات الاستخراج', 'Scrape ledger')} style={{ marginBlockEnd: 16 }}>
        {scrapeRunsLoading ? (
          <LoadingBlock rows={3} />
        ) : scrapeRunsError ? (
          <ErrorState
            error={scrapeRunsError.message}
            hint={scrapeRunsError.hint}
            onRetry={loadScrapeRuns}
          />
        ) : scrapeRuns === null || scrapeRuns.runs.length === 0 ? (
          <EmptyState
            description={tt(
              'لم تُسجَّل أي عملية استخراج بعد. كل تشغيل يُكتب هنا قبل استدعاء المشغّل — شغّل لقطة الملف الشخصي أو استخراج التعليقات.',
              'No scrape has been ledgered yet. Every run is written here before its actor is called — run the profile snapshot or the comment scrape.',
            )}
            actionLabel={tt('إلى الاستخراج الآلي', 'Go to the scrape actions')}
            onAction={scrollToScrapes}
          />
        ) : (
          <>
            <Typography.Text
              type="secondary"
              style={{ display: 'block', fontSize: 12, marginBlockEnd: 12 }}
            >
              {tt(
                'العمود الأول هو ما قُدِّرت به العملية قبل تشغيلها، والثاني هو ما عاد منها فعلاً. العملية المحجوبة تحمل تقديراً بلا نتائج — وتلك هي المقارنة.',
                'The first column is what the run was priced at before it started; the second is what actually came back. A blocked run carries an estimate and no results — that is the comparison.',
              )}
            </Typography.Text>

            <Table<ScrapeRunRow>
              rowKey="id"
              size="small"
              scroll={{ x: true }}
              columns={scrapeRunColumns}
              dataSource={scrapeRuns.runs}
              pagination={{ pageSize: 10 }}
            />

            <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 8 }}>
              {tt('إجمالي التقدير', 'Estimated total')}:{' '}
              <span className="tq-num">{formatUsd(scrapeRuns.totals.estimated_usd)}</span>
              {' · '}
              {tt('عمليات بتقدير', 'runs with an estimate')}:{' '}
              <span className="tq-num">{formatNumber(scrapeRuns.totals.runs_with_estimate)}</span>
              {' · '}
              {tt('بلا تقدير', 'not estimated')}:{' '}
              <span className="tq-num">{formatNumber(scrapeRuns.totals.runs_without_estimate)}</span>
              {' · '}
              {tt('إجمالي النتائج', 'results returned')}:{' '}
              <span className="tq-num">{formatNumber(scrapeRuns.totals.actual_results)}</span>
            </div>
          </>
        )}
      </Card>

      <Card title={tt('سجل الملف الشخصي', 'Profile history')} style={{ marginBlockEnd: 16 }}>
        {profileInfoLoading ? (
          <LoadingBlock rows={3} />
        ) : profileInfoError ? (
          <ErrorState
            error={profileInfoError.message}
            hint={profileInfoError.hint}
            onRetry={loadProfileInfo}
          />
        ) : historyRows.length === 0 ? (
          <EmptyState
            description={tt(
              'لا توجد لقطة ملف شخصي بعد. عدّاد المتابعين والمتابَعين لا يأتي مع تصدير المنشورات — شغّل لقطة الملف الشخصي.',
              'No profile snapshot has been taken yet. Follower and following counts do not come with the post export — run the profile snapshot.',
            )}
            actionLabel={tt('إلى الاستخراج الآلي', 'Go to the scrape actions')}
            onAction={scrollToScrapes}
          />
        ) : (
          <>
            <Typography.Text
              type="secondary"
              style={{ display: 'block', fontSize: 12, marginBlockEnd: 12 }}
            >
              {tt(
                'آخر قياسين لكل حساب، ولا شيء بينهما مُستنتج — ما لم يُقَس لا يُرسم.',
                'The two most recent measurements per account, with nothing interpolated between them — what was not measured is not drawn.',
              )}
            </Typography.Text>

            <Table<ProfileHistoryRow>
              rowKey="key"
              size="small"
              scroll={{ x: true }}
              columns={profileHistoryColumns}
              dataSource={historyRows}
              pagination={false}
            />
          </>
        )}
      </Card>

      <Card title={tt('المحاور الحالية', 'Current pillars')}>
        {pillars.length === 0 ? (
          <EmptyState
            title={tt('لا محاور بعد', 'No pillars yet')}
            description={tt(
              'المحاور هي المواضيع التي يدور حولها المحتوى فعلاً، مقروءةً من المنشورات المخزّنة — وعليها تُبنى الأفكار والحملات.',
              'The pillars are the themes the content actually revolves around, read back out of the stored posts. Concepts and campaigns are built on them.',
            )}
            hint={tt('يقرأ التحديث اللقطات ويعيد بناءها.', 'Refresh reads the snapshots and rebuilds them.')}
            actionLabel={tt('شغّل التحديث', 'Run Refresh')}
            onAction={handleRefresh}
          />
        ) : (
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            scroll={{ x: true }}
            dataSource={pillars}
            columns={[
              {
                title: tt('الاسم (عربي)', 'Name (Arabic)'),
                dataIndex: 'name_ar',
                key: 'name_ar',
                render: (value: string) => <ArabicText>{value}</ArabicText>,
              },
              {
                title: tt('الاسم (إنجليزي)', 'Name (English)'),
                dataIndex: 'name_en',
                key: 'name_en',
                render: (value: string | null) => value ?? '—',
              },
              {
                title: tt('عدد المنشورات', 'Post count'),
                dataIndex: 'post_count',
                key: 'post_count',
                render: (value: number) => <span className="tq-num">{value}</span>,
              },
              {
                title: tt('متوسط التفاعل', 'Avg engagement'),
                dataIndex: 'avg_engagement',
                key: 'avg_engagement',
                render: (value: number) => <span className="tq-num">{value}</span>,
              },
              {
                title: tt('نمط الافتتاحية', 'Hook pattern'),
                dataIndex: 'hook_pattern',
                key: 'hook_pattern',
                render: (value: string | null) =>
                  value ? (
                    <span dir="auto" className="tq-ar">
                      {value}
                    </span>
                  ) : (
                    '—'
                  ),
              },
            ] as ColumnsType<PillarRow>}
          />
        )}
      </Card>

      <Drawer
        title={tt('نتيجة التحديث', 'Refresh result')}
        placement={isRTL ? 'left' : 'right'}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={480}
      >
        {refreshResult ? (
          <>
            <Descriptions size="small" column={1} style={{ marginBlockEnd: 16 }}>
              <Descriptions.Item label={tt('تاريخ اللقطة', 'Snapshot taken on')}>
                {formatDate(refreshResult.snapshot.taken_on, isRTL ? 'ar' : 'en')}
              </Descriptions.Item>
              <Descriptions.Item label={tt('اللقطة السابقة', 'Previous snapshot')}>
                {refreshResult.previous
                  ? formatDate(refreshResult.previous.taken_on, isRTL ? 'ar' : 'en')
                  : '—'}
              </Descriptions.Item>
              <Descriptions.Item label={tt('حقائق محدّثة', 'Facts updated')}>
                <span className="tq-num">{refreshResult.facts_updated}</span>
              </Descriptions.Item>
              <Descriptions.Item label={tt('محاور مكتوبة', 'Pillars written')}>
                <span className="tq-num">{refreshResult.pillars_written}</span>
              </Descriptions.Item>
              <Descriptions.Item label={tt('أفكار مكتملة التفاعل', 'Concepts backfilled')}>
                <span className="tq-num">{refreshResult.shipped.backfilled}</span>
              </Descriptions.Item>
            </Descriptions>

            {/* Bound to a local so the null check narrows inside the map callback. */}
            {((diff) =>
              diff ? (
                <div style={{ marginBlockEnd: 16 }}>
                  {ACCOUNTS.map((account) => (
                    <div key={account} style={{ marginBlockEnd: 12 }}>
                      <Typography.Text strong>
                        {account === 'personal' ? t.common.personal : t.common.academy}
                      </Typography.Text>
                      <div>
                        {tt('المتابعون', 'Followers')}:{' '}
                        <span className="tq-num">
                          {formatSignedNumber(diff.followers[account])}
                        </span>
                      </div>
                      <div>
                        {tt('متوسط التفاعل', 'Avg engagement')}:{' '}
                        <span className="tq-num">
                          {formatSignedNumber(diff.avg_engagement[account])}
                        </span>
                      </div>
                      <div>
                        {tt('عدد المنشورات', 'Post count')}:{' '}
                        <span className="tq-num">{diff.post_count[account]}</span>
                      </div>
                    </div>
                  ))}
                  <div>
                    {tt('منشورات جديدة', 'New posts')}:{' '}
                    <span className="tq-num">{diff.new_post_count}</span>
                  </div>
                </div>
              ) : (
                <Typography.Text type="secondary">
                  {tt('لا توجد لقطة سابقة للمقارنة.', 'No previous snapshot to compare against.')}
                </Typography.Text>
              ))(refreshResult.diff)}

            {refreshResult.pillar_warnings.length > 0 ? (
              <Alert
                type="warning"
                style={{ marginBlockEnd: 16 }}
                message={tt('تحذيرات المحاور', 'Pillar warnings')}
                description={
                  <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                    {refreshResult.pillar_warnings.map((warning, i) => (
                      <li key={i}>{warning}</li>
                    ))}
                  </ul>
                }
              />
            ) : null}

            {refreshResult.shipped.unmatched.length > 0 ? (
              <div>
                <Typography.Text strong>
                  {tt('أفكار غير مطابقة', 'Unmatched concepts')}
                </Typography.Text>
                <ul style={{ marginBlockStart: 8, paddingInlineStart: 18 }}>
                  {refreshResult.shipped.unmatched.map((title, i) => (
                    <li key={i}>{title}</li>
                  ))}
                </ul>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {tt(
                    'لم يُعثر على منشور مطابق لهذه الأفكار — تأكد من صحة رابط إنستغرام.',
                    'No matching post was found for these concepts — check their Instagram URL.',
                  )}
                </Typography.Text>
              </div>
            ) : null}
          </>
        ) : null}
      </Drawer>
    </div>
  );
}
