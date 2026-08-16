'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  App,
  Alert,
  Button,
  ColorPicker,
  Descriptions,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Select,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { apiGet, apiSend, describeError } from '@/lib/client/api';
import { PageHeader, SeedAlert, EmptyState, ErrorState, LoadingBlock, ArabicText } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/date';
import type { BrandRow, BrandFact, VoiceExample, Palette, Typography as BrandTypography } from '@/lib/types/db';

interface BrandGetResponse {
  brand: BrandRow;
  seeded: boolean;
}

interface BrandPutResponse {
  brand: BrandRow;
}

interface SwatchRow {
  name: string;
  color: string;
}

interface VoiceFormValues {
  text: string;
  source_url?: string;
  engagement?: number | null;
}

/* ============================================ the web-retrieval surface ====
 *
 * RULE 22's OPERATOR-TRIGGERED SURFACE — the screen /api/web did not have.
 *
 * The whole of src/lib/web/fetch.ts (the ledger, the day cap, the SSRF guard)
 * and the whole of src/lib/web/facts.ts (the rule-21 class that can never carry
 * a source_key) were reachable from nothing. This tab is the button. Retrieving
 * is an OPERATOR's act — a person types a URL and presses a key, the fetch is
 * ledgered before it leaves and counted against the day — and filing a claim off
 * the page is a second, network-free act.
 *
 * WHAT THIS SCREEN MUST NEVER BECOME: an automatic lookup. There is no "search
 * the web for this" here, nothing on this page fires on mount, and no model can
 * reach the route behind it. A fetch happens because somebody pressed Retrieve.
 * ========================================================================= */

type ExternalKind = 'statistic' | 'statement' | 'definition' | 'event' | 'listing';
type ExternalConfidenceValue = 'unverified' | 'corroborated' | 'contradicted';
type ClientMeasureValue = 'followers' | 'following' | 'post_count' | 'engagement' | 'verification';

interface RetrievalPayload {
  retrieval_id: string;
  requested_url: string;
  final_url: string;
  retrieved_at: string;
  page_title: string | null;
}

type WebRetrieveResponse =
  | {
      ok: true;
      retrieval: RetrievalPayload;
      http_status: number;
      content_type: string;
      bytes: number;
      truncated: boolean;
      redirects: string[];
      fetches_reserved_today: number;
      daily_cap: number;
      /** What the operator reads before quoting. Never stored, never modelled. */
      excerpt: string;
    }
  | {
      ok: false;
      reason: string;
      detail: string;
      retrieval_id: string | null;
      http_status: number | null;
      fetches_reserved_today: number | null;
      daily_cap: number;
    };

interface LedgerRow {
  id: string;
  url: string;
  host: string;
  final_url: string | null;
  trigger: string;
  triggered_by: string;
  status: string;
  http_status: number | null;
  bytes: number | null;
  note: string | null;
  requested_at: string;
  settled_at: string | null;
}

interface ExternalClaimRow {
  id: string;
  claim: string;
  source_url: string;
  page_title: string | null;
  retrieved_at: string;
  topic: string;
  kind: string;
  confidence: string;
  about_client: boolean;
  client_account: string | null;
  client_measure: string | null;
}

interface WebStateResponse {
  cap: { amman_day: string; reserved_fetches: number; daily_cap: number };
  retrievals: LedgerRow[];
  facts: ExternalClaimRow[];
}

interface FileClaimResponse {
  escalated: boolean;
}

/** The four settled states, coloured so a refusal is not read as a success. */
function statusColor(status: string): string {
  if (status === 'ok') return 'green';
  if (status === 'refused') return 'red';
  if (status === 'failed') return 'orange';
  return 'default';
}

