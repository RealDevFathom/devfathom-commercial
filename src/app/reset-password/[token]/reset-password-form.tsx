'use client';

import { useState } from 'react';
import { PasswordInput } from '@/components/ui/password-input';
import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
import { Loader2, Check, CheckCircle2 } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { passwordRules, passwordMeetsPolicy } from '@/lib/password-policy';
import { cn } from '@/lib/utils';

const inputClass =
  'flex h-12 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-card px-4 text-sm text-text-strong placeholder:text-text-faint transition-colors focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30';

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const { data, isLoading } = trpc.passwordReset.validate.useQuery({ token }, { retry: false });
  const reset = trpc.passwordReset.reset.useMutation();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  // Verifying the link
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-accent-brand" />
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text-strong">
          Reset your password
        </h1>
        <p className="text-sm text-text-muted">Checking your reset link...</p>
      </div>
    );
  }

  // Invalid / expired link
  if (!data?.valid) {
    return (
      <div role="status" aria-live="polite" className="space-y-5 text-center">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text-strong">
          Link unavailable
        </h1>
        <p className="text-sm text-text-muted">
          This reset link is invalid or has expired. Request a new one to continue.
        </p>
        <a
          href="/forgot-password"
          className="inline-flex h-12 w-full items-center justify-center rounded-[var(--radius-sm)] bg-primary text-sm font-semibold text-primary-foreground transition-all hover:bg-primary-hover active:scale-[0.98]"
        >
          Request a new link
        </a>
      </div>
    );
  }

  // Success state
  if (done) {
    return (
      <div role="status" aria-live="polite" className="space-y-5 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success">
          <CheckCircle2 className="h-6 w-6" />
        </div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text-strong">
          Password updated
        </h1>
        <p className="text-sm text-text-muted">
          Your password has been changed. You can now sign in with it.
        </p>
        <a
          href="/login"
          className="inline-flex h-12 w-full items-center justify-center rounded-[var(--radius-sm)] bg-primary text-sm font-semibold text-primary-foreground transition-all hover:bg-primary-hover active:scale-[0.98]"
        >
          Go to sign in
        </a>
      </div>
    );
  }

  const policyOk = passwordMeetsPolicy(password);
  const confirmOk = password.length > 0 && password === confirm;
  const canSubmit = policyOk && confirmOk && !reset.isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!passwordMeetsPolicy(password)) {
      setError('Please choose a password that meets all the requirements.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    try {
      await reset.mutateAsync({ token, newPassword: password });
      setDone(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    }
  };

  return (
    <div>
      <div className="mb-7">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text-strong">
          Choose a new password
        </h1>
        <p className="mt-1.5 text-sm text-text-muted">
          Pick a strong password you don&apos;t use elsewhere.
        </p>
      </div>

      {error && (
        <div
          id="account-error"
          role="alert"
          className="mb-5 rounded-[var(--radius-sm)] border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* New password */}
        <div className="space-y-2">
          <label htmlFor="password" className="block text-sm font-medium text-text-body">
            New Password
          </label>
          <PasswordInput
            id="password"
            aria-invalid={Boolean(error)}
            aria-describedby={
              error ? 'account-error password-requirements' : 'password-requirements'
            }
            revealed={showPassword}
            onReveal={() => setShowPassword((visible) => !visible)}
            placeholder="Create a password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />

          {/* Live password requirements checklist */}
          <ul id="password-requirements" className="mt-2 space-y-1.5">
            {passwordRules.map((rule) => {
              const met = rule.test(password);
              return (
                <li key={rule.id} className="flex items-center gap-2 text-xs">
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors',
                      met ? 'bg-success/20 text-success' : 'bg-muted text-transparent'
                    )}
                  >
                    {met ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-text-faint" />
                    )}
                  </span>
                  <span className={met ? 'text-text-body' : 'text-text-muted'}>{rule.label}</span>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Confirm password */}
        <div className="space-y-2">
          <label htmlFor="confirm" className="block text-sm font-medium text-text-body">
            Confirm Password
          </label>
          <input
            id="confirm"
            aria-invalid={Boolean(error) || (confirm.length > 0 && !confirmOk)}
            aria-describedby={
              error
                ? 'account-error'
                : confirm.length > 0 && !confirmOk
                  ? 'confirm-error'
                  : undefined
            }
            type={showPassword ? 'text' : 'password'}
            placeholder="Re-enter your password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={inputClass}
          />
          {confirm.length > 0 && !confirmOk && (
            <p id="confirm-error" role="status" className="text-xs text-destructive">
              Passwords do not match.
            </p>
          )}
        </div>

        <Button
          type="submit"
          disabled={!canSubmit}
          className="group flex h-12 w-full items-center justify-center rounded-[var(--radius-sm)] bg-primary text-sm font-semibold text-primary-foreground transition-all hover:bg-primary-hover active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
        >
          {reset.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Updating password...
            </>
          ) : (
            'Reset password'
          )}
        </Button>
      </form>
    </div>
  );
}
