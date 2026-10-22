'use client';

import { useMemo } from 'react';
import { qrCodeModules } from '@/lib/qr-code';

export function AuthenticatorQrCode({ uri }: { uri: string }) {
  const modules = useMemo(() => {
    try {
      return qrCodeModules(uri);
    } catch {
      return null;
    }
  }, [uri]);

  if (!modules) return <p className="text-xs text-text-muted">Use the setup key for manual entry.</p>;
  const quietZone = 4;
  const size = modules.length + quietZone * 2;
  const path = modules
    .flatMap((row, y) =>
      row.map((dark, x) => (dark ? `M${x + quietZone} ${y + quietZone}h1v1h-1z` : '')),
    )
    .join('');
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Scan to add this account to an authenticator app"
      shapeRendering="crispEdges"
      className="h-44 w-44 rounded-sm bg-white"
    >
      <rect width={size} height={size} fill="white" />
      <path d={path} fill="black" />
    </svg>
  );
}
