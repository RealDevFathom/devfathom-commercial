'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';

import {
  RestaurantStaffSelect,
  type RestaurantStaffOption,
} from '@/components/restaurant/restaurant-staff-select';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';

import type { TerminalRequest } from './checkout-panel';

type Preview = {
  businessDate: string;
  readiness: { openBillCount: number; unbilledOrderCount: number; openDrawerCount: number };
  existingCloseId: string | null;
  totals: {
    grossSales: string;
    netSales: string;
    deliveryFeeSales: string;
    deliveryFeeRefunds: string;
    refundTotal: string;
    cashExpected: string;
    cashCounted: string;
    cashVariance: string;
  };
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Day close request failed. Retry this action.';
}

export function DayClosePanel({
  request,
  operators,
  actingOperatorId,
  disabled = false,
}: {
  request: TerminalRequest;
  operators: RestaurantStaffOption[];
  actingOperatorId: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [businessDate, setBusinessDate] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [managerId, setManagerId] = useState('');
  const [managerSecret, setManagerSecret] = useState('');
  const eligibleManagers = operators.filter(
    (operator) => operator.id !== actingOperatorId || operator.canSelfApprove
  );

  async function setPanelOpen(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) return;
    setPending('date');
    setError(null);
    try {
      const current = await request<{ businessDate: string }>('/api/restaurant/cash/day/current');
      setBusinessDate(current.businessDate);
      setPreview(null);
    } catch (caught) {
      setBusinessDate('');
      setError(errorMessage(caught));
    } finally {
      setPending(null);
    }
  }

  async function load() {
    setPending('preview');
    setError(null);
    setNotice(null);
    try {
      setPreview(
        await request<Preview>(`/api/restaurant/cash/day/preview?businessDate=${businessDate}`)
      );
    } catch (caught) {
      setPreview(null);
      setError(errorMessage(caught));
    } finally {
      setPending(null);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview || !ready || busy || disabled) return;
    const correction = preview.existingCloseId !== null;
    if (correction && (!reason.trim() || !managerId.trim() || !managerSecret)) {
      setError('A correction requires a reason and an eligible approving manager PIN.');
      return;
    }
    const body = correction
      ? {
          businessDate,
          supersedesCloseId: preview.existingCloseId,
          reason: reason.trim(),
          approving: {
            staffProfileId: managerId.trim(),
            type: 'PIN' as const,
            secret: managerSecret,
          },
        }
      : { businessDate };
    const path = correction ? '/api/restaurant/cash/day/correct' : '/api/restaurant/cash/day/close';
    setPending('close');
    setError(null);
    try {
      await request(path, { method: 'POST', body, intent: `day-close:${JSON.stringify(body)}` });
      setReason('');
      setManagerSecret('');
      setNotice(correction ? 'Day-close correction recorded.' : 'Business day closed.');
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(null);
    }
  }

  const ready =
    preview?.readiness.openBillCount === 0 &&
    preview.readiness.unbilledOrderCount === 0 &&
    preview.readiness.openDrawerCount === 0;
  const busy = pending !== null;
  return (
    <Dialog open={open} onOpenChange={(next) => void setPanelOpen(next)}>
      <DialogTrigger
        render={<Button type="button" variant="outline" className="h-11" />}
        disabled={disabled}
      >
        Close day
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>Close business day</DialogTitle>
          <DialogDescription>
            Preview readiness, cut once, or append a manager-authorized correction.
          </DialogDescription>
        </DialogHeader>
        {notice ? (
          <p role="status" className="text-sm text-success">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="day-close-date">Business date</Label>
            <Input
              id="day-close-date"
              type="date"
              value={businessDate}
              disabled
              onChange={(event) => {
                setBusinessDate(event.target.value);
                setPreview(null);
              }}
              className="h-11"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !businessDate}
            onClick={() => void load()}
            className="h-11"
          >
            {pending === 'preview' ? 'Checking…' : 'Check readiness'}
          </Button>
        </div>
        {preview ? (
          <SectionCard
            eyebrow="Operator close"
            title={
              preview.existingCloseId ? 'Closed day' : ready ? 'Ready to close' : 'Close blocked'
            }
            actions={
              <StatusPill
                status={preview.existingCloseId ? 'closed' : ready ? 'ready' : 'blocked'}
                tone={preview.existingCloseId ? 'success' : ready ? 'success' : 'warning'}
              />
            }
          >
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-text-muted">Open bills</dt>
                <dd className="font-mono tabular-nums">{preview.readiness.openBillCount}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Unbilled active orders</dt>
                <dd className="font-mono tabular-nums">{preview.readiness.unbilledOrderCount}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Open drawers</dt>
                <dd className="font-mono tabular-nums">{preview.readiness.openDrawerCount}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Gross sales</dt>
                <dd className="font-mono tabular-nums">{preview.totals.grossSales}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Net sales</dt>
                <dd className="font-mono tabular-nums">{preview.totals.netSales}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Refunds</dt>
                <dd className="font-mono tabular-nums">{preview.totals.refundTotal}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Delivery fee sales</dt>
                <dd className="font-mono tabular-nums">{preview.totals.deliveryFeeSales}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Delivery fee refunds</dt>
                <dd className="font-mono tabular-nums">{preview.totals.deliveryFeeRefunds}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Cash expected</dt>
                <dd className="font-mono tabular-nums">{preview.totals.cashExpected}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Cash counted</dt>
                <dd className="font-mono tabular-nums">{preview.totals.cashCounted}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Cash variance</dt>
                <dd className="font-mono tabular-nums">{preview.totals.cashVariance}</dd>
              </div>
            </dl>
            {!ready ? (
              <p className="mt-3 text-sm text-warning">
                Resolve {preview.readiness.openBillCount} open bill(s),{' '}
                {preview.readiness.unbilledOrderCount} unbilled active order(s) and{' '}
                {preview.readiness.openDrawerCount} open drawer(s).
              </p>
            ) : null}
            {ready ? (
              <form onSubmit={submit} className="mt-4 space-y-3">
                {preview.existingCloseId ? (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="day-close-reason">Correction reason</Label>
                      <Input
                        id="day-close-reason"
                        value={reason}
                        disabled={busy}
                        onChange={(event) => setReason(event.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="day-close-manager">Approving manager</Label>
                      <RestaurantStaffSelect
                        id="day-close-manager"
                        staff={eligibleManagers}
                        value={managerId}
                        disabled={busy}
                        required
                        label="Approving manager"
                        onChange={setManagerId}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="day-close-pin">Manager PIN</Label>
                      <Input
                        id="day-close-pin"
                        type="password"
                        value={managerSecret}
                        disabled={busy}
                        onChange={(event) => setManagerSecret(event.target.value)}
                      />
                    </div>
                  </>
                ) : null}
                <Button type="submit" disabled={busy} className="h-11 w-full">
                  {pending === 'close'
                    ? 'Recording…'
                    : preview.existingCloseId
                      ? 'Record correction'
                      : 'Close business day'}
                </Button>
              </form>
            ) : null}
            {preview.existingCloseId ? (
              <Button
                render={<Link href="/restaurant/money?tab=daily-close" />}
                variant="link"
                className="mt-3 px-0"
              >
                Review in Restaurant Finance
              </Button>
            ) : null}
          </SectionCard>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => setOpen(false)}
            className="h-11"
          >
            Close day panel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
