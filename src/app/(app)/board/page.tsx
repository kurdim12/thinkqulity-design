'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Row,
  Col,
  Card,
  Space,
  Select,
  Segmented,
  Button,
  Tag,
  Descriptions,
  Typography,
  Progress,
  Modal,
  Tooltip,
  App,
} from 'antd';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { apiGet, apiSend, describeError } from '@/lib/client/api';
import {
  PageHeader,
  EmptyState,
  ErrorState,
  LoadingBlock,
  ArabicText,
  GroundingTag,
} from '@/components/ui';
import { AskAbout } from '@/components/AskAbout';
import { formatDate, formatDateTime, formatNumber } from '@/lib/date';
import type { Grounding } from '@/lib/types/db';

type BoardAccount = 'personal' | 'academy';
type PercentileBand = 'top10' | 'top25' | 'median' | 'bottom25';

interface BoardComputed {
  vs_account_avg: number;
  vs_format_avg: number;
  percentile: number;
  days_old: number | null;
}

interface BoardAnalysis {
  computed: BoardComputed;
  cluster_label: string | null;
  explanation: string | null;
  grounding: Grounding;
  model: string | null;
  /** When the comparatives below were computed. They are frozen at that moment. */
  created_at: string;
  /**
   * True when this analysis was written against an EARLIER scrape row of the
   * same post. The work was done and paid for — it is not "unanalysed" — but the
   * numbers in it were computed over the population as it stood then.
   */
  superseded: boolean;
}

/**
 * Whether this post has a mirrored thumbnail in the private bucket, and how to
 * read it. Three states, because the bucket can only prove two of them: an
 * object is there, an object is not there, or the listing that would have said
 * could not be read. The third is `null` and renders as an em-dash with its
 * reason — never as "no image", which would be a fact nobody measured.
 *
 * `src` is `/api/assets?path=…`: an operator-gated route that 307s to a
 * five-minute signed URL minted on the server. The signed URL itself never
 * reaches this bundle, which is the whole reason the Board reads images this
 * way instead of holding a URL of its own (hard rule 4).
 */
interface PostMedia {
  mirrored: boolean | null;
  path: string | null;
  src: string | null;
}

/** The image state of the cards on screen, as the route measured it. */
interface MediaRead {
  /** MIRROR_MEDIA, as the server reads it. The flag, never a secret's value. */
  enabled: boolean;
  index_complete: boolean;
  index_error: string | null;
  /** Cards examined. The three counts below sum to it. */
  examined: number;
  mirrored: number;
  not_mirrored: number;
  unknown: number;
}

interface BoardPost {
  id: string;
  /** The scrape this row came from. Returned because the board reads one row per post. */
  snapshot_id: string;
  account: BoardAccount;
  ig_id: string;
  url: string | null;
  caption: string | null;
  media_type: string | null;
  likes: number | null;
  /** The count Instagram reported for the post. Null = the scraper did not report one. */
  comments: number | null;
  engagement: number;
  posted_at: string | null;
  rank: number | null;
  /**
   * The scraper's `firstComment` for this post — comment text we actually hold,
   * which is a different fact from the count above. Null on every row ingested
   * before 0002_v3_ingestion added the column.
   */
  first_comment: string | null;
  /** Video plays, when the actor returned one. Null on non-video posts and on older rows. */
  video_play_count: number | null;
  analysis: BoardAnalysis | null;
  /** Whether a mirrored thumbnail exists for this post. See PostMedia above. */
  media: PostMedia;
}

interface BoardTotals {
  posts: number;
  /** Posts carrying an analysis, matched to the POST rather than to a scrape row. */
  analyzed: number;
  /** …of which the analysis hangs off the row displayed here. */
  analyzed_current: number;
  /** …and of which it was computed against an earlier scrape of the same post. */
  analyzed_superseded: number;
  account_avg: { personal: number | null; academy: number | null };
}

/** One capped read of `posts`, in both units. Same shape /api/audience reports. */
interface PopulationScan {
  rows_fetched: number;
  limit: number;
  truncated: boolean;
  /** Rows left once re-scrapes were collapsed. */
  distinct: number;
  duplicates_collapsed: number;
  snapshots_seen: number;
}

interface AnalysesRead {
  rows_read: number;
  /** Analyses whose post row was not in this read — a truncated scan, or a gone row. */
  unresolved: number;
}

interface BoardResponse {
  posts: BoardPost[];
  totals: BoardTotals;
  analyses: AnalysesRead;
  population: PopulationScan;
  media: MediaRead;
}

/**
 * The spend ceiling, with everything needed to say what it assumes. `usd` is
 * null when no published rate for the model has been verified — rendered as an
 * em-dash with the reason, never as 0.
 */
interface CostCeiling {
  usd: number | null;
  model: string;
  requests: number;
  prompt_chars: number;
  input_tokens: number;
  output_tokens: number;
  chars_per_token: number;
  rate_in_per_mtok: number | null;
  rate_out_per_mtok: number | null;
  unpriced_reason: string | null;
}

