'use client';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import type { CounterReceiptFormat } from '@/lib/pharmacy/counter-browser-print';
import {
  buildCounterReceiptDocument,
  COUNTER_RECEIPT_DIRECTION,
  COUNTER_RECEIPT_STRINGS,
  formatMinor,
  formatReceiptDate,
  receiptTitle,
  type CounterReceipt,
  type CounterReceiptLocale,
} from '@/lib/pharmacy/counter-receipt';

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
};

/**
 * POS-08 — the receipt, in both formats and both languages.
 *
 * The thermal preview is the exact `RECEIPT` document that goes to the printing
 * seam, rendered as text. Showing the real document rather than a lookalike is
 * what makes "what printed" and "what was on screen" the same artifact.
 *
 * Reprinting re-renders; it never re-settles. The receipt number is whatever
 * the settling tender issued, and an unsettled bill says so instead of showing
 * a number it does not have.
 */
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
}: CounterReceiptViewProps) {
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

  let document: ReturnType<typeof buildCounterReceiptDocument> | null = null;
  let documentError: string | null = null;
  try {
    document = buildCounterReceiptDocument(receipt, locale, { reprint });
  } catch {
    documentError =
      'This bill cannot be rendered as a print document. Check that it has at least one line.';
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
          disabled={printing || document === null || receipt.receiptNumber === null}
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

      {documentError ? (
        <p className="text-sm text-destructive" role="alert">
          {documentError}
        </p>
      ) : null}

      <section
        aria-label={receiptTitle(receipt, locale)}
        lang={language}
        dir={direction}
        className={`space-y-4 rounded-lg border border-border-subtle bg-surface-card p-5 ${
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
                <span className="min-w-0 text-text-strong">
                  {line.medicineName}
                  {line.strength ? ` ${line.strength}` : ''}
                </span>
                <span className="shrink-0 tabular-nums text-text-strong">
                  {formatMinor(line.lineTotalMinor)}
                </span>
              </div>
              <p className="text-text-muted">
                {line.presentation} · {line.quantity} {strings.saleUnit[line.saleUnit]} ×{' '}
                {formatMinor(line.unitPriceMinor)}
              </p>
              <p className="tabular-nums text-text-muted">
                {strings.batch}: {line.batchNumber} · {strings.expiry}:{' '}
                {formatReceiptDate(line.expiresAt)}
              </p>
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
            Shared protocol document preview (not queued)
          </summary>
          <pre className="mt-2 overflow-x-auto font-mono text-xs text-text-body">
            {[
              `${document.type} ${document.reference}`,
              document.title,
              ...document.lines.map((line) => `${line.quantity} × ${line.label}`),
              document.footer ?? '',
            ]
              .filter(Boolean)
              .join('\n')}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
