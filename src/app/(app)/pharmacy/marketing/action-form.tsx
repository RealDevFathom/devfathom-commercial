'use client';

import { useId, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { marketingAction } from './actions';

export function MarketingActionForm({
  branchId,
  operation,
  campaignId,
  label,
  children,
  disabled = false,
  timeZone,
}: {
  branchId: string;
  operation: string;
  campaignId?: string;
  label: string;
  children?: ReactNode;
  disabled?: boolean;
  /** Workspace zone the form's calendar days and local times are entered in. */
  timeZone?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Awaited<ReturnType<typeof marketingAction>> | null>(null);
  const feedbackId = useId();
  return (
    <form
      className="space-y-4"
      aria-busy={pending}
      aria-describedby={result ? feedbackId : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending || disabled) return;
        setResult(null);
        const data = new FormData(event.currentTarget);
        startTransition(async () => {
          let next: Awaited<ReturnType<typeof marketingAction>>;
          try {
            next = await marketingAction(data);
          } catch {
            next = {
              error: true,
              message:
                'Connection lost. Reload history before retrying. Your form values are preserved.',
            };
          }
          // Updates after an await leave the transition unless re-wrapped; keep the feedback and
          // the re-enabled form in one commit so a message never shows beside a disabled form.
          startTransition(() => setResult(next));
        });
      }}
    >
      <input type="hidden" name="branchId" value={branchId} />
      <input type="hidden" name="operation" value={operation} />
      {campaignId && <input type="hidden" name="campaignId" value={campaignId} />}
      {timeZone && <input type="hidden" name="timeZone" value={timeZone} />}
      <fieldset disabled={pending || disabled} className="min-w-0 space-y-4">
        {children}
        <Button
          type="submit"
          variant={operation === 'preview' || operation === 'sandbox' ? 'outline' : 'default'}
          className="min-h-11"
          disabled={pending || disabled}
        >
          {pending ? 'Working…' : label}
        </Button>
      </fieldset>
      {result?.campaignId && !result.error && (
        <Link
          className="inline-flex min-h-11 items-center underline focus-visible:outline-2 focus-visible:outline-ring"
          href={`/pharmacy/marketing?branch=${encodeURIComponent(branchId)}&campaign=${encodeURIComponent(result.campaignId)}`}
        >
          Open campaign review
        </Link>
      )}
      {result && (
        <p
          id={feedbackId}
          role={result.error ? 'alert' : 'status'}
          className={`whitespace-pre-wrap break-words text-sm ${result.error ? 'text-destructive' : 'text-text-body'}`}
        >
          {result.message}
        </p>
      )}
    </form>
  );
}
