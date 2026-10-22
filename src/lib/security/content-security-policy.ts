const ABLY_ORIGINS =
  'https://*.ably.io https://*.ably-realtime.com https://*.ably.net ' +
  'wss://*.ably.io wss://*.ably-realtime.com wss://*.ably.net';

function liveKitConnectSrc(): string {
  const value = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (!value) return '';

  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

/** Build the request-scoped policy consumed by Next's nonce-aware renderer. */
export function contentSecurityPolicy(nonce: string): string {
  const scriptSrc =
    process.env.NODE_ENV === 'production'
      ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`
      : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`;

  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    `connect-src 'self' ${ABLY_ORIGINS} ${liveKitConnectSrc()}`,
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ]
    .join('; ')
    .replace(/\s+/g, ' ')
    .trim();
}
