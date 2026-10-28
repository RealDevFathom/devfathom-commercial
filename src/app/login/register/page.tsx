import { headers } from 'next/headers';
import { Logo } from '@/components/brand/logo';
import { LoginHero } from '../login-hero';
import { loginVertical, verticalCopy, workspaceEyebrow } from '../vertical';
import { RequestForm } from './request-form';
export const metadata = { title: 'Request a workspace' };
export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const requestHeaders = await headers();
  const vertical = loginVertical(
    query.vertical,
    requestHeaders.get('x-devfathom-host') ?? requestHeaders.get('host')
  );
  return (
    <div className="studio-auth studio-auth-register">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:bg-surface-card focus:p-4"
      >
        Skip to form
      </a>
      <LoginHero vertical={vertical} registration />
      <main id="main-content" className="studio-auth-main">
        <div className="w-full max-w-[34rem]">
          <div className="mb-10 lg:hidden">
            <Logo variant="auto" />
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent-brand">
            {workspaceEyebrow(vertical)}
          </p>
          <h1 className="mt-3 text-[clamp(2.1rem,4vw,3.15rem)] font-semibold leading-tight tracking-[-0.055em]">
            {verticalCopy[vertical].setup}
          </h1>
          <p className="mt-3 text-sm leading-6 text-text-muted">
            {vertical === 'pharmacy'
              ? 'Tell us about the premises and the licence. We check both before the counter can sell.'
              : vertical === 'restaurant'
                ? 'Tell us how you serve and where your first branch is. We review every request before the workspace goes live.'
                : 'Choose how the property operates and where it is. We review your details before setup begins.'}
          </p>
          {vertical === 'default' ? (
            <nav aria-label="Workspace type" className="mt-8 grid gap-4">
              {(['pharmacy', 'restaurant', 'hotel'] as const).map((v) => (
                <a
                  className="studio-auth-link rounded-[var(--radius-sm)] border border-border-default bg-surface-card p-5"
                  key={v}
                  href={`/login/register?vertical=${v}`}
                >
                  {verticalCopy[v].setup} →
                </a>
              ))}
            </nav>
          ) : (
            <RequestForm vertical={vertical} />
          )}
          <p className="mt-8 border-t border-border-subtle pt-6 text-sm text-text-muted">
            Already set up?{' '}
            <a
              className="studio-auth-link text-text-strong"
              href={`/login${vertical === 'default' ? '' : `?vertical=${vertical}`}`}
            >
              Sign in
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}
