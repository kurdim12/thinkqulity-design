'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Layout, Menu, Segmented, Dropdown, Typography, Tooltip, App } from 'antd';
import {
  AppstoreOutlined,
  BulbOutlined,
  CalendarOutlined,
  DatabaseOutlined,
  DashboardOutlined,
  FileTextOutlined,
  RocketOutlined,
  SettingOutlined,
  UserOutlined,
  ThunderboltOutlined,
  TableOutlined,
  TeamOutlined,
  ReadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { useQuality } from '@/components/Providers';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { GOLD } from '@/lib/theme';

const { Sider, Header, Content } = Layout;

export function Shell({ email, children }: { email: string; children: React.ReactNode }) {
  const { t, tt, locale, setLocale, isRTL } = useLocale();
  const { quality, setQuality } = useQuality();
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const { message } = App.useApp();

  const items = [
    { key: '/dashboard', icon: <DashboardOutlined />, label: t.nav.dashboard },
    { key: '/brand', icon: <BulbOutlined />, label: t.nav.brand },
    { key: '/data', icon: <DatabaseOutlined />, label: t.nav.data },
    { key: '/concepts', icon: <AppstoreOutlined />, label: t.nav.concepts },
    { key: '/campaigns', icon: <RocketOutlined />, label: t.nav.campaigns },
    { key: '/calendar', icon: <CalendarOutlined />, label: t.nav.calendar },
    { key: '/reports', icon: <FileTextOutlined />, label: t.nav.reports },
    { key: '/board', icon: <TableOutlined />, label: t.nav.board },
    // Labelled inline rather than from dict.ts: the dictionary is shared with
    // other work in flight, and this screen needs exactly one new string.
    { key: '/audience', icon: <TeamOutlined />, label: tt('الجمهور', 'Audience') },
    { key: '/guideline', icon: <ReadOutlined />, label: t.nav.guideline },
    { key: '/compliance', icon: <SafetyCertificateOutlined />, label: t.nav.compliance },
    { key: '/settings', icon: <SettingOutlined />, label: t.nav.settings },
  ];

  const selected = items.find((i) => pathname.startsWith(i.key))?.key ?? '/dashboard';

  async function signOut() {
    try {
      await supabaseBrowser().auth.signOut();
    } catch {
      // Sign-out is best-effort; the redirect below is what matters.
    }
    router.replace('/login');
    router.refresh();
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        breakpoint="lg"
        width={224}
        theme="dark"
      >
        <div
          style={{
            padding: collapsed ? '18px 8px' : '18px 20px',
            borderBlockEnd: '1px solid rgba(255,255,255,0.08)',
            marginBlockEnd: 8,
          }}
        >
          <div style={{ color: GOLD, fontWeight: 700, fontSize: collapsed ? 16 : 15 }}>
            {collapsed ? 'TQ' : t.appName}
          </div>
          {!collapsed && (
            <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, marginBlockStart: 2 }}>
              {t.byline}
            </div>
          )}
        </div>

        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selected]}
          items={items.map((item) => ({
            key: item.key,
            icon: item.icon,
            label: <Link href={item.key}>{item.label}</Link>,
          }))}
        />
      </Sider>

      <Layout>
        <Header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            paddingInline: 20,
            borderBlockEnd: '1px solid var(--tq-line)',
          }}
        >
          <Typography.Text strong style={{ fontSize: 15 }}>
            {items.find((i) => i.key === selected)?.label}
          </Typography.Text>

          <div className="tq-inline-end" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Segmented
              size="small"
              value={locale}
              onChange={(value) => setLocale(value as 'en' | 'ar')}
              options={[
                { label: 'EN', value: 'en' },
                { label: 'عربي', value: 'ar' },
              ]}
            />

            <Tooltip
              title={tt(
                'النموذج القياسي أسرع؛ نموذج الجودة العالية للتفكير الاستراتيجي الأصعب.',
                'Standard is faster; Quality uses the stronger model for harder strategy work.',
              )}
            >
              <Segmented
                size="small"
                value={quality}
                onChange={(value) => {
                  const next = value as 'standard' | 'high';
                  setQuality(next);
                  message.success(
                    next === 'high'
                      ? tt('سيستخدم التوليد التالي نموذج الجودة العالية.', 'Next generation will use the quality model.')
                      : tt('سيستخدم التوليد التالي النموذج القياسي.', 'Next generation will use the standard model.'),
                  );
                }}
                options={[
                  { label: t.header.standard, value: 'standard' },
                  {
                    label: (
                      <span>
                        <ThunderboltOutlined /> {t.header.high}
                      </span>
                    ),
                    value: 'high',
                  },
                ]}
              />
            </Tooltip>

            <Dropdown
              placement={isRTL ? 'bottomLeft' : 'bottomRight'}
              menu={{
                items: [
                  {
                    key: 'email',
                    disabled: true,
                    label: (
                      <span style={{ fontSize: 12 }}>
                        {t.header.signedInAs} <strong>{email}</strong>
                      </span>
                    ),
                  },
                  { type: 'divider' as const },
                  { key: 'signout', label: t.header.signOut, onClick: () => void signOut() },
                ],
              }}
            >
              <a
                onClick={(e) => e.preventDefault()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'inherit' }}
              >
                <UserOutlined />
              </a>
            </Dropdown>
          </div>
        </Header>

        <Content>{children}</Content>
      </Layout>
    </Layout>
  );
}
