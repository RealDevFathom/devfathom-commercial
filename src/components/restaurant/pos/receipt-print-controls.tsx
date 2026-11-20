'use client';

import { browserUuid } from '@/lib/browser-uuid';

import { useRef, useState } from 'react';
import Link from 'next/link';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { TerminalRequest } from './checkout-panel';
import type { Receipt } from './receipt-view';
import { requestReceiptDialog } from './receipt-browser-print';
import { PrintWindowNotice } from '@/components/ui/print-window-notice';
import { RawPrintValidationError } from '@/lib/restaurant/printing/contract';

export type ReceiptPrinting = {
  branchId: string;
  registerId: string;
  registerName: string;
  printerId: string | null;
  preview?: {
    text: string | null;
    validation?: {
      code: RawPrintValidationError['code'];
      fallback: 'BROWSER_OS' | null;
      error: string;
    } | null;
    paperWidth: 58 | 80;
    source: 'queued' | 'saved';
  };
  latestJob: {
    id: string;
    status: string;
    printerId: string | null;
    attemptCount: number;
    lastAttemptAt: string | null;
    printedAt: string | null;
    createdAt: string;
  } | null;
};

function statusText(state: ReceiptPrinting) {
  const job = state.latestJob;
  if (!job)
    return state.printerId
      ? 'Ready to request a receipt print.'
      : 'No receipt printer configured for this branch.';
  if (job.status === 'PRINTED')
    return 'Bridge acknowledged delivery to the printer or OS queue. Paper output is not confirmed.';
  if (job.status === 'OFFLINE' || job.status === 'NO_PRINTER')
    return 'Printer unavailable or delivery failed. Check the existing job and connection before making another copy.';
  if (job.status === 'PENDING' && job.attemptCount === 0)
    return 'Receipt queued. Waiting for the bridge; paper output is not confirmed.';
  return 'Delivery uncertain. Check the printer and existing job before requesting another copy.';
}

