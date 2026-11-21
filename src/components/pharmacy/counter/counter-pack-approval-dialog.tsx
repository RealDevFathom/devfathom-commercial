'use client';

import { OwnPinLink } from '@/components/pharmacy/pin-aware-message';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CounterApprovalPin } from '@/lib/pharmacy/counter-line-approval';
import { useCounterApprovalCopy } from './counter-approval-copy';

type Approver = { id: string; name: string; self: boolean };

/** DEV-929: the same manager/owner PIN dialog approves a manual discount, in its own words. */
export type CounterApprovalDialogCopy = { title: string; description: string; confirm: string };

/** Uses the counter's shared dialog and manager/owner PIN approval controls. */
export function CounterPackApprovalDialog({
  medicineName,
  copy,
  loadApprovers,
  onCancel,
  onConfirm,
}: {
  medicineName: string;
  copy?: CounterApprovalDialogCopy;
  loadApprovers: () => Promise<Approver[]>;
  onCancel: () => void;
  onConfirm: (approval: CounterApprovalPin) => void;
}) {
  const approvalCopy = useCounterApprovalCopy();
  const [rows, setRows] = useState<Approver[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    void loadApprovers().then(
      (value) => {
        if (current) setRows(value);
      },
      () => {
        if (current) setFailed(true);
      }
    );
    return () => {
      current = false;
    };
  }, [loadApprovers, retry]);
  const [staffProfileId, setStaffProfileId] = useState('');
  const [pin, setPin] = useState('');
  const eligible = !failed && rows?.some((row) => row.id === staffProfileId);
  const ready = rows !== null && eligible && /^\d{4,8}$/.test(pin);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            const approval = { staffProfileId, pin };
            setPin('');
            onConfirm(approval);
          }}
        >
          <DialogTitle>{copy?.title ?? 'Approve this scanned pack?'}</DialogTitle>
          <DialogDescription>
            {copy?.description ??
              `${medicineName}: this pack is not from the earliest-expiry batch. A manager or owner must enter a fresh PIN. A solo owner can enter their own PIN. The approval is recorded in the audit.`}
          </DialogDescription>
          <div className="grid gap-2">
            <Label htmlFor="pack-approver">Approving manager or owner</Label>
            <select
              id="pack-approver"
              className="h-11 w-full rounded-md border border-border-subtle bg-surface-raised px-3 focus-visible:outline-2 focus-visible:outline-ring"
              disabled={rows === null || failed}
              value={staffProfileId}
              onChange={(event) => {
                setStaffProfileId(event.target.value);
                setPin('');
              }}
            >
              <option value="">Select manager or owner</option>
              {(failed ? [] : (rows ?? [])).map((row) => (
                <option key={row.id} value={row.id}>
                  {row.self ? `${row.name} (you)` : row.name}
                </option>
              ))}
            </select>
            {failed ? (
              <div role="alert" className="text-sm text-destructive">
                Approvers could not be loaded.
                <Button
                  type="button"
                  variant="outline"
                  className="ml-2 h-11"
                  onClick={() => {
                    setFailed(false);
                    setRows(null);
                    setPin('');
                    setRetry((value) => value + 1);
                  }}
                >
                  Retry
                </Button>
              </div>
            ) : rows === null ? (
              <p role="status">Loading approvers…</p>
            ) : rows.length === 0 ? (
              <p role="status">
                No manager or owner has an active staff PIN. A manager or owner creates their own
                under Settings, Your PIN. <OwnPinLink />
              </p>
            ) : null}
            <Label htmlFor="pack-approver-pin">{approvalCopy.approverLabel}</Label>
            <Input
              id="pack-approver-pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              className="h-11"
              aria-describedby="pack-approver-pin-hint"
              value={pin}
              disabled={!eligible}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
            />
            <p id="pack-approver-pin-hint" className="text-sm text-text-muted">
              {approvalCopy.hint}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" className="h-11" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" className="h-11" disabled={!ready}>
              {copy?.confirm ?? 'Approve pack'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
