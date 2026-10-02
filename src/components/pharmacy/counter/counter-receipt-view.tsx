'use client';

import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import {
  buildCounterBrowserReceipt,
  printCounterBrowserReceipt,
  type CounterBrowserPrintReservation,
  type CounterReceiptFormat,
} from '@/lib/pharmacy/counter-browser-print';
import {
  COUNTER_RECEIPT_DIRECTION,
  COUNTER_RECEIPT_STRINGS,
  formatMinor,
  formatReceiptDate,
  receiptTitle,
  type CounterReceipt,
  type CounterReceiptLocale,
} from '@/lib/pharmacy/counter-receipt';

import {
  buildCounterReceiptPreview,
  counterLinePresentation,
} from '@/lib/pharmacy/counter-receipt-presentation';

export type CounterReceiptSettlement =
  | { status: 'pending' | 'unknown' }
  | {
      status: 'confirmed';
      saleId: string;
      receiptNumber: number;
      autoPrint: boolean;
      printReservation?: CounterBrowserPrintReservation;
    };

export type CounterReceiptPresentationResult = {
  saleId: string;
  receiptNumber: number;
  printStatus: 'manual' | 'dialog-requested' | 'manual-required';
};

export type CounterReceiptViewProps = {
  receipt: CounterReceipt | null;
  state: 'idle' | 'loading' | 'ready' | 'error';
  locale: CounterReceiptLocale;
  format: CounterReceiptFormat;
  /** True once this receipt has been rendered at least once in this session. */
  reprint: boolean;
  printing?: boolean;
  error?: string | null;
  onLocaleChange: (locale: CounterReceiptLocale) => void;
  onFormatChange: (format: CounterReceiptFormat) => void;
  onPrint: () => void;
  onRetry: () => void;
  /** Only a newly settled, authoritatively read sale; never a historical load. */
  settlement?: CounterReceiptSettlement | null;
  /** Clear the event here; keep this view mounted across bills to retain deduplication. */
  onSettlementPresented?: (result: CounterReceiptPresentationResult) => void;
};

