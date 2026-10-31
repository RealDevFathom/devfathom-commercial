'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

const inputClass =
  'flex h-12 w-full rounded-sm border border-border-default bg-card px-4 text-sm text-foreground placeholder:text-text-muted transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

export function PlatformLoginForm({ initialEnrollment = false }: { initialEnrollment?: boolean }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [enrollment, setEnrollment] = useState(initialEnrollment);
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  async function enroll(action: 'begin' | 'confirm') {
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/platform/mfa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...(action === 'confirm' ? { code } : {}) }),
      });
      const body = (await response.json()) as {
        error?: string;
        secret?: string;
        recoveryCodes?: string[];
      };
      if (!response.ok) {
        setError(body.error ?? 'Enrollment failed. Try again.');
        return;
      }
      setSecret(body.secret ?? '');
      setCode('');
      if (body.recoveryCodes) setRecoveryCodes(body.recoveryCodes);
    } catch {
      setError('Enrollment could not be reached. Try again.');
    } finally {
      setPending(false);
    }
  }

  async function logout() {
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/platform/session', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) throw new Error('logout');
      setEnrollment(false);
      setSecret('');
      setCode('');
      setRecoveryCodes([]);
    } catch {
      setError('Sign out failed. Try again.');
    } finally {
      setPending(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/platform/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: data.get('email'),
          password: data.get('password'),
          authenticationCode: data.get('authenticationCode'),
        }),
      });
      const body = (await response.json()) as { error?: string; enrollmentRequired?: boolean };
      if (!response.ok) {
        setError(body.error ?? 'Sign in failed.');
        return;
      }
      if (body.enrollmentRequired) {
        setEnrollment(true);
        return;
      }
      router.replace('/platform');
      router.refresh();
    } catch {
      setError('The control desk could not be reached. Check the connection and try again.');
    } finally {
      setPending(false);
    }
  }

  if (enrollment)
    return (
      <section className="space-y-5" aria-label="Authenticator enrollment">
        <p className="text-sm text-text-muted">
          Set up your authenticator before opening the control desk.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {recoveryCodes.length > 0 ? (
          <>
            <h3 className="font-semibold">Save your recovery codes</h3>
            <p className="text-sm text-text-muted">
              Keep these somewhere safe. Each code can be used once.
            </p>
            <ul className="space-y-2 font-mono text-sm">
              {recoveryCodes.map((value) => (
                <li key={value}>{value}</li>
              ))}
            </ul>
            <Button
              onClick={() => {
                router.replace('/platform');
                router.refresh();
              }}
            >
              I saved my codes — continue
            </Button>
          </>
        ) : secret ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void enroll('confirm');
            }}
          >
            <p className="text-sm text-text-muted">
              Add this setup key to your authenticator, then enter its six-digit code.
            </p>
            <code className="block break-all rounded-lg border border-border-subtle bg-card p-4 font-mono text-sm">
              {secret}
            </code>
            <label className="block text-sm font-semibold" htmlFor="enrollment-code">
              Authentication code
            </label>
            <input
              id="enrollment-code"
              className={inputClass}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-invalid={Boolean(error)}
            />
            <Button type="submit" disabled={pending}>
              {pending ? 'Verifying…' : 'Verify authenticator'}
            </Button>
          </form>
        ) : (
          <Button disabled={pending} onClick={() => void enroll('begin')}>
            {pending ? 'Starting…' : 'Set up authenticator'}
          </Button>
        )}
        <Button variant="secondary" disabled={pending} onClick={() => void logout()}>
          Sign out
        </Button>
      </section>
    );

  return (
    <form method="post" onSubmit={submit} className="space-y-5">
      {error ? (
        <div
          role="alert"
          className="rounded-sm border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      <div className="space-y-2">
        <label htmlFor="platform-email" className="block text-sm font-semibold text-foreground">
          Work email
        </label>
        <input
          id="platform-email"
          aria-label="Work email"
          name="email"
          type="email"
          autoComplete="username"
          autoFocus
          required
          maxLength={254}
          className={inputClass}
          placeholder="operator@devfathom.com"
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="platform-password" className="block text-sm font-semibold text-foreground">
          Password
        </label>
        <div className="relative">
          <input
            id="platform-password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            required
            minLength={8}
            maxLength={256}
            className={`${inputClass} pr-10`}
            placeholder="Enter your password"
          />
          <button
            type="button"
            onClick={() => setShowPassword((visible) => !visible)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            className="absolute top-1/2 right-3 -translate-y-1/2 text-text-muted transition-colors hover:text-foreground"
            tabIndex={-1}
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <label
            htmlFor="platform-auth-code"
            className="block text-sm font-semibold text-foreground"
          >
            Authentication code
          </label>
          <span className="text-xs text-text-muted">If enrolled</span>
        </div>
        <input
          id="platform-auth-code"
          name="authenticationCode"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={32}
          className={`${inputClass} font-mono tracking-[0.16em]`}
          placeholder="6-digit or recovery code"
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="group flex h-12 w-full items-center justify-center rounded-sm bg-primary text-sm font-semibold text-primary-foreground shadow-md transition-all hover:-translate-y-px hover:bg-primary-hover active:translate-y-0 disabled:pointer-events-none disabled:opacity-50"
      >
        {pending ? (
          <>
            <Loader2 className="mr-2 size-4 animate-spin" />
            Checking access…
          </>
        ) : (
          'Continue to control desk'
        )}
      </button>
    </form>
  );
}
