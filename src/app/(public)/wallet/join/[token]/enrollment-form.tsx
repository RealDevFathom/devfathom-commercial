'use client';

import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';

type Step = 'email' | 'otp' | 'done';

export function EnrollmentForm({ token }: { token: string }) {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [attemptId, setAttemptId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      const endpoint = step === 'email' ? 'start' : 'verify';
      const response = await fetch(`/api/wallet/enroll/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(step === 'email' ? { token, email } : { token, attemptId, otp }),
      });
      const body = (await response.json()) as { ok: boolean; message: string; attemptId?: string };
      if (!response.ok || !body.ok) throw new Error(body.message);
      if (step === 'email') {
        if (!body.attemptId) throw new Error('This enrollment request could not be completed.');
        setAttemptId(body.attemptId);
        setStep('otp');
      } else {
        setStep('done');
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'This enrollment request could not be completed.'
      );
    } finally {
      setPending(false);
    }
  }

  if (step === 'done') {
    return (
      <div role="status" className="rounded-md border border-border-subtle bg-surface-sunken p-5">
        <h2 className="font-display text-xl font-semibold text-text-strong">You’re enrolled</h2>
        <p className="mt-2 text-sm leading-6 text-text-muted">
          Your Apple and Google wallet passes are being prepared. You can safely close this page.
        </p>
      </div>
    );
  }

  return (
    <form className="space-y-5" onSubmit={submit} noValidate>
      <div className="space-y-2">
        <label htmlFor={step} className="block text-sm font-semibold text-text-strong">
          {step === 'email' ? 'Email address' : 'Six-digit code'}
        </label>
        <input
          id={step}
          type={step === 'email' ? 'email' : 'text'}
          inputMode={step === 'email' ? 'email' : 'numeric'}
          autoComplete={step === 'email' ? 'email' : 'one-time-code'}
          value={step === 'email' ? email : otp}
          onChange={(event) =>
            step === 'email'
              ? setEmail(event.target.value)
              : setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))
          }
          required
          disabled={pending}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'enrollment-error' : undefined}
          className="min-h-11 w-full rounded-sm border border-border bg-surface-raised px-3 text-text-strong outline-none transition focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-60"
        />
        {step === 'otp' ? (
          <p className="text-sm text-text-muted">We sent a code to {email}.</p>
        ) : null}
        {error ? (
          <p id="enrollment-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <Button
        type="submit"
        size="lg"
        className="min-h-11 w-full"
        disabled={pending || (step === 'email' ? !email : otp.length !== 6)}
      >
        {pending ? 'Please wait…' : step === 'email' ? 'Send my code' : 'Create my wallet pass'}
      </Button>
    </form>
  );
}
