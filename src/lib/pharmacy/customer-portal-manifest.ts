/**
 * DEV-15 (#762): installable web app manifest for the customer PWA. Scope and
 * start URL stay inside /my-pharmacy; the icons are the shipped app icons.
 */
export function portalManifest() {
  return {
    id: '/my-pharmacy',
    name: 'My pharmacy',
    short_name: 'My pharmacy',
    description: 'Receipts, refill requests, prescription orders, khata and loyalty points.',
    start_url: '/my-pharmacy',
    scope: '/my-pharmacy',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f6f6f3',
    theme_color: '#f6f6f3',
    icons: [
      { src: '/favicon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/favicon.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/images/icon-dark.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  } as const;
}
