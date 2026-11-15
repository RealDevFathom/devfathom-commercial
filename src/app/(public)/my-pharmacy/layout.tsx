import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

// DEV-15 (#762): the customer PWA installs from its own manifest, scoped to
// /my-pharmacy, so it never opens the staff workspace.
export const metadata: Metadata = {
  title: 'My pharmacy',
  manifest: '/my-pharmacy/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'My pharmacy', statusBarStyle: 'default' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#f6f6f3',
  width: 'device-width',
  initialScale: 1,
};

export default function MyPharmacyLayout({ children }: { children: ReactNode }) {
  return children;
}
