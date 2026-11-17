'use client';

import { useMemo } from 'react';
import { encodeQrCode } from '@/lib/qr-code';

/** White modules the QR standard requires around the code. */
const QUIET_ZONE = 4;

/**
 * Builds the QR matrix for an authenticator setup link (`otpauth://…`).
 * Drawn in the browser: the secret inside the link never leaves the page.
 * Returns one SVG path of 1×1 module squares and the grid size including the
 * quiet zone the QR standard requires around the code.
 */
export function authenticatorQrPath(uri: string): { path: string; size: number } {
  const modules = encodeQrCode(uri);
  const size = modules.length + QUIET_ZONE * 2;
  let path = '';
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
    })
  );
  return { path, size };
}

/**
 * A scannable QR code for adding an account to an authenticator app.
 * Always black on white, whatever the theme, because phone cameras need the
 * contrast and the white margin to read it.
 */
export function AuthenticatorQr({ uri, className }: { uri: string; className?: string }) {
  const { path, size } = useMemo(() => authenticatorQrPath(uri), [uri]);
  return (
    <svg
      role="img"
      aria-label="QR code to scan with your authenticator app"
      data-testid="authenticator-qr"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={className ?? 'h-44 w-44 max-w-full rounded-lg border border-border-subtle'}
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
