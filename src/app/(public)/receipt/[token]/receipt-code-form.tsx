'use client';

import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import type { HostedReceiptView } from '@/lib/pharmacy/hosted-receipt-view';

import { HostedReceiptCard } from './hosted-receipt-card';

type Step = 'request' | 'code' | 'done';
type OtpResponse = { ok: boolean; message: string; receipt?: HostedReceiptView };

const FAILURE = 'This request could not be completed. Ask the pharmacy to send your receipt again.';

/** One-time code gate for a receipt with Rx lines; the code goes to the number on file. */
export function ReceiptCodeForm({ token }: { token: string }) {
  const [step, setStep] = useState<Step>('request');
  const [otp, setOtp] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [receipt, setReceipt] = useState<HostedReceiptView | null>(null);

  async function call(body: Record<string, string>): Promise<OtpResponse> {
    const response = await fetch('/api/pharmacy/hosted-receipt/otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, ...body }),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    const parsed = (await response.json().catch(() => null)) as OtpResponse | null;
    if (!response.ok || !parsed?.ok) throw new Error(parsed?.message ?? FAILURE);
    return parsed;
  }

  async function requestCode() {
    setPending(true);
    setError('');
    try {
      const result = await call({ action: 'send' });
      setNotice(result.message);
      setStep('code');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : FAILURE);
    } finally {
      setPending(false);
    }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      const result = await call({ action: 'verify', otp });
      if (!result.receipt) throw new Error(FAILURE);
      setReceipt(result.receipt);
      setStep('done');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : FAILURE);
    } finally {
      setPending(false);
    }
  }

  if (step === 'done' && receipt) return <HostedReceiptCard receipt={receipt} />;

  const errorText = error ? (
    <p id="receipt-code-error" role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : null;

  if (step === 'request')
    return (
      <div className="space-y-4">
        <Button
          type="button"
          size="lg"
          className="min-h-11 w-full"
          disabled={pending}
          onClick={() => void requestCode()}
        >
          {pending ? 'Sending code…' : 'Send me a code'}
        </Button>
        {errorText}
      </div>
    );

  return (
    <form className="space-y-5" onSubmit={verify} noValidate>
      <div className="space-y-2">
        <label htmlFor="receipt-code" className="block text-sm font-semibold text-text-strong">
          Six-digit code
        </label>
        <input
          id="receipt-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={otp}
          onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
          required
          disabled={pending}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'receipt-code-error' : undefined}
          className="min-h-11 w-full rounded-sm border border-border bg-surface-raised px-3 text-text-strong tabular-nums outline-none transition focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-60"
        />
        {notice ? (
          <p role="status" className="text-sm text-text-muted">
            {notice}
          </p>
        ) : null}
        {errorText}
      </div>
      <div className="flex flex-wrap gap-3">
        <Button
          type="submit"
          size="lg"
          className="min-h-11 flex-1"
          disabled={pending || otp.length !== 6}
        >
          {pending ? 'Checking…' : 'Show my receipt'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="min-h-11"
          disabled={pending}
          onClick={() => void requestCode()}
        >
          Send a new code
        </Button>
      </div>
    </form>
  );
}
