'use client';

import { SessionProvider } from 'next-auth/react';
import { LazyMotion, domMax } from 'motion/react';
import { PreferencesProvider } from '@/components/preferences-provider';
import { ThemeProvider } from '@/components/theme-provider';
import { TRPCProvider } from '@/lib/trpc-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    // No component reads this provider's session: every useSession() consumer
    // sits under a nearer provider seeded with the server-validated session
    // (TenantSessionBoundary, the POS/KDS pages); this one only backs the
    // signIn/signOut helpers. Left unseeded it starts "loading" and flips to
    // settled right after hydration. That context change makes React
    // client-render any Suspense boundary still waiting on streamed content,
    // leaving the streamed copy of the page (and its forms) hidden in the
    // document beside the live one. `null` starts it settled, with no fetch.
    <SessionProvider session={null}>
      <ThemeProvider>
        {/* The five non-theme surface toggles (density/type/accent/layout/icons).
            Lives inside ThemeProvider so theme + prefs coexist on <html>. */}
        <PreferencesProvider>
          <TRPCProvider>
            <TooltipProvider delay={200}>
              <LazyMotion features={domMax}>{children}</LazyMotion>
              <Toaster position="top-right" richColors closeButton />
            </TooltipProvider>
          </TRPCProvider>
        </PreferencesProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}
