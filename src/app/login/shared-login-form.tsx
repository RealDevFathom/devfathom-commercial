'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Building2, Loader2, ShieldCheck } from 'lucide-react';
import { LOGIN_ERROR_MESSAGES, type LoginErrorKey } from './login-errors';
import { useHydrated } from './use-hydrated';
import { PasswordInput } from '@/components/ui/password-input';
import { Button } from '@/components/ui/button';
import { verticalCopy, workspaceEyebrow, type LoginVertical } from './vertical';

type Organization = {
  id: string;
  slug: string;
  displayName: string;
  ssoEnforced: boolean;
  /** The workspace's own host, where its SSO flow begins. Null if unconfigured. */
  ssoUrl: string | null;
};

type Stage = 'credentials' | 'select' | 'sso-only';

const inputClass =
  'flex h-12 w-full rounded-[var(--radius-sm)] border border-border-default bg-card px-4 text-sm text-foreground placeholder:text-text-faint transition-colors focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-destructive/20';

const GENERIC_ERROR = 'Invalid email or password. Please try again.';

/** "in 45 seconds" / "in 3 minutes" — never "in 0 seconds". */
function describeWait(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'in a few minutes';
  if (seconds < 60) return `in ${Math.ceil(seconds)} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/**
 * WHA-1208 — a tripped rate limiter is not a wrong password.
 *
 * `/api/login` deliberately returns the SAME body for both, so the endpoint
 * cannot be used to discover which addresses exist. But the status code already
 * separates them, so the form can name the real state — and say that retyping
 * the password will not help, because the limiter runs before the credential
 * check and the password was never looked at.
 */
function rateLimitedError(retryAfterHeader: string | null): string {
  const wait = describeWait(Number(retryAfterHeader));
  // Neutral about WHICH limiter tripped: the per-address one would otherwise
  // hint that the address is real.
  return `Too many sign-in attempts. Your password was not checked — wait ${wait} and try again.`;
}

/**
 * The shared-host sign-in.
 *
 * The URL carries no workspace slug and no `workspace=` parameter at any point.
 * Credentials are proven first; only then does the server say anything about
 * which organizations exist. When there is exactly one, the flow continues
 * straight to the workspace; when there are several, this renders the selection
 * screen. The chosen organization travels in the authenticated session, never in
 * the address bar.
 */
export function SharedLoginForm({
  vertical = 'default',
  callbackUrl,
  // WHA-1623: the outcome of a native submit that landed before hydration.
  initialError,
}: {
  vertical?: LoginVertical;
  callbackUrl: string;
  initialError?: LoginErrorKey;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const errorId = useId();
  const [stage, setStage] = useState<Stage>('credentials');
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string>(
    initialError ? LOGIN_ERROR_MESSAGES[initialError] : ''
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingOrganizationId, setPendingOrganizationId] = useState<string | null>(null);
  // Revealed only after a correct password, when the chosen account has 2FA on.
  const [twoFactorFor, setTwoFactorFor] = useState<string | null>(null);
  const totpRef = useRef<HTMLInputElement>(null);

  // Loaded in parallel with the credential request so the workspace transition
  // does not inherit the login page's bundle cost.
  const appProvidersReady = useRef<Promise<unknown> | null>(null);

  const selectable = organizations.filter((organization) => !organization.ssoEnforced);

  async function continueInto(organizationId: string, totp?: string) {
    setPendingOrganizationId(organizationId);
    setError('');
    try {
      const result = await signIn('login-intent', {
        organizationId,
        totp: totp ?? '',
        redirect: false,
      });

      if (result?.error) {
        if (result.code === '2fa_required') {
          setTwoFactorFor(organizationId);
          setError('Enter the 6-digit code from your authenticator app.');
        } else if (result.code === '2fa_invalid') {
          setTwoFactorFor(organizationId);
          setError('That code is incorrect or expired. Try again, or use a recovery code.');
        } else if (result.code === 'suspended') {
          setError('Your account has been suspended. Please contact your workspace administrator.');
        } else if (result.code === 'sso_required') {
          setError('This workspace requires enterprise SSO. Use its identity provider to sign in.');
        } else {
          setError('That sign-in could not be completed. Please sign in again.');
          setStage('credentials');
        }
        setPendingOrganizationId(null);
        setIsSubmitting(false);
        return;
      }

      await appProvidersReady.current;
      router.replace(callbackUrl);
    } catch {
      setError('Unable to sign in right now. Please check your connection and try again.');
      setPendingOrganizationId(null);
      setIsSubmitting(false);
    }
  }

  const onSubmitCredentials = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setIsSubmitting(true);

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get('email') ?? '');
    const password = String(formData.get('password') ?? '');

    appProvidersReady.current = import('@/components/app-providers');

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, callbackUrl }),
      });

      // Checked before the body, which is deliberately identical to a 401's.
      if (response.status === 429) {
        setError(rateLimitedError(response.headers.get('retry-after')));
        setIsSubmitting(false);
        return;
      }

      const body = (await response.json()) as {
        outcome?: string;
        organizations?: Organization[];
        message?: string;
      };

      if (!response.ok || body.outcome === 'failed') {
        setError(body.message ?? GENERIC_ERROR);
        setIsSubmitting(false);
        return;
      }

      const found = body.organizations ?? [];
      setOrganizations(found);

      if (body.outcome === 'single') {
        const only = found.find((organization) => !organization.ssoEnforced);
        if (!only) {
          setStage('sso-only');
          setIsSubmitting(false);
          return;
        }
        // Exactly one eligible workspace: continue without an extra step.
        await continueInto(only.id);
        return;
      }

      setStage(body.outcome === 'sso-only' ? 'sso-only' : 'select');
      setIsSubmitting(false);
    } catch {
      setError('Unable to sign in right now. Please check your connection and try again.');
      setIsSubmitting(false);
    }
  };

  const onSubmitTwoFactor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!twoFactorFor) return;
    setIsSubmitting(true);
    await continueInto(twoFactorFor, totpRef.current?.value ?? '');
  };

  const HEADINGS: Record<Stage, { eyebrow: string; title: string; description: string }> = {
    credentials: {
      eyebrow: workspaceEyebrow(vertical),
      title: 'Welcome back',
      description: verticalCopy[vertical].signIn,
    },
    select: {
      eyebrow: 'Choose a workspace',
      title: 'Where to?',
      description: 'Your account belongs to more than one workspace. Choose where to continue.',
    },
    'sso-only': {
      eyebrow: 'Single sign-on',
      title: 'Continue with SSO',
      description: 'Every workspace on this account signs in through its own identity provider.',
    },
  };
  const heading = HEADINGS[stage];

  const header = (
    <div className="mb-8">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-accent-brand">
        {heading.eyebrow}
      </p>
      <h1 className="mt-3 font-display text-[clamp(2rem,4vw,2.7rem)] font-semibold tracking-[-0.05em] text-foreground">
        {heading.title}
      </h1>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
        {heading.description}
      </p>
    </div>
  );

  const alert = error ? (
    <div
      id={errorId}
      role="alert"
      className="mb-5 rounded-[var(--radius-sm)] border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
    >
      {error}
    </div>
  ) : null;

  if (stage === 'credentials') {
    return (
      <>
        {header}
        {/* Reserve two text-sm lines, py-3 padding, and both borders. */}
        <div className="mb-5 min-h-[calc(4rem+2px)] [&>[role=alert]]:mb-0">{alert}</div>
        {/* WHA-1623: `action` is the no-JavaScript path. Once hydrated,
            onSubmitCredentials prevents it and the two-step flow runs unchanged. */}
        <form
          method="post"
          action="/login/submit"
          onSubmit={onSubmitCredentials}
          data-hydrated={hydrated ? 'true' : undefined}
          className="space-y-5"
        >
          <input type="hidden" name="callbackUrl" value={callbackUrl} />
          <div className="space-y-2">
            <label htmlFor="email" className="block text-sm font-semibold text-foreground">
              Email
            </label>
            <input
              id="email"
              type="email"
              placeholder={vertical === 'default' ? 'you@company.com' : `you@${vertical}.pk`}
              autoComplete="email"
              autoFocus
              name="email"
              required
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              className={inputClass}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="password" className="block text-sm font-semibold text-foreground">
                Password
              </label>
            </div>
            <PasswordInput
              id="password"
              revealed={showPassword}
              onReveal={() => setShowPassword((visible) => !visible)}
              placeholder="Enter your password"
              autoComplete="current-password"
              name="password"
              required
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              className={inputClass}
            />
            <div className="text-end">
              <a
                href="/forgot-password"
                className="studio-auth-link rounded-[var(--radius-sm)] text-xs font-semibold text-text-muted underline-offset-4 transition-colors hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                Forgot password?
              </a>
            </div>
          </div>

          <Button
            type="submit"
            disabled={isSubmitting}
            className="group flex h-12 w-full items-center justify-center rounded-[var(--radius-sm)] bg-primary text-sm font-semibold text-primary-foreground shadow-none transition-all hover:-translate-y-px hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 active:translate-y-0 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="me-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                Signing in...
              </>
            ) : (
              'Sign in'
            )}
          </Button>
        </form>
      </>
    );
  }

  if (stage === 'sso-only') {
    return (
      <>
        {header}
        {alert}
        <ul className="space-y-3">
          {organizations.map((organization) => (
            <li key={organization.id}>
              <SsoEntry organization={organization} />
            </li>
          ))}
        </ul>
        <BackToCredentials onBack={() => resetToCredentials()} />
      </>
    );
  }

  return (
    <>
      {header}
      {alert}

      <ul className="space-y-3">
        {organizations.map((organization) =>
          organization.ssoEnforced ? (
            <li key={organization.id}>
              <SsoEntry organization={organization} />
            </li>
          ) : (
            <li key={organization.id}>
              <button
                type="button"
                onClick={() => continueInto(organization.id)}
                disabled={Boolean(pendingOrganizationId)}
                aria-describedby={error ? errorId : undefined}
                className="group flex w-full items-center justify-between gap-4 rounded-[var(--radius-sm)] border border-border-default bg-card px-4 py-4 text-start transition-colors hover:border-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-60"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-foreground">
                    {organization.displayName}
                  </span>
                  <span className="mt-1 block truncate font-mono text-[10px] uppercase tracking-[0.14em] text-text-faint">
                    {organization.slug}
                  </span>
                </span>
                {pendingOrganizationId === organization.id ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-text-muted motion-reduce:animate-none" />
                ) : (
                  <ArrowRight className="h-4 w-4 shrink-0 text-text-faint transition-colors group-hover:text-primary" />
                )}
              </button>
            </li>
          )
        )}
      </ul>

      {twoFactorFor ? (
        <form onSubmit={onSubmitTwoFactor} className="mt-6 space-y-2">
          <label htmlFor="totp" className="block text-sm font-semibold text-foreground">
            Authentication code
          </label>
          <input
            id="totp"
            ref={totpRef}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456 or a recovery code"
            autoFocus
            name="totp"
            required
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            className={inputClass}
          />
          <p className="text-xs text-text-muted">
            Open your authenticator app, or enter one of your recovery codes.
          </p>
          <Button
            type="submit"
            disabled={isSubmitting}
            className="flex h-12 w-full items-center justify-center rounded-[var(--radius-sm)] bg-primary text-sm font-semibold text-primary-foreground transition-all hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none"
          >
            {isSubmitting ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              'Continue'
            )}
          </Button>
        </form>
      ) : null}

      {selectable.length === 0 ? (
        <p className="mt-5 border-s-2 border-accent-brand bg-muted px-4 py-3 text-xs leading-5 text-text-muted">
          None of these workspaces accept a password. Use the identity provider link on each one.
        </p>
      ) : null}

      <BackToCredentials onBack={() => resetToCredentials()} />
    </>
  );

  function resetToCredentials() {
    setStage('credentials');
    setOrganizations([]);
    setTwoFactorFor(null);
    setPendingOrganizationId(null);
    setError('');
    setIsSubmitting(false);
  }
}

/**
 * D12 — an SSO-enforced workspace is shown, clearly labelled, and NOT activatable
 * as a selection. Its "Sign in with SSO" link is keyboard reachable, because a
 * member of that workspace has to be able to get there.
 */
function SsoEntry({ organization }: { organization: Organization }) {
  const labelId = `sso-${organization.id}`;
  return (
    <div
      aria-labelledby={labelId}
      className="flex items-center justify-between gap-4 rounded-[var(--radius-sm)] border border-border-subtle bg-surface-sunken px-4 py-4"
    >
      <span className="min-w-0">
        <span id={labelId} className="block truncate text-sm font-semibold text-text-muted">
          {organization.displayName}
        </span>
        <span className="mt-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-text-faint">
          <ShieldCheck className="h-3 w-3" aria-hidden="true" />
          Single sign-on required
        </span>
      </span>
      {organization.ssoUrl ? (
        <a
          href={organization.ssoUrl}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] border border-border-default bg-card px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Building2 className="h-3.5 w-3.5 text-accent-brand" aria-hidden="true" />
          Sign in with SSO
          <span className="sr-only"> to {organization.displayName}</span>
        </a>
      ) : (
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-text-faint">
          Contact your administrator
        </span>
      )}
    </div>
  );
}

function BackToCredentials({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="mt-6 rounded-[var(--radius-sm)] text-xs font-semibold text-text-muted underline-offset-4 transition-colors hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      Use a different account
    </button>
  );
}
