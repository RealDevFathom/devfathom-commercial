'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export type CounterRxApprovalLine = { saleLineId: string; medicineName: string };

/** What the server accepts as a reason: 3 to 300 characters once trimmed. */
export function rxApprovalReasonValid(reason: string | undefined): boolean {
  const trimmed = (reason ?? '').trim();
  return trimmed.length >= 3 && trimmed.length <= 300;
}

export type CounterRxApprovalProps = {
  /** Prescription-only/restricted, non-controlled lines on the bill with no approval yet. */
  lines: readonly CounterRxApprovalLine[];
  /** 'approver' holds pharmacy:dispense; 'viewer' does not; the others are the access read. */
  access: 'loading' | 'error' | 'approver' | 'viewer';
  reasons: Readonly<Record<string, string>>;
  /** The line whose approval is being saved, if any. */
  pendingLineId: string | null;
  disabled?: boolean;
  onReasonChange: (saleLineId: string, reason: string) => void;
  onApprove: (saleLineId: string) => void;
};

/**
 * #341 — the counter's path for a pharmacist to approve a prescription-only line instead of only
 * voiding it. The approval and its reason are recorded on the server and clear that line's
 * POS-09 prescription block; nothing here lets someone without the dispensing permission sell it.
 */
export function CounterRxApproval({
  lines,
  access,
  reasons,
  pendingLineId,
  disabled,
  onReasonChange,
  onApprove,
}: CounterRxApprovalProps) {
  if (lines.length === 0) return null;
  const locked = Boolean(disabled) || pendingLineId !== null;
  return (
    <section
      aria-label="Pharmacist approval"
      className="mb-4 space-y-3 rounded-md border border-border-subtle p-3"
    >
      <h4 className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
        Pharmacist approval
      </h4>
      {access === 'loading' ? (
        <p role="status" className="text-sm text-text-muted">
          Checking who can approve prescription-only lines…
        </p>
      ) : access === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          Approval access could not be checked. Refresh the counter and try again.
        </p>
      ) : access === 'viewer' ? (
        <p role="status" className="text-sm text-text-body">
          A pharmacist with the dispensing permission must approve and sell{' '}
          {lines.map((line) => line.medicineName).join(', ')}. Void the line to clear the block
          instead.
        </p>
      ) : (
        <ul className="space-y-3">
          {lines.map((line) => {
            const inputId = `rx-approval-reason-${line.saleLineId}`;
            const reason = reasons[line.saleLineId] ?? '';
            return (
              <li key={line.saleLineId} className="space-y-2">
                <Label htmlFor={inputId}>Approval reason for {line.medicineName}</Label>
                <Input
                  id={inputId}
                  className="h-11"
                  maxLength={300}
                  placeholder="e.g. Prescription seen: Dr Khan, 22 Oct"
                  value={reason}
                  disabled={locked}
                  onChange={(event) => onReasonChange(line.saleLineId, event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
                  disabled={locked || !rxApprovalReasonValid(reason)}
                  onClick={() => onApprove(line.saleLineId)}
                >
                  {pendingLineId === line.saleLineId ? 'Approving…' : 'Approve as pharmacist'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-text-muted">
        The approving pharmacist and the reason are recorded with the line and cannot be edited.
      </p>
    </section>
  );
}
