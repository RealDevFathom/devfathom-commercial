'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';

import type { TerminalRequest } from './checkout-panel';
import { ReceiptPrintControls, type ReceiptPrinting } from './receipt-print-controls';

export type Receipt = {
  billId: string;
  orderNumber: number;
  channel: string;
  branchName: string;
  businessDate: string;
  receiptNumber: number | null;
  settledAt: string;
  splitKind: string;
  printing?: ReceiptPrinting;
  lines: {
    id: string;
    name: string;
    quantity: number;
    unitPrice: string;
    lineSubtotal: string;
    compAmount: string;
    lineTotal: string;
  }[];
  tenders: {
    id: string;
    type: string;
    amount: string;
    tipAmount: string;
    changeGiven: string | null;
  }[];
  totals: {
    subtotal: string;
    taxTotal: string;
    serviceChargeTotal: string;
    deliveryFeeTotal: string;
    compTotal: string;
    discountTotal: string;
    roundingAdjustment: string;
    grandTotal: string;
  };
};

type ReceiptViewProps = {
  billId: string;
  request: TerminalRequest;
};

function message(error: unknown) {
  return error instanceof Error ? error.message : 'Receipt could not be loaded.';
}

export function ReceiptView({ billId, request }: ReceiptViewProps) {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReceipt = useCallback(
    () => request<Receipt>(`/api/restaurant/checkout/receipt?billId=${encodeURIComponent(billId)}`),
    [billId, request]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReceipt(await fetchReceipt());
    } catch (requestError) {
      setReceipt(null);
      setError(message(requestError));
    } finally {
      setLoading(false);
    }
  }, [fetchReceipt]);

  useEffect(() => {
    let active = true;
    void fetchReceipt()
      .then((next) => {
        if (!active) return;
        setReceipt(next);
        setError(null);
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        setReceipt(null);
        setError(message(requestError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fetchReceipt]);

  if (loading || (receipt && receipt.billId !== billId)) {
    return <p className="text-sm text-text-muted">Loading settled receipt…</p>;
  }

  if (error || !receipt) {
    return (
      <div className="space-y-2" role="alert">
        <p className="text-sm text-destructive">{error ?? 'Receipt is unavailable.'}</p>
        <Button type="button" variant="outline" onClick={() => void load()} className="h-11">
          Retry receipt
        </Button>
      </div>
    );
  }

  const receiptLabel =
    receipt.receiptNumber === null ? 'Receipt unissued' : `Receipt ${receipt.receiptNumber}`;

  return (
    <section aria-label={receiptLabel} className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle pb-3">
        <div>
          <p className="font-mono text-xs tracking-wide text-text-muted uppercase">
            {receiptLabel}
          </p>
          <p className="mt-1 text-sm text-text-strong">
            {receipt.branchName} · Order {receipt.orderNumber}
          </p>
          <p className="text-xs text-text-muted">
            {receipt.businessDate} · {receipt.channel.replaceAll('_', ' ')}
          </p>
        </div>
        <StatusPill status="settled" tone="success" />
      </div>

      <ul className="divide-y divide-border-subtle">
        {receipt.lines.map((line) => (
          <li key={line.id} className="flex items-start justify-between gap-3 py-2 text-sm">
            <span className="min-w-0 text-text-strong">
              {line.quantity} × {line.name}
              {line.compAmount !== '0' && line.compAmount !== '0.00' ? (
                <span className="block text-xs text-text-muted">Comp {line.compAmount}</span>
              ) : null}
            </span>
            <span className="shrink-0 font-mono tabular-nums text-text-strong">
              {line.lineTotal}
            </span>
          </li>
        ))}
      </ul>

      <dl className="space-y-1 border-y border-border-subtle py-3 text-sm">
        {[
          ['Subtotal', receipt.totals.subtotal],
          ['Delivery fee', receipt.totals.deliveryFeeTotal],
          ['Service charge', receipt.totals.serviceChargeTotal],
          ['Tax', receipt.totals.taxTotal],
          ['Comp', receipt.totals.compTotal],
          ['Discount', receipt.totals.discountTotal],
          ['Rounding', receipt.totals.roundingAdjustment],
          ['Total', receipt.totals.grandTotal],
        ].map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt className="text-text-muted">{label}</dt>
            <dd className="font-mono tabular-nums text-text-strong">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="space-y-2">
        <p className="font-mono text-xs tracking-wide text-text-muted uppercase">Tenders</p>
        {receipt.tenders.map((tender) => (
          <div
            key={tender.id}
            className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-lg bg-surface-sunken p-3 text-sm"
          >
            <span className="text-text-strong">{tender.type}</span>
            <span className="font-mono tabular-nums text-text-strong">{tender.amount}</span>
            {tender.tipAmount !== '0' && tender.tipAmount !== '0.00' ? (
              <>
                <span className="text-text-muted">Tip</span>
                <span className="font-mono tabular-nums text-text-muted">{tender.tipAmount}</span>
              </>
            ) : null}
            {tender.changeGiven !== null ? (
              <>
                <span className="text-text-muted">Change</span>
                <span className="font-mono tabular-nums text-text-muted">{tender.changeGiven}</span>
              </>
            ) : null}
          </div>
        ))}
      </div>
      {receipt.printing ? (
        <ReceiptPrintControls
          key={receipt.billId}
          receipt={receipt}
          request={request}
          initial={receipt.printing}
        />
      ) : null}
    </section>
  );
}
