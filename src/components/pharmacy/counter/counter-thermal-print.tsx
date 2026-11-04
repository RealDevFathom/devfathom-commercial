// No 'use client' here on purpose: this is not a client entry point. It is only rendered from
// CounterReceiptView (already a client module), and `onBrowserPrint` is a function prop that a
// Server Component could not pass.
import { useId, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import type { CounterReceiptFormat } from '@/lib/pharmacy/counter-browser-print';
import type { CounterReceiptLocale } from '@/lib/pharmacy/counter-receipt';
import {
  PRINT_JOB_POLL_MS,
  PRINT_JOB_STATE_TEXT,
  fallbackText,
  isPrintJobSettled,
  newPrintRequestKey,
  thermalPaperForFormat,
  thermalPaperForWidth,
  type PrintJobView,
  type ThermalPaper,
} from '@/lib/pharmacy/print-job-ui';
import { trpc } from '@/lib/trpc';

export type CounterThermalPrintProps = {
  branchId: string;
  saleId: string;
  receiptNumber: number | null;
  locale: CounterReceiptLocale;
  format: CounterReceiptFormat;
  /** The receipt was already shown or printed in this session. */
  reprint: boolean;
  settled: boolean;
  printing: boolean;
  onBrowserPrint: () => void;
  /** A send was queued for this sale (a replay included), so a later browser print is a reprint. */
  onThermalQueued?: (saleId: string) => void;
};

type EnqueueInput = {
  branchId: string;
  saleId: string;
  locale: CounterReceiptLocale;
  reprint: boolean;
  paper: ThermalPaper;
  requestKey?: string;
  bridgeId?: string;
};

type Attempt = { key: string; input: EnqueueInput } & (
  | { phase: 'sending' }
  | { phase: 'queued'; job: PrintJobView; replayed: boolean }
  | { phase: 'fallback'; code: string }
  /** `uncertain`: the request may or may not have reached the server; resend the same input. */
  | { phase: 'error'; message: string; uncertain: boolean }
);

/** Fallbacks that mean the cached saved paper may be stale. */
const SETTINGS_FALLBACKS = new Set([
  'A4_OUTPUT',
  'PAPER_MISMATCH',
  'SETTINGS_CHANGED',
  'SETTINGS_UNAVAILABLE',
]);

const PAPER_MM: Record<ThermalPaper, 58 | 80> = { THERMAL_58: 58, THERMAL_80: 80 };

/** Server answers that mean the request was processed and refused; anything else is uncertain. */
const DEFINITIVE_CODES = new Set([
  'BAD_REQUEST',
  'PARSE_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_SUPPORTED',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'UNPROCESSABLE_CONTENT',
]);

function errorCode(error: unknown): string | undefined {
  return (error as { data?: { code?: string } | null } | null)?.data?.code ?? undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const SELECT_CLASS =
  'h-11 rounded-md border border-input bg-surface-card px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50';

/**
 * DEV-742: send the settled receipt to the branch's thermal print bridge. It only offers the
 * bridge when the chosen Format, the branch's saved paper and an online bridge all agree;
 * otherwise it explains why and points to the browser print. No state here means paper came out.
 */
export function CounterThermalPrint({
  branchId,
  saleId,
  receiptNumber,
  locale,
  format,
  reprint,
  settled,
  printing,
  onBrowserPrint,
  onThermalQueued,
}: CounterThermalPrintProps) {
  const ids = useId();
  const utils = trpc.useUtils();
  const paper = thermalPaperForFormat(format);

  // Same key and options as useBranchReceiptFormat, so the counter shares one cached read.
  const saved = trpc.pharmacySales.counterReceiptFormat.useQuery(
    { branchId },
    {
      enabled: Boolean(branchId),
      staleTime: 10 * 60_000,
      refetchOnWindowFocus: false,
      retry: false,
    }
  );
  const status = trpc.pharmacyPrinting.printerStatus.useQuery(
    { branchId },
    {
      enabled: Boolean(branchId) && paper !== null,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: false,
    }
  );
  const enqueue = trpc.pharmacyPrinting.enqueueReceipt.useMutation();
  const retry = trpc.pharmacyPrinting.retryJob.useMutation();

  const key = `${saleId}:${locale}`;
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [queuedSales, setQueuedSales] = useState<ReadonlySet<string>>(new Set());
  const [bridgeChoice, setBridgeChoice] = useState<{ branchId: string; bridgeId: string } | null>(
    null
  );
  const [paperChecked, setPaperChecked] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<{ jobId: string; message: string } | null>(null);
  // Blocks a second click before React re-renders the pending state.
  const inFlight = useRef(false);

  const current = attempt?.key === key ? attempt : null;
  const queued = current?.phase === 'queued' ? current : null;
  const jobQuery = trpc.pharmacyPrinting.jobStatus.useQuery(
    { branchId, jobId: queued?.job.id ?? '' },
    {
      enabled: Boolean(queued),
      initialData: queued?.job,
      staleTime: PRINT_JOB_POLL_MS / 2,
      refetchOnWindowFocus: false,
      retry: false,
      refetchInterval: (query) => {
        // A failing status read stops polling; the operator rechecks by hand.
        if (query.state.status === 'error') return false;
        const state = query.state.data?.state;
        return state && isPrintJobSettled(state) ? false : PRINT_JOB_POLL_MS;
      },
    }
  );
  const job: PrintJobView | null = queued ? (jobQuery.data ?? queued.job) : null;

  const sendReprint = reprint || queuedSales.has(saleId);
  const bridges = status.data?.bridges ?? [];
  const onlineBridges = bridges.filter((bridge) => bridge.online);
  const needsChoice = bridges.length > 1;
  const chosen =
    needsChoice && bridgeChoice?.branchId === branchId
      ? onlineBridges.find((bridge) => bridge.id === bridgeChoice.bridgeId)
      : undefined;
  const jobInFlight = job !== null && !isPrintJobSettled(job.state);

  async function send(input: EnqueueInput) {
    if (inFlight.current) return;
    inFlight.current = true;
    const attemptKey = `${input.saleId}:${input.locale}`;
    setAttempt({ key: attemptKey, input, phase: 'sending' });
    setRetryError(null);
    try {
      const result = await enqueue.mutateAsync(input);
      if (result.status === 'QUEUED') {
        setAttempt({
          key: attemptKey,
          input,
          phase: 'queued',
          job: result.job,
          replayed: result.replayed,
        });
        setQueuedSales((prior) => new Set(prior).add(input.saleId));
        onThermalQueued?.(input.saleId);
      } else {
        setAttempt({ key: attemptKey, input, phase: 'fallback', code: result.code });
        if (SETTINGS_FALLBACKS.has(result.code)) void saved.refetch();
        else void status.refetch();
      }
    } catch (error) {
      const code = errorCode(error);
      const uncertain = !code || !DEFINITIVE_CODES.has(code);
      setAttempt({
        key: attemptKey,
        input,
        phase: 'error',
        uncertain,
        message: errorMessage(error, 'The thermal print request failed.'),
      });
      if (!uncertain) void status.refetch();
    } finally {
      inFlight.current = false;
    }
  }

  function sendNew() {
    if (!paper) return;
    void send({
      branchId,
      saleId,
      locale,
      reprint: sendReprint,
      paper,
      // One key per click; only a "Try again" of this click reuses it.
      ...(sendReprint ? { requestKey: newPrintRequestKey() } : {}),
      ...(chosen ? { bridgeId: chosen.id } : {}),
    });
  }

  async function retryQueued(target: PrintJobView) {
    if (inFlight.current) return;
    inFlight.current = true;
    setRetryError(null);
    try {
      const next = await retry.mutateAsync({
        branchId,
        jobId: target.id,
        confirmNoPaperPrinted: paperChecked === target.id,
      });
      utils.pharmacyPrinting.jobStatus.setData({ branchId, jobId: target.id }, next);
      setAttempt((prior) =>
        prior?.phase === 'queued' && prior.job.id === target.id ? { ...prior, job: next } : prior
      );
      setPaperChecked(null);
    } catch (error) {
      setRetryError({
        jobId: target.id,
        message: errorMessage(error, 'The print job could not be resent.'),
      });
      // PRECONDITION_FAILED includes "the branch moved to A4 or another width".
      if (errorCode(error) === 'PRECONDITION_FAILED') void saved.refetch();
      void jobQuery.refetch();
    } finally {
      inFlight.current = false;
    }
  }

  const browserButton = (label = 'Use browser print instead') => (
    <Button
      type="button"
      variant="outline"
      className="h-11"
      disabled={!settled || printing}
      onClick={onBrowserPrint}
    >
      {label}
    </Button>
  );

  // Every case that must never reach the bridge, checked before any send control renders.
  let blocked: { text: string; role: 'status' | 'alert'; action?: ReactNode } | null = null;
  if (paper === null) {
    blocked = {
      role: 'status',
      text: 'A4 prints through Print receipt, in the browser print dialog. The thermal printer is not used.',
    };
  } else if (saved.isError) {
    blocked = {
      role: 'alert',
      text: 'This branch’s saved paper could not be read, so nothing is sent to the thermal printer. Use the browser print.',
      action: (
        <>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={saved.isFetching}
            onClick={() => void saved.refetch()}
          >
            Check saved paper again
          </Button>
          {browserButton()}
        </>
      ),
    };
  } else if (!saved.data) {
    blocked = { role: 'status', text: 'Checking this branch’s saved paper…' };
  } else if (saved.data.output === 'A4') {
    blocked = {
      role: 'status',
      text: 'This branch’s saved paper is A4 (Settings → Printers), so the thermal printer is not used. Use Print receipt.',
    };
  } else if (thermalPaperForWidth(saved.data.layout.paperWidth) !== paper) {
    const mm = saved.data.layout.paperWidth;
    blocked = {
      role: 'status',
      text: `The thermal printer uses this branch’s saved ${mm} mm roll; switch Format to Thermal · ${mm} mm.`,
    };
  } else if (status.isError) {
    blocked = {
      role: 'alert',
      text: `The thermal print bridge status could not be read (${status.error.message}). Nothing is sent. Use the browser print.`,
      action: (
        <>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={status.isFetching}
            onClick={() => void status.refetch()}
          >
            Check bridge again
          </Button>
          {browserButton()}
        </>
      ),
    };
  } else if (!status.data) {
    blocked = { role: 'status', text: 'Checking the thermal print bridge…' };
  } else if (onlineBridges.length === 0) {
    blocked = {
      role: 'status',
      text: 'No thermal print bridge is online for this branch. Print the receipt in the browser instead.',
      action: browserButton('Print receipt (browser)'),
    };
  }

  const sending = enqueue.isPending || current?.phase === 'sending';
  // An unresolved uncertain request: only "Try again" (same key) or "Discard" may follow.
  const unresolved = current?.phase === 'error' && current.uncertain ? current : null;
  // FAILED / UNCONFIRMED may have printed: only the paper-checked resend may follow.
  const needsPaperCheck = job !== null && job.retryRequiresPaperCheck;
  const canSend =
    settled &&
    !printing &&
    !sending &&
    !jobInFlight &&
    !unresolved &&
    !needsPaperCheck &&
    (!needsChoice || chosen !== undefined);
  // Try again resends the stored input, so it needs the same routing as Send, on the same paper.
  const retryPaperMoved = unresolved !== null && unresolved.input.paper !== paper;
  const canTryAgain =
    unresolved !== null && !blocked && !retryPaperMoved && settled && !printing && !sending;

  return (
    <section aria-label="Thermal print queue" className="max-w-full min-w-0 space-y-3">
      {blocked ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role={blocked.role} className="text-sm text-text-muted">
            {blocked.text}
          </p>
          {blocked.action}
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          {needsChoice ? (
            <div className="space-y-1.5">
              <Label htmlFor={`${ids}-bridge`}>Thermal printer</Label>
              <select
                id={`${ids}-bridge`}
                value={chosen?.id ?? ''}
                disabled={sending}
                onChange={(event) => setBridgeChoice({ branchId, bridgeId: event.target.value })}
                className={SELECT_CLASS}
              >
                <option value="">Choose a printer</option>
                {bridges.map((bridge) => (
                  <option key={bridge.id} value={bridge.id} disabled={!bridge.online}>
                    {bridge.online ? bridge.name : `${bridge.name} (offline)`}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={!canSend}
            aria-describedby={`${ids}-paper`}
            onClick={sendNew}
          >
            {sending
              ? 'Sending to thermal printer…'
              : sendReprint
                ? 'Send reprint to thermal printer'
                : 'Send to thermal printer'}
          </Button>
          <p id={`${ids}-paper`} className="text-sm text-text-muted">
            Thermal · {PAPER_MM[paper!]} mm, this branch’s saved roll.
            {needsChoice && !chosen ? ' Choose a printer first.' : ''}
            {unresolved ? ' Resolve the request below first: Try again or Discard.' : ''}
            {needsPaperCheck ? ' Check the printer and use Resend this job below.' : ''}
          </p>
        </div>
      )}

      {current?.phase === 'fallback' ? (
        <div className="flex flex-wrap items-center gap-3">
          <StatusPill status="not-sent" tone="warning" label="Not sent" />
          <p role="alert" className="text-sm text-text-strong">
            {fallbackText(current.code)}
          </p>
          {browserButton()}
        </div>
      ) : null}

      {current?.phase === 'error' ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            {current.message}
            {current.uncertain
              ? ' The request may not have reached DevFathom. Try again resends the same request, so it is not queued twice.'
              : ''}
          </p>
          {current.uncertain ? (
            <>
              {canTryAgain ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
                  onClick={() => void send(current.input)}
                >
                  Try again
                </Button>
              ) : (
                <p className="text-sm text-text-muted">
                  Try again is unavailable:{' '}
                  {blocked
                    ? blocked.text
                    : retryPaperMoved
                      ? 'the paper changed since this request.'
                      : 'wait until the receipt is ready.'}
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                className="h-11"
                disabled={sending}
                aria-describedby={`${ids}-discard`}
                onClick={() => setAttempt(null)}
              >
                Discard
              </Button>
              <p id={`${ids}-discard`} className="text-sm text-warning">
                Discard only after checking the printer: the previous request may already have
                queued a job, and a new send can print another copy.
              </p>
            </>
          ) : null}
        </div>
      ) : null}

      {queued && job ? (
        <div className="space-y-3 rounded-md border border-border-subtle p-3">
          <div role="status" className="space-y-1.5">
            <StatusPill
              status={job.state}
              tone={PRINT_JOB_STATE_TEXT[job.state].tone}
              label={PRINT_JOB_STATE_TEXT[job.state].label}
            />
            <p className="text-sm text-text-strong">
              {job.reprint ? 'Reprint' : 'Original'}
              {receiptNumber !== null ? ` · receipt #${receiptNumber}` : ''} · thermal{' '}
              {job.paperWidth} mm
            </p>
            <p className="text-sm text-text-muted">{PRINT_JOB_STATE_TEXT[job.state].detail}</p>
            {queued.replayed ? (
              <p className="text-sm text-text-muted">
                {queued.input.reprint
                  ? 'This reprint was already queued; showing its status.'
                  : 'This sale’s original receipt was already queued, so this shows that job. Use Send reprint for another copy.'}
              </p>
            ) : null}
          </div>
          {jobQuery.isError ? (
            <div className="flex flex-wrap items-center gap-3">
              <p role="alert" className="text-sm text-destructive">
                The job status could not be refreshed: {jobQuery.error.message}. Updates are paused.
              </p>
              <Button
                type="button"
                variant="outline"
                className="h-11"
                disabled={jobQuery.isFetching}
                onClick={() => void jobQuery.refetch()}
              >
                Check again
              </Button>
            </div>
          ) : null}
          {job.retryable ? (
            <div className="flex flex-wrap items-center gap-3">
              {job.retryRequiresPaperCheck ? (
                <div className="flex min-h-11 items-center gap-2">
                  <input
                    id={`${ids}-paper-check`}
                    type="checkbox"
                    checked={paperChecked === job.id}
                    disabled={retry.isPending}
                    onChange={(event) => setPaperChecked(event.target.checked ? job.id : null)}
                    className="size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                  />
                  <Label htmlFor={`${ids}-paper-check`} className="min-h-11 leading-snug">
                    I checked the printer: this receipt did not come out
                  </Label>
                </div>
              ) : null}
              <Button
                type="button"
                variant="outline"
                className="h-11"
                disabled={
                  retry.isPending ||
                  printing ||
                  (job.retryRequiresPaperCheck && paperChecked !== job.id)
                }
                onClick={() => void retryQueued(job)}
              >
                {retry.isPending ? 'Resending…' : 'Resend this job'}
              </Button>
            </div>
          ) : null}
          {retryError?.jobId === job.id ? (
            <p role="alert" className="text-sm text-destructive">
              {retryError.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
