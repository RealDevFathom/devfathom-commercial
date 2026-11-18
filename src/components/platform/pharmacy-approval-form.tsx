'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BadgeCheck, CircleDashed, LoaderCircle, Undo2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import {
  PHARMACY_APPROVAL_NOTE_MAX_LENGTH,
  PHARMACY_APPROVAL_WITHDRAW_REASON_MAX_LENGTH,
  PHARMACY_APPROVAL_WITHDRAW_REASON_MIN_LENGTH,
  pharmacyApprovalCommand,
  pharmacyApprovalWithdrawCommand,
} from '@/lib/platform/pharmacy-approval';

type ControlFailure = {
  error?: string;
  gates?: Array<{ message?: string }>;
};

export type PharmacyApprovalCheck = { key: string; label: string };

async function sendControl(body: unknown): Promise<{ message: string; gates: string[] } | null> {
  const response = await fetch('/api/platform/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.ok) return null;
  const failure = (await response.json().catch(() => ({}))) as ControlFailure;
  return {
    message: failure.error ?? 'The platform could not complete this.',
    gates: (failure.gates ?? [])
      .map((gate) => gate.message)
      .filter((message): message is string => typeof message === 'string'),
  };
}

function FormError({ id, error }: { id: string; error: { message: string; gates: string[] } }) {
  return (
    <div
      id={id}
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
  );
}

/**
 * DEV-905 — "Approve pharmacy" with an optional note.
 *
 * Owner decision (18 Nov): approval is manual and may be given whatever the pharmacy's
 * state. When checks are not met, the form lists them and the operator must confirm
 * them by name before Approve is enabled; the server recomputes the list and refuses if
 * it differs from what was confirmed. Approval is never automatic.
 */
export function PharmacyApprovalForm({
  organizationId,
  organizationName,
  unmetChecks = [],
}: {
  organizationId: string;
  organizationName: string;
  /** The checks the pharmacy does not meet now, shown as information. */
  unmetChecks?: readonly PharmacyApprovalCheck[];
}) {
  const router = useRouter();
  const id = useId();
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; gates: string[] } | null>(null);
  const needsConfirmation = unmetChecks.length > 0;

  async function approve(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (needsConfirmation && !confirmed) return;
    setPending(true);
    setError(null);
    try {
      const failure = await sendControl(
        pharmacyApprovalCommand(
          organizationId,
          note,
          unmetChecks.map((check) => check.key)
        )
      );
      if (failure) {
        setError(failure);
        return;
      }
      toast.success(`${organizationName} approved`);
      setNote('');
      setConfirmed(false);
      router.refresh();
    } catch {
      setError({ message: 'The pharmacy could not be approved. Try again.', gates: [] });
    } finally {
      setPending(false);
    }
  }

  const noteId = `${id}-note`;
  const errorId = `${id}-error`;
  const checksId = `${id}-checks`;
  const count = unmetChecks.length;
  return (
    <form onSubmit={approve} className="space-y-3" aria-label={`Approve ${organizationName}`}>
      {needsConfirmation ? (
        <div
          id={checksId}
          className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-text-body"
        >
          <p className="font-semibold text-text-strong">
            {count === 1 ? 'This check is not met:' : `These ${count} checks are not met:`}
          </p>
          <ul className="mt-1.5 space-y-1">
            {unmetChecks.map((check) => (
              <li key={check.key} className="flex items-start gap-2">
                <CircleDashed
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning"
                  aria-hidden="true"
                />
                {check.label}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-text-muted">
            Approving lets the pharmacy run without them. Prescription, controlled-medicine, refund,
            discount, stock, tax and money rules still apply to every sale.
          </p>
          <label className="mt-2 flex min-h-11 items-center gap-2 text-sm text-text-strong">
            <Checkbox
              checked={confirmed}
              disabled={pending}
              aria-describedby={checksId}
              onCheckedChange={(checked) => setConfirmed(Boolean(checked))}
            />
            {count === 1 ? 'Approve without this check' : `Approve without these ${count} checks`}
          </label>
        </div>
      ) : null}
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
          Recorded with your name, the time and any unmet checks on the organization and in the
          audit ledger.
        </p>
      </div>
      {error ? <FormError id={errorId} error={error} /> : null}
      <Button
        type="submit"
        className="min-h-11"
        disabled={pending || (needsConfirmation && !confirmed)}
      >
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

/**
 * DEV-905 — withdraw a pharmacy's approval. The normal checks apply again at once; the
 * lifecycle state is left as it is. The reason goes to the audit ledger.
 */
export function PharmacyApprovalWithdrawForm({
  organizationId,
  organizationName,
}: {
  organizationId: string;
  organizationName: string;
}) {
  const router = useRouter();
  const id = useId();
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; gates: string[] } | null>(null);
  const tooShort = reason.trim().length < PHARMACY_APPROVAL_WITHDRAW_REASON_MIN_LENGTH;

  async function withdraw(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (tooShort) return;
    setPending(true);
    setError(null);
    try {
      const failure = await sendControl(pharmacyApprovalWithdrawCommand(organizationId, reason));
      if (failure) {
        setError(failure);
        return;
      }
      toast.success(`Approval withdrawn for ${organizationName}`);
      setReason('');
      router.refresh();
    } catch {
      setError({ message: 'The approval could not be withdrawn. Try again.', gates: [] });
    } finally {
      setPending(false);
    }
  }

  const reasonId = `${id}-reason`;
  const errorId = `${id}-error`;
  return (
    <form
      onSubmit={withdraw}
      className="space-y-3"
      aria-label={`Withdraw approval for ${organizationName}`}
    >
      <div>
        <label htmlFor={reasonId} className="mb-1.5 block text-xs font-semibold text-text-strong">
          Reason for withdrawing
        </label>
        <Textarea
          id={reasonId}
          name="reason"
          value={reason}
          minLength={PHARMACY_APPROVAL_WITHDRAW_REASON_MIN_LENGTH}
          maxLength={PHARMACY_APPROVAL_WITHDRAW_REASON_MAX_LENGTH}
          required
          disabled={pending}
          onChange={(event) => setReason(event.target.value)}
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          placeholder="At least 10 characters, kept in the audit ledger"
        />
        <p className="mt-1 text-xs text-text-muted">
          Every normal check applies again at once: the organization, regulatory profile, qualified
          person and onboarding gates.
        </p>
      </div>
      {error ? <FormError id={errorId} error={error} /> : null}
      <Button
        type="submit"
        variant="destructive"
        className="min-h-11"
        disabled={pending || tooShort}
      >
        {pending ? (
          <LoaderCircle className="animate-spin" aria-hidden="true" />
        ) : (
          <Undo2 aria-hidden="true" />
        )}
        {pending ? 'Withdrawing…' : 'Withdraw approval'}
      </Button>
    </form>
  );
}
