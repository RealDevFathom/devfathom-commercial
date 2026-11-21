'use client';

import { OwnPinLink } from '@/components/pharmacy/pin-aware-message';
import { useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

import type { CounterTenderResult, KhataApprover } from './counter-tender-panel';
import { useCounterApprovalCopy } from './counter-approval-copy';

const APPROVER_PIN = /^\d{4,8}$/;
const MIN_REASON = 3;

export type CounterTenderDiscardInput = { staffProfileId: string; pin: string; reason: string };

type Props = {
  /** Locks the form while a payment or an outcome check is running. */
  disabled?: boolean;
  loadApprovers: () => Promise<KhataApprover[]>;
  onDiscard: (input: CounterTenderDiscardInput) => Promise<CounterTenderResult>;
};

/**
 * DEV-712: a manager or owner releases a payment attempt whose outcome is unknown, with their
 * PIN and a reason. A solo owner or manager picks their own profile and re-enters their own
 * PIN. The server decides; this form never clears the saved attempt itself.
 */
export function CounterTenderDiscard({ disabled = false, loadApprovers, onDiscard }: Props) {
  const approvalCopy = useCounterApprovalCopy();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [approvers, setApprovers] = useState<KhataApprover[] | null>(null);
  const [approversError, setApproversError] = useState(false);
  const [reload, setReload] = useState(0);
  const [approverId, setApproverId] = useState('');
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const submitRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    let current = true;
    void loadApprovers()
      .then((rows) => {
        if (!current) return;
        setApprovers(rows);
        setApproversError(false);
        setApproverId((selected) => (rows.some((row) => row.id === selected) ? selected : ''));
      })
      .catch(() => {
        if (current) setApproversError(true);
      });
    return () => {
      current = false;
    };
  }, [open, loadApprovers, reload]);

  const locked = disabled || submitting;
  const ready = Boolean(approverId) && APPROVER_PIN.test(pin) && reason.trim().length >= MIN_REASON;

  async function submit() {
    if (!ready || locked || submitRef.current) return;
    submitRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      const result = await onDiscard({ staffProfileId: approverId, pin, reason: reason.trim() });
      // The PIN is one-time evidence: never keep it after a decision.
      setPin('');
      if (result.status === 'unknown') setError(result.message);
      else setOpen(false);
    } catch {
      setPin('');
      setError('The attempt was not discarded. Check the connection and try again.');
    } finally {
      submitRef.current = false;
      setSubmitting(false);
    }
  }

  if (!open)
    return (
      <Button
        type="button"
        variant="outline"
        className="min-h-11 rounded-sm"
        disabled={disabled}
        onClick={() => {
          setApprovers(null);
          setApproversError(false);
          setError('');
          setOpen(true);
        }}
      >
        Supervisor: discard this attempt
      </Button>
    );

  return (
    <fieldset
      className="space-y-3 rounded-md border border-border-subtle bg-surface-sunken p-4"
      aria-describedby={`${id}-help`}
    >
      <legend className="px-1 text-sm font-medium text-text-strong">
        Discard the payment attempt
      </legend>
      <p id={`${id}-help`} className="text-sm leading-relaxed text-text-body">
        Use this only after checking the payment did not reach the shop. A manager or owner approves
        with their PIN. The attempt can never be recorded afterwards; if it was already recorded,
        the counter shows it as paid instead.
      </p>
      <Label htmlFor={`${id}-approver`}>Approving manager or owner</Label>
      <select
        id={`${id}-approver`}
        className="h-11 w-full rounded-md border border-border-subtle bg-surface-raised px-3 focus-visible:outline-2 focus-visible:outline-ring"
        disabled={locked || approvers === null || approversError}
        value={approverId}
        onChange={(event) => {
          setApproverId(event.target.value);
          setPin('');
        }}
      >
        <option value="">Select manager or owner</option>
        {(approvers ?? []).map((approver) => (
          <option key={approver.id} value={approver.id}>
            {approver.self ? `${approver.name} (you)` : approver.name}
          </option>
        ))}
      </select>
      {approversError ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            Approvers could not be loaded.
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 rounded-sm"
            onClick={() => {
              setApproversError(false);
              setReload((value) => value + 1);
            }}
          >
            Retry loading approvers
          </Button>
        </div>
      ) : approvers === null ? (
        <p role="status" className="text-sm text-text-muted">
          Loading approvers…
        </p>
      ) : approvers.length === 0 ? (
        <p role="status" className="text-sm text-text-body">
          No manager or owner has an active staff PIN. A manager or owner creates their own under
          Settings, Your PIN. <OwnPinLink />
        </p>
      ) : null}
      <Label htmlFor={`${id}-pin`}>{approvalCopy.approverLabel}</Label>
      <Input
        id={`${id}-pin`}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={8}
        aria-describedby={`${id}-pin-hint`}
        value={pin}
        disabled={locked || !approverId}
        onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
        className="h-11 rounded-sm"
      />
      <p id={`${id}-pin-hint`} className="text-sm text-text-muted">
        {approvalCopy.hint}
      </p>
      <Label htmlFor={`${id}-reason`}>Reason</Label>
      <Textarea
        id={`${id}-reason`}
        value={reason}
        maxLength={500}
        disabled={locked}
        onChange={(event) => setReason(event.target.value)}
        placeholder="For example: customer did not pay; terminal shows no transaction"
      />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="destructive"
          className="min-h-11 rounded-sm"
          disabled={!ready || locked}
          onClick={() => void submit()}
        >
          {submitting ? 'Discarding attempt…' : 'Discard payment attempt'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 rounded-sm"
          disabled={submitting}
          onClick={() => {
            setPin('');
            setError('');
            setOpen(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}
