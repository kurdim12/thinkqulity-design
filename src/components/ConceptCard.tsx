'use client';

import { Card, Space, Typography, Button, Tooltip } from 'antd';
import { CheckOutlined, CloseOutlined, EditOutlined, SendOutlined } from '@ant-design/icons';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { ArabicText, FormatTag, GroundingTag, StatusTag } from '@/components/ui';
import { formatNumber } from '@/lib/date';
import type { AgentConcept, ConceptRow } from '@/lib/types/db';

export type DisplayConcept = AgentConcept | ConceptRow;

function isPersisted(concept: DisplayConcept): concept is ConceptRow {
  return 'id' in concept;
}

export interface ConceptCardActions {
  onApprove?: (concept: ConceptRow) => void;
  onReject?: (concept: ConceptRow) => void;
  onEdit?: (concept: ConceptRow) => void;
  onShip?: (concept: ConceptRow) => void;
}

/**
 * One concept, rendered identically wherever it appears — the Concepts board,
 * a campaign's flagship list, or the calendar drawer.
 */
export function ConceptCard({
  concept,
  pillarName,
  actions,
  compact,
}: {
  concept: DisplayConcept;
  pillarName?: string | null;
  actions?: ConceptCardActions;
  compact?: boolean;
}) {
  const { tt } = useLocale();
  const persisted = isPersisted(concept);
  const needsCalibration = !persisted && concept.needs_calibration;

  const footer: React.ReactNode[] = [];
  if (persisted && actions) {
    if (actions.onEdit) {
      footer.push(
        <Button key="edit" size="small" icon={<EditOutlined />} onClick={() => actions.onEdit?.(concept)}>
          {tt('تعديل', 'Edit')}
        </Button>,
      );
    }
    if (actions.onApprove && concept.status === 'draft') {
      footer.push(
        <Button
          key="approve"
          size="small"
          type="primary"
          icon={<CheckOutlined />}
          onClick={() => actions.onApprove?.(concept)}
        >
          {tt('اعتماد', 'Approve')}
        </Button>,
      );
    }
    if (actions.onShip && concept.status === 'approved') {
      footer.push(
        <Button key="ship" size="small" icon={<SendOutlined />} onClick={() => actions.onShip?.(concept)}>
          {tt('تم النشر', 'Mark shipped')}
        </Button>,
      );
    }
    if (actions.onReject && concept.status !== 'rejected' && concept.status !== 'shipped') {
      footer.push(
        <Button
          key="reject"
          size="small"
          danger
          icon={<CloseOutlined />}
          onClick={() => actions.onReject?.(concept)}
        >
          {tt('رفض', 'Reject')}
        </Button>,
      );
    }
  }

  return (
    <Card
      size="small"
      title={
        <Space size={6} wrap>
          <FormatTag format={concept.format} />
          <GroundingTag grounding={concept.grounding} />
          {persisted ? <StatusTag status={concept.status} /> : null}
          {needsCalibration ? (
            <Tooltip
              title={tt(
                'لا توجد أمثلة صوت في عقل العلامة بعد — النبرة تحتاج معايرة.',
                'No voice examples in the Brand Brain yet — the register still needs calibration.',
              )}
            >
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                {tt('يحتاج معايرة', 'Needs calibration')}
              </Typography.Text>
            </Tooltip>
          ) : null}
        </Space>
      }
      extra={
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {pillarName ?? (persisted ? null : concept.pillar) ?? tt('بلا محور', 'No pillar')}
        </Typography.Text>
      }
      actions={footer.length > 0 ? [<Space key="actions">{footer}</Space>] : undefined}
      style={{ height: '100%' }}
    >
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {concept.title}
      </Typography.Text>

      <ArabicText className="tq-hook" style={{ marginBlockStart: 6 }}>
        {concept.hook_ar}
      </ArabicText>

      <ArabicText>
        <Typography.Paragraph
          ellipsis={compact ? { rows: 3, expandable: true, symbol: tt('المزيد', 'more') } : false}
          style={{ marginBlockEnd: 12 }}
        >
          {concept.caption_ar}
        </Typography.Paragraph>
      </ArabicText>

      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBlockEnd: 6 }}>
        <strong>{tt('الاتجاه البصري: ', 'Visual direction: ')}</strong>
        {concept.visual_direction}
      </Typography.Paragraph>

      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBlockEnd: 0 }}>
        <strong>{tt('لماذا: ', 'Why: ')}</strong>
        {concept.why}
      </Typography.Paragraph>

      {persisted && concept.shipped_engagement !== null ? (
        <Typography.Paragraph style={{ fontSize: 12, marginBlockStart: 8, marginBlockEnd: 0 }}>
          <strong>{tt('التفاعل بعد النشر: ', 'Engagement after shipping: ')}</strong>
          <span className="tq-num">{formatNumber(concept.shipped_engagement)}</span>
        </Typography.Paragraph>
      ) : null}
    </Card>
  );
}
