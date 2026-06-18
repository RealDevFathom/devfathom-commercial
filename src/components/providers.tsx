'use client';

import { SessionProvider } from 'next-auth/react';
import { LazyMotion, domMax } from 'motion/react';
import { ThemeProvider } from 'next-themes';
import { TRPCProvider } from '@/lib/trpc-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <ThemeProvider
        attribute="class"
        defaultTheme="light"
        enableSystem={false}
        disableTransitionOnChange
      >
        <TRPCProvider>
          <TooltipProvider delay={200}>
            <LazyMotion features={domMax}>{children}</LazyMotion>
            <Toaster position="top-right" richColors closeButton />
          </TooltipProvider>
        </TRPCProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}
