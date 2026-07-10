import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import Script from 'next/script';
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
// CSS in globals.css applies pre-hydration. Theme is included here too so the
// saved surface and color choices become visible together. The values are
// allow-listed and no user content is evaluated.
const PREFERENCES_FOUC_SCRIPT = `(function(){try{var d=document.documentElement;var allow={density:['default','compact'],type:['default','lg'],accent:['quiet','bold'],layout:['rail','top'],icons:['numeric','architectural']};var def={density:'default',type:'default',accent:'quiet',layout:'rail',icons:'numeric'};var raw=localStorage.getItem('devfathom-prefs');var p=raw?JSON.parse(raw):{};Object.keys(allow).forEach(function(k){var v=p&&p[k];if(allow[k].indexOf(v)===-1)v=def[k];d.setAttribute('data-'+k,v);});var theme=localStorage.getItem('theme');theme=theme==='dark'?'dark':'light';d.setAttribute('data-theme',theme);d.style.colorScheme=theme;}catch(e){}})();`;

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
    { media: '(prefers-color-scheme: light)', color: '#F7F1E5' },
    { media: '(prefers-color-scheme: dark)', color: '#18211B' },
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
      className={`${plexSans.variable} ${plexMono.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="min-h-full">
        <Providers>{children}</Providers>
        {/* Injected by Next before hydration, avoiding a raw React <script>. */}
        <Script
          id="apply-user-preferences"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: PREFERENCES_FOUC_SCRIPT }}
        />
      </body>
    </html>
  );
}
