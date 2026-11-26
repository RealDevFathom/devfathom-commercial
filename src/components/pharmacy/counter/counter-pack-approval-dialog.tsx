'use client';

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
import {
  ApprovalFallback,
  ApprovalNames,
  useApprovalEntry,
  UnavailableCounterApprover,
  type ApprovalEntry,
} from './counter-approval-entry';
import { useCounterApprovalCopy } from './counter-approval-copy';

type Approver = { id: string; name: string; self: boolean };

/** DEV-929: the same manager/owner PIN dialog approves a manual discount, in its own words. */
export type CounterApprovalDialogCopy = { title: string; description: string; confirm: string };

/** Uses the counter's shared dialog and manager/owner PIN approval controls. */
export function CounterPackApprovalDialog({
  medicineName,
  pharmacist = false,
  copy,
  loadApprovers,
  matches,
  onCancel,
  onConfirm,
}: {
  medicineName: string;
  pharmacist?: boolean;
  copy?: CounterApprovalDialogCopy;
  matches?: string[];
  loadApprovers: () => Promise<Approver[]>;
  onCancel: () => void;
  onConfirm: (approval: ApprovalEntry) => void;
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
  const form = useApprovalEntry(matches);
  const { profile: staffProfileId, setProfile: setStaffProfileId, pin, setPin } = form;
  const eligible = form.codeOnly || (!failed && rows?.some((row) => row.id === staffProfileId));
  const ready = eligible && form.entry;

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
            const approval = ready;
            setPin('');
            onConfirm(approval);
          }}
        >
          <DialogTitle>
            {copy?.title ??
              (pharmacist ? 'Approve this batch override?' : 'Approve this scanned pack?')}
          </DialogTitle>
          <DialogDescription>
            {copy?.description ??
              (pharmacist
                ? `${medicineName}: a pharmacist must approve this batch with their ${approvalCopy.secretName}.`
                : `${medicineName}: this pack is not from the earliest-expiry batch. ${approvalCopy.managerInstruction} The approval is recorded in the audit.`)}
          </DialogDescription>
          <div className="grid gap-2">
            <ApprovalNames form={form}>
              <Label htmlFor="pack-approver">
                {pharmacist ? 'Approving pharmacist' : 'Approving manager or owner'}
              </Label>
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
                <option value="">
                  {pharmacist ? 'Select pharmacist' : 'Select manager or owner'}
                </option>
                {form.visible(failed ? [] : (rows ?? [])).map((row) => (
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
                  <UnavailableCounterApprover pharmacist={pharmacist} />
                </p>
              ) : null}
            </ApprovalNames>
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
            <ApprovalFallback form={form} disabled={false} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" className="h-11" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" className="h-11" disabled={!ready}>
              {copy?.confirm ?? (pharmacist ? 'Approve batch' : 'Approve pack')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
