import type { NextConfig } from 'next';

// Content-Security-Policy. `'unsafe-inline'` for scripts is a temporary allowance
// (Next's inline hydration bootstrap); the hardening goal is a nonce-based policy.
// `connect-src` includes the realtime socket origin + ws/wss for Socket.IO.
// NOTE: tune this if a feature breaks (e.g. a new third-party origin).
const socketOrigin = process.env.NEXT_PUBLIC_SOCKET_URL || '';
// Dev/HMR (Turbopack) needs 'unsafe-eval'; keep it OUT of production.
const isDev = process.env.NODE_ENV !== 'production';
const scriptSrc = isDev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";
const contentSecurityPolicy = [
  "default-src 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  `connect-src 'self' ${socketOrigin} ws: wss:`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
]
  .join('; ')
  .replace(/\s+/g, ' ')
  .trim();

const nextConfig: NextConfig = {
  serverExternalPackages: ['bcryptjs'],
  images: {
    // Was `hostname: '**'`, which turned the Next image optimizer into an open
    // proxy (SSRF: `/_next/image?url=<any-host>`). The app renders avatars with
    // plain <img>, not next/image, so restricting to the production origin breaks
    // nothing. Add hosts here only as concrete needs arise.
    remotePatterns: [{ protocol: 'https', hostname: 'hub.devfathom.com' }],
  },
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=63072000; includeSubDomains; preload',
        },
        { key: 'Content-Security-Policy', value: contentSecurityPolicy },
      ],
    },
  ],
  poweredByHeader: false,
};

export default nextConfig;
