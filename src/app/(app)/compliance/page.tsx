'use client';

import { useEffect, useState } from 'react';
import { App, Alert, Button, Card, Collapse, Input, Select, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { apiGet, apiSend, describeError } from '@/lib/client/api';
import { PageHeader, EmptyState, ErrorState, LoadingBlock } from '@/components/ui';
import { formatDateTime } from '@/lib/date';

type SubjectType = 'concept' | 'storyboard' | 'caption' | 'freeform';

interface LawResult {
  check: string;
  passed: boolean;
  evidence: string;
  source: 'law';
  severity: 'violation' | 'warning';
  detail?: Record<string, unknown>;
}

interface JudgeViolation {
  rule: string;
  evidence: string;
  source: string;
}

interface JudgeVerdict {
  verdict: 'pass' | 'fail';
  score: number;
  violations: JudgeViolation[];
  fixes: string[];
  needs_human: boolean;
}

interface ComplianceCheck {
  id: string;
  passed: boolean;
  law_results: LawResult[];
  judge_verdict: JudgeVerdict;
  created_at: string;
}

interface ComplianceHistoryRow {
  id: string;
  subject_type: SubjectType;
  input_text: string;
  passed: boolean;
  created_at: string;
  judge_verdict: { score: number };
}

interface ComplianceListResponse {
  checks: ComplianceHistoryRow[];
}

const SUBJECT_TYPES: SubjectType[] = ['freeform', 'concept', 'storyboard', 'caption'];

export default function CompliancePage() {
  const { tt, locale } = useLocale();
  const { notification } = App.useApp();

  const [history, setHistory] = useState<ComplianceHistoryRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);

  const [inputText, setInputText] = useState('');
  const [subjectType, setSubjectType] = useState<SubjectType>('freeform');
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<{ message: string; hint: string | null } | null>(null);

  const [result, setResult] = useState<ComplianceCheck | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<ComplianceListResponse>('/api/compliance');
      setHistory(data.checks);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runCheck = async (text: string, type: SubjectType) => {
    if (!text.trim()) return;
    setChecking(true);
    setCheckError(null);
    try {
      const res = await apiSend<ComplianceCheck>('/api/compliance', 'POST', {
        input_text: text,
        subject_type: type,
        subject_ref: null,
      });
      setResult(res);
      load();
    } catch (err) {
      setCheckError(describeError(err));
    } finally {
      setChecking(false);
    }
  };

  const handleCheck = () => runCheck(inputText, subjectType);

  const handleApplyFixes = () => {
    if (!result || result.judge_verdict.fixes.length === 0) return;
    const block = [
      '',
      '',
      tt('— إصلاحات مقترحة —', '— Suggested fixes —'),
      ...result.judge_verdict.fixes.map((f) => `- ${f}`),
    ].join('\n');
    const nextText = `${inputText}${block}`;
    setInputText(nextText);
    runCheck(nextText, subjectType);
  };

  const handleHistoryRowClick = (row: ComplianceHistoryRow) => {
    setInputText(row.input_text);
    setSubjectType(row.subject_type);
    setResult({
      id: row.id,
      passed: row.passed,
      law_results: [],
      judge_verdict: { verdict: row.passed ? 'pass' : 'fail', score: row.judge_verdict.score, violations: [], fixes: [], needs_human: false },
      created_at: row.created_at,
    });
  };

  const columns: ColumnsType<ComplianceHistoryRow> = [
    {
      title: tt('التاريخ', 'Date'),
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v: string) => <span className="tq-num">{formatDateTime(v, locale)}</span>,
    },
    {
      title: tt('النوع', 'Subject'),
      dataIndex: 'subject_type',
      key: 'subject_type',
    },
    {
      title: tt('النتيجة', 'Result'),
      dataIndex: 'passed',
      key: 'passed',
      render: (v: boolean) => (
        <Tag color={v ? 'green' : 'red'}>{v ? tt('مطابق', 'PASS') : tt('غير مطابق', 'FAIL')}</Tag>
      ),
    },
    {
      title: tt('الدرجة', 'Score'),
      dataIndex: ['judge_verdict', 'score'],
      key: 'score',
      render: (_: unknown, row: ComplianceHistoryRow) => (
        <span className="tq-num">{row.judge_verdict.score}/100</span>
      ),
    },
    {
      title: tt('مقتطف', 'Excerpt'),
      dataIndex: 'input_text',
      key: 'input_text',
      render: (v: string) => (
        <span dir="auto" className="tq-ar">
          {v.slice(0, 60)}
          {v.length > 60 ? '…' : ''}
        </span>
      ),
    },
  ];

  return (
    <div className="tq-page">
      <PageHeader
        title={tt('فاحص الالتزام', 'Compliance Checker')}
        subtitle={tt(
          'الصق أي نص — يُفحص مقابل دليل العلامة وقوانين الدماغ.',
          "Paste any text — checked against the brand guideline and the brain's laws.",
        )}
      />

      <Alert
        type="warning"
        showIcon
        style={{ marginBlockEnd: 16 }}
        message={tt('نص فقط في هذه النسخة', 'Text only in this version')}
        description={tt(
          'لا تُفحص التصاميم النهائية أو الصور — فقط النص.',
          'Finished visuals and images are not checked — text only.',
        )}
      />

      <Card style={{ marginBlockEnd: 16 }}>
        <Input.TextArea
          dir="auto"
          rows={8}
          className="tq-ar"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={tt('الصق النص هنا…', 'Paste text here…')}
          style={{ marginBlockEnd: 12 }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Select
            value={subjectType}
            onChange={(v: SubjectType) => setSubjectType(v)}
            style={{ minWidth: 160 }}
            options={SUBJECT_TYPES.map((s) => ({ value: s, label: s }))}
          />
          <Button type="primary" loading={checking} onClick={handleCheck} disabled={!inputText.trim()}>
            {tt('فحص', 'Check')}
          </Button>
        </div>
      </Card>

      {checkError ? <ErrorState error={checkError.message} hint={checkError.hint} /> : null}

      {result ? (
        <Card style={{ marginBlockEnd: 16 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBlockEnd: 16 }}>
            <Tag color={result.passed ? 'green' : 'red'} style={{ fontSize: 16, padding: '4px 12px' }}>
              {result.passed ? tt('مطابق', 'PASS') : tt('غير مطابق', 'FAIL')}
            </Tag>
            <span className="tq-num" style={{ fontSize: 16 }}>
              {result.judge_verdict.score}/100
            </span>
          </div>

          <Collapse
            items={[
              ...result.law_results.map((r, i) => ({
                key: `law-${i}`,
                label: (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span>{r.check}</span>
                    <Tag color={r.passed ? 'green' : r.severity === 'warning' ? 'orange' : 'red'}>
                      {r.passed ? 'PASS' : r.severity.toUpperCase()}
                    </Tag>
                  </div>
                ),
                children: (
                  <div>
                    <div dir="auto" className="tq-ar">
                      {r.evidence}
                    </div>
                    <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 8 }}>
                      {tt('فحص حتمي', 'Deterministic check')}
                    </div>
                    {r.detail?.heuristic ? (
                      <div className="tq-muted" style={{ fontSize: 12 }}>
                        {tt('إرشادي — ليس حكماً', 'Heuristic — not a verdict')}
                      </div>
                    ) : null}
                  </div>
                ),
              })),
              ...result.judge_verdict.violations.map((v, i) => ({
                key: `judge-${i}`,
                label: v.rule,
                children: (
                  <div>
                    <div dir="auto" className="tq-ar" style={{ marginBlockEnd: 8 }}>
                      {v.evidence}
                    </div>
                    <Tag>{v.source}</Tag>
                  </div>
                ),
              })),
            ]}
          />

          {result.judge_verdict.fixes.length > 0 ? (
            <div style={{ marginBlockStart: 16 }}>
              <h4>{tt('الإصلاحات المقترحة', 'Suggested fixes')}</h4>
              <ol dir="auto" className="tq-ar" style={{ paddingInlineStart: 20 }}>
                {result.judge_verdict.fixes.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ol>
              <Button onClick={handleApplyFixes}>
                {tt('تطبيق الإصلاحات وإعادة الفحص', 'Apply fixes & re-check')}
              </Button>
            </div>
          ) : null}

          {result.judge_verdict.needs_human ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBlockStart: 16 }}
              message={tt('يحتاج مراجعة بشرية', 'Needs human review')}
            />
          ) : null}
        </Card>
      ) : null}

      {loading ? <LoadingBlock rows={4} /> : null}
      {!loading && error ? <ErrorState error={error.message} hint={error.hint} onRetry={load} /> : null}
      {!loading && !error && history && history.length === 0 ? (
        <EmptyState description={tt('لا يوجد سجل فحص بعد.', 'No check history yet.')} />
      ) : null}
      {!loading && !error && history && history.length > 0 ? (
        <Table<ComplianceHistoryRow>
          rowKey="id"
          columns={columns}
          dataSource={history}
          pagination={{ pageSize: 10 }}
          onRow={(row) => ({ onClick: () => handleHistoryRowClick(row), style: { cursor: 'pointer' } })}
        />
      ) : null}
    </div>
  );
}
