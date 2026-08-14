'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Row,
  Col,
  Card,
  Space,
  InputNumber,
  Button,
  Tag,
  Alert,
  Collapse,
  Steps,
  Typography,
  App,
} from 'antd';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { apiGet, apiSend, describeError } from '@/lib/client/api';
import { EmptyState, ArabicText } from '@/components/ui';
import type { BrandRow, ConceptRow, Frame } from '@/lib/types/db';

interface StoryboardResponse {
  result: { warnings: string[]; frames: Frame[] };
  persisted: { concept: ConceptRow; frames: Frame[]; needs_human: boolean };
  brain?: {
    judge: {
      score: number;
      verdict: 'pass' | 'fail';
      violations: { rule: string; evidence: string; source: string }[];
      needs_human: boolean;
    };
    law: {
      violations: { check: string; evidence: string }[];
      warnings: { check: string; evidence: string }[];
    };
  };
}

interface BrandResponse {
  brand: BrandRow;
}

export function StoryboardPanel({
  concept,
  onUpdated,
}: {
  concept: ConceptRow;
  onUpdated: (concept: ConceptRow) => void;
}) {
  const { tt } = useLocale();
  const { notification } = App.useApp();

  const [swatches, setSwatches] = useState<Record<string, string>>({});
  const [frameCount, setFrameCount] = useState<number>(5);
  const [generating, setGenerating] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [lastBrain, setLastBrain] = useState<StoryboardResponse['brain'] | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet<BrandResponse>('/api/brand')
      .then((res) => {
        if (!cancelled) setSwatches(res.brand.palette?.swatches ?? {});
      })
      .catch(() => {
        // Palette is a nicety here — silently fall back to neutral bands.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const generate = useCallback(async () => {
    setGenerating(true);
    try {
      const res = await apiSend<StoryboardResponse>('/api/generate/storyboard', 'POST', {
        concept_id: concept.id,
        frames: frameCount,
      });
      setLastBrain(res.brain ?? null);
      onUpdated(res.persisted.concept);
    } catch (err) {
      const d = describeError(err);
      notification.error({ message: d.message, description: d.hint ?? undefined });
    } finally {
      setGenerating(false);
    }
  }, [concept.id, frameCount, notification, onUpdated]);

  const frames = concept.frames ?? [];
  const totalDuration = frames.reduce((sum, f) => sum + f.duration_s, 0);

  if (frames.length === 0) {
    return (
      <div>
        <EmptyState
          description={tt('لا يوجد ستوري بورد بعد.', 'No storyboard yet.')}
          actionLabel={tt('ولّد ستوري بورد', 'Generate storyboard')}
          onAction={() => void generate()}
        />
        <Space style={{ marginBlockStart: 8 }}>
          <span>{tt('عدد اللقطات', 'Frame count')}</span>
          <InputNumber min={3} max={10} defaultValue={5} value={frameCount} onChange={(v) => setFrameCount(v ?? 5)} />
          <Button type="primary" loading={generating} onClick={() => void generate()}>
            {tt('ولّد', 'Generate')}
          </Button>
        </Space>
      </div>
    );
  }

  return (
    <div>
      {printing ? <FilmingSheet concept={concept} frames={frames} onDone={() => setPrinting(false)} /> : null}

      <div className="no-print">
        <Space wrap style={{ marginBlockEnd: 12 }} align="center">
          <span className="tq-muted">{tt('إجمالي المدة', 'Total duration')}</span>
          <span className="tq-num">{totalDuration}s</span>
          <InputNumber min={3} max={10} value={frameCount} onChange={(v) => setFrameCount(v ?? 5)} />
          <Button loading={generating} onClick={() => void generate()}>
            {tt('إعادة التوليد', 'Regenerate')}
          </Button>
          <Button
            type="primary"
            onClick={() => {
              setPrinting(true);
              setTimeout(() => window.print(), 100);
            }}
          >
            {tt('ورقة التصوير', 'Filming sheet')}
          </Button>
        </Space>

        {lastBrain ? (
          <Space direction="vertical" style={{ width: '100%', marginBlockEnd: 12 }}>
            <Tag color={lastBrain.judge.verdict === 'pass' ? 'green' : 'red'}>
              {tt('التقييم', 'Score')}: <span className="tq-num">{lastBrain.judge.score}</span>
            </Tag>
            {lastBrain.judge.needs_human ? (
              <Alert
                type="warning"
                showIcon
                message={tt('يحتاج مراجعة بشرية', 'Needs human review')}
                description={
                  <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                    {lastBrain.judge.violations.map((v, i) => (
                      <li key={i}>
                        {v.rule} — {v.evidence}
                      </li>
                    ))}
                  </ul>
                }
              />
            ) : null}
            {lastBrain.law.violations.length > 0 || lastBrain.law.warnings.length > 0 ? (
              <Collapse
                size="small"
                items={[
                  {
                    key: 'law',
                    label: tt('فحوصات القانون', 'Law checks'),
                    children: (
                      <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                        {lastBrain.law.violations.map((v, i) => (
                          <li key={`v-${i}`}>
                            {v.check} — {v.evidence}
                          </li>
                        ))}
                        {lastBrain.law.warnings.map((w, i) => (
                          <li key={`w-${i}`}>
                            {w.check} — {w.evidence}
                          </li>
                        ))}
                      </ul>
                    ),
                  },
                ]}
              />
            ) : null}
          </Space>
        ) : null}

        <Steps
          direction="vertical"
          size="small"
          style={{ marginBlockEnd: 16 }}
          items={frames.map((f) => ({
            title: (
              <span>
                <span className="tq-num">
                  #{f.order} · {f.duration_s}s
                </span>
              </span>
            ),
            description: <span dir="ltr">{f.shot_direction || '—'}</span>,
          }))}
        />

        <Row gutter={[16, 16]}>
          {frames.map((f) => {
            const color = f.palette_ref ? swatches[f.palette_ref] : null;
            return (
              <Col xs={24} sm={12} lg={8} key={f.order}>
                <Card size="small" styles={{ body: { padding: 0 } }}>
                  <div
                    style={{
                      height: 8,
                      background: color ?? 'var(--tq-line)',
                    }}
                  />
                  <div style={{ padding: 16 }}>
                    <Space style={{ marginBlockEnd: 8 }} align="center">
                      <span className="tq-num">
                        #{f.order} · {f.duration_s}s
                      </span>
                      <Tag>{f.palette_ref ?? tt('بلا لون', 'no palette ref')}</Tag>
                    </Space>
                    <div
                      dir="auto"
                      className="tq-ar"
                      style={{
                        fontSize: 22,
                        fontWeight: 600,
                        lineHeight: 1.7,
                        textAlign: 'center',
                        minHeight: 80,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {f.overlay_ar || '—'}
                    </div>
                    <ArabicText style={{ marginBlockStart: 8 }}>{f.scene_beat_ar || '—'}</ArabicText>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }} dir="ltr">
                      {f.shot_direction || '—'}
                    </Typography.Text>
                  </div>
                </Card>
              </Col>
            );
          })}
        </Row>
      </div>
    </div>
  );
}

