'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Loader2 } from 'lucide-react';

const inputClass =
  'flex h-12 w-full rounded-[3px] border border-border-default bg-card px-4 text-sm text-foreground placeholder:text-text-faint transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

export function PlatformLoginForm() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

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
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? 'Sign in failed.');
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

  return (
    <form method="post" onSubmit={submit} className="space-y-5">
      {error ? (
        <div
          role="alert"
          className="rounded-[3px] border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
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
        className="group flex h-12 w-full items-center justify-center rounded-[3px] bg-primary text-sm font-semibold text-primary-foreground shadow-[0_10px_22px_-14px_rgba(17,17,16,0.86)] transition-all hover:-translate-y-px hover:bg-primary-hover active:translate-y-0 disabled:pointer-events-none disabled:opacity-50"
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
