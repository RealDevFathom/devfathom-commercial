'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, LoaderCircle } from 'lucide-react';

export function PlatformLoginForm() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

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
    <form method="post" onSubmit={submit} className="mt-8 space-y-5">
      <label className="block">
        <span className="mb-2 block font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">
          Work email
        </span>
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          maxLength={254}
          className="h-12 w-full border border-border-default bg-surface-card px-3.5 text-sm outline-none transition focus:border-accent-brand focus:ring-2 focus:ring-accent-brand/15"
          placeholder="operator@devfathom.com"
        />
      </label>
      <label className="block">
        <span className="mb-2 block font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">
          Authenticator or recovery code
        </span>
        <input
          name="authenticationCode"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={32}
          className="h-12 w-full border border-border-default bg-surface-card px-3.5 font-mono text-sm tracking-[0.16em] outline-none transition focus:border-accent-brand focus:ring-2 focus:ring-accent-brand/15"
          placeholder="Required after MFA enrollment"
        />
      </label>
      <label className="block">
        <span className="mb-2 block font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">
          Password
        </span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          minLength={8}
          maxLength={256}
          className="h-12 w-full border border-border-default bg-surface-card px-3.5 text-sm outline-none transition focus:border-accent-brand focus:ring-2 focus:ring-accent-brand/15"
        />
      </label>
      {error ? (
        <p role="alert" className="border-l-2 border-destructive bg-red-100 px-3 py-2.5 text-sm">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="flex h-12 w-full items-center justify-between bg-abyss-900 px-4 text-sm font-semibold text-paper-white transition hover:bg-abyss-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-brand disabled:cursor-wait disabled:opacity-70"
      >
        {pending ? 'Checking access…' : 'Continue to control desk'}
        {pending ? (
          <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
        ) : (
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        )}
      </button>
    </form>
  );
}
