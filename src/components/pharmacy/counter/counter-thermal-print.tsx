'use client';

import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { StatusPill } from '@/components/ui/status-pill';
import type { CounterReceiptFormat } from '@/lib/pharmacy/counter-browser-print';
import type { CounterReceiptLocale } from '@/lib/pharmacy/counter-receipt';
import { trpc } from '@/lib/trpc';

/** Delivery states the server reports; mirrors `PrintJobState` without importing server code. */
export type CounterThermalJobState =
  'QUEUED' | 'SENDING' | 'SENT_TO_PRINTER' | 'FAILED' | 'UNCONFIRMED' | 'EXPIRED';

type JobView = {
  id: string;
  state: CounterThermalJobState;
  reprint: boolean;
  failureCode: string | null;
  retryable: boolean;
  retryRequiresPaperCheck: boolean;
};

/** States the bridge can still move on its own; the counter keeps asking only for these. */
const ACTIVE: ReadonlySet<CounterThermalJobState> = new Set(['QUEUED', 'SENDING']);
export const THERMAL_STATUS_POLL_MS = 2_000;

/**
 * Plain words for each delivery state. `SENT_TO_PRINTER` only means the print
 * bridge handed the bytes to the printer; no state claims paper came out.
 */
export const THERMAL_STATE_TEXT: Record<
  CounterThermalJobState,
  { label: string; tone: 'info' | 'success' | 'warning' | 'danger' | 'neutral'; text: string }
> = {
  QUEUED: {
    label: 'Waiting',
    tone: 'info',
    text: 'Waiting for the print bridge to pick up this receipt.',
  },
  SENDING: {
    label: 'Sending',
    tone: 'info',
    text: 'The print bridge is sending this receipt to the printer.',
  },
  SENT_TO_PRINTER: {
    label: 'Sent to printer',
    tone: 'success',
    text: 'The print bridge handed this receipt to the printer. Check that the paper came out; DevFathom cannot see the paper.',
  },
  FAILED: {
    label: 'Not sent',
    tone: 'danger',
    text: 'The print bridge could not send this receipt to the printer.',
  },
  UNCONFIRMED: {
    label: 'No answer',
    tone: 'warning',
    text: 'The print bridge took this receipt but did not report back. It may or may not have printed.',
  },
  EXPIRED: {
    label: 'Not sent',
    tone: 'neutral',
    text: 'No print bridge picked this receipt up in time, so it was not sent and will not print later.',
  },
};

const FAILURE_TEXT: Record<string, string> = {
  TRANSPORT_FAILED: 'The printer did not accept it. Check that it is on, connected and has paper.',
  PRINTER_NOT_ALLOWED: 'The print bridge is not allowed to use this printer. Ask an administrator.',
  INVALID_JOB: 'The print bridge rejected the job. Use Print receipt instead.',
  INVALID_DOCUMENT: 'The print bridge rejected the receipt. Use Print receipt instead.',
};

const UNSUPPORTED_TEXT =
  'The thermal printer cannot print this receipt’s text (Urdu or other non-Latin characters). Nothing was sent. Use Print receipt for the browser / OS receipt.';

function newRequestKey(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return random
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 64)
    .padEnd(8, '0');
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * DEV-904: sends a settled receipt to the branch thermal print queue and shows
 * what the print bridge reported. The server builds the receipt from the sale;
 * this control sends only identifiers. Retrying after FAILED or UNCONFIRMED
 * needs the cashier to confirm no paper came out (enforced on the server too).
 */
