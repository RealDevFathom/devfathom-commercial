import type { Metadata, Viewport } from 'next';
import { Oxanium, IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/providers';

// IBM Plex Sans — body & UI workhorse (legible long-form).
const plexSans = IBM_Plex_Sans({
  variable: '--font-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

// IBM Plex Mono — code, data, small metadata.
const plexMono = IBM_Plex_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
});

// Oxanium — the logo face, used for display & headings so brand and
// product type read as one system.
const oxanium = Oxanium({
  variable: '--font-display',
  subsets: ['latin'],
  display: 'swap',
});

const description =
  'The DevFathom company hub — projects, finance, clients, people, and real-time collaboration in one calm, unified workspace for the team that designs, builds, and advises.';

export const metadata: Metadata = {
  metadataBase: new URL('https://hub.devfathom.com'),
  applicationName: 'DevFathom Hub',
  title: {
    default: 'DevFathom Hub',
    template: '%s · DevFathom',
  },
  description,
  keywords: [
    'DevFathom',
    'software consultancy',
    'company hub',
    'operations platform',
    'project management',
    'team collaboration',
  ],
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
    shortcut: '/favicon.ico',
  },
  manifest: '/manifest.json',
  openGraph: {
    type: 'website',
    title: 'DevFathom Hub',
    description,
    siteName: 'DevFathom',
    url: 'https://hub.devfathom.com',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'DevFathom Hub',
    description,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#0C2E2C' },
    { media: '(prefers-color-scheme: dark)', color: '#08221F' },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} ${oxanium.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
