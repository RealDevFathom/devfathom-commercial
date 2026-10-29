import type { ReactNode } from 'react';
import { Logo } from '@/components/brand/logo';
import { LoginHero } from '@/app/login/login-hero';

type AuthRecoveryShellProps = {
  children: ReactNode;
  context: string;
};

/**
 * The Studio authentication composition shared by account-recovery flows.
 * The form remains the only content on small screens; the positioning panel
 * appears at the same desktop breakpoint as sign-in.
 */
export function AuthRecoveryShell({ children, context }: AuthRecoveryShellProps) {
  return (
    <main
      id="main-content"
      className="min-h-dvh bg-background text-foreground lg:grid lg:grid-cols-[minmax(0,1.08fr)_minmax(26rem,0.92fr)]"
    >
      <a
        href="#recovery-form"
        className="sr-only z-50 bg-surface-card px-4 py-3 text-text-strong focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to account form
      </a>
      <LoginHero />

      <div className="relative flex min-h-dvh items-center justify-center px-5 py-10 sm:px-10">
        <div className="w-full max-w-[25rem] animate-slide-up">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <Logo variant="auto" size="md" textClassName="text-foreground" />
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted">
              {context}
            </span>
          </div>

          <section id="recovery-form" className="border-l-2 border-primary pl-5 sm:pl-6">
            {children}
          </section>
        </div>
      </div>
    </main>
  );
}
