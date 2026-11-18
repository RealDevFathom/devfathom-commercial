'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BadgeCheck, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  PHARMACY_APPROVAL_NOTE_MAX_LENGTH,
  pharmacyApprovalCommand,
} from '@/lib/platform/pharmacy-approval';

type ControlFailure = {
  error?: string;
  gates?: Array<{ message?: string }>;
};

/**
 * DEV-905 — "Approve pharmacy" with an optional note.
 *
 * It sends the existing lifecycle transition to ACTIVE through the platform control
 * route, so the server's capability check and activation preflight decide, exactly as
 * they do for the lifecycle form. A refusal is shown as the server worded it, with any
 * blocking gates it named.
 */
export function PharmacyApprovalForm({
  organizationId,
  organizationName,
}: {
  organizationId: string;
  organizationName: string;
}) {
  const router = useRouter();
  const id = useId();
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; gates: string[] } | null>(null);

  async function approve(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/platform/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pharmacyApprovalCommand(organizationId, note)),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ControlFailure;
        setError({
          message: body.error ?? 'The pharmacy could not be approved.',
          gates: (body.gates ?? [])
            .map((gate) => gate.message)
            .filter((message): message is string => typeof message === 'string'),
        });
        return;
      }
      toast.success(`${organizationName} approved`);
      setNote('');
      router.refresh();
    } catch {
      setError({ message: 'The pharmacy could not be approved. Try again.', gates: [] });
    } finally {
      setPending(false);
    }
  }

  const noteId = `${id}-note`;
  const errorId = `${id}-error`;
  return (
    <form onSubmit={approve} className="space-y-3" aria-label={`Approve ${organizationName}`}>
      <div>
        <label htmlFor={noteId} className="mb-1.5 block text-xs font-semibold text-text-strong">
          Approval note (optional)
        </label>
        <Textarea
          id={noteId}
          name="note"
          value={note}
          maxLength={PHARMACY_APPROVAL_NOTE_MAX_LENGTH}
          disabled={pending}
          onChange={(event) => setNote(event.target.value)}
          aria-describedby={error ? errorId : undefined}
          placeholder="Anything the audit record should say about this approval"
        />
        <p className="mt-1 text-xs text-text-muted">
          Recorded with your name and the time in the lifecycle and audit ledgers.
        </p>
      </div>
      {error ? (
        <div
          id={errorId}
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <p>{error.message}</p>
          {error.gates.length ? (
            <ul className="mt-1 list-disc pl-5">
              {error.gates.map((gate) => (
                <li key={gate}>{gate}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <Button type="submit" className="min-h-11" disabled={pending}>
        {pending ? (
          <LoaderCircle className="animate-spin" aria-hidden="true" />
        ) : (
          <BadgeCheck aria-hidden="true" />
        )}
        {pending ? 'Approving…' : 'Approve pharmacy'}
      </Button>
    </form>
  );
}
