'use client';
import { receiptTierLines } from '@/lib/pharmacy/counter-receipt';

import { useEffect, useRef, useState } from 'react';

import { buildDispensingLabels, type DispensingLabelSource } from '@/lib/pharmacy/dispensing-label';
import type { CounterEvidenceView } from '@/lib/pharmacy/counter-evidence';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  formatReceiptIssuedAt,
  receiptCashReceived,
  receiptPromotionLabel,
  receiptTitle,
  type CounterReceipt,
  type CounterReceiptLocale,
} from '@/lib/pharmacy/counter-receipt';

import {
  buildCounterReceiptPreview,
  counterLinePresentation,
  counterLinePricing,
  receiptCashReceivedLabel,
} from '@/lib/pharmacy/counter-receipt-presentation';

import { CounterThermalPrint } from './counter-thermal-print';

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

/** DEV-16: what the counter reports after asking the server to send a WhatsApp receipt. */
export type CounterWhatsAppReceiptResult = { ok: boolean; message: string };

export type CounterReceiptViewProps = {
  receipt: CounterReceipt | null;
  state: 'idle' | 'loading' | 'ready' | 'error';
  locale: CounterReceiptLocale;
  format: CounterReceiptFormat;
  /** Marker returned by the server for the most recently allocated browser copy. */
  reprint: boolean;
  printing?: boolean;
  evidence?: readonly CounterEvidenceView[] | null;
  /** The owner-only evidence read failed; cached stills are already withheld. */
  evidenceError?: boolean;
  evidenceRefreshing?: boolean;
  onEvidenceRefresh?: () => void;
  /** Authorized, receipt-bound Rx data; absent until the receipt API supplies it. */
  dispensingLabelSources?: readonly DispensingLabelSource[];
  error?: string | null;
  onLocaleChange: (locale: CounterReceiptLocale) => void;
  onFormatChange: (format: CounterReceiptFormat) => void;
  onPrint: (reservation?: CounterBrowserPrintReservation) => Promise<boolean>;
  onRetry: () => void;
  /** Only a newly settled, authoritatively read sale; never a historical load. */
  branchId?: string;
  settlement?: CounterReceiptSettlement | null;
  /** Clear the event here; keep this view mounted across bills to retain deduplication. */
  onSettlementPresented?: (result: CounterReceiptPresentationResult) => void;
  /** DEV-16: send the settled receipt's neutral WhatsApp link, on the customer's request. */
  onSendWhatsApp?: (saleId: string) => Promise<CounterWhatsAppReceiptResult>;
};

/**
 * DEV-16: the cashier confirms the customer asked for a WhatsApp receipt, then
 * sends it. The server enforces opt-in, the phone on file and neutral text.
 */
