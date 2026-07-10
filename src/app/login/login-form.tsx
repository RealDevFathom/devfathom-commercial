'use client';

import { useState, type FormEvent } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Loader2 } from 'lucide-react';

// Prevent open redirect: accept only same-origin relative paths (a single
// leading slash, not '//' or '/\'), rejecting absolute and javascript: URLs.
function safeCallbackUrl(raw: string | null): string {
  return raw && /^\/(?![/\\])/.test(raw) ? raw : '/dashboard';
}

const inputClass =
  'flex h-11 w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white placeholder:text-[#5A6670] transition-colors focus:border-[#BC8850] focus:outline-none focus:ring-2 focus:ring-[#BC8850]/30';

export function LoginForm() {
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // IMP-AUTH-02: revealed after a correct password when the account has 2FA on.
  const [twoFactor, setTwoFactor] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setIsSubmitting(true);

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get('email') ?? '');
    const password = String(formData.get('password') ?? '');
    const totp = String(formData.get('totp') ?? '');
    const callbackUrl = safeCallbackUrl(
      new URLSearchParams(window.location.search).get('callbackUrl')
    );

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
          className="mb-5 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400"
        >
          {error}
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-5">
        <div className="space-y-2">
          <label htmlFor="email" className="block text-sm font-medium text-[#C2CBD1]">
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
            <label htmlFor="password" className="block text-sm font-medium text-[#C2CBD1]">
              Password
            </label>
            <a
              href="/forgot-password"
              className="text-xs font-medium text-[#8A97A1] underline-offset-4 transition-colors hover:text-[#BC8850] hover:underline"
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
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#5A6670] transition-colors hover:text-white"
              tabIndex={-1}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {twoFactor && (
          <div className="space-y-2">
            <label htmlFor="totp" className="block text-sm font-medium text-[#C2CBD1]">
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
            <p className="text-xs text-[#5A6670]">
              Open your authenticator app, or enter one of your recovery codes.
            </p>
          </div>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          className="group flex h-11 w-full items-center justify-center rounded-xl bg-primary text-sm font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
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
    </>
  );
}
