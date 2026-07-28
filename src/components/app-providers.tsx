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
    <SessionProvider>
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