export function CounterThermalPrint({
  branchId,
  saleId,
  locale,
  format,
  disabled = false,
}: {
  branchId: string;
  saleId: string;
  locale: CounterReceiptLocale;
  format: CounterReceiptFormat;
  disabled?: boolean;
}) {
  const utils = trpc.useUtils();
  const [job, setJob] = useState<JobView | null>(null);
  const [notice, setNotice] = useState<{ tone: 'status' | 'alert'; text: string } | null>(null);
  const [paperChecked, setPaperChecked] = useState(false);
  const pending = useRef(false);

  const enqueue = trpc.pharmacyPrinting.enqueueReceipt.useMutation({ retry: false });
  const retry = trpc.pharmacyPrinting.retryJob.useMutation({ retry: false });
  const status = trpc.pharmacyPrinting.jobStatus.useQuery(
    { branchId, jobId: job?.id ?? '' },
    {
      enabled: job !== null && ACTIVE.has(job.state),
      retry: false,
      refetchInterval: (query) => {
        const state = query.state.data?.state ?? job?.state;
        return state && ACTIVE.has(state) ? THERMAL_STATUS_POLL_MS : false;
      },
    }
  );
  const latest: JobView | null = job && status.data?.id === job.id ? status.data : job;

  const paper = format === 'THERMAL_58' ? 'THERMAL_58' : format === 'THERMAL' ? 'THERMAL_80' : null;
  const busy = enqueue.isPending || retry.isPending;
  const active = latest !== null && ACTIVE.has(latest.state);

  async function send() {
    if (!paper || pending.current) return;
    pending.current = true;
    setNotice(null);
    setPaperChecked(false);
    try {
      const result = await enqueue.mutateAsync({
        branchId,
        saleId,
        locale,
        paper,
        requestKey: newRequestKey(),
      });
      if (!result) return;
      if (result.status === 'QUEUED') {
        setJob(result.job);
        // Same job id after a retry: keep the cached status coherent with the reply.
        utils.pharmacyPrinting.jobStatus.setData({ branchId, jobId: result.job.id }, result.job);
        if (result.replayed)
          setNotice({ tone: 'status', text: 'This receipt was already sent to the queue.' });
      } else {
        setJob(null);
        setNotice({
          tone: 'alert',
          text: result.code === 'UNSUPPORTED_PRINT_TEXT' ? UNSUPPORTED_TEXT : result.message,
        });
      }
    } catch (error) {
      setNotice({
        tone: 'alert',
        text: errorText(
          error,
          'The receipt could not be sent to the print queue. Check the connection and try again.'
        ),
      });
    } finally {
      pending.current = false;
    }
  }

  async function resend() {
    if (!latest || pending.current) return;
    pending.current = true;
    setNotice(null);
    try {
      const view = await retry.mutateAsync({
        branchId,
        jobId: latest.id,
        confirmNoPaperPrinted: latest.retryRequiresPaperCheck ? paperChecked : false,
      });
      if (!view) return;
      setPaperChecked(false);
      setJob(view);
      utils.pharmacyPrinting.jobStatus.setData({ branchId, jobId: view.id }, view);
    } catch (error) {
      setNotice({
        tone: 'alert',
        text: errorText(error, 'The receipt was not sent again. Check the connection and retry.'),
      });
    } finally {
      pending.current = false;
    }
  }

  const words = latest ? THERMAL_STATE_TEXT[latest.state] : null;
  const failure =
    latest?.state === 'FAILED' && latest.failureCode ? FAILURE_TEXT[latest.failureCode] : null;

  return (
    <section
      aria-label="Thermal printer"
      className="space-y-3 rounded-md border border-border-subtle bg-surface-sunken p-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={disabled || busy || active || !paper}
          onClick={() => void send()}
        >
          {enqueue.isPending
            ? 'Sending to thermal printer…'
            : latest
              ? 'Send another copy to thermal printer'
              : 'Send to thermal printer'}
        </Button>
        {latest && words ? (
          <StatusPill status={latest.state} tone={words.tone} label={words.label} />
        ) : null}
        {latest?.reprint ? <StatusPill status="reprint" tone="info" label="Reprint" /> : null}
      </div>
      {!paper ? (
        <p className="text-sm text-text-muted">
          Choose a thermal format (80 mm or 58 mm) to send this receipt to the thermal printer.
        </p>
      ) : null}
      {latest && words ? (
        <div role="status" aria-live="polite" className="space-y-1">
          <p className="text-sm text-text-body">{words.text}</p>
          {failure ? <p className="text-sm text-text-muted">{failure}</p> : null}
          {status.isError ? (
            <p className="text-sm text-text-muted">
              The latest status could not be read. It is shown as last reported.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-text-muted">
          Sends this receipt to the branch print bridge. The counter shows what the bridge reports;
          it cannot see whether paper came out.
        </p>
      )}
      {latest?.retryable ? (
        <div className="flex flex-wrap items-center gap-3">
          {latest.retryRequiresPaperCheck ? (
            <label className="flex min-h-11 items-center gap-2 text-sm text-text-body">
              <Checkbox
                checked={paperChecked}
                disabled={busy}
                onCheckedChange={(checked) => setPaperChecked(checked === true)}
              />
              I checked the printer and no receipt came out
            </label>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            className="h-11"
            disabled={busy || (latest.retryRequiresPaperCheck && !paperChecked)}
            onClick={() => void resend()}
          >
            {retry.isPending ? 'Retrying…' : 'Retry thermal print'}
          </Button>
        </div>
      ) : null}
      {notice ? (
        <p
          role={notice.tone}
          className={
            notice.tone === 'alert' ? 'text-sm text-destructive' : 'text-sm text-text-muted'
          }
        >
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}
