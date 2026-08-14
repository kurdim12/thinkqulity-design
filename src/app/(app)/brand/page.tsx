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
  Tabs,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { UploadFile } from 'antd/es/upload/interface';
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

export default function BrandPage() {
  const { locale, t, tt } = useLocale();
  const { message } = App.useApp();

  const [brand, setBrand] = useState<BrandRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);

  const [voiceModalOpen, setVoiceModalOpen] = useState(false);
  const [voiceForm] = Form.useForm<VoiceFormValues>();
  const [savingVoice, setSavingVoice] = useState(false);

  const [fileList, setFileList] = useState<UploadFile[]>([]);

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

  const factsTab = (
    <div>
      {brand.facts.length === 0 ? (
        <EmptyState
          description={tt('لم تُزرع أي حقائق بعد.', 'No facts have been seeded yet.')}
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
            {tt('الحقائق للقراءة فقط — أضِف أو عدِّل عبر supabase/seed.sql.', 'Facts are read-only — add or edit them via supabase/seed.sql.')}
          </Typography.Text>
        </>
      )}
    </div>
  );

  const voiceTab = (
    <div>
      {brand.voice_examples.length === 0 ? (
        <EmptyState
          description={tt(
            'لا توجد أمثلة صوت. بدونها ينتج الوكيل نسختين من النبرة ويضع علامة "يحتاج معايرة".',
            'No voice examples yet. Without them the agent produces two register variants and flags "needs calibration".',
          )}
          actionLabel={tt('إضافة مثال', 'Add an example')}
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

  const identityTab = (
    <div>
      <Upload.Dragger
        multiple
        accept="image/*,.pdf"
        fileList={fileList}
        beforeUpload={() => false}
        onChange={(info) => setFileList(info.fileList)}
      >
        <p className="ant-upload-text">{tt('اسحب الملفات هنا أو انقر للاختيار', 'Drag files here or click to select')}</p>
      </Upload.Dragger>
      <Alert
        type="info"
        showIcon
        style={{ marginBlockStart: 12, marginBlockEnd: 24 }}
        message={tt(
          'رفع الملفات محلي فقط في هذه النسخة — استخرج الألوان والخطوط يدويًا وأدخلها أدناه.',
          'File drop is local-only in this build — read the colours and fonts off the asset yourself and enter them below.',
        )}
      />

      <Typography.Title level={5}>{tt('اللوحة', 'Palette')}</Typography.Title>
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
      <Input
        dir="auto"
        placeholder={tt('اسم الخط كما هو في ملف الهوية', 'Font name exactly as written in the identity file')}
        value={typoDisplay}
        onChange={(e) => setTypoDisplay(e.target.value)}
        style={{ marginBlockEnd: 8 }}
        addonBefore={tt('عربي - عناوين', 'Arabic display')}
      />
      <Input
        dir="auto"
        placeholder={tt('اسم الخط كما هو في ملف الهوية', 'Font name exactly as written in the identity file')}
        value={typoBody}
        onChange={(e) => setTypoBody(e.target.value)}
        style={{ marginBlockEnd: 8 }}
        addonBefore={tt('عربي - نص', 'Arabic body')}
      />
      <Input
        dir="auto"
        placeholder={tt('اسم الخط كما هو في ملف الهوية', 'Font name exactly as written in the identity file')}
        value={typoLatin}
        onChange={(e) => setTypoLatin(e.target.value)}
        style={{ marginBlockEnd: 8 }}
        addonBefore={tt('لاتيني', 'Latin')}
      />
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
        style={{ marginBlockEnd: 8 }}
      />
      <Typography.Text type="secondary" style={{ display: 'block', marginBlockEnd: 12, fontSize: 12 }}>
        {tt('يُمرَّر هذا النص إلى الوكيل كما هو. اكتب ما تعرفه فقط.', 'This text is passed to the agent verbatim. Write only what you actually know.')}
      </Typography.Text>
      <Button type="primary" loading={savingAudience} onClick={saveAudienceNotes}>
        {t.common.save}
      </Button>
    </div>
  );

  return (
    <div className="tq-page">
      <PageHeader
        title={t.nav.brand}
        subtitle={tt(
          'كل ما يعرفه الوكيل عن العميل — ولا شيء غير ذلك.',
          'Everything the agent knows about the client — and nothing else.',
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
        items={[
          { key: 'facts', label: tt('الحقائق', 'Facts'), children: factsTab },
          { key: 'voice', label: tt('الصوت', 'Voice'), children: voiceTab },
          { key: 'identity', label: tt('الهوية', 'Identity'), children: identityTab },
          { key: 'audience', label: tt('الجمهور', 'Audience'), children: audienceTab },
        ]}
      />

      <Typography.Text type="secondary">
        {tt('آخر تحديث: ', 'Last updated: ') + formatDateTime(brand.updated_at, locale)}
      </Typography.Text>
    </div>
  );
}
