'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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

export type TerminalRequest = <T>(path: string, options?: TerminalRequestOptions) => Promise<T>;

type CheckoutSummary = {
  orderId: string;
  settled: boolean;
  blocker: 'NO_BILLS' | 'ITEMS_UNBILLED' | 'BILLS_OPEN' | 'TOTAL_MISMATCH' | null;
  derivedOrderTotal: string;
  accountedTotal: string;
  unbilledItemIds: string[];
  bills: {
    id: string;
    status: string;
    splitKind: string;
    grandTotal: string;
    compTotal: string;
    receiptNumber: number | null;
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
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
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

const blockerLabels: Record<Exclude<CheckoutSummary['blocker'], null>, string> = {
  NO_BILLS: 'No bills have been cut.',
  ITEMS_UNBILLED: 'Some order items are not billed.',
  BILLS_OPEN: 'Payment is still due on one or more bills.',
  TOTAL_MISMATCH: 'Bill totals do not match the order total.',
};

export function CheckoutPanel({ open, orderId, request, onClose }: CheckoutPanelProps) {
  const [summary, setSummary] = useState<CheckoutSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tenderPending, setTenderPending] = useState(false);
  const [remainingDueByBill, setRemainingDueByBill] = useState<Record<string, string>>({});

  const fetchSummary = useCallback(
    () =>
      orderId
        ? request<CheckoutSummary>(
            `/api/restaurant/checkout/summary?orderId=${encodeURIComponent(orderId)}`
          )
        : Promise.reject(new Error('An order is required for checkout.')),
    [orderId, request]
  );

  const loadSummary = useCallback(async () => {
    if (!open || !orderId) return;
    setLoading(true);
    setPermissionDenied(false);
    setError(null);
    try {
      setSummary(await fetchSummary());
    } catch (requestError) {
      const details = errorDetails(requestError);
      setSummary(null);
      setPermissionDenied(details.status === 403);
      setError(details.message);
    } finally {
      setLoading(false);
    }
  }, [fetchSummary, open, orderId]);

  useEffect(() => {
    if (!open || !orderId) return;
    let active = true;
    void fetchSummary()
      .then((next) => {
        if (!active) return;
        setSummary(next);
        setPermissionDenied(false);
        setError(null);
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        const details = errorDetails(requestError);
        setSummary(null);
        setPermissionDenied(details.status === 403);
        setError(details.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fetchSummary, open, orderId]);

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

  async function tenderApplied(result: TenderResult) {
    setRemainingDueByBill((current) => ({
      ...current,
      [result.billId]: result.remainingDue,
    }));
    if (result.settled) await loadSummary();
  }

  function closePanel() {
    setSummary(null);
    setError(null);
    setLoading(true);
    onClose();
  }

  const dismissBlocked = busy || tenderPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !dismissBlocked) closePanel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-4xl"
      >
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
              <Button
                type="button"
                variant="outline"
                onClick={() => void loadSummary()}
                className="h-11"
              >
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
                  {blockerLabels[summary.blocker]}
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
                title={
                  bill.receiptNumber !== null
                    ? `Receipt ${bill.receiptNumber}`
                    : bill.splitKind.replaceAll('_', ' ')
                }
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
                    amountDue={remainingDueByBill[bill.id]}
                    request={request}
                    disabled={busy}
                    onApplied={tenderApplied}
                    onPendingChange={setTenderPending}
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
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={closePanel}
            disabled={dismissBlocked}
            className="h-11"
          >
            Close checkout
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
