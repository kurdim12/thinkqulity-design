'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Layout, Menu, Segmented, Dropdown, Typography, Tooltip, App } from 'antd';
import {
  AuditOutlined,
  BulbOutlined,
  DatabaseOutlined,
  MessageOutlined,
  SettingOutlined,
  UserOutlined,
  ThunderboltOutlined,
  TableOutlined,
} from '@ant-design/icons';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { useQuality } from '@/components/Providers';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { GOLD } from '@/lib/theme';
import { NAV, label, navKeyFor, titleFor, type NavKey } from '@/lib/nav';

const { Sider, Header, Content } = Layout;

/**
 * One icon per surface, and the type says exactly five.
 *
 * `Record<NavKey, ...>` is what makes this safe to leave here while the nav
 * itself lives in a .ts module the tests can read: adding a sixth entry to NAV
 * without deciding what it looks like is a tsc error, and tsc runs before the
 * build. The icons cannot live in nav.ts — JSX would put it out of reach of
 * `node --test --experimental-strip-types`, which is the whole point of it.
 */
const NAV_ICON: Record<NavKey, React.ReactNode> = {
  '/chat': <MessageOutlined />,
  '/board': <TableOutlined />,
  '/brand': <BulbOutlined />,
  '/digest': <AuditOutlined />,
  '/data': <DatabaseOutlined />,
};

export function Shell({ email, children }: { email: string; children: React.ReactNode }) {
  const { t, tt, locale, setLocale, isRTL } = useLocale();
  const { quality, setQuality } = useQuality();
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const { message } = App.useApp();

  /**
   * Null on a demoted screen, and the sidebar then highlights nothing. The
   * title is resolved separately, from every route this app owns rather than
   * from the five — so /concepts still names itself in the header even though
   * no sidebar entry leads there.
   */
  const selected = navKeyFor(pathname);
  const title = titleFor(pathname, locale);

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
          selectedKeys={selected === null ? [] : [selected]}
          items={NAV.map((surface) => ({
            key: surface.key,
            icon: NAV_ICON[surface.key],
            label: <Link href={surface.key}>{label(surface, locale)}</Link>,
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
            {title}
          </Typography.Text>

          {/* The whole of the product's self-defence, in two words, on every
              screen at once — which is why six screens no longer carry a
              paragraph of it each. The sentence is in the tooltip, and the
              trigger includes focus because the tooltip IS the content here:
              on hover alone a keyboard would land on the tag and be told
              nothing. */}
          <Tooltip title={t.header.readOnlyHint} trigger={['hover', 'focus']}>
            <span className="tq-tag" tabIndex={0}>
              {t.header.readOnly}
            </span>
          </Tooltip>

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

            {/* Settings leaves the sidebar for the user menu, which is where an
                operator already looks for the account he is signed in as. It is
                the only screen in here: a menu that collects every demoted
                surface would be the same fifteen-entry list wearing a hat. */}
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
                  {
                    key: 'settings',
                    icon: <SettingOutlined />,
                    label: <Link href="/settings">{t.nav.settings}</Link>,
                  },
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
