'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { signOutEverything } from '@/lib/auth/sign-out';
import { trpc } from '@/lib/trpc';
import { AuthenticatorQrCode } from '@/app/(app)/settings/approval-authenticator-section';

type Step =
  | { kind: 'password' }
  | { kind: 'scan'; secret: string; otpauthUri: string }
  | { kind: 'codes'; recoveryCodes: string[] };

/**
 * DEV-961: password, then QR code and setup key confirmed with a current code, then the
 * one-time recovery codes, shown once. Every step is checked on the server.
 */
export function ApprovalAuthenticatorSetupForm({
  passwordless = false,
}: {
  passwordless?: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const begin = trpc.approvalAuthenticator.beginEnrollment.useMutation({
    onSuccess: (data) => {
      setStep({ kind: 'scan', ...data });
      setPassword('');
      setError('');
    },
    onError: (failure) => setError(failure.message),
  });
  const confirm = trpc.approvalAuthenticator.confirmEnrollment.useMutation({
    onSuccess: (data) => {
      setStep({ kind: 'codes', recoveryCodes: data.recoveryCodes });
      setCode('');
      setError('');
    },
    onError: (failure) => setError(failure.message),
  });

  const signOut = (
    <Button
      type="button"
      variant="outline"
      className="min-h-11"
      onClick={() => void signOutEverything('/login')}
    >
      Sign out
    </Button>
  );
  const alert = error ? (
    <p
      role="alert"
      className="rounded-control bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {error}
    </p>
  ) : null;

  if (step.kind === 'password') {
    const submit = (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError('');
      begin.mutate(passwordless ? {} : { currentPassword: password });
    };
    return (
      <form className="mt-6 space-y-4" onSubmit={submit} aria-label="Start set-up">
        {passwordless ? (
          <p className="text-sm text-text-body">
            You signed in with your organization&apos;s single sign-on, so there is no password to
            enter. Set the app up within 15 minutes of signing in.
          </p>
        ) : (
          <label className="block text-sm text-text-body">
            Your current password
            <Input
              className="mt-1.5 block min-h-11"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              aria-invalid={Boolean(error) || undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        )}
        {alert}
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            className="min-h-11"
            disabled={(!passwordless && !password) || begin.isPending}
          >
            {begin.isPending ? 'Starting…' : 'Continue'}
          </Button>
          {signOut}
        </div>
      </form>
    );
  }

  if (step.kind === 'scan') {
    const submit = (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError('');
      confirm.mutate({ token: code });
    };
    return (
      <form className="mt-6 space-y-4" onSubmit={submit} aria-label="Confirm your authenticator">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-text-body">
          <li>
            Open an authenticator app on your phone, such as Google Authenticator or Microsoft
            Authenticator.
          </li>
          <li>Scan this QR code, or add an account with the setup key below.</li>
          <li>Enter the 6-digit code the app shows.</li>
        </ol>
        <AuthenticatorQrCode uri={step.otpauthUri} />
        <div>
          <p className="mb-1 font-mono text-[11px] font-medium uppercase tracking-wider text-text-muted">
            Setup key
          </p>
          <code className="block rounded-[var(--radius-xs)] border border-border bg-surface-card px-3 py-2 font-mono text-xs break-all text-text-strong">
            {step.secret}
          </code>
        </div>
        <label className="block text-sm text-text-body">
          6-digit code from your app
          <Input
            className="mt-1.5 block min-h-11 w-40"
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            required
            value={code}
            aria-invalid={Boolean(error) || undefined}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          />
        </label>
        {alert}
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            className="min-h-11"
            disabled={code.length !== 6 || confirm.isPending}
          >
            {confirm.isPending ? 'Checking…' : 'Check code and turn on'}
          </Button>
          {signOut}
        </div>
      </form>
    );
  }

  return (
    <section className="mt-6 space-y-4" aria-labelledby="recovery-codes-heading">
      <h2 id="recovery-codes-heading" className="text-base font-semibold text-text-strong">
        Save your recovery codes
      </h2>
      <p className="text-sm text-text-body">
        If you lose your phone, one of these codes lets you set up the app again. Each code works
        once. They are shown only now, so write them down or store them somewhere safe.
      </p>
      <ul
        aria-label="Recovery codes"
        className="grid grid-cols-2 gap-2 rounded-[var(--radius-sm)] border border-border bg-surface-card p-4"
      >
        {step.recoveryCodes.map((recoveryCode) => (
          <li key={recoveryCode} className="font-mono text-sm tabular-nums text-text-strong">
            {recoveryCode}
          </li>
        ))}
      </ul>
      <label className="flex items-start gap-2 text-sm text-text-body">
        <Checkbox
          className="mt-0.5"
          checked={saved}
          onCheckedChange={(checked) => setSaved(checked === true)}
        />
        I have saved my recovery codes
      </label>
      <Button
        type="button"
        className="min-h-11"
        disabled={!saved}
        onClick={() => {
          // The server re-reads the gate on this request and opens the workspace.
          router.replace('/dashboard');
          router.refresh();
        }}
      >
        Continue to the workspace
      </Button>
    </section>
  );
}
