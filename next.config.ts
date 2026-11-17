import type { NextConfig } from 'next';

// Content-Security-Policy is generated per request in src/proxy.ts so Next can
// propagate its nonce to framework and application scripts.

const nextConfig: NextConfig = {
  output: 'standalone',
  // DEV-857: `next dev` otherwise re-adds a managed block to AGENTS.md on every
  // start. The repository maintains its own agent instructions there.
  agentRules: false,
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
      ],
    },
  ],
  poweredByHeader: false,
};

export default nextConfig;
