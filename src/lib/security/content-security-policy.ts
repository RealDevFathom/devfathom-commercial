const ablyOrigins =
  'https://*.ably.io https://*.ably-realtime.com https://*.ably.net ' +
  'wss://*.ably.io wss://*.ably-realtime.com wss://*.ably.net';

function liveKitConnectSrc(): string {
  // Invalid configuration fails closed instead of widening connect-src.
  const value = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (!value) return '';
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

/** Build the request-specific policy consumed by Next.js to nonce its scripts. */
export function contentSecurityPolicy(nonce: string): string {
  const scriptSrc = `script-src 'self' 'nonce-${nonce}'${
    process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"
  }`;

  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    `connect-src 'self' ${ablyOrigins} ${liveKitConnectSrc()}`,
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