interface AnalyzeProgressResponse {
  total: number;
  analyzed: number;
  analyzed_current: number;
  analyzed_superseded: number;
  remaining: number;
  unresolved_analyses: number;
  estimate: CostCeiling;
  population: PopulationScan;
}

interface AnalyzeRunResponse {
  analyzed: number;
  analyzed_total: number;
  total: number;
  remaining: number;
  failed: number;
}

type AccountFilter = 'all' | BoardAccount;
type BandFilter = 'all' | PercentileBand;

/**
 * What names this post to a reader — used ONLY in the Ask affordance's
 * accessible name, never encoded and never sent (see src/lib/chat/scope.ts).
 * The post's own words when it has any; otherwise the id Instagram gave it,
 * which is a real identifier rather than a description nobody wrote.
 */
function postName(post: BoardPost): string {
  const caption = post.caption === null ? '' : post.caption.trim();
  return caption.length > 0 ? caption : post.ig_id;
}

function vsAccountColor(value: number): string {
  if (value > 1.5) return 'green';
  if (value < 0.75) return 'red';
  return 'default';
}

/**
 * The comment slot on a card, which has four genuinely different states.
 *
 * `post.comments` is the count Instagram reported; `post.first_comment` is
 * comment text this database actually holds. Collapsing the two would let a
 * post with 40 uningested comments read exactly like a post with none, which is
 * the quiet lie hard rule 2 exists to stop. So:
 *
 *   text present            -> quote it verbatim, dir="auto"
 *   count 0                 -> a measured zero: there is nothing to ingest
 *   count > 0, no text      -> comments exist and have not been pulled yet
 *   count null, no text     -> nothing was reported at all
 *
 * Nothing here substitutes a 0 for an absence, and no state is hidden.
 */
function TopComment({ post }: { post: BoardPost }) {
  const { tt } = useLocale();

  const raw = post.first_comment;
  const text = raw !== null && raw.trim().length > 0 ? raw : null;
  const count = post.comments;

  const label = (
    <Tooltip
      title={tt(
        'أول تعليق أعاده المُستخرِج لهذا المنشور — يُعرض كما هو دون تحرير.',
        "The scraper's first comment on this post — shown verbatim, unedited.",
      )}
    >
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {tt('أبرز تعليق', 'Top comment')}
      </Typography.Text>
    </Tooltip>
  );

  if (text !== null) {
    return (
      <div>
        {label}
        <ArabicText
          style={{
            marginBlockStart: 4,
            paddingInlineStart: 12,
            borderInlineStart: '3px solid var(--tq-gold)',
          }}
        >
          {text}
        </ArabicText>
      </div>
    );
  }

  const note =
    count === null
      ? tt(
          'لم يُعِد المُستخرِج عدد التعليقات لهذا المنشور، ولا يوجد نص تعليق مخزَّن — أعد استخراج المنشور من شاشة البيانات.',
          'The scraper reported no comment count for this post, and no comment text is stored — re-scrape it from the Data screen.',
        )
      : count === 0
        ? tt(
            'لا تعليقات على هذا المنشور — المُستخرِج أعاد صفراً، فليس هناك ما يُستورد.',
            'No comments on this post — the scraper returned zero, so there is nothing to ingest.',
          )
        : tt(
            'التعليقات لم تُستورد بعد — شغّل استخراج التعليقات من شاشة البيانات.',
            'Comments not ingested yet — run the comment scrape on the Data screen.',
          );

  return (
    <div>
      {label}
      <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 4 }}>
        {note}
      </div>
    </div>
  );
}

/**
 * The image slot on a card — which today, on every card, is the no-image state.
 *
 * WHY IT SITS BELOW THE CAPTION. The caption-first card was a deliberate v2
 * decision and this does not reverse it: the caption still leads, and the image
 * supports it. That ordering also means the DEFAULT case — no image — changes
 * the card by exactly one quiet line rather than by an empty grey box where a
 * picture is supposed to be. Nothing here is mirrored today: `posts.raw` is null
 * on all 320 stored rows, so the June CDN URLs have nothing to mirror FROM until
 * a refresh scrape runs, and MIRROR_MEDIA is off by default besides.
 *
 * FOUR STATES, AND NONE OF THEM IS A BROKEN IMAGE.
 *
 *   mirrored, loads      -> the thumbnail
 *   mirrored, won't load -> the object exists; this browser could not read it
 *   not mirrored         -> em-dash, with WHICH reason: the flag is off, or the
 *                           flag is on and there was nothing left to copy
 *   index unreadable     -> em-dash, said as unknown — not as "no image"
 *
 * An <img> is rendered ONLY in the first case, because `src` is populated only
 * when the bucket listing proved the object is there. That is what keeps the
 * browser's broken-image glyph off this screen: it is never asked to fetch
 * something that was not confirmed to exist (hard rule 2 — absent renders as an
 * em-dash, never as a zero and never as a failure the user has to interpret).
 */