export function ReceiptPrintControls({
  receipt,
  request,
  initial,
}: {
  receipt: Receipt;
  request: TerminalRequest;
  initial: ReceiptPrinting;
}) {
  const [state, setState] = useState(initial);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState('');
  const [refusal, setRefusal] = useState<RawPrintValidationError | null>(null);
  const [reason, setReason] = useState('');
  const width = state.preview?.paperWidth ?? 80;
  const [dialogStatus, setDialogStatus] = useState('');
  const [duplicateAccepted, setDuplicateAccepted] = useState(false);
  const [retry, setRetry] = useState<{ requestId: string; reason: string } | null>(null);
  const canReprint = state.latestJob?.status === 'PRINTED';
  const endpoint = '/api/restaurant/checkout/receipt';

  async function dispatch() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    setRefusal(null);
    const copy = retry ?? (canReprint ? { requestId: browserUuid(), reason: reason.trim() } : null);
    setRetry(copy);
    try {
      const next = await request<ReceiptPrinting>(endpoint, {
        method: 'POST',
        intent: `receipt:${receipt.billId}:${copy?.requestId ?? 'original'}`,
        body: copy
          ? { billId: receipt.billId, action: 'reprint', ...copy }
          : { billId: receipt.billId, action: 'print' },
      });
      setState(next);
      setRetry(null);
      setReason('');
    } catch (cause) {
      // TerminalRequest retains only HTTP status and the safe server message. Unknown 422s
      // fail closed; recognize the shared constant unsupported-text message, never payload text.
      if (cause instanceof Error && 'status' in cause && cause.status === 422) {
        const unsupported = new RawPrintValidationError('UNSUPPORTED_PRINT_TEXT');
        const rejected =
          cause.message === unsupported.message
            ? unsupported
            : new RawPrintValidationError('INVALID_PRINT_DOCUMENT');
        setRefusal(rejected);
        setRetry(null);
        setError(rejected.message);
        return;
      }
      setError(
        `${cause instanceof Error ? cause.message : 'Print request failed.'} Delivery may be uncertain. Retry keeps the same request; check status before another copy.`
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function refresh() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const next = await request<Receipt & { printing: ReceiptPrinting }>(
        `${endpoint}?billId=${encodeURIComponent(receipt.billId)}`
      );
      setState(next.printing);
      setRefusal(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Print status could not be loaded.');
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-label="Receipt printing" className="space-y-3 border-t border-border-subtle pt-4">
      <p className="break-words text-sm text-text-muted">
        Branch: {receipt.branchName} · Register: {state.registerName} ({state.registerId}) · Receipt
        printer: {state.printerId ?? 'None'}
      </p>
      {state.latestJob ? (
        <p className="break-words text-xs text-text-muted">
          Job {state.latestJob.id} · Destination: {state.latestJob.printerId ?? 'None'}
        </p>
      ) : null}
      <p role="status" className="text-sm text-text-body">
        {statusText(state)}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {canReprint || retry ? (
        <label className="block space-y-1 text-sm text-text-body">
          Reprint reason
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={200}
            minLength={3}
            disabled={pending || Boolean(retry)}
            className="h-11"
          />
        </label>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className="min-h-11"
          onClick={() => void dispatch()}
          disabled={
            pending ||
            Boolean(state.preview?.validation) ||
            !state.printerId ||
            receipt.receiptNumber === null ||
            (!retry && (canReprint ? reason.trim().length < 3 : Boolean(state.latestJob)))
          }
        >
          {pending
            ? 'Working…'
            : retry
              ? 'Retry same print request'
              : canReprint
                ? 'Reprint receipt'
                : 'Print receipt'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={pending}
          onClick={() => void refresh()}
        >
          Check print status
        </Button>
        <Link
          href="/settings"
          className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
        >
          Printer settings
        </Link>
      </div>
      <p className="text-xs text-text-muted">
        Printer settings require an administrator session. Routing applies to this branch; the
        bridge uses its configured destination allowlist.
      </p>
      <p className="text-xs text-text-muted">
        {state.preview?.source === 'queued'
          ? 'Using the queued receipt layout.'
          : 'Using the saved branch receipt width.'}{' '}
        Choose matching {width} mm paper in the OS print dialog. The receipt content uses this width
        with 2 mm margins.
      </p>
      {state.preview?.validation ? (
        <p className="text-xs text-text-muted">{state.preview.validation.error}</p>
      ) : null}
      {state.latestJob || (error && !refusal) ? (
        <label className="flex items-start gap-2 text-sm text-text-body">
          <input
            type="checkbox"
            checked={duplicateAccepted}
            onChange={(event) => setDuplicateAccepted(event.target.checked)}
            className="mt-1 size-4"
          />
          I checked the printer. A browser copy may duplicate this queued or delivered receipt.
        </label>
      ) : null}
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        disabled={
          pending ||
          typeof state.preview?.text !== 'string' ||
          refusal?.fallback === null ||
          state.preview?.validation?.fallback === null ||
          (Boolean(state.latestJob || (error && !refusal)) && !duplicateAccepted)
        }
        onClick={async () => {
          try {
            if (typeof state.preview?.text !== 'string')
              throw new Error('Validated receipt preview unavailable. Check print status.');
            await requestReceiptDialog(receipt, width, state.preview.text);
            setDialogStatus(
              'Print dialog requested. Closing the dialog does not confirm printing.'
            );
          } catch (cause) {
            setDialogStatus(
              cause instanceof Error ? cause.message : 'Print dialog could not be requested.'
            );
          }
        }}
      >
        Open browser print dialog
      </Button>
      {dialogStatus ? (
        <p role="status" className="text-sm text-text-muted">
          {dialogStatus}
        </p>
      ) : null}
      {/* DEV-973: the terminal has no app shell; the print window line lives here. */}
      <PrintWindowNotice className="rounded-[var(--radius-xs)] border" />
    </section>
  );
}
