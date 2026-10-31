import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import localFont from 'next/font/local';
import './globals.css';
import { Providers } from '@/components/providers';
import { PreferenceBootstrap } from '@/components/preference-bootstrap';

// Separate subset calls preserve Unicode coverage and Latin-only preloading.
//
// Every call pins its faces to one family name through `declarations`
// (`Instrument Sans`, `IBM Plex Mono`) so the subsets compose by unicode-range,
// and the semantic tokens in globals.css (`--font-sans`, `--font-mono`) name
// those families directly. The `variable` of each call is deliberately NOT a
// semantic token: Turbopack fills the generated `.variable` class with the
// JavaScript identifier of the call (`--font-instrument-sans: "instrumentSans"`),
// which matches no @font-face, so mapping `--font-sans` from it, or reusing
// `--font-sans` as the variable name, renders the browser default face.
const instrumentSansExtended = localFont({
  src: [
    { path: './fonts/instrument-sans-400-700-latin-ext.woff2', weight: '400 700', style: 'normal' },
  ],
  variable: '--font-instrument-sans',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  fallback: ["'Instrument Sans Fallback'"],
  declarations: [
    { prop: 'font-family', value: 'Instrument Sans' },
    {
      prop: 'unicode-range',
      value:
        'U+100-2BA,U+2BD-2C5,U+2C7-2CC,U+2CE-2D7,U+2DD-2FF,U+304,U+308,U+329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF',
    },
    { prop: 'font-stretch', value: '100%' },
  ],
});

const instrumentSans = localFont({
  src: [
    { path: './fonts/instrument-sans-400-700-latin.woff2', weight: '400 700', style: 'normal' },
  ],
  variable: '--font-instrument-sans',
  display: 'swap',
  preload: true,
  adjustFontFallback: false,
  fallback: ["'Instrument Sans Fallback'"],
  declarations: [
    { prop: 'font-family', value: 'Instrument Sans' },
    {
      prop: 'unicode-range',
      value:
        'U+??,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+304,U+308,U+329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
    },
    { prop: 'font-stretch', value: '100%' },
  ],
});

const plexMonoCyrillicExtended = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-400-cyrillic-ext.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-500-cyrillic-ext.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-mono-600-cyrillic-ext.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  fallback: ["'IBM Plex Mono Fallback'"],
  declarations: [
    { prop: 'font-family', value: 'IBM Plex Mono' },
    {
      prop: 'unicode-range',
      value: 'U+460-52F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F',
    },
  ],
});

const plexMonoCyrillic = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-400-cyrillic.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-500-cyrillic.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-mono-600-cyrillic.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  fallback: ["'IBM Plex Mono Fallback'"],
  declarations: [
    { prop: 'font-family', value: 'IBM Plex Mono' },
    { prop: 'unicode-range', value: 'U+301,U+400-45F,U+490-491,U+4B0-4B1,U+2116' },
  ],
});

const plexMonoVietnamese = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-400-vietnamese.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-500-vietnamese.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-mono-600-vietnamese.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  fallback: ["'IBM Plex Mono Fallback'"],
  declarations: [
    { prop: 'font-family', value: 'IBM Plex Mono' },
    {
      prop: 'unicode-range',
      value:
        'U+102-103,U+110-111,U+128-129,U+168-169,U+1A0-1A1,U+1AF-1B0,U+300-301,U+303-304,U+308-309,U+323,U+329,U+1EA0-1EF9,U+20AB',
    },
  ],
});

const plexMonoExtended = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-400-latin-ext.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-500-latin-ext.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-mono-600-latin-ext.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  fallback: ["'IBM Plex Mono Fallback'"],
  declarations: [
    { prop: 'font-family', value: 'IBM Plex Mono' },
    {
      prop: 'unicode-range',
      value:
        'U+100-2BA,U+2BD-2C5,U+2C7-2CC,U+2CE-2D7,U+2DD-2FF,U+304,U+308,U+329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF',
    },
  ],
});

const plexMono = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-400-latin.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-500-latin.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-mono-600-latin.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
  preload: true,
  adjustFontFallback: false,
  fallback: ["'IBM Plex Mono Fallback'"],
  declarations: [
    { prop: 'font-family', value: 'IBM Plex Mono' },
    {
      prop: 'unicode-range',
      value:
        'U+??,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+304,U+308,U+329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
    },
  ],
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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html
      lang="en"
      data-theme="light"
      className={`${instrumentSansExtended.variable} ${instrumentSans.variable} ${plexMonoCyrillicExtended.variable} ${plexMonoCyrillic.variable} ${plexMonoVietnamese.variable} ${plexMonoExtended.variable} ${plexMono.variable} h-full`}
      // Saved preferences intentionally mutate only <html> before hydration.
      // React's one-level escape hatch must not spread to descendants.
      suppressHydrationWarning
    >
      <head>
        <PreferenceBootstrap nonce={nonce} />
      </head>
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
