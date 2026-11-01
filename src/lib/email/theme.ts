// DevFathom email brand tokens — the single source of truth for every email.
// Mirrors the values in src/app/globals.css. Brand tone: understated, serious,
// quietly confident. Whitespace over decoration; no gradients/glow; hairline
// borders; brass earns its place (used rarely — eyebrows, rules, links).

export const palette = {
  // Abyss teal — the helm
  abyss900: '#08221F',
  abyss800: '#0C2E2C',
  abyss700: '#123A38',
  abyss500: '#245C57',
  abyss400: '#3C7A74',
  abyss200: '#A8CBC6',

  // Paper — warm, editorial canvas
  paper50: '#F7F5EF',
  paperWhite: '#FDFCF8',
  paper100: '#EFEBE1',
  paper200: '#E3DDD0',

  // Ink & slate — text
  ink900: '#161A19',
  slate700: '#3B423F',
  slate500: '#6E7570',

  // Brass — the one warm accent, used sparingly
  brass: '#BC8850',
  brassDeep: '#A6743F',

  // Semantic — desaturated, restrained (never consumer-app loud)
  destructive: '#9A4A40',
  success: '#3E6B52',
  warning: '#9C7A3A',
} as const;

export const fonts = {
  // Oxanium (display/headings) → graceful fallback for clients without web
  // fonts. Ends in Helvetica/Arial so it can never fall back to a serif.
  heading: "'Oxanium', 'Trebuchet MS', 'Segoe UI', Helvetica, Arial, sans-serif",
  // IBM Plex Sans (body/UI workhorse).
  body: "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  // IBM Plex Mono (metadata labels, codes).
  mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

// Email canvas geometry — the brand's largest common radius is 10px and it is
// "not pill-shaped", so corners stay architectural.
export const layout = {
  maxWidth: 600,
  radius: 10,
  radiusSm: 6,
  hairline: palette.paper200,
} as const;

const DEFAULT_APP_URL = 'https://dev-fathom-hub.vercel.app';

function isDevelopmentHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === 'lvh.me' ||
    hostname.endsWith('.lvh.me')
  );
}

function normalizeAppUrl(value: string): string {
  try {
    const url = new URL(value);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_APP_URL;

    // Local development commonly uses plain HTTP. lvh.me and its subdomains
    // resolve to loopback, so they receive the same treatment as localhost and
    // the IPv4/IPv6 loopback addresses.
    if (url.protocol === 'http:' && !isDevelopmentHost(url.hostname)) {
      url.protocol = 'https:';
    }

    return url.toString().replace(/\/$/, '');
  } catch {
    return DEFAULT_APP_URL;
  }
}

// The app's public base URL, used to build deep links and load the logo.
export function appUrl(): string {
  return normalizeAppUrl(
    process.env.NEXT_PUBLIC_APP_URL ??
      process.env.NEXTAUTH_URL ??
      process.env.AUTH_URL ??
      DEFAULT_APP_URL
  );
}

// Hosted logo mark (the chevron on an Abyss tile). Overridable via env so it can
// point at a CDN. Falls back to the prod app's public asset.
export function logoUrl(): string {
  return process.env.EMAIL_LOGO_URL ?? `${appUrl()}/images/icon-dark.png`;
}
