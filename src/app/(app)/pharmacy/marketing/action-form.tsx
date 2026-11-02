'use client';

import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { marketingAction } from './actions';

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** The visible label of a control, without the text of anything nested in it. */
function fieldName(field: Control) {
  const label = field.labels?.[0];
  const own = label
    ? Array.from(label.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
    : '';
  return own || field.getAttribute('aria-label') || field.name;
}

export function MarketingActionForm({
  branchId,
  operation,
  campaignId,
  label,
  children,
  disabled = false,
}: {
  branchId: string;
  operation: string;
  campaignId?: string;
  label: string;
  children?: ReactNode;
  disabled?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Awaited<ReturnType<typeof marketingAction>> | null>(null);
  const feedbackId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    // DEV-597: the browser stops an invalid submit before onSubmit runs, and its bubble is easy
    // to miss (and never shows for a field inside a closed Advanced section). Open that section,
    // mark each field and name them inline, so a click is never a silent no-op.
    let problems: string[] = [];
    const onInvalid = (event: Event) => {
      const field = event.target as Control;
      field.setAttribute('aria-invalid', 'true');
      const section = field.closest('details');
      if (section && !section.open) section.open = true;
      problems.push(`${fieldName(field)}: ${field.validationMessage}`);
      if (problems.length === 1)
        queueMicrotask(() => {
          setResult({ error: true, message: `Check before continuing:\n${problems.join('\n')}` });
          problems = [];
        });
    };
    const onEdit = (event: Event) => (event.target as Element).removeAttribute('aria-invalid');
    form.addEventListener('invalid', onInvalid, true);
    form.addEventListener('input', onEdit);
    return () => {
      form.removeEventListener('invalid', onInvalid, true);
      form.removeEventListener('input', onEdit);
    };
  }, []);
  return (
    <form
      ref={formRef}
      className="space-y-4"
      aria-busy={pending}
      aria-describedby={result ? feedbackId : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending || disabled) return;
        setResult(null);
        const data = new FormData(event.currentTarget);
        startTransition(async () => {
          try {
            setResult(await marketingAction(data));
          } catch {
            setResult({
              error: true,
              message:
                'Connection lost. Reload history before retrying. Your form values are preserved.',
            });
          }
        });
      }}
    >
      <input type="hidden" name="branchId" value={branchId} />
      <input type="hidden" name="operation" value={operation} />
      {campaignId && <input type="hidden" name="campaignId" value={campaignId} />}
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
