import type { ReactNode } from 'react';
import { Logo } from '@/components/brand/logo';
import { LoginHero } from '@/app/login/login-hero';

type AuthRecoveryShellProps = {
  children: ReactNode;
  context: string;
  wide?: boolean;
};

/**
 * The Studio authentication composition shared by account-recovery flows.
 * The form remains the only content on small screens; the positioning panel
 * appears at the same desktop breakpoint as sign-in.
 */
export function AuthRecoveryShell({ children, context, wide = false }: AuthRecoveryShellProps) {
  return (
    <main className="min-h-dvh bg-surface-page text-text-strong lg:grid lg:grid-cols-[minmax(0,1.08fr)_minmax(26rem,0.92fr)]">
      <LoginHero />

      <div className="relative flex min-h-dvh items-center justify-center px-5 py-10 sm:px-10">
        <div
          className={
            wide
              ? 'w-full max-w-[30rem] animate-slide-up'
              : 'w-full max-w-[25rem] animate-slide-up'
          }
        >
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <Logo variant="auto" size="md" textClassName="text-foreground" />
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted">
              {context}
            </span>
          </div>

          <section className="rounded-md border border-border-subtle bg-surface-card p-6 shadow-xs sm:p-8">
            {children}
          </section>
        </div>
      </div>
    </main>
  );
}
