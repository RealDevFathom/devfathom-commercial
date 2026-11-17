'use client';

import { FileText, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import type {
  InvoiceCaptureProposal,
  InvoiceLineWarningCode,
  InvoiceProposalLine,
  InvoiceWarningCode,
  PriceCheck,
} from '@/lib/pharmacy/invoice-capture';
import { minorToRupees } from '@/lib/pharmacy/pack-photo-receiving';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { CONTROL } from './form-controls';
import { base64Of, preparedPhoto } from './pack-photo-reader';
import { REVEAL_LINES_EVENT } from './progressive-lines';

/** Matches the server's bounded-file limit. */
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

export type InvoiceCaptureReaderProps = {
  branchId: string;
  /** How many line slots the form below holds. */
  lineSlots: number;
  /** Form control names the reviewed values are copied into. */
  names: {
    supplier: string;
    invoiceRef: string;
    invoiceDate: string;
    /** `${packPrefix}${index}` is the medicine-and-pack select of a line. */
    packPrefix: string;
    /** `${field}:${linePrefix}${index}` are a line's capture fields. */
    linePrefix: string;
  };
};

const INVOICE_WARNINGS: Readonly<Record<InvoiceWarningCode, string>> = {
  DUPLICATE_SUPPLIER_INVOICE: 'This bill is already filed as a receipt.',
  SUPPLIER_NOT_MATCHED:
    'The distributor is not one supplier in your register. Choose the supplier on the form.',
  INVOICE_NUMBER_UNREADABLE: 'The invoice number could not be read. Type it from the bill.',
  INVOICE_DATE_UNREADABLE:
    'The invoice date could not be read as one clear day. Type it from the bill.',
  NO_LINES: 'No product lines could be read. Enter the lines by hand.',
};

const LINE_WARNINGS: Readonly<Record<InvoiceLineWarningCode, string>> = {
  MEDICINE_NOT_MATCHED: 'Not matched to one medicine in your register: choose it on the line.',
  PACK_NOT_MATCHED: 'Pack level not clear: choose it on the line.',
  BATCH_UNREADABLE: 'Batch not readable.',
  EXPIRY_UNREADABLE: 'Expiry not readable as one date.',
  EXPIRY_AMBIGUOUS: 'Expiry can be read two ways: type it from the bill.',
  QUANTITY_UNREADABLE: 'Quantity not readable.',
  BONUS_UNREADABLE: 'Bonus or scheme not readable.',
  MRP_UNREADABLE: 'MRP not readable.',
  TRADE_PRICE_UNREADABLE: 'Trade price not readable.',
  MRP_DIFFERS_FROM_LAST_PURCHASE: 'MRP differs from the last purchase.',
  TRADE_PRICE_DIFFERS_FROM_LAST_PURCHASE: 'Trade price differs from the last purchase.',
  TRADE_PRICE_ABOVE_MRP: 'Trade price is above the MRP.',
  NO_EARLIER_PURCHASE: 'No earlier posted purchase of this pack to compare with.',
  LOW_CONFIDENCE: 'Part of this line was hard to read.',
};

const rupees = (minor: number) => `Rs ${minorToRupees(minor)}`;

function percent(bps: number): string {
  const whole = Math.trunc(Math.abs(bps) / 100);
  const fraction = String(Math.abs(bps) % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}

/** "+Rs 12.50 (+3.2%) on Rs 400.00": the server computed every figure. */
function difference(check: PriceCheck): string {
  if (check.differenceMinor === 0) return `same as last (${rupees(check.lastMinor)})`;
  const sign = check.differenceMinor > 0 ? '+' : '−';
  return `${sign}${rupees(Math.abs(check.differenceMinor))} (${sign}${percent(check.differenceBps)}%) on last ${rupees(check.lastMinor)}`;
}

function fill(form: HTMLFormElement, name: string, value: string): boolean {
  const control = form.elements.namedItem(name);
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) return false;
  control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function selectPack(form: HTMLFormElement, name: string, line: InvoiceProposalLine): boolean {
  const control = form.elements.namedItem(name);
  if (!(control instanceof HTMLSelectElement) || !line.medicine || !line.pack) return false;
  const prefix = `${line.medicine.medicineId}|${line.pack.packLevelId}|`;
  const option = [...control.options].find((item) => item.value.startsWith(prefix));
  return option ? fill(form, name, option.value) : false;
}

async function preparedDocument(
  file: File
): Promise<{
  contentType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
  dataBase64: string;
}> {
  if (file.type !== 'application/pdf') return preparedPhoto(file);
  if (file.size === 0 || file.size > MAX_PDF_BYTES) {
    throw new Error('Upload a PDF of at most 5 MiB, or a photo of the invoice.');
  }
  try {
    return { contentType: 'application/pdf', dataBase64: await base64Of(file) };
  } catch {
    throw new Error('The PDF could not be read on this device. Enter the lines by hand.');
  }
}

/**
 * DEV-679: read a distributor invoice (photo or PDF) into a reviewable draft,
 * show where its MRP and trade price differ from the last purchase and whether
 * the bill is already filed, then copy the checked values into the form. Nothing
 * is drafted or posted here: the receipt is filed and posted through the
 * existing actions, and no selling price is changed.
 */
export function InvoiceCaptureReader(props: InvoiceCaptureReaderProps) {
  const id = useId();
  // The reader's own controls belong to an inert form outside the receipt, so
  // Enter cannot draft the receipt and their values are never submitted with it.
  const formId = `${id}-reader`;
  const root = useRef<HTMLDivElement>(null);
  const read = trpc.pharmacyInvoiceCapture.read.useMutation();
  // Each read gets a number; a late answer to a closed or replaced read is ignored.
  const request = useRef(0);
  const [open, setOpen] = useState(false);
  const [proposal, setProposal] = useState<InvoiceCaptureProposal | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);

  function close() {
    request.current += 1;
    setProposal(null);
    setFailure(null);
    setChecked(false);
    setOpen(false);
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    const mine = (request.current += 1);
    setProposal(null);
    setFailure(null);
    setChecked(false);
    setApplied(null);
    try {
      const document = await preparedDocument(file);
      if (mine !== request.current) return;
      const form = root.current?.closest('form');
      const supplierControl = form?.elements.namedItem(props.names.supplier);
      const supplierId =
        supplierControl instanceof HTMLSelectElement && supplierControl.value
          ? supplierControl.value
          : undefined;
      const result = await read.mutateAsync({ branchId: props.branchId, supplierId, document });
      if (mine !== request.current) return;
      setProposal(result);
    } catch (error) {
      if (mine !== request.current) return;
      setFailure(
        error instanceof Error && error.message
          ? error.message
          : 'The invoice could not be read. Enter the lines by hand.'
      );
    }
  }

  function apply() {
    const form = root.current?.closest('form');
    if (!form || !proposal || !checked || proposal.duplicate) return;
    const { names } = props;
    if (proposal.supplier.match) fill(form, names.supplier, proposal.supplier.match.supplierId);
    if (proposal.invoiceNumber.value) fill(form, names.invoiceRef, proposal.invoiceNumber.value);
    if (proposal.invoiceDate.date) fill(form, names.invoiceDate, proposal.invoiceDate.date);

    const lines = proposal.lines.slice(0, props.lineSlots);
    // Mount the line slots the copy needs before filling them.
    form
      .querySelector('[data-progressive-lines]')
      ?.dispatchEvent(new CustomEvent(REVEAL_LINES_EVENT, { detail: { count: lines.length } }));

    const unmatched: number[] = [];
    for (const [slot, line] of lines.entries()) {
      const key = `${names.linePrefix}${slot}`;
      if (!selectPack(form, `${names.packPrefix}${slot}`, line)) unmatched.push(slot + 1);
      if (line.batch.value) fill(form, `batchNumber:${key}`, line.batch.value);
      if (line.expiry.kind === 'read') {
        fill(form, `printedExpiry:${key}`, line.expiry.candidate.date);
        fill(form, `expiryPrecision:${key}`, line.expiry.candidate.precision);
      }
      if (line.printedMrpMinor !== null) {
        fill(form, `printedMrp:${key}`, minorToRupees(line.printedMrpMinor));
      }
      if (line.receivedPacks !== null)
        fill(form, `receivedPacks:${key}`, String(line.receivedPacks));
      if (line.bonusPacks !== null) fill(form, `bonusPacks:${key}`, String(line.bonusPacks));
      if (line.tradePriceMinor !== null) {
        fill(form, `invoicedPrice:${key}`, minorToRupees(line.tradePriceMinor));
      }
      if (line.discountBps !== null) fill(form, `discount:${key}`, percent(line.discountBps));
      if (line.taxBps !== null) fill(form, `tax:${key}`, percent(line.taxBps));
    }

    const skipped = proposal.lines.length - lines.length;
    setApplied(
      [
        `Copied ${lines.length} line${lines.length === 1 ? '' : 's'} into the form.`,
        unmatched.length
          ? `Choose the medicine and pack on line${unmatched.length === 1 ? '' : 's'} ${unmatched.join(', ')}.`
          : '',
        skipped > 0
          ? `The form holds ${props.lineSlots} lines; the last ${skipped} were not copied.`
          : '',
        'Check every line and choose where it is received, then file the direct purchase. Nothing is in stock, and no selling price changes, until a person posts it.',
      ]
        .filter(Boolean)
        .join(' ')
    );
    setProposal(null);
    setChecked(false);
    setOpen(false);
  }

  const liveRegion = (
    <div aria-live="polite" role="status">
      {applied ? <p className="text-sm text-success">{applied}</p> : null}
    </div>
  );

  if (!open) {
    return (
      <div className="space-y-2" ref={root}>
        <Button
          className="h-auto min-h-11 max-w-full py-2 text-left whitespace-normal"
          onClick={() => setOpen(true)}
          size="touch"
          type="button"
          variant="outline"
        >
          <FileText aria-hidden="true" />
          Fill from a distributor invoice (photo or PDF)
        </Button>
        {liveRegion}
      </div>
    );
  }

  return (
    <div className="space-y-2" ref={root}>
      {createPortal(
        <form
          hidden
          id={formId}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        />,
        document.body
      )}
      <div
        aria-labelledby={`${id}-title`}
        className="rounded-[var(--radius-sm)] border border-border-default bg-surface-sunken p-4"
        role="group"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-strong" id={`${id}-title`}>
              Distributor invoice
            </p>
            <p className="text-xs text-text-muted">
              The invoice is read once and not stored. What it suggests is checked by you before
              anything is filed; it never changes a selling price.
            </p>
          </div>
          <Button onClick={close} size="touch" type="button" variant="ghost">
            <X aria-hidden="true" />
            Close
          </Button>
        </div>

        <div className="mt-3 space-y-1">
          <label className="block text-sm font-medium text-text-body" htmlFor={`${id}-file`}>
            Invoice photo or PDF
          </label>
          <input
            accept={ACCEPT}
            className={cn(CONTROL, 'py-2')}
            disabled={read.isPending}
            form={formId}
            id={`${id}-file`}
            onChange={(event) => {
              void onFile(event.currentTarget.files?.[0]);
              event.currentTarget.value = '';
            }}
            type="file"
          />
          <p className="text-xs text-text-muted">
            One invoice: a flat, well-lit photo, or a PDF of up to 5 pages.
          </p>
        </div>

        {read.isPending ? (
          <p className="mt-3 text-sm text-text-muted" role="status">
            Reading the invoice…
          </p>
        ) : null}
        {failure ? (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {failure} The form below still works by hand.
          </p>
        ) : null}

        {proposal ? <ProposalReview proposal={proposal} /> : null}

        {proposal ? (
          <div className="mt-4 space-y-3">
            {proposal.duplicate ? (
              <p className="text-sm text-destructive" role="alert">
                Already filed as receipt {proposal.duplicate.reference} (
                {proposal.duplicate.status.toLowerCase()}). A supplier bill is received once, so
                nothing is copied.
              </p>
            ) : (
              <>
                <label className="flex min-h-11 items-center gap-2 text-sm text-text-body">
                  <input
                    checked={checked}
                    form={formId}
                    onChange={(event) => setChecked(event.currentTarget.checked)}
                    type="checkbox"
                  />
                  I have checked these values against the paper invoice.
                </label>
                <Button disabled={!checked} onClick={apply} size="touch" type="button">
                  Copy into the direct purchase form
                </Button>
              </>
            )}
          </div>
        ) : null}
      </div>
      {liveRegion}
    </div>
  );
}

function ProposalReview({ proposal }: { proposal: InvoiceCaptureProposal }) {
  const headerWarnings = proposal.warnings.filter((code) => code !== 'DUPLICATE_SUPPLIER_INVOICE');
  return (
    <div className="mt-4 space-y-3">
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-xs text-text-muted">Supplier</dt>
          <dd className="text-text-strong">
            {proposal.supplier.match?.name ?? proposal.supplier.printed ?? 'Not readable'}
            {proposal.supplier.match ? '' : ' (not matched)'}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-text-muted">Invoice number</dt>
          <dd className="text-text-strong">{proposal.invoiceNumber.value ?? 'Not readable'}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-text-muted">Invoice date</dt>
          <dd className="text-text-strong">
            {proposal.invoiceDate.date ?? proposal.invoiceDate.printed ?? 'Not readable'}
          </dd>
        </div>
      </dl>
      {headerWarnings.length ? (
        <ul className="space-y-1">
          {headerWarnings.map((code) => (
            <li className="text-sm text-warning" key={code}>
              {INVOICE_WARNINGS[code]}
            </li>
          ))}
        </ul>
      ) : null}

      {proposal.lines.length ? (
        <div className="max-w-full overflow-x-auto rounded-[var(--radius-sm)] border border-border-subtle bg-surface-raised">
          <table className="w-full min-w-[44rem] text-sm">
            <caption className="sr-only">Lines read from the invoice</caption>
            <thead>
              <tr className="border-b border-border-subtle text-left font-mono text-xs tracking-wide text-text-muted uppercase">
                <th className="px-3 py-2 font-medium" scope="col">
                  Line
                </th>
                <th className="px-3 py-2 font-medium" scope="col">
                  Batch · expiry
                </th>
                <th className="px-3 py-2 text-right font-medium" scope="col">
                  Packs + free
                </th>
                <th className="px-3 py-2 text-right font-medium" scope="col">
                  MRP
                </th>
                <th className="px-3 py-2 text-right font-medium" scope="col">
                  Trade price
                </th>
                <th className="px-3 py-2 font-medium" scope="col">
                  Checks
                </th>
              </tr>
            </thead>
            <tbody>
              {proposal.lines.map((line) => (
                <tr
                  className="border-b border-border-subtle align-top last:border-0"
                  key={line.index}
                >
                  <td className="px-3 py-2">
                    <span className="block text-text-strong">
                      {line.index + 1}. {line.product.value}
                    </span>
                    <span className="block text-xs text-text-muted">
                      {line.medicine
                        ? `Matched ${line.medicine.productName}${line.pack ? ` · ${line.pack.level}` : ''}`
                        : line.candidates.length
                          ? `Possible: ${line.candidates.map((item) => item.productName).join(', ')}`
                          : 'No match in your register'}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="block text-text-body">{line.batch.value ?? '—'}</span>
                    <span className="block text-xs text-text-muted">
                      {line.expiry.kind === 'read'
                        ? line.expiry.candidate.date
                        : (line.expiry.printed ?? '—')}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {line.receivedPacks ?? '—'}
                    {line.bonusPacks ? ` + ${line.bonusPacks}` : ''}
                    {line.bonus.kind === 'scheme' ? (
                      <span className="block text-xs text-text-muted">
                        scheme {line.bonus.buy}+{line.bonus.free}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {line.printedMrpMinor === null ? '—' : rupees(line.printedMrpMinor)}
                    {line.mrpCheck ? (
                      <span
                        className={cn(
                          'block text-xs',
                          line.mrpCheck.differenceMinor ? 'text-warning' : 'text-text-muted'
                        )}
                      >
                        {difference(line.mrpCheck)}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {line.tradePriceMinor === null ? '—' : rupees(line.tradePriceMinor)}
                    {line.tradePriceCheck ? (
                      <span
                        className={cn(
                          'block text-xs',
                          line.tradePriceCheck.differenceMinor ? 'text-warning' : 'text-text-muted'
                        )}
                      >
                        {difference(line.tradePriceCheck)}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    {line.warnings.length ? (
                      <ul className="space-y-0.5 text-xs text-warning">
                        {line.warnings.map((code) => (
                          <li key={code}>{LINE_WARNINGS[code]}</li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-xs text-text-muted">No differences found</span>
                    )}
                    {line.lastPurchase ? (
                      <span className="mt-1 block text-xs text-text-muted">
                        Last: {line.lastPurchase.reference} · {line.lastPurchase.supplierName} ·{' '}
                        {line.lastPurchase.receivedAt.slice(0, 10)}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
