'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, MailCheck } from 'lucide-react';

const schema = z.object({
  email: z.string().email('Please enter a valid email address'),
});

type FormData = z.infer<typeof schema>;

const inputClass =
  'flex h-11 w-full rounded-sm border border-border-default bg-surface-sunken px-4 text-sm text-text-strong placeholder:text-text-faint transition-colors focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30';

// Identical confirmation regardless of whether the email maps to an account —
// the server never reveals existence, and neither does this UI.
const CONFIRMATION = "If an account exists for that email, we've sent a reset link.";

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  const onSubmit = async (data: FormData) => {
    try {
      // D19: this used to call the tRPC mutation, but the transport answered 401
      // before the router ran, so no reset link was ever sent — and the catch
      // below hid it. The anonymous endpoint carries the email; on the shared
      // host it fans out across every workspace the address belongs to.
      await fetch('/api/password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: data.email }),
      });
    } catch {
      // Swallow errors (e.g. rate limiting) — still show the neutral
      // confirmation so the form can never be used to probe for accounts.
    }
    setSent(true);
  };

  if (sent) {
    return (
      <div role="status" aria-live="polite" className="space-y-5 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success">
          <MailCheck className="h-6 w-6" />
        </div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text-strong">
          Check your inbox
        </h1>
        <p className="text-sm text-text-muted">{CONFIRMATION}</p>
        <a
          href="/login"
          className="inline-flex h-11 w-full items-center justify-center rounded-sm bg-primary text-sm font-semibold text-primary-foreground transition-all hover:bg-primary-hover active:scale-[0.98]"
        >
          Back to sign in
        </a>
      </div>
    );
  }

  return (
    <>
      <div className="mb-7">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text-strong">
          Forgot your password?
        </h1>
        <p className="mt-1.5 text-sm text-text-muted">
          Enter your email and we&apos;ll send you a link to reset it.
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <div className="space-y-2">
          <label htmlFor="email" className="block text-sm font-medium text-text-body">
            Email
          </label>
          <input
            id="email"
            type="email"
            placeholder="you@company.com"
            autoComplete="email"
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? 'email-error' : undefined}
            {...register('email')}
            className={inputClass}
          />
          {errors.email && (
            <p id="email-error" role="alert" className="text-sm text-destructive">
              {errors.email.message}
            </p>
          )}
        </div>

        <Button
          type="submit"
          disabled={isSubmitting}
          className="group flex h-11 w-full items-center justify-center rounded-sm bg-primary text-sm font-semibold text-primary-foreground transition-all hover:bg-primary-hover active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Sending link...
            </>
          ) : (
            'Send reset link'
          )}
        </Button>
      </form>

      <p className="mt-6 text-center text-xs text-text-muted">
        Remembered it?{' '}
        <a
          href="/login"
          className="font-medium text-text-body underline-offset-4 hover:text-accent-brand hover:underline"
        >
          Back to sign in
        </a>
      </p>
    </>
  );
}
