'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';

import { ReceiptView } from './receipt-view';
import { SplitBillDialog, type BillSplit } from './split-bill-dialog';
import { TenderPad, type TenderResult } from './tender-pad';

export type TerminalRequestOptions = {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  intent?: string;
};

export type TerminalRequest = <T>(
  path: string,
  options?: TerminalRequestOptions
) => Promise<T>;

type CheckoutSummary = {
  orderId: string;
  settled: boolean;
  blocker: string | null;
  derivedOrderTotal: string;
  accountedTotal: string;
  unbilledItemIds: string[];
  bills: {
    id: string;
    status: string;
    splitKind: string;
    grandTotal: string;
    compTotal: string;
    receiptNumber: string | null;
  }[];
};

type CheckoutPanelProps = {
  open: boolean;
  orderId: string | null;
  request: TerminalRequest;
  onClose: () => void;
};

function errorDetails(error: unknown) {
  const status =
    typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
      ? error.status
      : null;
  const message = error instanceof Error ? error.message : 'Checkout request failed.';
  return {
    status,
    message: status === 403 ? `Permission denied: ${message}` : message,
  };
}

function billTone(status: string): StatusTone {
  if (status === 'SETTLED') return 'success';
  if (status === 'OPEN') return 'warning';
  if (status === 'VOID') return 'danger';
  return 'neutral';
}

export function CheckoutPanel({ open, orderId, request, onClose }: CheckoutPanelProps) {
  const [summary, setSummary] = useState<CheckoutSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadSummary = useCallback(async () => {
    if (!open || !orderId) return;
    setLoading(true);
    setPermissionDenied(false);
    setError(null);
    try {
      setSummary(
        await request<CheckoutSummary>(
          `/api/restaurant/checkout/summary?orderId=${encodeURIComponent(orderId)}`
        )
      );
    } catch (requestError) {
      const details = errorDetails(requestError);
      setSummary(null);
      setPermissionDenied(details.status === 403);
      setError(details.message);
    } finally {
      setLoading(false);
    }
  }, [open, orderId, request]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  async function cut(split: { kind: 'NONE' } | BillSplit) {
    if (!orderId || busy) return false;
    const body = { orderId, split };
    setBusy(true);
    setError(null);
    try {
      await request<unknown>('/api/restaurant/checkout/bill', {
        method: 'POST',
        body,
        intent: `checkout-bill:${JSON.stringify(body)}`,
      });
      await loadSummary();
      return true;
    } catch (requestError) {
      const details = errorDetails(requestError);
      setPermissionDenied(details.status === 403);
      setError(details.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function tenderApplied(_result: TenderResult) {
    await loadSummary();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Collect payment</DialogTitle>
          <DialogDescription>
            Cut bills, apply split tenders, and review settled receipts for this order.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <SectionCard eyebrow="Checkout" title="Loading settlement">
            <p className="text-sm text-text-muted">Loading bill and settlement state…</p>
          </SectionCard>
        ) : null}

        {!loading && error && !summary ? (
          <SectionCard
            eyebrow="Checkout"
            title={permissionDenied ? 'Payment access denied' : 'Checkout unavailable'}
            actions={<StatusPill status={permissionDenied ? 'denied' : 'error'} tone="danger" />}
          >
            <div className="space-y-3">
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
              <Button type="button" variant="outline" onClick={() => void loadSummary()} className="h-11">
                Retry checkout
              </Button>
            </div>
          </SectionCard>
        ) : null}

        {!loading && summary ? (
          <div className="space-y-4">
            <SectionCard
              eyebrow="Settlement"
              title="Order balance"
              actions={
                <StatusPill
                  status={summary.settled ? 'settled' : 'payment pending'}
                  tone={summary.settled ? 'success' : 'warning'}
                />
              }
            >
              <dl className="grid gap-3 sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-text-muted">Order total</dt>
                  <dd className="font-mono text-lg font-semibold tabular-nums text-text-strong">
                    {summary.derivedOrderTotal}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-text-muted">Accounted on bills</dt>
                  <dd className="font-mono text-lg font-semibold tabular-nums text-text-strong">
                    {summary.accountedTotal}
                  </dd>
                </div>
              </dl>
              {summary.blocker ? (
                <p className="mt-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-text-body">
                  {summary.blocker}
                </p>
              ) : null}
            </SectionCard>

            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}

            {summary.bills.length === 0 && summary.unbilledItemIds.length > 0 ? (
              <SectionCard
                eyebrow="Billing"
                title={`${summary.unbilledItemIds.length} unbilled item${summary.unbilledItemIds.length === 1 ? '' : 's'}`}
              >
                <p className="mb-4 text-sm text-text-muted">
                  Cut one bill for the order or choose a supported split method.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    onClick={() => void cut({ kind: 'NONE' })}
                    disabled={busy}
                    className="h-11"
                  >
                    {busy ? 'Creating bill…' : 'Cut single bill'}
                  </Button>
                  <SplitBillDialog
                    itemIds={summary.unbilledItemIds}
                    disabled={busy}
                    onSplit={cut}
                  />
                </div>
              </SectionCard>
            ) : null}

            {summary.bills.length === 0 && summary.unbilledItemIds.length === 0 ? (
              <SectionCard eyebrow="Billing" title="Nothing to collect">
                <p className="text-sm text-text-muted">
                  This order has no live bills or unbilled items.
                </p>
              </SectionCard>
            ) : null}

            {summary.bills.map((bill, index) => (
              <SectionCard
                key={bill.id}
                eyebrow={`Bill ${index + 1}`}
                title={bill.receiptNumber ? `Receipt ${bill.receiptNumber}` : bill.splitKind.replaceAll('_', ' ')}
                actions={<StatusPill status={bill.status} tone={billTone(bill.status)} />}
              >
                <dl className="mb-4 grid gap-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-text-muted">Bill total</dt>
                    <dd className="font-mono text-lg font-semibold tabular-nums text-text-strong">
                      {bill.grandTotal}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-text-muted">Comp total</dt>
                    <dd className="font-mono text-lg font-semibold tabular-nums text-text-strong">
                      {bill.compTotal}
                    </dd>
                  </div>
                </dl>
                {bill.status === 'OPEN' ? (
                  <TenderPad
                    billId={bill.id}
                    amountDue={bill.grandTotal}
                    request={request}
                    disabled={busy}
                    onApplied={tenderApplied}
                  />
                ) : null}
                {bill.status === 'SETTLED' ? (
                  <ReceiptView billId={bill.id} request={request} />
                ) : null}
                {!['OPEN', 'SETTLED'].includes(bill.status) ? (
                  <p className="text-sm text-text-muted">This bill is not available for tender.</p>
                ) : null}
              </SectionCard>
            ))}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
