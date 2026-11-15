'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';

type Step = 'send' | 'code';

export function PortalSignInForm({ token }: { token: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('send');
  const [otp, setOtp] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function post(action: 'start' | 'verify', body: Record<string, string>) {
    const response = await fetch(`/api/pharmacy/portal/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: string;
      sentTo?: string | null;
    };
    if (!response.ok || !result.ok)
      throw new Error(result.message ?? 'This request could not be completed.');
    return result;
  }

  async function sendCode() {
    setPending(true);
    setError('');
    try {
      const result = await post('start', { token });
      setSentTo(result.sentTo ?? null);
      setOtp('');
      setStep('code');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This request could not be completed.');
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
      setError(cause instanceof Error ? cause.message : 'This request could not be completed.');
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
        {sentTo ? <p className="text-sm text-text-muted">Sent on WhatsApp to {sentTo}.</p> : null}
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