/** Receipt browser preview; requesting a print never confirms paper delivery. */
export function CounterReceiptView({
  receipt,
  state,
  locale,
  format,
  reprint,
  printing = false,
  error,
  onLocaleChange,
  onFormatChange,
  onPrint,
  onRetry,
  settlement,
  onSettlementPresented,
}: CounterReceiptViewProps) {
  const receiptRegion = useRef<HTMLElement>(null);
  const presentedReceipts = useRef(new Set<string>());
  const [presentation, setPresentation] = useState<
    (CounterReceiptPresentationResult & { message: string }) | null
  >(null);

  useEffect(() => {
    if (
      settlement?.status !== 'confirmed' ||
      state !== 'ready' ||
      printing ||
      !receipt ||
      receipt.saleId !== settlement.saleId ||
      receipt.receiptNumber !== settlement.receiptNumber
    )
      return;

    // Rendering issued data is not itself proof of a new settlement. The caller
    // supplies that explicit event only after authoritative bill/receipt reads.
    const key = JSON.stringify([receipt.saleId, receipt.receiptNumber]);
    if (presentedReceipts.current.has(key)) return;
    try {
      buildCounterBrowserReceipt(receipt, locale, format);
    } catch {
      return;
    }
    // Consume before callbacks/printing so StrictMode and rerenders cannot replay.
    presentedReceipts.current.add(key);
    receiptRegion.current?.focus({ preventScroll: true });
    receiptRegion.current?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });

    let printStatus: CounterReceiptPresentationResult['printStatus'] = 'manual';
    let message = 'Receipt ready. Use Print receipt to open the browser print dialog.';
    if (settlement.autoPrint) {
      try {
        printCounterBrowserReceipt(receipt, locale, format, false, settlement.printReservation);
        printStatus = 'dialog-requested';
        message = 'Browser print dialog requested. Physical printing is not confirmed.';
      } catch (error) {
        printStatus = 'manual-required';
        message =
          error instanceof Error
            ? error.message
            : 'The browser print dialog could not open. Retry Print receipt.';
      }
    } else {
      settlement.printReservation?.cancel();
    }
    const result = { saleId: receipt.saleId, receiptNumber: settlement.receiptNumber, printStatus };
    // This result comes from the imperative browser print attempt, not derived props.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Surface the external popup result for manual recovery.
    setPresentation({ ...result, message });
    onSettlementPresented?.(result);
  }, [receipt, state, printing, settlement, locale, format, onSettlementPresented]);

  if (state === 'idle') {
    return <p className="text-sm text-text-muted">Settle the bill to render its receipt.</p>;
  }

  if (state === 'loading') {
    return (
      <p className="text-sm text-text-muted" role="status">
        Loading receipt…
      </p>
    );
  }

  if (state === 'error' || receipt === null) {
    return (
      <div className="space-y-2" role="alert">
        <p className="text-sm text-destructive">{error ?? 'The receipt could not be loaded.'}</p>
        <Button type="button" variant="outline" className="h-11" onClick={onRetry}>
          Retry receipt
        </Button>
      </div>
    );
  }

  const strings = COUNTER_RECEIPT_STRINGS[locale];
  const direction = COUNTER_RECEIPT_DIRECTION[locale];
  const language = locale === 'ur' ? 'ur-PK' : 'en';

  let document: string | null = null;
  let documentError: string | null = null;
  try {
    document = buildCounterReceiptPreview(
      receipt,
      locale,
      format === 'THERMAL_58' ? 58 : 80,
      reprint
    );
  } catch {
    documentError =
      'This receipt cannot be previewed. Reload it or ask support to check its source data.';
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="receipt-locale">Language</Label>
          <select
            id="receipt-locale"
            value={locale}
            disabled={printing}
            onChange={(event) => onLocaleChange(event.target.value as CounterReceiptLocale)}
            className="h-11 rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <option value="en">English</option>
            <option value="ur">اردو</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="receipt-format">Format</Label>
          <select
            id="receipt-format"
            value={format}
            disabled={printing}
            onChange={(event) => onFormatChange(event.target.value as CounterReceiptFormat)}
            className="h-11 rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <option value="THERMAL">Thermal · 80 mm</option>
            <option value="THERMAL_58">Thermal · 58 mm</option>
            <option value="A4">A4</option>
          </select>
        </div>
        <Button
          type="button"
          className="h-11"
          disabled={
            printing || document === null || receipt.receiptNumber === null || !receipt.completedAt
          }
          onClick={onPrint}
        >
          {printing ? 'Loading receipt…' : reprint ? 'Reprint receipt' : 'Print receipt'}
        </Button>
        {receipt.receiptNumber === null ? (
          <StatusPill status="unissued" tone="warning" label={strings.unissued} />
        ) : reprint ? (
          <StatusPill status="reprint" tone="info" label={strings.reprint} />
        ) : (
          <StatusPill status="settled" tone="success" label={`#${receipt.receiptNumber}`} />
        )}
      </div>

      <p className="text-sm text-text-muted">
        Browser / OS print fallback: allow pop-ups, then select your printer and matching paper size
        in the print dialog. These paper choices apply to this session; saved designer settings are
        not connected yet. Printing cannot be confirmed here.
      </p>

      {presentation?.saleId === receipt.saleId &&
      presentation.receiptNumber === receipt.receiptNumber ? (
        <p
          role={presentation.printStatus === 'manual-required' ? 'alert' : 'status'}
          className="text-sm text-text-muted"
        >
          {presentation.message}
        </p>
      ) : null}

      {documentError ? (
        <p className="text-sm text-destructive" role="alert">
          {documentError}
        </p>
      ) : null}

      <section
        ref={receiptRegion}
        tabIndex={-1}
        aria-label={receiptTitle(receipt, locale)}
        lang={language}
        dir={direction}
        className={`space-y-4 rounded-lg border border-border-subtle bg-surface-card p-5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${
          format === 'THERMAL_58'
            ? 'max-w-[16rem] font-mono text-xs'
            : format === 'THERMAL'
              ? 'max-w-[22rem] font-mono text-xs'
              : 'text-sm'
        }`}
      >
        <header className="space-y-1 border-b border-border-subtle pb-3">
          <p className="text-base font-semibold text-text-strong">
            {receiptTitle(receipt, locale)}
          </p>
          <p className="text-text-muted">
            {strings.branch}: {receipt.branchName}
          </p>
          <p className="text-text-muted">
            {strings.date}: {receipt.businessDate ?? formatReceiptDate(receipt.completedAt)}
          </p>
          {receipt.receiptNumber === null ? (
            <p className="text-warning">{strings.noReceiptNumber}</p>
          ) : null}
          {reprint ? <p className="text-text-muted">{strings.reprint}</p> : null}
        </header>

        <ul className="divide-y divide-border-subtle">
          {receipt.lines.map((line) => (
            <li key={line.saleLineId} className="space-y-0.5 py-2">
              <div className="flex justify-between gap-3">
                <span className="min-w-0 break-words text-text-strong">
                  {counterLinePresentation(line, locale).identity}
                </span>
                <span className="shrink-0 tabular-nums text-text-strong">
                  {formatMinor(line.lineTotalMinor)}
                </span>
              </div>
              <p className="text-text-muted">
                {line.quantity} {strings.saleUnit[line.saleUnit]} ×{' '}
                {formatMinor(line.unitPriceMinor)}
              </p>
              {counterLinePresentation(line, locale).allocations.map((allocation, index) => (
                <p
                  key={line.allocations![index]!.allocationId}
                  className="whitespace-pre-wrap break-words tabular-nums text-text-muted"
                >
                  {allocation}
                </p>
              ))}
            </li>
          ))}
        </ul>

        <dl className="space-y-1 border-t border-border-subtle pt-3">
          {(
            [
              [strings.gross, receipt.totals.grossMinor],
              [strings.discount, receipt.totals.discountMinor],
              [strings.net, receipt.totals.netMinor],
              [strings.tendered, receipt.totals.tenderedMinor],
              [strings.change, receipt.totals.changeMinor],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3">
              <dt className="text-text-muted">{label}</dt>
              <dd className="tabular-nums text-text-strong">{formatMinor(value)}</dd>
            </div>
          ))}
        </dl>

        {receipt.tenders.length > 0 ? (
          <div className="space-y-1 border-t border-border-subtle pt-3">
            <p className="text-text-muted">{strings.tenders}</p>
            {receipt.tenders.map((tender) => (
              <div key={tender.tenderId} className="flex justify-between gap-3">
                <span className="text-text-strong">{tender.type}</span>
                <span className="tabular-nums text-text-strong">
                  {formatMinor(tender.amountMinor)}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {document ? (
        <details className="rounded-md border border-border-subtle p-3">
          <summary className="cursor-pointer text-sm font-semibold text-text-strong">
            Shared browser receipt preview (not queued)
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-text-body">
            {document}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
