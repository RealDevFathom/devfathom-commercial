import type { Metadata, Viewport } from 'next';
import { Instrument_Sans, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/providers';
import { PreferenceBootstrap } from '@/components/preference-bootstrap';

// Instrument Sans gives the workspace its precise, editorial geometry.
const instrumentSans = Instrument_Sans({
  variable: '--font-sans',
  subsets: ['latin'],
  display: 'swap',
});

// IBM Plex Mono — code, data, small metadata.
const plexMono = IBM_Plex_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
});

const description =
  'The DevFathom company hub — projects, finance, clients, people, and real-time collaboration in one calm, unified workspace for the team that designs, builds, and advises.';

export const metadata: Metadata = {
  metadataBase: new URL('https://dev-fathom-hub.vercel.app'),
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
    url: 'https://dev-fathom-hub.vercel.app',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'DevFathom Hub',
    description,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#E8E8E5' },
    { media: '(prefers-color-scheme: dark)', color: '#181817' },
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
      data-theme="light"
      className={`${instrumentSans.variable} ${plexMono.variable} h-full`}
      // Saved preferences intentionally mutate only <html> before hydration.
      // React's one-level escape hatch must not spread to descendants.
      suppressHydrationWarning
    >
      <head>
        <PreferenceBootstrap />
      </head>
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
