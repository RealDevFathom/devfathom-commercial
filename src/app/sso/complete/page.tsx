'use client';

import { useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { LoaderCircle, ShieldCheck } from 'lucide-react';

export default function SsoCompletePage() {
  const router = useRouter();
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void signIn('enterprise', { redirect: false })
      .then((result) => {
        if (!active) return;
        if (!result || result.error) {
          setError('The enterprise sign-in ticket is invalid or expired. Start again.');
          return;
        }
        router.replace('/dashboard?landing=1');
        router.refresh();
      })
      .catch(() => {
        if (active) setError('The enterprise sign-in ticket is invalid or expired. Start again.');
      });
    return () => {
      active = false;
    };
  }, [router]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-5">
      <section className="w-full max-w-md border border-border-default bg-surface-card p-8 text-center">
        {error ? (
          <>
            <ShieldCheck className="mx-auto h-9 w-9 text-destructive" />
            <h1 className="mt-5 font-display text-2xl font-semibold">Sign-in could not finish</h1>
            <p className="mt-3 text-sm leading-6 text-text-muted">{error}</p>
            <a
              href="/login"
              className="mt-6 inline-flex h-10 items-center bg-abyss-900 px-4 text-xs font-semibold text-paper-white"
            >
              Return to sign in
            </a>
          </>
        ) : (
          <>
            <LoaderCircle className="mx-auto h-9 w-9 animate-spin text-accent-brand" />
            <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">
              Enterprise identity
            </p>
            <h1 className="mt-2 font-display text-2xl font-semibold">Opening your workspace</h1>
            <p className="mt-3 text-sm text-text-muted">
              The signed identity assertion is being exchanged for a short workspace session.
            </p>
          </>
        )}
      </section>
    </main>
  );
}