function CounterWhatsAppReceipt({
  saleId,
  onSend,
}: {
  saleId: string;
  onSend: (saleId: string) => Promise<CounterWhatsAppReceiptResult>;
}) {
  const [requested, setRequested] = useState<{ saleId: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<(CounterWhatsAppReceiptResult & { saleId: string }) | null>(
    null
  );
  const confirmed = requested?.saleId === saleId;
  const shown = result?.saleId === saleId ? result : null;

  async function send() {
    setSending(true);
    try {
      setResult({ saleId, ...(await onSend(saleId)) });
    } catch {
      setResult({ saleId, ok: false, message: 'The WhatsApp receipt could not be sent. Retry.' });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-border-subtle bg-surface-sunken p-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-h-11 items-center gap-2 text-sm text-text-body">
          <Checkbox
            checked={confirmed}
            disabled={sending}
            onCheckedChange={(checked) => setRequested(checked ? { saleId } : null)}
          />
          Customer asked for a WhatsApp receipt
        </label>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={!confirmed || sending}
          onClick={() => void send()}
        >
          {sending ? 'Sending WhatsApp receipt…' : 'Send WhatsApp receipt'}
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        The message shows only the branch, receipt number, total, payment method and a secure link.
      </p>
      {shown ? (
        <p
          role={shown.ok ? 'status' : 'alert'}
          className={shown.ok ? 'text-sm text-text-muted' : 'text-sm text-destructive'}
        >
          {shown.message}
        </p>
      ) : null}
    </div>
  );
}

const EVIDENCE_KIND: Record<CounterEvidenceView['kind'], string> = {
  TENDER: 'Tender',
  REFUND: 'Refund',
  DAILY_CLOSE: 'Day close',
};

const EVIDENCE_STATUS: Record<CounterEvidenceView['status'], string> = {
  PENDING: 'Still pending capture.',
  CAPTURED: 'Still no longer in storage.',
  FAILED: 'No still was captured.',
  PURGED: 'Still removed under the camera retention period.',
};

function evidenceTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

/** Operator-only evidence stills; kept outside the receipt document on purpose. */
function CounterReceiptEvidence({
  evidence,
  error = false,
  refreshing = false,
  onRefresh,
}: {
  evidence: readonly CounterEvidenceView[];
  error?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const pending = evidence.some((item) => item.status === 'PENDING');
  return (
    <section
      aria-label="Camera evidence"
      className="space-y-2 rounded-md border border-border-subtle p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-text-strong">Camera evidence</p>
        {onRefresh && (error || pending) ? (
          <Button
            size="touch"
            type="button"
            variant="secondary"
            disabled={refreshing}
            onClick={onRefresh}
          >
            {refreshing ? 'Refreshing evidence…' : 'Refresh evidence'}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-text-muted">
          Camera evidence could not be loaded. Your access may have changed; no stills are shown.
        </p>
      ) : null}
      <ul className="grid gap-3 sm:grid-cols-2">
        {evidence.map((item) => (
          <li key={item.id} className="space-y-1">
            <p className="text-sm text-text-strong">{EVIDENCE_KIND[item.kind]}</p>
            {item.image ? (
              // A private data: URL from the branch-scoped read; nothing to optimise.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.image}
                alt={`Camera still at ${EVIDENCE_KIND[item.kind].toLowerCase()}, ${evidenceTime(item.capturedAt)}`}
                className="w-full rounded border border-border-subtle"
              />
            ) : (
              <p className="text-sm text-text-muted">{EVIDENCE_STATUS[item.status]}</p>
            )}
            <p className="text-xs text-text-muted">
              {item.capturedAt
                ? `Captured ${evidenceTime(item.capturedAt)}`
                : `Requested ${evidenceTime(item.requestedAt)}`}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Receipt browser preview; requesting a print never confirms paper delivery. */
export function CounterReceiptView({
  receipt,
  state,
  locale,
  format,
  reprint,
  printing = false,
  evidence,
  evidenceError = false,
  evidenceRefreshing = false,
  onEvidenceRefresh,
  dispensingLabelSources = receipt?.dispensingLabelSources ?? [],
  error,
  onLocaleChange,
  onFormatChange,
  onPrint,
  onRetry,
  branchId,
  settlement,
  onSettlementPresented,
  onSendWhatsApp,
}: CounterReceiptViewProps) {
  const [labelError, setLabelError] = useState<{ saleId: string; message: string } | null>(null);
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

    if (!settlement.autoPrint) {
      settlement.printReservation?.cancel();
      const result = {
        saleId: receipt.saleId,
        receiptNumber: settlement.receiptNumber,
        printStatus: 'manual' as const,
      };
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Surface this one-shot settlement event.
      setPresentation({
        ...result,
        message: 'Receipt ready. Use Print receipt to open the browser print dialog.',
      });
      onSettlementPresented?.(result);
      return;
    }
    void onPrint(settlement.printReservation).then((printed) => {
      const result = {
        saleId: receipt.saleId,
        receiptNumber: settlement.receiptNumber,
        printStatus: printed ? ('dialog-requested' as const) : ('manual-required' as const),
      };
      setPresentation({
        ...result,
        message: printed
          ? 'Browser print dialog requested. Physical printing is not confirmed.'
          : 'The browser print dialog could not open. Retry Print receipt.',
      });
      onSettlementPresented?.(result);
    });
  }, [receipt, state, printing, settlement, locale, format, onPrint, onSettlementPresented]);

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
  let cashReceived: number | null = null;
  try {
    cashReceived = receiptCashReceived(receipt.tenders);
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

  const settled = receipt.receiptNumber !== null && Boolean(receipt.completedAt);
  return (
    <div className="space-y-4">
      {settled && document !== null ? (
        <div
          role="status"
          lang={language}
          dir={direction}
          className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border-subtle bg-success/10 p-4"
        >
          <div className="space-y-2">
            <StatusPill status="settled" tone="success" label={receiptTitle(receipt, locale)} />
            <h3 className="text-xl font-semibold tracking-tight text-text-strong">
              {locale === 'ur' ? 'ادائیگی درج ہو گئی' : 'Payment recorded'}
            </h3>
            <p className="text-sm text-text-muted">
              {receipt.branchName} ·{' '}
              {receipt.businessDate ?? formatReceiptDate(receipt.completedAt)}
            </p>
          </div>
          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            <div>
              <dt className="font-mono text-xs text-text-muted">{strings.net}</dt>
              <dd className="text-2xl font-semibold tabular-nums text-text-strong">
                {receipt.currency} {formatMinor(receipt.totals.netMinor, locale)}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-xs text-text-muted">{strings.change}</dt>
              <dd className="text-2xl font-semibold tabular-nums text-text-strong">
                {receipt.currency} {formatMinor(receipt.totals.changeMinor, locale)}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}

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
          onClick={() => void onPrint()}
        >
          {printing ? 'Loading receipt…' : reprint ? 'Reprint receipt' : 'Print receipt'}
        </Button>
        {receipt.receiptNumber === null ? (
          <StatusPill
            status="unissued"
            tone="warning"
            label={<span className="text-text-strong">{strings.unissued}</span>}
          />
        ) : reprint ? (
          <StatusPill status="reprint" tone="info" label={strings.reprint} />
        ) : (
          <StatusPill status="settled" tone="success" label={`#${receipt.receiptNumber}`} />
        )}
      </div>

      {branchId && settled ? (
        <CounterThermalPrint
          key={receipt.saleId}
          branchId={branchId}
          saleId={receipt.saleId}
          locale={locale}
          format={format}
          disabled={printing}
        />
      ) : null}

      {onSendWhatsApp && settled ? (
        <CounterWhatsAppReceipt saleId={receipt.saleId} onSend={onSendWhatsApp} />
      ) : null}

      {labelError?.saleId === receipt.saleId ? (
        <p role="alert" className="text-sm text-destructive">
          {labelError.message}
        </p>
      ) : null}
      <p className="text-sm text-text-muted">
        Browser / OS print: allow pop-ups, then select your printer and matching paper size in the
        print dialog. The format starts on this branch&apos;s saved printer settings; a change here
        applies to this session only. Printing cannot be confirmed here.
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

      <h3 className="font-mono text-xs uppercase tracking-wider text-text-muted">
        {locale === 'ur' ? 'رسید کا پیش منظر' : 'Receipt preview'}
      </h3>
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
          <h4 className="text-base font-semibold text-text-strong">
            {receiptTitle(receipt, locale)}
          </h4>
          <p className="text-text-muted">
            {strings.branch}: {receipt.branchName}
          </p>
          <p className="text-text-muted">
            {strings.date}:{' '}
            {receipt.completedAt
              ? formatReceiptIssuedAt(receipt.completedAt)
              : (receipt.businessDate ?? formatReceiptDate(receipt.completedAt))}
          </p>
          {receipt.cashierName ? (
            <p className="text-text-muted">
              {strings.cashier}: {receipt.cashierName}
            </p>
          ) : null}
          {receipt.receiptNumber === null ? (
            <p className="text-warning">{strings.noReceiptNumber}</p>
          ) : null}
          {reprint ? <p className="text-text-muted">{strings.reprint}</p> : null}
        </header>

        <ul className="divide-y divide-border-subtle">
          {receipt.lines.map((line) => {
            const lineSources = dispensingLabelSources.filter(
              (source) => source.saleLineId === line.saleLineId
            );
            let labelUnavailable: string | null = null;
            try {
              buildDispensingLabels(receipt, lineSources);
            } catch (error) {
              labelUnavailable =
                error instanceof Error ? error.message : 'Rx label source unavailable.';
            }
            return (
              <li key={line.saleLineId} className="space-y-0.5 py-2">
                <div className="flex justify-between gap-3">
                  <span className="min-w-0 break-words text-text-strong">
                    {counterLinePresentation(line, locale).identity}
                  </span>
                  <span className="shrink-0 tabular-nums text-text-strong">
                    {formatMinor(line.lineTotalMinor, locale)}
                  </span>
                </div>
                <p className="text-text-muted">{counterLinePricing(line, locale)}</p>
                {receiptPromotionLabel(line, locale) ? (
                  <p className="break-words tabular-nums text-text-muted">
                    {receiptPromotionLabel(line, locale)}
                  </p>
                ) : null}
                {counterLinePresentation(line, locale).allocations.map((allocation, index) => (
                  <p
                    key={line.allocations![index]!.allocationId}
                    className="whitespace-pre-wrap break-words tabular-nums text-text-muted"
                  >
                    {allocation}
                  </p>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto min-h-11 max-w-full whitespace-normal py-2"
                  disabled={printing || document === null || labelUnavailable !== null}
                  aria-describedby={`rx-label-${line.saleLineId}`}
                  onClick={() => {
                    setLabelError(null);
                    try {
                      printCounterBrowserReceipt(
                        receipt,
                        locale,
                        'LABEL_50x30',
                        reprint,
                        undefined,
                        lineSources
                      );
                    } catch (error) {
                      setLabelError({
                        saleId: receipt.saleId,
                        message:
                          error instanceof Error ? error.message : 'Rx label printing failed.',
                      });
                    }
                  }}
                >
                  Print Rx labels · 50 × 30 mm
                </Button>
                <p id={`rx-label-${line.saleLineId}`} className="text-text-muted">
                  {labelUnavailable ??
                    'English / Urdu · 50 × 30 mm, 100% scale, no browser headers or footers.'}
                </p>
              </li>
            );
          })}
        </ul>

        {receiptTierLines(receipt, locale).map((text) => (
          <p key={text} className="text-sm">
            {text}
          </p>
        ))}
        <dl className="space-y-1 border-t border-border-subtle pt-3">
          {(
            [
              [strings.gross, receipt.totals.grossMinor],
              [strings.discount, receipt.totals.discountMinor],
              [strings.net, receipt.totals.netMinor],
              [strings.tendered, receipt.totals.tenderedMinor],
              ...(cashReceived !== null
                ? [[receiptCashReceivedLabel(locale), cashReceived] as const]
                : []),
              [strings.change, receipt.totals.changeMinor],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3">
              <dt className="text-text-muted">{label}</dt>
              <dd className="tabular-nums text-text-strong">{formatMinor(value, locale)}</dd>
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
                  {formatMinor(tender.amountMinor, locale)}
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
      {evidenceError || (evidence && evidence.length > 0) ? (
        <CounterReceiptEvidence
          evidence={evidenceError ? [] : (evidence ?? [])}
          error={evidenceError}
          refreshing={evidenceRefreshing}
          onRefresh={onEvidenceRefresh}
        />
      ) : null}
    </div>
  );
}
