'use client';

import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';

const AppProviders = dynamic(() =>
  import('@/components/app-providers').then((module) => module.AppProviders)
);

export function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // The login page only needs Auth.js' signIn helper. Keeping app-wide
  // providers out of this route avoids hydrating realtime, TRPC, tooltips,
  // theming, and Motion before the user can interact with the form.
  if (pathname === '/login') return <>{children}</>;

  return <AppProviders>{children}</AppProviders>;
}
