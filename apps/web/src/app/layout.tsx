import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ServiceWorkerRegister } from './sw-register';
import { datatypeFont } from '@/lib/datatype-font';

const SITE_URL = 'https://b1dz.com';
const SITE_TITLE = 'b1dz — AI Arbitrage Terminal';
const SITE_DESCRIPTION =
  'Realtime auto-trading across multiple crypto exchanges. AI-powered arbitrage and trading strategies.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  manifest: '/manifest.webmanifest',
  applicationName: 'b1dz',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'b1dz',
    url: SITE_URL,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [{ url: '/banner.png', width: 3000, height: 2000, alt: 'b1dz — AI Arbitrage Terminal' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ['/banner.png'],
  },
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'b1dz' },
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/favicon-16.png', sizes: '16x16', type: 'image/png' },
    ],
    shortcut: ['/icons/favicon.ico'],
    apple: [
      { url: '/icons/apple-touch-icon-180x180.png', sizes: '180x180', type: 'image/png' },
      { url: '/icons/apple-touch-icon-152x152.png', sizes: '152x152', type: 'image/png' },
      { url: '/icons/apple-touch-icon-144x144.png', sizes: '144x144', type: 'image/png' },
      { url: '/icons/apple-touch-icon-120x120.png', sizes: '120x120', type: 'image/png' },
      { url: '/icons/apple-touch-icon-114x114.png', sizes: '114x114', type: 'image/png' },
      { url: '/icons/apple-touch-icon-76x76.png', sizes: '76x76', type: 'image/png' },
      { url: '/icons/apple-touch-icon-72x72.png', sizes: '72x72', type: 'image/png' },
      { url: '/icons/apple-touch-icon-60x60.png', sizes: '60x60', type: 'image/png' },
      { url: '/icons/apple-touch-icon-57x57.png', sizes: '57x57', type: 'image/png' },
    ],
  },
  other: {
    'msapplication-TileColor': '#0a0a0a',
    'msapplication-TileImage': '/icons/apple-touch-icon-144x144.png',
    'msapplication-config': '/browserconfig.xml',
    'mobile-web-app-capable': 'yes',
  },
};

export const viewport: Viewport = {
  themeColor: '#0a0a0a',
  width: 'device-width',
  initialScale: 1,
};

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#organization`,
      name: 'b1dz',
      url: SITE_URL,
      logo: `${SITE_URL}/logo.svg`,
      description: SITE_DESCRIPTION,
      sameAs: ['https://github.com/profullstack/b1dz.com'],
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      name: SITE_TITLE,
      url: SITE_URL,
      description: SITE_DESCRIPTION,
      publisher: { '@id': `${SITE_URL}/#organization` },
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_URL}/#software`,
      name: 'b1dz',
      applicationCategory: 'FinanceApplication',
      operatingSystem: 'Web',
      url: SITE_URL,
      description:
        'AI-powered crypto arbitrage terminal with realtime multi-exchange auto-trading, deterministic setup scoring, backtesting, and risk controls.',
      featureList: [
        'Realtime multi-exchange WebSocket data',
        'Deterministic analysis engine (EMA, RSI, MACD, ATR, VWAP, market-regime classification)',
        'Spread and inventory arbitrage',
        'Backtesting and analytics',
        'OHLC charts with trade context',
        'Risk controls (trailing stops, position limits)',
        'Plugin store for DEX connectors and strategies',
      ],
      publisher: { '@id': `${SITE_URL}/#organization` },
    },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={datatypeFont.variable}>
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}