function PostMediaSlot({ post, enabled }: { post: BoardPost; enabled: boolean | null }) {
  const { tt } = useLocale();
  const [failed, setFailed] = useState(false);

  const src = post.media.src;

  if (post.media.mirrored === true && src !== null && !failed) {
    return (
      <div style={{ lineHeight: 0 }}>
        {/* Plain <img>: /api/assets is an operator-gated redirect, not a
            configured next/image remote host. Same call the Brand screen makes. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          /* Factual, not descriptive: this app transcribes images, it does not
             invent captions for them. The alt names the post, nothing more. */
          alt={tt(`صورة مُرآة للمنشور ${post.ig_id}`, `Mirrored thumbnail for post ${post.ig_id}`)}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          style={{
            width: '100%',
            aspectRatio: '1 / 1',
            objectFit: 'cover',
            borderRadius: 8,
            border: '1px solid var(--tq-line)',
            background: 'var(--tq-line)',
          }}
        />
      </div>
    );
  }

  const label = failed
    ? tt('الصورة لم تُحمَّل', 'Image did not load')
    : post.media.mirrored === null
      ? tt('حالة الصورة غير معروفة', 'Image state unknown')
      : tt('لا صورة مُرآة', 'No mirrored image');

  const reason = failed
    ? tt(
        'الكائن موجود في التخزين، لكن المتصفح لم يستطع قراءته. القراءة تمرّ عبر \u200E/api/assets وتتطلّب جلسة مشغِّل، والرابط الموقَّع ينتهي خلال خمس دقائق — أعد تحميل الصفحة.',
        'The object is in storage, but this browser could not read it. The read goes through /api/assets, needs an operator session, and the signed URL it redirects to expires in five minutes — reload the page.',
      )
    : post.media.mirrored === null
      ? tt(
          'تعذّرت قراءة فهرس التخزين، فحالة صورة هذا المنشور غير معروفة — وهذا ليس نفيَ وجود صورة.',
          'The storage listing could not be read, so this post’s image state is unknown — which is not the same as saying it has no image.',
        )
      : enabled === true
        ? tt(
            'التدوير مفعَّل ولا يوجد كائن لهذا المنشور: إمّا أن حمولته لا تحمل رابط صورة، أو أن رابط الشبكة انتهت صلاحيته قبل أن تعمل النسخة.',
            'Mirroring is on and no object exists for this post: either its payload carries no image URL, or the CDN link had expired before the pass ran.',
          )
        : enabled === false
          ? tt(
              'MIRROR_MEDIA غير مفعَّل، فلم تُنسخ أي صورة إلى التخزين. البطاقة تبدأ بالنص، وهذا هو الوضع الافتراضي.',
              'MIRROR_MEDIA is not enabled, so no image has been copied into storage. The card leads with its caption — that is the default, not a failure.',
            )
          : // The flag was not in this render's data. Stating the absence is
            // honest; guessing which cause produced it would not be.
            tt(
              'لا يوجد كائن صورة لهذا المنشور في التخزين.',
              'No image object exists for this post in storage.',
            );

  return (
    <Tooltip title={reason}>
      <span className="tq-muted" style={{ fontSize: 12 }}>
        <span className="tq-num">—</span>
        {` ${label}`}
      </span>
    </Tooltip>
  );
}

/**
 * When the frozen tags above it were computed, and whether they describe the
 * scrape now on screen.
 *
 * The ×-multiples and the percentile were calculated at analysis time over the
 * population as it stood then; the engagement figure beside them is read live
 * from the row. Undated, the two read as one measurement taken at one moment,
 * which they are not.
 */
function AnalysisStamp({ analysis }: { analysis: BoardAnalysis }) {
  const { tt, isRTL } = useLocale();
  const when = formatDateTime(analysis.created_at, isRTL ? 'ar' : 'en');

  return (
    <Space direction="vertical" size={2} style={{ width: '100%' }}>
      <span className="tq-muted" style={{ fontSize: 12 }}>
        <Tooltip
          title={tt(
            'المقارنات أعلاه ثابتة عند لحظة التحليل، بينما رقم التفاعل يُقرأ من الصف الحالي.',
            'The comparatives above are frozen at analysis time; the engagement figure beside them is read live.',
          )}
        >
          <span>{tt('حُسبت في ', 'Computed ')}</span>
        </Tooltip>
        <span className="tq-num">{when}</span>
        {analysis.model ? <span className="tq-muted">{` · ${analysis.model}`}</span> : null}
      </span>
      {analysis.superseded ? (
        <Tooltip
          title={tt(
            'هذا التحليل كُتب على نسخة أقدم من هذا المنشور (سحب سابق). العمل تمّ ولن يُعاد شراؤه، لكن أرقامه محسوبة على مجتمع تلك اللحظة. أعد التحليل إن أردت أرقاماً على السحب الحالي.',
            'This analysis was written against an earlier scrape of this post. The work is done and will not be bought again, but its figures were computed over the population as it stood then. Re-analyse if you want figures on the current scrape.',
          )}
        >
          <Tag color="orange">{tt('على سحب أقدم', 'From an earlier scrape')}</Tag>
        </Tooltip>
      ) : null}
    </Space>
  );
}

/**
 * What this screen is counting, in both units — the block the route always sent
 * and the page used to drop.
 *
 * `posts` is UNIQUE (snapshot_id, ig_id): one row per post PER SNAPSHOT. So a
 * read of it returns scrape ROWS, and the number of posts is what is left after
 * re-scrapes collapse. Showing only one of those two numbers, unlabelled, is how
 * a doubled row count comes to be read as a doubled audience. `truncated` means
 * the read filled its cap and the population is a PREFIX — it is stated here
 * rather than logged and dropped, because a prefix presented as a total is a
 * fabricated number.
 */
function BoardCoverage({
  totals,
  population,
  analyses,
  media,
}: {
  totals: BoardTotals;
  population: PopulationScan;
  analyses: AnalysesRead;
  media: MediaRead;
}) {
  const { tt } = useLocale();

  // Every figure below is rendered verbatim from the route's own count — this
  // screen does no arithmetic on them, so what is on the card is what was
  // measured, under the key the response returned it under (rule 12).
  const imageNote = !media.index_complete
    ? media.index_error === null
      ? tt(
          'فهرس الصور لم يُقرأ بالكامل، فبعض البطاقات تقول "غير معروف" بدل نفي وجود صورة.',
          'The image listing was not read in full, so some cards say “unknown” rather than claiming no image exists.',
        )
      : tt(
          `تعذّرت قراءة فهرس الصور (${media.index_error})، فحالة الصور غير معروفة على البطاقات المعنيّة.`,
          `The image listing could not be read (${media.index_error}), so those cards report an unknown image state.`,
        )
    : media.enabled
      ? tt(
          'MIRROR_MEDIA مفعَّل: كل منشور له كائن في التخزين تُعرض صورته، والباقي لم يكن لديه ما يُنسخ.',
          'MIRROR_MEDIA is on: every post with an object in storage shows it, and the rest had nothing to copy.',
        )
      : media.mirrored > 0
        ? tt(
            'MIRROR_MEDIA غير مفعَّل الآن؛ الصور المعروضة نُسخت في تشغيل سابق.',
            'MIRROR_MEDIA is off now; the images shown were copied by an earlier run.',
          )
        : tt(
            'MIRROR_MEDIA غير مفعَّل، فلا صور منسوخة — البطاقات تبدأ بالنص، وهذا هو التصميم الافتراضي.',
            'MIRROR_MEDIA is off, so no images are stored — cards lead with their captions, which is the intended default.',
          );

  return (
    <Card size="small" title={tt('ما تغطّيه هذه اللوحة', 'What this board covers')} style={{ marginBlockEnd: 16 }}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
          <Descriptions.Item label={tt('صفوف قُرئت', 'Scrape rows read')}>
            <span className="tq-num">{formatNumber(population.rows_fetched)}</span>
          </Descriptions.Item>
          <Descriptions.Item label={tt('منشورات بعد الدمج', 'Posts after collapsing')}>
            <span className="tq-num">{formatNumber(population.distinct)}</span>
          </Descriptions.Item>
          <Descriptions.Item label={tt('إعادات سحب مدموجة', 'Re-scrapes collapsed')}>
            <span className="tq-num">{formatNumber(population.duplicates_collapsed)}</span>
          </Descriptions.Item>
          <Descriptions.Item label={tt('لقطات مرئية', 'Snapshots seen')}>
            <span className="tq-num">{formatNumber(population.snapshots_seen)}</span>
          </Descriptions.Item>
        </Descriptions>

        <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
          <Descriptions.Item label={tt('محلَّلة', 'Analysed')}>
            <span className="tq-num">{formatNumber(totals.analyzed)}</span>
            {' / '}
            <span className="tq-num">{formatNumber(totals.posts)}</span>
          </Descriptions.Item>
          <Descriptions.Item
            label={
              <Tooltip
                title={tt(
                  'تحليلها مكتوب على الصف المعروض الآن.',
                  'Their analysis is written against the row shown here.',
                )}
              >
                {tt('على السحب الحالي', 'On the current scrape')}
              </Tooltip>
            }
          >
            <span className="tq-num">{formatNumber(totals.analyzed_current)}</span>
          </Descriptions.Item>
          <Descriptions.Item
            label={
              <Tooltip
                title={tt(
                  'تحليلها كُتب على سحب أقدم لنفس المنشور — عمل مدفوع ومعروض، وأرقامه محسوبة على مجتمع تلك اللحظة. لا يُعاد شراؤه.',
                  'Their analysis was written against an earlier scrape of the same post — paid for and shown, with figures computed over the population as it stood then. It is not bought again.',
                )}
              >
                {tt('على سحب أقدم', 'From an earlier scrape')}
              </Tooltip>
            }
          >
            <span className="tq-num">{formatNumber(totals.analyzed_superseded)}</span>
          </Descriptions.Item>
          <Descriptions.Item label={tt('تحليلات قُرئت', 'Analyses read')}>
            <span className="tq-num">{formatNumber(analyses.rows_read)}</span>
          </Descriptions.Item>
        </Descriptions>

        <Descriptions size="small" column={{ xs: 1, sm: 2 }}>
          <Descriptions.Item label={tt('متوسط التفاعل — شخصي', 'Avg engagement — Personal')}>
            <span className="tq-num">{formatNumber(totals.account_avg.personal)}</span>
          </Descriptions.Item>
          <Descriptions.Item label={tt('متوسط التفاعل — أكاديمية', 'Avg engagement — Academy')}>
            <span className="tq-num">{formatNumber(totals.account_avg.academy)}</span>
          </Descriptions.Item>
        </Descriptions>

        {/* The images, counted over the cards on screen rather than over the
            whole corpus — these are the cards that ask for one. The three
            states are shown apart because "no object" and "could not tell"
            are different findings, and collapsing them would invent the
            stronger one. */}
        <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
          <Descriptions.Item
            label={
              <Tooltip
                title={tt(
                  'منشورات هذا العرض التي لها كائن صورة في التخزين الخاص، مقروءة من التخزين نفسه لا من الصفوف.',
                  'Posts in this view with an image object in private storage, read from storage itself rather than from the rows.',
                )}
              >
                {tt('صور مُرآة (هذا العرض)', 'Mirrored images (this view)')}
              </Tooltip>
            }
          >
            <span className="tq-num">{formatNumber(media.mirrored)}</span>
            {' / '}
            <span className="tq-num">{formatNumber(media.examined)}</span>
          </Descriptions.Item>
          <Descriptions.Item label={tt('بلا كائن صورة', 'No image object')}>
            <span className="tq-num">{formatNumber(media.not_mirrored)}</span>
          </Descriptions.Item>
          <Descriptions.Item
            label={
              <Tooltip
                title={tt(
                  'بطاقات تعذّر التحقّق من صورتها — ليست "بلا صورة".',
                  'Cards whose image could not be checked — this is not “no image”.',
                )}
              >
                {tt('غير معروف', 'Unknown')}
              </Tooltip>
            }
          >
            <span className="tq-num">{formatNumber(media.unknown)}</span>
          </Descriptions.Item>
          <Descriptions.Item label="MIRROR_MEDIA">
            <Tag color={media.enabled ? 'green' : 'default'}>
              {media.enabled ? tt('مفعَّل', 'On') : tt('غير مفعَّل', 'Off')}
            </Tag>
          </Descriptions.Item>
        </Descriptions>

        <div className="tq-muted" style={{ fontSize: 12 }}>
          {imageNote}
        </div>

        {population.truncated ? (
          <div className="tq-muted" style={{ fontSize: 12 }}>
            {tt('قراءة المنشورات بلغت سقفها: أول ', 'The post read filled its cap: the first ')}
            <span className="tq-num">{formatNumber(population.limit)}</span>
            {tt(
              ' صف فقط، فالأعداد أعلاه حدٌّ أدنى وليست إجمالياً.',
              ' rows only, so the counts above are a floor, not a total.',
            )}
          </div>
        ) : null}

        {analyses.unresolved > 0 ? (
          <div className="tq-muted" style={{ fontSize: 12 }}>
            <span className="tq-num">{formatNumber(analyses.unresolved)}</span>
            {tt(
              ' تحليلاً يشير إلى صف منشور غير موجود في هذه القراءة، فلم يُنسب إلى أي بطاقة.',
              ' analysis/analyses point at a post row outside this read, so they could not be attached to any card.',
            )}
          </div>
        ) : null}
      </Space>
    </Card>
  );
}

/**
 * The spend block, stated as what it is: a ceiling built on measured prompt
 * sizes, this route's own output-token limit, and one named assumption.
 *
 * A bare "~$0.42" with invented constants behind it is the thing hard rule 2
 * exists to forbid, so the number never appears without the arithmetic that
 * produced it.
 */
function EstimateDetail({ estimate }: { estimate: CostCeiling }) {
  const { tt } = useLocale();

  if (estimate.usd === null) {
    return (
      <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 8 }}>
        {estimate.unpriced_reason ??
          tt('تعذّر تقدير التكلفة.', 'The cost could not be estimated.')}
      </div>
    );
  }

  return (
    <ul
      className="tq-muted"
      style={{ fontSize: 12, marginBlockStart: 8, paddingInlineStart: 18 }}
    >
      <li>
        {tt('سقف وليس عرض سعر — كل خطوة تُقرَّب لأعلى.', 'A ceiling, not a quote — every step rounds up.')}
      </li>
      <li>
        <span className="tq-num">{formatNumber(estimate.requests)}</span>
        {tt(' طلب، وسعر الإخراج محسوب على سقف ', ' request(s), with output priced at this route’s own ceiling of ')}
        <span className="tq-num">{formatNumber(estimate.output_tokens)}</span>
        {tt(
          ' رمز — لأن حجم ما سيكتبه النموذج غير معروف مسبقاً.',
          ' tokens — because how much the model will actually write is not knowable in advance.',
        )}
      </li>
      <li>
        {tt('الإدخال: ', 'Input: ')}
        <span className="tq-num">{formatNumber(estimate.prompt_chars)}</span>
        {tt(' محرف مقيسة من النص المُرسَل فعلاً ÷ ', ' characters measured from the text actually sent ÷ ')}
        <span className="tq-num">{formatNumber(estimate.chars_per_token)}</span>
        {tt(
          ' محرف لكل رمز — وهذا الرقم افتراض لا قياس.',
          ' characters per token — that divisor is an assumption, not a measurement.',
        )}
      </li>
      <li>
        {tt('السعر المنشور لـ ', 'At the published rate for ')}
        {estimate.model}
        {': $'}
        <span className="tq-num">{estimate.rate_in_per_mtok}</span>
        {tt(' إدخال / $', ' in / $')}
        <span className="tq-num">{estimate.rate_out_per_mtok}</span>
        {tt(' إخراج لكل مليون رمز.', ' out per million tokens.')}
      </li>
    </ul>
  );
}

