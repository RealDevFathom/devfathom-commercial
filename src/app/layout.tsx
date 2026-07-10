import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
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

// FOUC guard for the five configurable surface toggles (see
// preferences-provider.tsx). Runs synchronously in <head> before the body
// paints, mirroring localStorage `devfathom-prefs` onto <html> data-* so the
// CSS in globals.css applies pre-hydration. data-theme is handled separately by
// next-themes. SSR-safe (try/catch); sets attributes only — no user data.
const PREFERENCES_FOUC_SCRIPT = `(function(){try{var d=document.documentElement;var allow={density:['default','compact'],type:['default','lg'],accent:['quiet','bold'],layout:['rail','top'],icons:['numeric','architectural']};var def={density:'default',type:'default',accent:'quiet',layout:'rail',icons:'numeric'};var raw=localStorage.getItem('devfathom-prefs');var p=raw?JSON.parse(raw):{};Object.keys(allow).forEach(function(k){var v=p&&p[k];if(allow[k].indexOf(v)===-1)v=def[k];d.setAttribute('data-'+k,v);});}catch(e){}})();`;

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
    { media: '(prefers-color-scheme: light)', color: '#F4F5F1' },
    { media: '(prefers-color-scheme: dark)', color: '#0B1724' },
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
      className={`${plexSans.variable} ${plexMono.variable} h-full`}
      suppressHydrationWarning
    >
      <head>
        {/* Apply persisted surface preferences pre-paint to avoid FOUC. This is
            the ONLY dangerouslySetInnerHTML in the app — it sets <html> data-*
            attributes only, from an allow-list, with no user-controlled data. */}
        <script dangerouslySetInnerHTML={{ __html: PREFERENCES_FOUC_SCRIPT }} />
      </head>
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
