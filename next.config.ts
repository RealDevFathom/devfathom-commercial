import type { NextConfig } from 'next';

// Content-Security-Policy. `'unsafe-inline'` for scripts is a temporary allowance
// (Next's inline hydration bootstrap); the hardening goal is a nonce-based policy.
// `connect-src` must allow Ably's realtime hosts — both the https REST token
// requests AND the realtime websocket. The legacy Socket.IO origin is retained
// only while NEXT_PUBLIC_SOCKET_URL is set; it's a harmless no-op once unset.
// NOTE: tune this if a feature breaks (e.g. a new third-party origin).
// (The legacy Socket.IO connect-src origin was removed in SEC-01 — Ably/JaaS are
// allowlisted explicitly, so no blanket ws:/wss: or NEXT_PUBLIC_SOCKET_URL is used.)
// Ably cycles a primary host plus lettered fallbacks across these domains; ALL
// must be allowed or the browser's CSP blocks the token request before it's even
// sent (surfaces as Ably "requestToken … statusCode=400" + connection failure).
const ablyOrigins =
  'https://*.ably.io https://*.ably-realtime.com https://*.ably.net ' +
  'wss://*.ably.io wss://*.ably-realtime.com wss://*.ably.net';
// JaaS (8x8-hosted Jitsi) video embed: external_api.js loads from 8x8.vc, the
// meeting runs in an iframe served from 8x8.vc, and the API fetches room config
// over https/wss. Without these, the browser's CSP silently blocks the embed.
const jaasScript = 'https://8x8.vc https://*.8x8.vc';
const jaasConnect = 'https://8x8.vc https://*.8x8.vc wss://8x8.vc wss://*.8x8.vc';
const jaasFrame = 'https://8x8.vc https://*.8x8.vc';
// Dev/HMR (Turbopack) needs 'unsafe-eval'; keep it OUT of production.
const isDev = process.env.NODE_ENV !== 'production';
const scriptSrc = isDev
  ? `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${jaasScript}`
  : `script-src 'self' 'unsafe-inline' ${jaasScript}`;
const contentSecurityPolicy = [
  "default-src 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline'",
  // SEC-02: was `'self' data: https:`, allowing images from ANY https origin (a
  // tracking-pixel/exfil surface). Avatars/attachments are served same-origin
  // (/api/files, plain <img>) or as data:/blob: previews — no external host needed.
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // SEC-01: the explicit Ably/JaaS wss: allowlist above is authoritative — drop
  // the blanket `ws: wss:` (which let a WebSocket reach ANY host, nullifying the
  // allowlist) and the stale Socket.IO origin (which had leaked as localhost:3001).
  `connect-src 'self' ${ablyOrigins} ${jaasConnect}`,
  `frame-src 'self' ${jaasFrame}`,
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
    remotePatterns: [{ protocol: 'https', hostname: 'dev-fathom-hub.vercel.app' }],
    formats: ['image/avif', 'image/webp'],
  },
  experimental: {
    optimizePackageImports: ['@base-ui/react', 'cmdk'],
  },
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        {
          // Camera/microphone/screen-share must be delegated to this origin and
          // the JaaS (8x8.vc) iframe, or the browser blocks getUserMedia and the
          // video call can't access the camera or mic. Geolocation stays denied.
          key: 'Permissions-Policy',
          value:
            'camera=(self "https://8x8.vc"), microphone=(self "https://8x8.vc"), display-capture=(self "https://8x8.vc"), geolocation=()',
        },
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
