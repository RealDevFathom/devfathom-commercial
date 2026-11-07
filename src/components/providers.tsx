'use client';

import { usePathname } from 'next/navigation';
import { AppProviders } from '@/components/app-providers';
import { ThemeProvider } from '@/components/theme-provider';
import { PreferencesProvider } from '@/components/preferences-provider';

export function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // The customer portal uses its own identity. Keep shared Studio theme and
  // preferences without starting staff Auth.js session refreshes on focus.
  if (pathname === '/pharmacy/customer' || pathname === '/pharmacy/customer/') {
    return (
      <ThemeProvider>
        <PreferencesProvider>{children}</PreferencesProvider>
      </ThemeProvider>
    );
  }

  // The login page only needs Auth.js' signIn helper. Keeping app-wide
  // providers out of this route avoids hydrating realtime, TRPC, tooltips,
  // theming, and Motion before the user can interact with the form.
  if (
    pathname === '/login' ||
    pathname.startsWith('/login/') ||
    pathname === '/terminal' ||
    pathname === '/pos' ||
    pathname === '/kds'
  ) {
    return <>{children}</>;
  }

  return <AppProviders>{children}</AppProviders>;
}
