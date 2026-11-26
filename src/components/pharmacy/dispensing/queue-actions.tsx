'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, fieldClass } from './field';

export type ReviewKind = 'VERIFY' | 'CLARIFY' | 'REFUSE' | 'OVERRIDE' | 'COUNSEL' | 'SIGN';

export function QueueActions({
  canApprove,
  separateSign = false,
  pending = false,
  disabled = false,
  onDirtyChange,
  onAction,
}: {
  canApprove: boolean;
  separateSign?: boolean;
  pending?: boolean;
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onAction: (kind: ReviewKind, reason?: string) => void | Promise<void>;
}) {
  const [mode, setMode] = useState<ReviewKind | null>(null);
  const [reason, setReason] = useState('');
  const [checks, setChecks] = useState([false, false, false]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const locked = pending || submitting || disabled;
  const reasonRequired = mode === 'CLARIFY' || mode === 'REFUSE' || mode === 'OVERRIDE';
  const counselReady = mode !== 'COUNSEL' || checks.every(Boolean);

  async function confirm() {
    if (
      !canApprove ||
      locked ||
      submittingRef.current ||
      !mode ||
      (reasonRequired && !reason.trim()) ||
      !counselReady
    )
      return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onAction(
        mode,
        reason.trim() || (mode === 'COUNSEL' ? 'Counselling checklist completed.' : undefined)
      );
      setMode(null);
      setReason('');
      setChecks([false, false, false]);
      onDirtyChange?.(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Decision could not be recorded.');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (!canApprove && separateSign) return null;
  if (!canApprove) {
    return (
      <p
        role="note"
        className="rounded-sm border border-warning/30 bg-warning/10 p-3 text-sm text-text-strong"
      >
        Segregation of duties: the cashier who requested this review cannot approve or sign it.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" aria-label="Review actions">
        {(['VERIFY', 'CLARIFY', 'REFUSE', 'OVERRIDE', 'COUNSEL', 'SIGN'] as const)
          .filter((kind) => kind !== 'SIGN' || !separateSign)
          .map((kind) => (
            <Button
              key={kind}
              type="button"
              variant={kind === 'REFUSE' ? 'destructive' : mode === kind ? 'default' : 'outline'}
              disabled={locked}
              onClick={() => {
                setMode(kind);
                setReason('');
                setError(null);
                onDirtyChange?.(true);
              }}
            >
              {kind[0] + kind.slice(1).toLowerCase()}
            </Button>
          ))}
      </div>
      {reasonRequired ? (
        <Field
          label={
            mode === 'CLARIFY'
              ? 'Note back to counter'
              : `${mode === 'REFUSE' ? 'Refusal' : 'Override'} reason`
          }
        >
          <textarea
            autoFocus
            required
            disabled={locked}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={`${fieldClass} min-h-24 py-3`}
          />
        </Field>
      ) : null}
      {mode === 'COUNSEL' ? (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-semibold">Counselling checklist</legend>
          {[
            'Directions and duration explained',
            'Key risks and storage explained',
            'Patient questions answered',
          ].map((label, index) => (
            <label
              key={label}
              className="flex min-h-11 items-center gap-3 rounded-sm border border-border-subtle px-3 text-sm"
            >
              <input
                type="checkbox"
                disabled={locked}
                checked={checks[index]}
                onChange={(e) =>
                  setChecks((current) =>
                    current.map((value, item) => (item === index ? e.target.checked : value))
                  )
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
      ) : null}
      {mode ? (
        <Button
          type="button"
          size="lg"
          disabled={locked || (reasonRequired && !reason.trim()) || !counselReady}
          onClick={() => void confirm()}
        >
          {pending || submitting ? 'Recording…' : `Confirm ${mode.toLowerCase()}`}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {mode === 'OVERRIDE' ? (
        <p className="text-xs text-text-muted">
          A second authorized signature remains required when the governing rule marks this override
          dual-control.
        </p>
      ) : null}
    </div>
  );
}