function FilmingSheet({
  concept,
  frames,
  onDone,
}: {
  concept: ConceptRow;
  frames: Frame[];
  onDone: () => void;
}) {
  const { tt } = useLocale();

  useEffect(() => {
    const handler = () => onDone();
    window.addEventListener('afterprint', handler);
    return () => window.removeEventListener('afterprint', handler);
  }, [onDone]);

  return (
    <>
      <style>{`
        @media print {
          @page { size: A4; margin: 14mm; }
          .ant-layout-sider, .ant-layout-header, .ant-drawer-header, .no-print {
            display: none !important;
          }
          body, .tq-sheet {
            background: #fff !important;
            color: #000 !important;
          }
          .tq-sheet table, .tq-sheet th, .tq-sheet td {
            border: 1px solid #000 !important;
            box-shadow: none !important;
          }
          .tq-sheet {
            font-size: 14pt;
          }
        }
      `}</style>
      <div dir="rtl" className="tq-sheet">
        <h1 dir="auto">{concept.title}</h1>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ padding: 8, textAlign: 'start' }}>{tt('رقم', 'No.')}</th>
              <th style={{ padding: 8, textAlign: 'start' }}>{tt('المدة', 'Duration')}</th>
              <th style={{ padding: 8, textAlign: 'start' }}>{tt('النص على الشاشة', 'On-screen text')}</th>
              <th style={{ padding: 8, textAlign: 'start' }}>{tt('المشهد', 'Scene')}</th>
              <th style={{ padding: 8, textAlign: 'start' }}>{tt('التصوير', 'Shot')}</th>
            </tr>
          </thead>
          <tbody>
            {frames.map((f) => (
              <tr key={f.order}>
                <td className="tq-num" style={{ padding: 8 }}>
                  {f.order}
                </td>
                <td className="tq-num" style={{ padding: 8 }}>
                  {f.duration_s ? `${f.duration_s}${tt('ث', 's')}` : '—'}
                </td>
                <td dir="auto" style={{ padding: 8, fontSize: 18, fontWeight: 600 }}>
                  {f.overlay_ar || '—'}
                </td>
                <td dir="auto" style={{ padding: 8 }}>
                  {f.scene_beat_ar || '—'}
                </td>
                <td dir="ltr" style={{ padding: 8 }}>
                  {f.shot_direction || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
