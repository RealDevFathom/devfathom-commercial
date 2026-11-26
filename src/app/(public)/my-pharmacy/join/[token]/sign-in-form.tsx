'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import { portalSignInMessages } from '@/lib/pharmacy/portal-sign-in-messages';
import { Button } from '@/components/ui/button';

type Step = 'send' | 'code';

export function PortalSignInForm({ token }: { token: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('send');
  const [otp, setOtp] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function post(action: 'start' | 'verify', body: Record<string, string>) {
    const response = await fetch(`/api/pharmacy/portal/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!response) throw new Error(portalSignInMessages.unexpected);
    const result = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: string;
    };
    if (!response.ok || !result.ok)
      throw new Error(result.message ?? portalSignInMessages.unexpected);
    return result;
  }

  async function sendCode() {
    setPending(true);
    setError('');
    try {
      await post('start', { token });
      setOtp('');
      setStep('code');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : portalSignInMessages.unexpected);
    } finally {
      setPending(false);
    }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      await post('verify', { token, otp });
      router.replace('/my-pharmacy');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : portalSignInMessages.unexpected);
      setPending(false);
    }
  }

  const errorText = error ? (
    <p id="portal-sign-in-error" role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : null;

  if (step === 'send') {
    return (
      <div className="space-y-4">
        <Button className="w-full" size="touch" onClick={sendCode} disabled={pending}>
          {pending ? 'Sending code…' : 'Send me a code'}
        </Button>
        {errorText}
      </div>
    );
  }

  return (
    <form className="space-y-5" onSubmit={verify} noValidate>
      <div className="space-y-2">
        <label htmlFor="portal-otp" className="block text-sm font-semibold text-text-strong">
          Six-digit code
        </label>
        <p className="text-sm text-text-muted">If you receive a code, enter it here.</p>
        <input
          id="portal-otp"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={otp}
          onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
          required
          disabled={pending}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'portal-sign-in-error' : undefined}
          className="min-h-11 w-full rounded-sm border border-border bg-surface-raised px-3 text-text-strong outline-none transition focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-60"
        />
      </div>
      <details className="text-sm text-text-muted">
        <summary className="cursor-pointer focus-visible:outline-ring">
          Didn’t receive a code?
        </summary>
        <dl className="mt-3 space-y-2">
          <div>
            <dt className="font-semibold">If the link expired</dt>
            <dd>{portalSignInMessages.invalidLink}</dd>
          </div>
          <div>
            <dt className="font-semibold">If delivery failed</dt>
            <dd>{portalSignInMessages.delivery}</dd>
          </div>
        </dl>
      </details>
      {errorText}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" size="touch" disabled={pending || otp.length !== 6}>
          {pending ? 'Checking…' : 'Sign in'}
        </Button>
        <Button type="button" variant="outline" size="touch" onClick={sendCode} disabled={pending}>
          Send a new code
        </Button>
      </div>
    </form>
  );
}
