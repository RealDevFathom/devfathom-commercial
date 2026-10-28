'use client';

import { useState, type FormEvent } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Building2, Eye, EyeOff, Loader2 } from 'lucide-react';
import { LOGIN_ERROR_MESSAGES, type LoginErrorKey } from './login-errors';
import { useHydrated } from './use-hydrated';

const inputClass =
  'flex h-12 w-full rounded-[3px] border border-border-default bg-card px-4 text-sm text-foreground placeholder:text-text-faint transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

export function LoginForm({
  connections,
  ssoEnforced,
  // D15: already validated on the server. The form no longer reads, or trusts,
  // the raw query string.
  callbackUrl,
  // WHA-1623: the outcome of a native submit that landed before hydration.
  initialError,
}: {
  connections: Array<{ id: string; name: string; protocol: 'OIDC' | 'SAML' }>;
  ssoEnforced: boolean;
  callbackUrl: string;
  initialError?: LoginErrorKey;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string>(
    initialError ? LOGIN_ERROR_MESSAGES[initialError] : ''
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  // IMP-AUTH-02: revealed after a correct password when the account has 2FA on.
  const [twoFactor, setTwoFactor] = useState(
    initialError === '2fa-required' || initialError === '2fa-invalid'
  );

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setIsSubmitting(true);

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get('email') ?? '');
    const password = String(formData.get('password') ?? '');
    const totp = String(formData.get('totp') ?? '');

    // This chunk is required after authentication, but not to render the login
    // form. Fetch it in parallel with the credentials request so the dashboard
    // transition does not inherit the login page's bundle cost.
    const appProvidersReady = import('@/components/app-providers');

    try {
      const result = await signIn('credentials', {
        email,
        password,
        totp,
        redirect: false,
      });

      if (result?.error) {
        // A deactivated account that supplied the CORRECT password is surfaced by
        // the server with code 'suspended' (see SuspendedError in src/lib/auth.ts).
        // Every other failure — wrong password or unknown email, including a wrong
        // password for a suspended account — stays on the generic message so the
        // form can't be used to enumerate which emails are suspended.
        if (result.code === '2fa_required') {
          // Password was correct; the account needs a second factor. Reveal the field.
          setTwoFactor(true);
          setError('Enter the 6-digit code from your authenticator app.');
        } else if (result.code === '2fa_invalid') {
          setTwoFactor(true);
          setError('That code is incorrect or expired. Try again, or use a recovery code.');
        } else if (result.code === 'sso_required') {
          setTwoFactor(false);
          setError('Password sign-in is disabled. Use your organization identity provider.');
        } else {
          setTwoFactor(false);
          setError(
            result.code === 'suspended'
              ? 'Your account has been suspended. Please contact your workspace administrator.'
              : 'Invalid email or password. Please try again.'
          );
        }
        setIsSubmitting(false);
        return;
      }

      await appProvidersReady;
      router.replace(callbackUrl);
    } catch {
      setError('Unable to sign in right now. Please check your connection and try again.');
      setIsSubmitting(false);
    }
  };

  return (
    <>
      {error && (
        <div
          role="alert"
          className="mb-5 rounded-[3px] border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {connections.length ? (
        <div className="mb-6 space-y-2">
          {connections.map((connection) => (
            <a
              key={connection.id}
              href={`/api/sso/${connection.protocol.toLowerCase()}/${connection.id}/start`}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-[3px] border border-border-default bg-card text-sm font-semibold text-foreground transition hover:border-primary hover:bg-muted"
            >
              <Building2 className="h-4 w-4 text-accent-brand" />
              Continue with {connection.name}
            </a>
          ))}
          {!ssoEnforced ? (
            <div className="flex items-center gap-3 py-2">
              <span className="h-px flex-1 bg-border-subtle" />
              <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-faint">
                or password
              </span>
              <span className="h-px flex-1 bg-border-subtle" />
            </div>
          ) : null}
        </div>
      ) : null}

      {!ssoEnforced ? (
        // WHA-1623: `action` is the no-JavaScript path. Once hydrated, onSubmit
        // prevents it and the client path below runs unchanged.
        <form
          method="post"
          action="/login/submit"
          onSubmit={onSubmit}
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
              placeholder="you@company.com"
              autoComplete="email"
              autoFocus
              name="email"
              required
              className={inputClass}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="password" className="block text-sm font-semibold text-foreground">
                Password
              </label>
              <a
                href="/forgot-password"
                className="text-xs font-semibold text-text-muted underline-offset-4 transition-colors hover:text-primary hover:underline"
              >
                Forgot password?
              </a>
            </div>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="Enter your password"
                autoComplete="current-password"
                name="password"
                required
                className={`${inputClass} pr-10`}
              />
              <button
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted transition-colors hover:text-foreground"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {twoFactor && (
            <div className="space-y-2">
              <label htmlFor="totp" className="block text-sm font-semibold text-foreground">
                Authentication code
              </label>
              <input
                id="totp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456 or a recovery code"
                autoFocus
                name="totp"
                required
                className={inputClass}
              />
              <p className="text-xs text-text-muted">
                Open your authenticator app, or enter one of your recovery codes.
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="group flex h-12 w-full items-center justify-center rounded-[3px] bg-primary text-sm font-semibold text-primary-foreground shadow-[0_10px_22px_-14px_rgba(12,29,48,0.86)] transition-all hover:-translate-y-px hover:bg-primary-hover active:translate-y-0 disabled:pointer-events-none disabled:opacity-50"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Signing in...
              </>
            ) : (
              'Sign in'
            )}
          </button>
        </form>
      ) : (
        <p className="border-l-2 border-accent-brand bg-muted px-4 py-3 text-xs leading-5 text-text-muted">
          This organization requires enterprise SSO. Password authentication is unavailable.
        </p>
      )}
    </>
  );
}