export default function BrandPage() {
  const { locale, t, tt } = useLocale();
  const { message } = App.useApp();

  const [brand, setBrand] = useState<BrandRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);

  const [voiceModalOpen, setVoiceModalOpen] = useState(false);
  const [voiceForm] = Form.useForm<VoiceFormValues>();
  const [savingVoice, setSavingVoice] = useState(false);

  const [swatchRows, setSwatchRows] = useState<SwatchRow[]>([]);
  const [paletteNote, setPaletteNote] = useState('');
  const [savingPalette, setSavingPalette] = useState(false);

  const [typoDisplay, setTypoDisplay] = useState('');
  const [typoBody, setTypoBody] = useState('');
  const [typoLatin, setTypoLatin] = useState('');
  const [typoNote, setTypoNote] = useState('');
  const [savingTypo, setSavingTypo] = useState(false);

  const [audienceNotes, setAudienceNotes] = useState('');
  const [savingAudience, setSavingAudience] = useState(false);

  /* ---------------------------------------------------- the web surface -- */
  const [activeTab, setActiveTab] = useState('facts');
  const [webState, setWebState] = useState<WebStateResponse | null>(null);
  const [webLoading, setWebLoading] = useState(false);
  const [webError, setWebError] = useState<{ message: string; hint: string | null } | null>(null);

  const [webUrl, setWebUrl] = useState('');
  const [retrieving, setRetrieving] = useState(false);
  const [retrieval, setRetrieval] = useState<WebRetrieveResponse | null>(null);

  const [claimText, setClaimText] = useState('');
  const [claimTopic, setClaimTopic] = useState('');
  const [claimKind, setClaimKind] = useState<ExternalKind>('statement');
  const [claimConfidence, setClaimConfidence] = useState<ExternalConfidenceValue>('unverified');
  const [claimAccount, setClaimAccount] = useState<'' | 'personal' | 'academy'>('');
  const [claimMeasure, setClaimMeasure] = useState<'' | ClientMeasureValue>('');
  const [filing, setFiling] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiGet<BrandGetResponse>('/api/brand')
      .then((res) => {
        setBrand(res.brand);
        if (res.brand.palette) {
          setSwatchRows(
            Object.entries(res.brand.palette.swatches).map(([name, color]) => ({ name, color })),
          );
          setPaletteNote(res.brand.palette.note ?? '');
        } else {
          setSwatchRows([]);
          setPaletteNote('');
        }
        setTypoDisplay(res.brand.typography?.arabic_display ?? '');
        setTypoBody(res.brand.typography?.arabic_body ?? '');
        setTypoLatin(res.brand.typography?.latin ?? '');
        setTypoNote(res.brand.typography?.note ?? '');
        setAudienceNotes(res.brand.audience_notes ?? '');
      })
      .catch((err) => setError(describeError(err)))
      .finally(() => setLoading(false));
  }, []);

  /**
   * The ledger and the filed claims. Called when the Web tab is OPENED and after
   * each retrieval or filing — never on mount, because this page is mostly not
   * about the web and an unopened tab should cost nothing.
   *
   * Reading state is free: no fetch leaves the Worker, no unit is taken. Only
   * `retrieve()` below spends, and only when a person presses the button.
   */
  const loadWeb = useCallback(() => {
    setWebLoading(true);
    setWebError(null);
    apiGet<WebStateResponse>('/api/web')
      .then((res) => setWebState(res))
      .catch((err) => setWebError(describeError(err)))
      .finally(() => setWebLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="tq-page">
        <PageHeader title={t.nav.brand} />
        <LoadingBlock />
      </div>
    );
  }

  if (error || !brand) {
    return (
      <div className="tq-page">
        <PageHeader title={t.nav.brand} />
        <ErrorState error={error?.message ?? t.common.error} hint={error?.hint} onRetry={load} />
      </div>
    );
  }

  const deleteVoiceExample = (index: number) => {
    const next = brand.voice_examples.filter((_, i) => i !== index);
    apiSend<BrandPutResponse>('/api/brand', 'PUT', { voice_examples: next })
      .then((res) => setBrand(res.brand))
      .catch((err) => {
        const d = describeError(err);
        message.error(d.message);
      });
  };

  const submitVoiceExample = () => {
    voiceForm
      .validateFields()
      .then((values) => {
        setSavingVoice(true);
        const example: VoiceExample = {
          text: values.text,
          source_url: values.source_url ? values.source_url : null,
          engagement: values.engagement === undefined || values.engagement === null ? null : values.engagement,
        };
        const next = [...brand.voice_examples, example];
        return apiSend<BrandPutResponse>('/api/brand', 'PUT', { voice_examples: next });
      })
      .then((res) => {
        setBrand(res.brand);
        setVoiceModalOpen(false);
        voiceForm.resetFields();
      })
      .catch((err) => {
        if (err && typeof err === 'object' && 'errorFields' in err) return;
        const d = describeError(err);
        message.error(d.message);
      })
      .finally(() => setSavingVoice(false));
  };

  const addSwatchRow = () => {
    setSwatchRows((prev) => [...prev, { name: '', color: '' }]);
  };

  const removeSwatchRow = (index: number) => {
    setSwatchRows((prev) => prev.filter((_, i) => i !== index));
  };

  const updateSwatchName = (index: number, name: string) => {
    setSwatchRows((prev) => prev.map((row, i) => (i === index ? { ...row, name } : row)));
  };

  const updateSwatchColor = (index: number, color: string) => {
    setSwatchRows((prev) => prev.map((row, i) => (i === index ? { ...row, color } : row)));
  };

  const savePalette = () => {
    setSavingPalette(true);
    const wasLive = brand.status === 'live';
    const swatches: Record<string, string> = {};
    for (const row of swatchRows) {
      if (row.name) swatches[row.name] = row.color;
    }
    const palette: Palette | null = swatchRows.length
      ? { swatches, note: paletteNote || null }
      : null;
    apiSend<BrandPutResponse>('/api/brand', 'PUT', { palette })
      .then((res) => {
        setBrand(res.brand);
        const nowLive = res.brand.status === 'live';
        if (nowLive && !wasLive) {
          message.success(tt('حُفظت اللوحة — حالة العلامة الآن «مباشر».', 'Palette saved — the brand is now live.'));
        } else if (!nowLive && wasLive) {
          message.success(tt('أُزيلت اللوحة — عادت الحالة إلى «بيانات أولية».', 'Palette cleared — status is back to seed.'));
        } else {
          message.success(t.common.save);
        }
      })
      .catch((err) => {
        const d = describeError(err);
        message.error(d.message);
      })
      .finally(() => setSavingPalette(false));
  };

  const saveTypography = () => {
    setSavingTypo(true);
    const allBlank = !typoDisplay && !typoBody && !typoLatin && !typoNote;
    const typography: BrandTypography | null = allBlank
      ? null
      : {
          arabic_display: typoDisplay || null,
          arabic_body: typoBody || null,
          latin: typoLatin || null,
          note: typoNote || null,
        };
    apiSend<BrandPutResponse>('/api/brand', 'PUT', { typography })
      .then((res) => {
        setBrand(res.brand);
        message.success(t.common.save);
      })
      .catch((err) => {
        const d = describeError(err);
        message.error(d.message);
      })
      .finally(() => setSavingTypo(false));
  };

  const saveAudienceNotes = () => {
    setSavingAudience(true);
    apiSend<BrandPutResponse>('/api/brand', 'PUT', { audience_notes: audienceNotes || null })
      .then((res) => {
        setBrand(res.brand);
        message.success(t.common.save);
      })
      .catch((err) => {
        const d = describeError(err);
        message.error(d.message);
      })
      .finally(() => setSavingAudience(false));
  };

  /**
   * THE ONE ACT ON THIS PAGE THAT REACHES THE NETWORK.
   *
   * It runs on a click and on nothing else — no debounce, no on-change lookup,
   * no retry. A refusal comes back as `ok: false` with a 200, because the ledger
   * row IS the result: the operator needs to see WHICH refusal it was and that
   * it was recorded, not a red toast with the id hidden behind it.
   */
  const retrieve = () => {
    const url = webUrl.trim();
    if (url.length === 0) return;
    setRetrieving(true);
    setRetrieval(null);
    apiSend<WebRetrieveResponse>('/api/web', 'POST', { url })
      .then((res) => {
        setRetrieval(res);
        if (res.ok) setClaimText('');
        loadWeb();
      })
      .catch((err) => {
        const d = describeError(err);
        message.error(d.message);
      })
      .finally(() => setRetrieving(false));
  };

  /** Files one claim against the retrieval above. Reaches nothing; spends nothing. */
  const fileClaim = () => {
    if (retrieval === null || !retrieval.ok) return;
    setFiling(true);
    apiSend<FileClaimResponse>('/api/web', 'PUT', {
      retrieval_id: retrieval.retrieval.retrieval_id,
      claim: claimText,
      topic: claimTopic,
      kind: claimKind,
      confidence: claimConfidence,
      page_title: retrieval.retrieval.page_title,
      // Omitted entirely when the operator declared nothing. The scan may still
      // raise the flag on its own — it can never lower it.
      about:
        claimAccount === ''
          ? undefined
          : {
              account: claimAccount,
              ...(claimMeasure === '' ? {} : { measure: claimMeasure }),
            },
    })
      .then((res) => {
        message.success(
          res.escalated
            ? tt(
                'حُفظ المرجع — ووُسِم تلقائيًا لأنه يتحدث عن أحد حسابات العميل. أرقامنا نقيسها نحن.',
                'Reference saved — and flagged automatically: it speaks about one of the client accounts. Those figures are ours to measure.',
              )
            : tt('حُفظ المرجع.', 'Reference saved.'),
        );
        setClaimText('');
        loadWeb();
      })
      .catch((err) => {
        const d = describeError(err);
        message.error(d.message);
      })
      .finally(() => setFiling(false));
  };

  const onTabChange = (key: string) => {
    setActiveTab(key);
    if (key === 'web' && webState === null && !webLoading) loadWeb();
  };

  const factsTab = (
    <div>
      {brand.facts.length === 0 ? (
        <EmptyState
          title={tt('لا حقائق بعد', 'No facts yet')}
          description={tt(
            'الحقائق هي الأرضية التي يقف عليها كل ما يكتبه الوكيل: من هو العميل، وماذا يبيع، ولمن — وكل حقيقة تحمل مصدرها.',
            'The facts are the floor everything the agent writes stands on: who the client is, what he sells, and to whom — each one carrying its source.',
          )}
          hint={tt('تُكتب في ملف البذور ثم تُقرأ هنا.', 'They are written in the seed file and read here.')}
        />
      ) : (
        <>
          <Descriptions bordered size="small" column={1}>
            {brand.facts.map((fact: BrandFact, i) => {
              const label =
                (locale === 'ar' ? fact.label_ar : fact.label_en) || fact.label_en || fact.key;
              return (
                <Descriptions.Item key={`${fact.key}-${i}`} label={label}>
                  <span dir="auto">{fact.value}</span>{' '}
                  <Tag>{fact.source}</Tag>
                </Descriptions.Item>
              );
            })}
          </Descriptions>
          <Typography.Text type="secondary" style={{ display: 'block', marginBlockStart: 8, fontSize: 12 }}>
            {tt('تُحرَّر هذه الحقائق في ملف البذور، لا من هذه الشاشة.', 'These are edited in the seed file, not on this screen.')}
          </Typography.Text>
        </>
      )}
    </div>
  );

  const voiceTab = (
    <div>
      {brand.voice_examples.length === 0 ? (
        <EmptyState
          title={tt('لا أمثلة صوت بعد', 'No voice examples yet')}
          description={tt(
            'الصق منشوراً كتبه أحمد بنفسه وأعجبك. هذه الأمثلة هي ما يتعلّم منه الوكيل نبرته — كيف يفتح، ومتى يقصر، وأين يمزح.',
            'Paste a post Ahmad wrote himself and you liked. These are what the agent learns his register from — how he opens, when he keeps it short, where he jokes.',
          )}
          hint={tt(
            'حتى يصل أوّلها، يكتب الوكيل نسختين من كل نبرة ويضع عليها «يحتاج معايرة».',
            'Until the first one lands, the agent writes two register variants and marks them "needs calibration".',
          )}
          actionLabel={tt('أضف مثالاً', 'Add an example')}
          onAction={() => setVoiceModalOpen(true)}
        />
      ) : (
        <>
          <div style={{ marginBlockEnd: 12 }}>
            <Button type="primary" onClick={() => setVoiceModalOpen(true)}>
              {tt('إضافة مثال', 'Add an example')}
            </Button>
          </div>
          <List
            bordered
            dataSource={brand.voice_examples}
            renderItem={(example: VoiceExample, index) => (
              <List.Item
                actions={[
                  <Button key="delete" danger type="text" onClick={() => deleteVoiceExample(index)}>
                    {t.common.delete}
                  </Button>,
                ]}
              >
                <div style={{ width: '100%' }}>
                  <ArabicText>{example.text}</ArabicText>
                  <div style={{ marginBlockStart: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
                    {example.engagement !== null ? (
                      <Tag className="tq-num">{formatNumber(example.engagement)}</Tag>
                    ) : null}
                    {example.source_url ? (
                      <a href={example.source_url} target="_blank" rel="noopener noreferrer">
                        {example.source_url}
                      </a>
                    ) : null}
                  </div>
                </div>
              </List.Item>
            )}
          />
        </>
      )}
      <Modal
        title={tt('إضافة مثال صوت', 'Add a voice example')}
        open={voiceModalOpen}
        onCancel={() => {
          setVoiceModalOpen(false);
          voiceForm.resetFields();
        }}
        onOk={submitVoiceExample}
        confirmLoading={savingVoice}
        okText={t.common.add}
        cancelText={t.common.cancel}
      >
        <Form form={voiceForm} layout="vertical">
          <Form.Item
            name="text"
            label={tt('النص', 'Text')}
            rules={[{ required: true, message: tt('مطلوب', 'Required') }]}
          >
            <Input.TextArea dir="auto" rows={4} />
          </Form.Item>
          <Form.Item name="source_url" label={tt('رابط المصدر', 'Source URL')}>
            <Input dir="ltr" />
          </Form.Item>
          <Form.Item name="engagement" label={tt('التفاعل', 'Engagement')}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );

  const creatives = (brand.assets ?? []).filter((a) => a.kind === 'creative');
  const documents = (brand.assets ?? []).filter((a) => a.kind === 'document');

  const identityTab = (
    <div>
      <Typography.Title level={5}>{tt('أعمال العلامة', 'Brand work')}</Typography.Title>
      {creatives.length > 0 ? (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
              gap: 12,
              marginBlockEnd: 12,
            }}
          >
            {creatives.map((asset) => (
              <a
                key={asset.path}
                href={asset.url}
                target="_blank"
                rel="noopener noreferrer"
                title={asset.name}
                style={{ display: 'block', lineHeight: 0 }}
              >
                {/* Plain <img>: these are Supabase Storage URLs, not a
                    configured next/image remote host. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={asset.url}
                  alt={asset.name}
                  loading="lazy"
                  style={{
                    width: '100%',
                    aspectRatio: '1 / 1',
                    objectFit: 'cover',
                    borderRadius: 8,
                    border: '1px solid var(--tq-line)',
                  }}
                />
              </a>
            ))}
          </div>
          {/* The old caption called these "published pieces" and said the
              palette below was sampled from them. Neither is knowable here: an
              asset row says a file was uploaded, not that it ran, and the
              swatches under it are typed in by hand. The count is the array's
              own length, and that is all this line now claims. */}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <span className="tq-num">{creatives.length}</span>{' '}
            {tt('ملفًا من أعمال العلامة.', 'brand files.')}
          </Typography.Text>
        </>
      ) : (
        <EmptyState
          title={tt('لا أعمال بعد', 'No brand work yet')}
          description={tt(
            'أعمال العلامة هي ما يرى الوكيل العلامة من خلاله: التصاميم المنشورة، وملفات الهوية. ضعها بجانب مجلد التطبيق ونفّذ npm run assets.',
            'The brand work is how the agent sees the brand at all — the finished pieces and the identity files. Put them beside the app folder and run npm run assets.',
          )}
        />
      )}

      {documents.length > 0 ? (
        <div style={{ marginBlockStart: 12, marginBlockEnd: 24 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {tt('مستندات: ', 'Documents: ')}
          </Typography.Text>
          {documents.map((doc) => (
            <a
              key={doc.path}
              href={doc.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ marginInlineEnd: 12, fontSize: 12 }}
            >
              {doc.name}
            </a>
          ))}
        </div>
      ) : null}

      {/* A drop zone that stored nothing, under a banner apologising for it.
          Deleted rather than reworded: the empty state above names the one
          command that actually files an asset, and a control that cannot do
          what it looks like it does is the dead button v6 is here to stop
          shipping. */}

      <Typography.Title level={5} style={{ marginBlockStart: 24 }}>
        {tt('اللوحة', 'Palette')}
      </Typography.Title>
      {swatchRows.map((row, index) => (
        <div key={index} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBlockEnd: 8 }}>
          <Input
            placeholder={tt('اسم اللون (مثال: primary)', 'Swatch name (e.g. primary)')}
            value={row.name}
            onChange={(e) => updateSwatchName(index, e.target.value)}
            style={{ maxWidth: 200 }}
          />
          <ColorPicker
            showText
            value={row.color || undefined}
            onChange={(value) => updateSwatchColor(index, value.toHexString())}
          />
          <Button danger type="text" onClick={() => removeSwatchRow(index)}>
            {t.common.delete}
          </Button>
        </div>
      ))}
      <Button onClick={addSwatchRow} style={{ marginBlockEnd: 12 }}>
        {tt('إضافة لون', 'Add swatch')}
      </Button>
      <Input.TextArea
        dir="auto"
        placeholder={tt('ملاحظة', 'Note')}
        value={paletteNote}
        onChange={(e) => setPaletteNote(e.target.value)}
        rows={2}
        style={{ marginBlockEnd: 12 }}
      />
      <div style={{ marginBlockEnd: 32 }}>
        <Button type="primary" loading={savingPalette} onClick={savePalette}>
          {t.common.save}
        </Button>
      </div>

      <Typography.Title level={5}>{tt('الطباعة', 'Typography')}</Typography.Title>
      {/* Real <label>s rather than Input addonBefore, which antd v5 deprecates
          and which reads as part of the value to a screen reader. */}
      {(
        [
          {
            key: 'display',
            label: tt('عربي — عناوين', 'Arabic display'),
            value: typoDisplay,
            set: setTypoDisplay,
          },
          {
            key: 'body',
            label: tt('عربي — نص', 'Arabic body'),
            value: typoBody,
            set: setTypoBody,
          },
          { key: 'latin', label: tt('لاتيني', 'Latin'), value: typoLatin, set: setTypoLatin },
        ] as const
      ).map((field) => (
        <label key={field.key} style={{ display: 'block', marginBlockEnd: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {field.label}
          </Typography.Text>
          <Input
            dir="auto"
            placeholder={tt(
              'اسم الخط كما هو في ملف الهوية',
              'Font name exactly as written in the identity file',
            )}
            value={field.value}
            onChange={(e) => field.set(e.target.value)}
            style={{ marginBlockStart: 4 }}
          />
        </label>
      ))}
      <Input.TextArea
        dir="auto"
        placeholder={tt('ملاحظة', 'Note')}
        value={typoNote}
        onChange={(e) => setTypoNote(e.target.value)}
        rows={2}
        style={{ marginBlockEnd: 12 }}
      />
      <div>
        <Button type="primary" loading={savingTypo} onClick={saveTypography}>
          {t.common.save}
        </Button>
      </div>
    </div>
  );

  const audienceTab = (
    <div>
      <Input.TextArea
        dir="auto"
        rows={10}
        value={audienceNotes}
        onChange={(e) => setAudienceNotes(e.target.value)}
        placeholder={tt(
          'من يتابع أحمد، ولماذا؟ ما الذي يسألونه كثيراً، وما الذي يوقفهم عن الشراء؟',
          'Who follows Ahmad, and why? What do they keep asking, and what stops them buying?',
        )}
        style={{ marginBlockEnd: 8 }}
      />
      <Typography.Text type="secondary" style={{ display: 'block', marginBlockEnd: 12, fontSize: 12 }}>
        {tt(
          'يصل هذا النص إلى الوكيل حرفياً — فاكتب ما تعرفه، لا ما تتمنّاه.',
          'This reaches the agent word for word, so write what you know rather than what you hope.',
        )}
      </Typography.Text>
      <Button type="primary" loading={savingAudience} onClick={saveAudienceNotes}>
        {t.common.save}
      </Button>
    </div>
  );

  const webTab = (
    <div>
      {/* «ما يقوله الويب» — «What the web says» — was the old framing, and it
          set the reader up to read a stranger's sentence as a reading. These
          are references: published material, kept for ideas and context and
          attributed wherever it is used. One line, stated once. */}
      <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBlockEnd: 16 }}>
        {tt(
          'مادة منشورة، تُحفَظ حرفيًا مع عنوانها — وقود للأفكار والسياق، تُنسَب لمصدرها أينما استُخدمت، ولا تصير رقمًا يُعرَض على العميل.',
          'Published material, stored verbatim with its address — fuel for ideas and context, attributed wherever used, never a client-facing figure.',
        )}
      </Typography.Paragraph>

      {webError ? (
        <ErrorState error={webError.message} hint={webError.hint} onRetry={loadWeb} />
      ) : null}

      {/* The day's remaining fetches, beside the button that spends them —
          the one place in this product where a budget belongs on a screen
          other than Data, because pressing Retrieve is what draws on it. */}
      {webState ? (
        <Typography.Text type="secondary" style={{ display: 'block', marginBlockEnd: 12, fontSize: 12 }}>
          {tt('عمليات الجلب اليوم: ', 'Fetches today: ')}
          <span className="tq-num">
            {formatNumber(webState.cap.reserved_fetches)} / {formatNumber(webState.cap.daily_cap)}
          </span>
        </Typography.Text>
      ) : null}

      {/* ------------------------------------------------------- retrieve -- */}
      <div style={{ display: 'flex', gap: 8, marginBlockEnd: 16 }}>
        <Input
          dir="ltr"
          placeholder="https://…"
          value={webUrl}
          onChange={(e) => setWebUrl(e.target.value)}
          onPressEnter={retrieve}
        />
        <Button type="primary" loading={retrieving} onClick={retrieve} disabled={!webUrl.trim()}>
          {tt('اجلب', 'Retrieve')}
        </Button>
      </div>

      {retrieval && !retrieval.ok ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBlockEnd: 16 }}
          message={`${tt('لم تُجلب: ', 'Not retrieved: ')}${retrieval.reason}`}
          description={
            <span dir="auto">
              {retrieval.detail}
              {retrieval.retrieval_id ? (
                <>
                  <br />
                  {tt('سُجِّلت المحاولة في السجل برقم ', 'The attempt is in the ledger as ')}
                  <code>{retrieval.retrieval_id}</code>
                </>
              ) : null}
            </span>
          }
        />
      ) : null}

      {retrieval && retrieval.ok ? (
        <>
          <Descriptions bordered size="small" column={1} style={{ marginBlockEnd: 16 }}>
            <Descriptions.Item label={tt('انتهى عند', 'Ended at')}>
              <a href={retrieval.retrieval.final_url} target="_blank" rel="noopener noreferrer" dir="ltr">
                {retrieval.retrieval.final_url}
              </a>
            </Descriptions.Item>
            <Descriptions.Item label={tt('عنوان الصفحة', 'Page title')}>
              {retrieval.retrieval.page_title === null ? (
                '—'
              ) : (
                <span dir="auto">{retrieval.retrieval.page_title}</span>
              )}
            </Descriptions.Item>
            <Descriptions.Item label={tt('الحالة والحجم', 'Status and size')}>
              <span className="tq-num">
                {formatNumber(retrieval.http_status)} · {formatNumber(retrieval.bytes)}
              </span>{' '}
              {tt('بايت', 'bytes')}
              {retrieval.truncated ? <Tag color="orange">{tt('مقطوع', 'truncated')}</Tag> : null}
            </Descriptions.Item>
            <Descriptions.Item label={tt('التحويلات', 'Redirects')}>
              {retrieval.redirects.length === 0 ? (
                '—'
              ) : (
                <span dir="ltr">{retrieval.redirects.join(' → ')}</span>
              )}
            </Descriptions.Item>
            <Descriptions.Item label={tt('رقم السجل', 'Ledger id')}>
              <code>{retrieval.retrieval.retrieval_id}</code>
            </Descriptions.Item>
          </Descriptions>

          <Typography.Title level={5}>{tt('نص الصفحة', 'The page text')}</Typography.Title>
          <div
            dir="auto"
            style={{
              maxBlockSize: 240,
              overflowY: 'auto',
              padding: 12,
              marginBlockEnd: 16,
              border: '1px solid var(--tq-line)',
              borderRadius: 8,
              fontSize: 13,
              lineHeight: 1.7,
            }}
          >
            {retrieval.excerpt || '—'}
          </div>

          {/* ---------------------------------------------------- file it -- */}
          <Typography.Title level={5}>{tt('احفظ مرجعًا', 'Save a reference')}</Typography.Title>
          <Typography.Text type="secondary" style={{ display: 'block', marginBlockEnd: 8, fontSize: 12 }}>
            {tt(
              'انسخ الجملة كما نُشرت حرفيًا. لا تلخّص ولا تترجم ولا تقرّب رقمًا.',
              'Copy the sentence exactly as published. Do not summarise, translate, or round a figure.',
            )}
          </Typography.Text>
          <Input.TextArea
            dir="auto"
            rows={3}
            value={claimText}
            onChange={(e) => setClaimText(e.target.value)}
            style={{ marginBlockEnd: 8 }}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBlockEnd: 8 }}>
            <Input
              dir="auto"
              placeholder={tt('الموضوع', 'Topic')}
              value={claimTopic}
              onChange={(e) => setClaimTopic(e.target.value)}
              style={{ maxWidth: 220 }}
            />
            <Select<ExternalKind>
              value={claimKind}
              onChange={setClaimKind}
              style={{ minWidth: 160 }}
              options={[
                { value: 'statement', label: tt('عبارة', 'statement') },
                { value: 'statistic', label: tt('إحصاء', 'statistic') },
                { value: 'definition', label: tt('تعريف', 'definition') },
                { value: 'event', label: tt('حدث', 'event') },
                { value: 'listing', label: tt('إدراج', 'listing') },
              ]}
            />
            <Select<ExternalConfidenceValue>
              value={claimConfidence}
              onChange={setClaimConfidence}
              style={{ minWidth: 180 }}
              options={[
                { value: 'unverified', label: tt('غير مُتحقَّق', 'unverified') },
                { value: 'corroborated', label: tt('مصدر ثانٍ يقوله', 'corroborated') },
                { value: 'contradicted', label: tt('قياسنا يخالفه', 'contradicted') },
              ]}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBlockEnd: 12 }}>
            <Select<'' | 'personal' | 'academy'>
              value={claimAccount}
              onChange={(value) => {
                setClaimAccount(value);
                if (value === '') setClaimMeasure('');
              }}
              style={{ minWidth: 220 }}
              options={[
                { value: '', label: tt('عن العالم، لا عنّا', 'About the world, not us') },
                { value: 'personal', label: tt('عن الحساب الشخصي', "About the personal account") },
                { value: 'academy', label: tt('عن حساب الأكاديمية', 'About the academy account') },
              ]}
            />
            <Select<'' | ClientMeasureValue>
              value={claimMeasure}
              onChange={setClaimMeasure}
              disabled={claimAccount === ''}
              style={{ minWidth: 220 }}
              options={[
                { value: '', label: tt('لا يدّعي قياسًا بعينه', 'Names no particular measure') },
                { value: 'followers', label: tt('متابعون', 'followers') },
                { value: 'following', label: tt('يتابع', 'following') },
                { value: 'post_count', label: tt('عدد المنشورات', 'post count') },
                { value: 'engagement', label: tt('تفاعل', 'engagement') },
                { value: 'verification', label: tt('توثيق', 'verification') },
              ]}
            />
          </div>
          <Button
            type="primary"
            loading={filing}
            onClick={fileClaim}
            disabled={!claimText.trim() || !claimTopic.trim()}
            style={{ marginBlockEnd: 24 }}
          >
            {tt('احفظه', 'Save it')}
          </Button>
        </>
      ) : null}

      {/* ------------------------------------------------------ references -- */}
      <Typography.Title level={5}>{tt('المراجع المحفوظة', 'Saved references')}</Typography.Title>
      {webLoading && webState === null ? (
        <LoadingBlock />
      ) : webState && webState.facts.length > 0 ? (
        <List
          bordered
          dataSource={webState.facts}
          style={{ marginBlockEnd: 24 }}
          renderItem={(fact) => (
            <List.Item>
              <div style={{ width: '100%' }}>
                {fact.about_client ? (
                  <Tag color="red">
                    {tt('عن حساباتنا — نحن نقيس هذا بأنفسنا', 'About our accounts — we measure this ourselves')}
                    {fact.client_measure ? `: ${fact.client_measure}` : ''}
                  </Tag>
                ) : null}
                <ArabicText>{fact.claim}</ArabicText>
                <div style={{ marginBlockStart: 4, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Tag>{fact.topic}</Tag>
                  <Tag>{fact.kind}</Tag>
                  <Tag>{fact.confidence}</Tag>
                  <a href={fact.source_url} target="_blank" rel="noopener noreferrer" dir="ltr" style={{ fontSize: 12 }}>
                    {fact.source_url}
                  </a>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {formatDateTime(fact.retrieved_at, locale)}
                  </Typography.Text>
                </div>
              </div>
            </List.Item>
          )}
        />
      ) : (
        <EmptyState
          title={tt('لا مراجع بعد', 'No references yet')}
          description={tt(
            'الصق عنوان صفحة نشرها غيرنا — تقرير سوق، مقالة، إعلان منافس — واحفظ منها الجملة التي تهمّك كما هي. يقرأ الوكيل المحفوظ هنا حين يبحث عن سياق أو فكرة.',
            'Paste the address of a page somebody else published — a market report, an article, a competitor announcement — and keep the sentence that matters, as it was written. The agent reads what is here when it needs context or an angle.',
          )}
          hint={tt(
            'هذا يعني «لم ننظر بعد»، لا «لا يوجد ما يُقال».',
            'Empty means "we have not looked yet", not "there is nothing out there".',
          )}
        />
      )}

      {/* --------------------------------------------------------- ledger -- */}
      <Typography.Title level={5}>{tt('سجل المحاولات', 'The attempt ledger')}</Typography.Title>
      <Typography.Text type="secondary" style={{ display: 'block', marginBlockEnd: 8, fontSize: 12 }}>
        {tt(
          'كل محاولة، بما فيها المرفوضة والفاشلة — السجل يُكتب قبل خروج الطلب.',
          'Every attempt, refusals and failures included — the row is written before the request leaves.',
        )}
      </Typography.Text>
      {webState && webState.retrievals.length > 0 ? (
        <List
          bordered
          size="small"
          dataSource={webState.retrievals}
          renderItem={(row) => (
            <List.Item>
              <div style={{ width: '100%', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Tag color={statusColor(row.status)}>{row.status}</Tag>
                <span dir="ltr" style={{ fontSize: 12 }}>{row.url}</span>
                <Tag>{row.trigger}</Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {row.triggered_by}
                </Typography.Text>
                {row.http_status === null ? null : (
                  <span className="tq-num" style={{ fontSize: 12 }}>{formatNumber(row.http_status)}</span>
                )}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {formatDateTime(row.requested_at, locale)}
                </Typography.Text>
                {row.note === null ? null : (
                  <Typography.Text type="secondary" dir="auto" style={{ fontSize: 12, inlineSize: '100%' }}>
                    {row.note}
                  </Typography.Text>
                )}
              </div>
            </List.Item>
          )}
        />
      ) : (
        <EmptyState
          description={tt(
            'كل محاولة جلب ستظهر هنا بحالتها وعنوانها ووقتها — حتى المرفوضة.',
            'Every attempt will appear here with its status, its address and its time — refusals included.',
          )}
        />
      )}
    </div>
  );

  return (
    <div className="tq-page">
      <PageHeader
        title={t.nav.brand}
        subtitle={tt(
          'كل ما يعرفه الوكيل عن العميل: الحقائق، والصوت، والهوية، والجمهور، والمراجع.',
          'Everything the agent knows about the client — the facts, the voice, the identity, the audience, the references.',
        )}
        extra={
          brand.status === 'live' ? (
            <Tag color="green">{tt('مباشر', 'Live')}</Tag>
          ) : (
            <Tag color="orange">{tt('بيانات أولية', 'Seed')}</Tag>
          )
        }
      />
      <SeedAlert status={brand.status} />

      <Tabs
        activeKey={activeTab}
        onChange={onTabChange}
        items={[
          { key: 'facts', label: tt('الحقائق', 'Facts'), children: factsTab },
          { key: 'voice', label: tt('الصوت', 'Voice'), children: voiceTab },
          { key: 'identity', label: tt('الهوية', 'Identity'), children: identityTab },
          { key: 'audience', label: tt('الجمهور', 'Audience'), children: audienceTab },
          { key: 'web', label: tt('مراجع خارجية', 'References'), children: webTab },
        ]}
      />

      <Typography.Text type="secondary">
        {tt('آخر تحديث: ', 'Last updated: ') + formatDateTime(brand.updated_at, locale)}
      </Typography.Text>
    </div>
  );
}
