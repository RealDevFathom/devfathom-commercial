import type { ReactNode } from 'react';
import { Logo } from '@/components/brand/logo';
import { LoginHero } from '@/app/login/login-hero';
import { verticalCopy, type LoginVertical } from '@/app/login/vertical';

/** One Studio split composition for sign-in, intake, terminal guidance and recovery. */
export function AuthShell({
  children,
  vertical = 'default',
  registration = false,
  context,
}: {
  children: ReactNode;
  vertical?: LoginVertical;
  registration?: boolean;
  context?: string;
}) {
  return (
    <div className={`studio-auth${registration ? ' studio-auth-register' : ''}`}>
      <a
        href="#main-content"
        className="sr-only fixed top-3 left-3 z-50 rounded-[var(--radius-xs)] bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus:not-sr-only"
      >
        Skip to content
      </a>
      <LoginHero vertical={vertical} registration={registration} />
      <main id="main-content" tabIndex={-1} className="studio-auth-main">
        <div className={`w-full ${registration ? 'max-w-[34rem]' : 'max-w-[25rem]'}`}>
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <Logo variant="auto" size="md" textClassName="text-foreground" />
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted">
              {context ?? verticalCopy[vertical].tag}
            </span>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
