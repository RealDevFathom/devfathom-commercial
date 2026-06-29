'use client';

import { SessionProvider } from 'next-auth/react';
import { LazyMotion, domMax } from 'motion/react';
import { ThemeProvider } from 'next-themes';
import { PreferencesProvider } from '@/components/preferences-provider';
import { TRPCProvider } from '@/lib/trpc-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { RealtimeProvider } from '@/components/chat/realtime-provider';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <ThemeProvider
        attribute="data-theme"
        defaultTheme="light"
        enableSystem={false}
        disableTransitionOnChange
      >
        {/* The five non-theme surface toggles (density/type/accent/layout/icons).
            Lives inside ThemeProvider so theme + prefs coexist on <html>. */}
        <PreferencesProvider>
          <TRPCProvider>
            <TooltipProvider delay={200}>
              <LazyMotion features={domMax}>
                <RealtimeProvider>{children}</RealtimeProvider>
              </LazyMotion>
              <Toaster position="top-right" richColors closeButton />
            </TooltipProvider>
          </TRPCProvider>
        </PreferencesProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}
