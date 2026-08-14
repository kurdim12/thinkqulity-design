import type { ThemeConfig } from 'antd';

/**
 * The STUDIO's chrome — deliberately neutral charcoal + gold so it never gets
 * mistaken for the client's identity. Think Quality's own palette only ever
 * appears inside concept previews, and only once brand.palette exists.
 */
export const CHARCOAL = '#1C1B19';
export const GOLD = '#C9A227';
export const PAPER = '#F6F4F0';

export const studioTheme: ThemeConfig = {
  token: {
    colorPrimary: GOLD,
    colorInfo: GOLD,
    colorLink: '#8A6D1F',
    colorBgLayout: PAPER,
    colorTextBase: CHARCOAL,
    borderRadius: 10,
    fontSize: 14,
    wireframe: false,
  },
  components: {
    Layout: {
      headerBg: '#FFFFFF',
      siderBg: CHARCOAL,
      headerHeight: 60,
      bodyBg: PAPER,
    },
    Menu: {
      darkItemBg: CHARCOAL,
      darkSubMenuItemBg: CHARCOAL,
      darkItemSelectedBg: 'rgba(201, 162, 39, 0.18)',
      darkItemSelectedColor: GOLD,
      darkItemHoverColor: GOLD,
    },
    Card: { headerFontSize: 15 },
    Statistic: { titleFontSize: 13 },
  },
};
