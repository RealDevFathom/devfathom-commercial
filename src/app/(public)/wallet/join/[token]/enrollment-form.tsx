'use client';

import { useState, type FormEvent } from 'react';

import type { WalletFiles } from '@/lib/wallet/issue';
import { Button, buttonVariants } from '@/components/ui/button';

type Step = 'email' | 'otp' | 'done';

export function EnrollmentForm({
  token,
  phoneJoin = false,
  pharmacy = false,
}: {
  token: string;
  phoneJoin?: boolean;
  pharmacy?: boolean;
}) {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [retryCard, setRetryCard] = useState('');
  const [consent, setConsent] = useState(false);
  const [cardCode, setCardCode] = useState('');
  const [wallet, setWallet] = useState<WalletFiles | null>(null);
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
        body: JSON.stringify(
          step === 'email'
            ? phoneJoin
              ? { token, phone: email }
              : { token, email }
            : {
                token,
                attemptId,
                otp,
                ...(phoneJoin ? { consent, ...(cardCode ? { cardCode } : {}) } : {}),
              }
        ),
      });
      const body = (await response.json()) as {
        ok: boolean;
        message: string;
        attemptId?: string;
        cardCode?: string;
        wallet?: WalletFiles;
      };
      if (!response.ok || !body.ok) throw new Error(body.message);
      if (step === 'email') {
        if (!body.attemptId) throw new Error('This enrollment request could not be completed.');
        setAttemptId(body.attemptId);
        setStep('otp');
      } else {
        setRetryCard(body.cardCode ?? '');
        setWallet(body.wallet ?? null);
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

  if (retryCard)
    return (
      <section role="status" className="space-y-3">
        <h2>Your card is ready</h2>
        <p>Keep this code and verify your phone again to retry adding it to your wallet.</p>
        <code className="break-all">{retryCard}</code>
        <Button
          onClick={() => {
            setCardCode(retryCard);
            setRetryCard('');
            setStep('email');
            setOtp('');
          }}
        >
          Try again
        </Button>
      </section>
    );
  if (wallet) {
    const jsonFile = (pass: object) =>
      'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(pass, null, 2));
    return (
      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Your loyalty card</h2>
        <p>
          {wallet.mode === 'TEST'
            ? 'TEST · Download the unsigned sample. Its QR works at the counter.'
            : wallet.mode === 'DEMO'
              ? 'DEMO · Use a Google Wallet test account.'
              : 'LIVE · Add your card to your phone.'}
        </p>
        <div className="flex flex-wrap gap-3">
          {wallet.apple && (
            <a
              className={buttonVariants({ variant: 'outline' })}
              download="apple-test-pass.json"
              href={jsonFile(wallet.apple)}
            >
              Download Apple test pass
            </a>
          )}
          {wallet.google && (
            <a
              className={buttonVariants({ variant: 'outline' })}
              download="google-test-pass.json"
              href={jsonFile(wallet.google)}
            >
              Download Google test pass
            </a>
          )}
          {wallet.googleUrl && (
            <a className={buttonVariants()} href={wallet.googleUrl} rel="noreferrer">
              Add to Google Wallet
            </a>
          )}
          {wallet.appleArchive && (
            <a
              className={buttonVariants()}
              download="loyalty.pkpass"
              href={'data:application/vnd.apple.pkpass;base64,' + wallet.appleArchive}
            >
              Add to Apple Wallet
            </a>
          )}
        </div>
      </section>
    );
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
          {step === 'email' ? (phoneJoin ? 'Phone number' : 'Email address') : 'Six-digit code'}
        </label>
        <input
          id={step}
          type={step === 'email' ? (phoneJoin ? 'tel' : 'email') : 'text'}
          inputMode={step === 'email' ? (phoneJoin ? 'tel' : 'email') : 'numeric'}
          autoComplete={step === 'email' ? (phoneJoin ? 'tel' : 'email') : 'one-time-code'}
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
      {step === 'otp' && phoneJoin && (
        <>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            I agree to join this loyalty programme.
          </label>
          {pharmacy && (
            <label className="grid gap-2">
              Existing card code (if you already have one)
              <input
                maxLength={64}
                value={cardCode}
                onChange={(e) => setCardCode(e.target.value)}
                className="min-h-11 rounded-control border border-border px-3"
              />
            </label>
          )}
        </>
      )}
      <Button
        type="submit"
        size="lg"
        className="min-h-11 w-full"
        disabled={
          pending || (step === 'email' ? !email : otp.length !== 6 || (phoneJoin && !consent))
        }
      >
        {pending ? 'Please wait…' : step === 'email' ? 'Send my code' : 'Create my wallet pass'}
      </Button>
    </form>
  );
}