export default function BoardPage() {
  const { tt, isRTL } = useLocale();
  const { notification } = App.useApp();

  const [posts, setPosts] = useState<BoardPost[]>([]);
  const [totals, setTotals] = useState<BoardTotals | null>(null);
  const [population, setPopulation] = useState<PopulationScan | null>(null);
  const [analysesRead, setAnalysesRead] = useState<AnalysesRead | null>(null);
  const [mediaRead, setMediaRead] = useState<MediaRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);

  const [accountFilter, setAccountFilter] = useState<AccountFilter>('all');
  const [formatFilter, setFormatFilter] = useState<string>('all');
  const [bandFilter, setBandFilter] = useState<BandFilter>('all');

  const [progress, setProgress] = useState<AnalyzeProgressResponse | null>(null);
  const [progressLoading, setProgressLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzePercent, setAnalyzePercent] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (accountFilter !== 'all') params.set('account', accountFilter);
      if (formatFilter !== 'all') params.set('format', formatFilter);
      if (bandFilter !== 'all') params.set('band', bandFilter);
      const qs = params.toString();
      const data = await apiGet<BoardResponse>(`/api/board${qs ? `?${qs}` : ''}`);
      setPosts(data.posts);
      setTotals(data.totals);
      setPopulation(data.population);
      setAnalysesRead(data.analyses);
      setMediaRead(data.media);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [accountFilter, formatFilter, bandFilter]);

  const loadProgress = useCallback(async () => {
    setProgressLoading(true);
    try {
      const data = await apiGet<AnalyzeProgressResponse>('/api/board/analyze');
      setProgress(data);
    } catch (err) {
      notification.error({
        message: describeError(err).message,
        description: describeError(err).hint ?? undefined,
      });
    } finally {
      setProgressLoading(false);
    }
  }, [notification]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadProgress();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formatOptions = useMemo(() => {
    const set = new Set<string>();
    posts.forEach((p) => {
      if (p.media_type) set.add(p.media_type);
    });
    return [
      { label: tt('الكل', 'All'), value: 'all' },
      ...Array.from(set).map((f) => ({ label: f, value: f })),
    ];
  }, [posts, tt]);

  const runAnalyze = useCallback(async () => {
    setAnalyzing(true);
    try {
      let remaining = progress?.remaining ?? 0;
      while (remaining > 0) {
        const res = await apiSend<AnalyzeRunResponse>('/api/board/analyze', 'POST', { limit: 25 });
        remaining = res.remaining;
        // The running total comes back from the database on every chunk rather
        // than being accumulated here, so a partially-failed batch cannot leave
        // the screen claiming more work than was actually saved.
        if (res.total > 0) {
          setAnalyzePercent(Math.min(100, Math.round((res.analyzed_total / res.total) * 100)));
        }
        setProgress((prev) =>
          prev
            ? { ...prev, analyzed: res.analyzed_total, total: res.total, remaining: res.remaining }
            : prev,
        );
        if (res.failed > 0 && res.analyzed === 0) {
          break;
        }
      }
      await loadProgress();
      await load();
    } catch (err) {
      const d = describeError(err);
      notification.error({ message: d.message, description: d.hint ?? undefined });
    } finally {
      setAnalyzing(false);
    }
  }, [progress, loadProgress, load, notification]);

  const confirmAnalyze = useCallback(() => {
    if (!progress) return;
    const { estimate } = progress;
    const estimateText =
      estimate.usd === null ? '—' : `${tt('بحد أقصى ~$', 'at most ~$')}${estimate.usd.toFixed(2)}`;

    Modal.confirm({
      title: tt('تحليل كل المنشورات', 'Analyze all posts'),
      width: 560,
      content: (
        <div>
          <div>
            {tt('سيتم تحليل ', 'This will analyze ')}
            <span className="tq-num">{formatNumber(progress.remaining)}</span>
            {tt(' منشور لم يُحلَّل بعد. التكلفة: ', ' post(s) that carry no analysis yet. Cost: ')}
            <strong>{estimateText}</strong>
          </div>
          {progress.analyzed > 0 ? (
            <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 8 }}>
              <span className="tq-num">{formatNumber(progress.analyzed)}</span>
              {tt(
                ' منشوراً محلَّل مسبقاً ولن يُعاد شراؤه',
                ' post(s) already carry an analysis and will not be bought again',
              )}
              {progress.analyzed_superseded > 0 ? (
                <>
                  {tt(' — منها ', ' — ')}
                  <span className="tq-num">{formatNumber(progress.analyzed_superseded)}</span>
                  {tt(' على سحب أقدم.', ' of them from an earlier scrape.')}
                </>
              ) : (
                '.'
              )}
            </div>
          ) : null}
          <EstimateDetail estimate={estimate} />
        </div>
      ),
      okText: tt('تحليل', 'Analyze'),
      cancelText: tt('إلغاء', 'Cancel'),
      onOk: () => runAnalyze(),
    });
  }, [progress, tt, runAnalyze]);

  const isComplete = progress !== null && progress.remaining === 0;

  const analyzeExtra = (
    <Space direction="horizontal" align="center" wrap>
      {progress ? (
        <span className="tq-muted" style={{ fontSize: 12 }}>
          <span className="tq-num">{formatNumber(progress.analyzed)}</span>
          {' / '}
          <span className="tq-num">{formatNumber(progress.total)}</span>
        </span>
      ) : null}
      {analyzing ? (
        <Progress
          percent={analyzePercent}
          size="small"
          style={{ width: 120 }}
          status="active"
        />
      ) : null}
      {isComplete ? (
        <Tag color="green">{tt('مكتمل', 'Complete')}</Tag>
      ) : (
        <Button
          type="primary"
          loading={analyzing || progressLoading}
          disabled={progress === null || progress.remaining === 0}
          onClick={confirmAnalyze}
        >
          {tt('تحليل الكل', 'Analyze all')}
        </Button>
      )}
    </Space>
  );

  return (
    <div className="tq-page">
      <PageHeader
        title={tt('اللوحة', 'The Board')}
        subtitle={tt(
          'كل منشور مع تحليله — الأرقام محسوبة، والتفسير نمطي.',
          'Every post with its analysis — numbers computed, explanation pattern-level.',
        )}
        extra={analyzeExtra}
      />

      <p className="tq-muted" style={{ fontSize: 12, marginBlockStart: -8, marginBlockEnd: 16 }}>
        {tt('مرتّبة حسب التفاعل تنازلياً', 'Sorted by engagement, highest first')}
      </p>

      <Card size="small" style={{ marginBlockEnd: 16 }}>
        <Space wrap size="middle">
          <Segmented
            options={[
              { label: tt('الكل', 'All'), value: 'all' },
              { label: tt('شخصي', 'Personal'), value: 'personal' },
              { label: tt('أكاديمية', 'Academy'), value: 'academy' },
            ]}
            value={accountFilter}
            onChange={(v) => setAccountFilter(v as AccountFilter)}
          />
          <Select
            style={{ width: 160 }}
            value={formatFilter}
            onChange={setFormatFilter}
            options={formatOptions}
          />
          <Select<BandFilter>
            style={{ width: 180 }}
            value={bandFilter}
            onChange={setBandFilter}
            options={[
              { label: tt('كل الفئات', 'All bands'), value: 'all' },
              { label: tt('أعلى 10%', 'Top 10%'), value: 'top10' },
              { label: tt('أعلى 25%', 'Top 25%'), value: 'top25' },
              { label: tt('الوسيط', 'Median'), value: 'median' },
              { label: tt('أدنى 25%', 'Bottom 25%'), value: 'bottom25' },
            ]}
          />
        </Space>
      </Card>

      {totals && population && analysesRead && mediaRead ? (
        <BoardCoverage
          totals={totals}
          population={population}
          analyses={analysesRead}
          media={mediaRead}
        />
      ) : null}

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorState error={error.message} hint={error.hint} onRetry={() => void load()} />
      ) : posts.length === 0 ? (
        <EmptyState
          description={tt(
            'لا توجد منشورات. شغّل المراقبة أو ارفع تصديراً.',
            'No posts. Run the monitor or upload an export.',
          )}
          actionLabel={tt('إلى البيانات', 'Go to Data')}
          href="/data"
        />
      ) : (
        <Row gutter={[16, 16]}>
          {posts.map((post) => (
            <Col xs={24} md={12} xl={8} key={post.id}>
              <Card size="small">
                <Space direction="vertical" style={{ width: '100%' }} size={8}>
                  <Space wrap size={4}>
                    <Tag>{post.rank !== null ? `#${post.rank}` : '—'}</Tag>
                    <Tag color={post.account === 'academy' ? 'blue' : 'purple'}>
                      {post.account === 'academy' ? tt('أكاديمية', 'Academy') : tt('شخصي', 'Personal')}
                    </Tag>
                    <Tag>{post.media_type ?? '—'}</Tag>
                  </Space>

                  {post.caption ? (
                    <ArabicText>
                      <Typography.Paragraph ellipsis={{ rows: 4, expandable: true }} style={{ marginBottom: 0 }}>
                        {post.caption}
                      </Typography.Paragraph>
                    </ArabicText>
                  ) : (
                    <span className="tq-muted">—</span>
                  )}

                  {/* Caption first, image second — the v2 card ordering, kept.
                      With no image this is one muted line; with one it is the
                      thumbnail. `enabled` comes from the route, so the card can
                      say WHY it has no image instead of merely that it has none. */}
                  <PostMediaSlot post={post} enabled={mediaRead?.enabled ?? null} />

                  <Descriptions size="small" column={2}>
                    <Descriptions.Item label={tt('التفاعل', 'Engagement')}>
                      <span className="tq-num">{formatNumber(post.engagement)}</span>
                    </Descriptions.Item>
                    <Descriptions.Item label={tt('الإعجابات', 'Likes')}>
                      <span className="tq-num">{formatNumber(post.likes)}</span>
                    </Descriptions.Item>
                    <Descriptions.Item label={tt('التعليقات', 'Comments')}>
                      <span className="tq-num">{formatNumber(post.comments)}</span>
                    </Descriptions.Item>
                    <Descriptions.Item
                      label={
                        <Tooltip
                          title={tt(
                            'مرات تشغيل الفيديو كما أعادها المُستخرِج. الشرطة تعني أنه لم يُعِد رقماً — وليست صفراً.',
                            'Video plays as returned by the scraper. An em-dash means none was returned — it is not a zero.',
                          )}
                        >
                          {tt('مرات التشغيل', 'Plays')}
                        </Tooltip>
                      }
                    >
                      <span className="tq-num">{formatNumber(post.video_play_count)}</span>
                    </Descriptions.Item>
                    <Descriptions.Item label={tt('تاريخ النشر', 'Posted')} span={2}>
                      {formatDate(post.posted_at, isRTL ? 'ar' : 'en')}
                    </Descriptions.Item>
                  </Descriptions>

                  <TopComment post={post} />

                  {post.analysis ? (
                    <>
                      <Space wrap size={4}>
                        <Tag color={vsAccountColor(post.analysis.computed.vs_account_avg)}>
                          {`×${post.analysis.computed.vs_account_avg.toFixed(1)} ${tt('مقابل متوسط الحساب', 'vs account avg')}`}
                        </Tag>
                        <Tag>
                          {`×${post.analysis.computed.vs_format_avg.toFixed(1)} ${tt('مقابل متوسط الشكل', 'vs format avg')}`}
                        </Tag>
                        <Tag>{`P${post.analysis.computed.percentile}`}</Tag>
                        {post.analysis.cluster_label ? (
                          <Tag color="gold">{post.analysis.cluster_label}</Tag>
                        ) : null}
                      </Space>
                      <AnalysisStamp analysis={post.analysis} />
                      {post.analysis.explanation ? (
                        <Space direction="vertical" size={4} style={{ width: '100%' }}>
                          <ArabicText className="tq-muted">{post.analysis.explanation}</ArabicText>
                          <GroundingTag grounding={post.analysis.grounding} />
                        </Space>
                      ) : null}
                    </>
                  ) : (
                    <span className="tq-muted">{tt('لم يُحلَّل بعد', 'Not analysed yet')}</span>
                  )}

                  {/* The foot of the card: the two things there are to do with
                      the post itself. «فتح» leaves for Instagram; the Ask stays
                      here and opens the chat already pointed at THIS row, by id.
                      It sits at the inline end so it reads as the card's own
                      affordance rather than as a second link in a list. */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    {post.url ? (
                      <a href={post.url} target="_blank" rel="noopener noreferrer">
                        {tt('فتح', 'Open')}
                      </a>
                    ) : null}
                    <span style={{ marginInlineStart: 'auto' }}>
                      <AskAbout
                        scope={{ kind: 'post', post_id: post.id }}
                        label={postName(post)}
                      />
                    </span>
                  </div>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      )}
    </div>
  );
}
