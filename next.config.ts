import type { NextConfig } from 'next';

// Content-Security-Policy. `'unsafe-inline'` for scripts is a temporary allowance
// (Next's inline hydration bootstrap); the hardening goal is a nonce-based policy.
// `connect-src` must allow Ably's realtime hosts — both the https REST token
// requests AND the realtime websocket. The legacy Socket.IO origin is retained
// only while NEXT_PUBLIC_SOCKET_URL is set; it's a harmless no-op once unset.
// NOTE: tune this if a feature breaks (e.g. a new third-party origin).
// (The legacy Socket.IO connect-src origin was removed in SEC-01 — Ably/LiveKit are
// allowlisted explicitly, so no blanket ws:/wss: or NEXT_PUBLIC_SOCKET_URL is used.)
// Ably cycles a primary host plus lettered fallbacks across these domains; ALL
// must be allowed or the browser's CSP blocks the token request before it's even
// sent (surfaces as Ably "requestToken … statusCode=400" + connection failure).
const ablyOrigins =
  'https://*.ably.io https://*.ably-realtime.com https://*.ably.net ' +
  'wss://*.ably.io wss://*.ably-realtime.com wss://*.ably.net';
// Self-hosted LiveKit: the browser opens a WebSocket to the SFU and fetches
// over https, both on this one origin. `ws:`/`wss:` are special schemes, so
// `URL.origin` serialises them rather than returning "null".
//
// An unset or unparseable value yields an empty allowance, which FAILS CLOSED —
// the call cannot connect — rather than widening `connect-src`. A malformed
// value must not take the whole build down with an opaque URL error, so it is
// caught here and left to surface as a blocked connection instead.
function liveKitConnectSrc(): string {
  const value = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (!value) return '';
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}
const liveKitOrigin = liveKitConnectSrc();
// Dev/HMR (Turbopack) needs 'unsafe-eval'; keep it OUT of production.
const isDev = process.env.NODE_ENV !== 'production';
const scriptSrc = isDev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";
const contentSecurityPolicy = [
  "default-src 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline'",
  // SEC-02: was `'self' data: https:`, allowing images from ANY https origin (a
  // tracking-pixel/exfil surface). Avatars/attachments are served same-origin
  // (/api/files, plain <img>) or as data:/blob: previews — no external host needed.
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // Camera playback streams through /api/restaurant/cameras/*/stream as blob: media.
  "media-src 'self' blob:",
  // SEC-01: the explicit Ably/LiveKit wss: allowlist above is authoritative — drop
  // the blanket `ws: wss:` (which let a WebSocket reach ANY host, nullifying the
  // allowlist) and the stale Socket.IO origin (which had leaked as localhost:3001).
  `connect-src 'self' ${ablyOrigins} ${liveKitOrigin}`,
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
]
  .join('; ')
  .replace(/\s+/g, ' ')
  .trim();

const nextConfig: NextConfig = {
  output: 'standalone',
  // Dev-only (WHA-1623). The browser suites serve `next dev` on 127.0.0.1, and
  // Next 16 blocks its dev websocket for any origin not listed here. That
  // socket also carries the React debug channel, so without it the page never
  // hydrates. Ignored by `next start` / production. See tests/e2e/README.md.
  allowedDevOrigins: ['127.0.0.1'],
  typescript: {
    // Docker runs `tsc --noEmit` in a clean process before `next build` so the
    // low-memory ACR builder does not retain compiler and bundler heaps together.
    ignoreBuildErrors: process.env.NEXT_BUILD_SKIP_TYPECHECK === '1',
  },
  // This checkout sits beneath another project that owns a package-lock.json.
  // Pinning the root keeps Turbopack resolution and file watching local.
  turbopack: {
    root: process.cwd(),
  },
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
    // Coupled to Dockerfile's per-process NODE_OPTIONS heap ceiling. Raising this
    // multiplies concurrently available heaps and must be evaluated against the
    // image builder's total memory before changing the worker count.
    cpus: 1,
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
          // The native LiveKit client captures media on this origin. No iframe
          // delegation is needed; geolocation remains denied.
          key: 'Permissions-Policy',
          value: 'camera=(self), microphone=(self), display-capture=(self), geolocation=()',
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
