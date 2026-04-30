import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ServiceWorkerRegister } from './sw-register';
import { datatypeFont } from '@/lib/datatype-font';

export const metadata: Metadata = {
  title: 'b1dz — AI Arbitrage Terminal',
  description: 'Realtime auto-trading across multiple crypto exchanges. AI-powered arbitrage and trading strategies.',
  manifest: '/manifest.webmanifest',
  applicationName: 'b1dz',
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={datatypeFont.variable}>
      <body>
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}
