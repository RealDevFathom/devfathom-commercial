'use client';

import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';
import {
  fallbackText,
  isPrintJobSettled,
  newPrintRequestKey,
  PRINT_JOB_POLL_MS,
  PRINT_JOB_STATE_TEXT,
  type PrintJobView,
  type ThermalPaper,
} from '@/lib/pharmacy/print-job-ui';

export type ThermalBridgePanelProps = {
  branchId: string;
  branchName: string;
  canEdit: boolean;
  savedPaper: { paper: ThermalPaper; output: 'THERMAL' | 'A4' };
};

type EnqueueTestResult =
  | { status: 'QUEUED'; replayed: boolean; job: PrintJobView }
  | { status: 'FALLBACK'; code: string; fallback: 'BROWSER_OS' | null; message: string };

type TestRequest = { paper: ThermalPaper; requestKey: string; bridgeId?: string };

type TestRun =
  | { kind: 'idle' }
  | { kind: 'queued'; job: PrintJobView; replayed: boolean }
  | { kind: 'fallback'; code: string }
  | { kind: 'error'; message: string }
  /** The request may or may not have arrived: a retry re-sends the SAME request key. */
  | { kind: 'uncertain'; request: TestRequest };

type Revealed = { bridgeName: string; credential: string; notice: string };

// Same recipes as the printer settings console beside this panel.
const FIELD =
  'min-h-11 w-full rounded-sm border border-border-default bg-surface-card px-3 py-2 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 aria-invalid:border-destructive';
const CHECK =
  'flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-border-default bg-surface-page px-3 py-2.5 transition-colors hover:bg-surface-sunken has-[:checked]:border-border-strong has-[:checked]:bg-surface-sunken has-[:focus-visible]:border-ring has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/30';

/**
 * Connection presets only shape the placeholder and hint. The server validates the target,
 * and the bridge host re-checks it against its own operating system before any write.
 */
const CONNECTIONS = [
  {
    value: 'usb-windows',
    label: 'USB – Windows',
    placeholder: 'queue:///Receipt%20Printer',
    hint: 'The printer’s name in the Windows printer list, with each space written as %20.',
  },
  {
    value: 'usb-macos',
    label: 'USB – macOS',
    placeholder: 'queue:///Receipt_Printer',
    hint: 'The printer’s queue name on the Mac: letters, numbers, _, . and - only.',
  },
  {
    value: 'usb-device',
    label: 'USB – Linux/macOS device',
    placeholder: '/dev/usb/lp0',
    hint: 'The printer’s device path on the bridge computer.',
  },
  {
    value: 'network',
    label: 'Network',
    placeholder: 'tcp://192.168.1.50:9100',
    hint: 'The printer’s fixed network address and port, usually 9100.',
  },
  {
    value: 'bluetooth-windows',
    label: 'Bluetooth – Windows',
    placeholder: 'queue:///…',
    hint: 'Pair the printer and add it as a Windows printer, then use its printer name with each space written as %20.',
  },
  {
    value: 'bluetooth-serial',
    label: 'Bluetooth – macOS/Linux serial',
    placeholder: 'serial:///dev/cu.<name> or /dev/rfcomm0',
    hint: 'The serial port the paired printer creates on the bridge computer.',
  },
] as const;
type ConnectionValue = (typeof CONNECTIONS)[number]['value'];

const PAPER_TEXT: Record<ThermalPaper, string> = {
  THERMAL_58: '58 mm thermal roll',
  THERMAL_80: '80 mm thermal roll',
};
const NAME_ERROR = 'Enter a bridge name of 1–80 characters.';
/** Server answers that are final: re-sending the same request cannot change them. */
const DEFINITIVE = new Set([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'PRECONDITION_FAILED',
  'CONFLICT',
]);

function errorCode(error: unknown): string | undefined {
  return (error as { data?: { code?: string } } | null)?.data?.code;
}

function errorMessage(error: unknown, fallback: string): string {
  return errorCode(error) && error instanceof Error && error.message ? error.message : fallback;
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTime.format(date);
}

/**
 * DEV-742: thermal print bridge status, enrolment (admins) and a bridge test page.
 * Keyed by branch so every local state — including a shown-once credential — is dropped
 * when the branch changes.
 */
export function ThermalBridgePanel(props: ThermalBridgePanelProps) {
  return <BridgePanel key={props.branchId} {...props} />;
}

function BridgePanel({ branchId, branchName, canEdit, savedPaper }: ThermalBridgePanelProps) {
  const ids = useId();
  const status = trpc.pharmacyPrinting.printerStatus.useQuery(
    { branchId },
    { enabled: Boolean(branchId), retry: false, refetchOnWindowFocus: false }
  );
  const activeBridges = status.data?.bridges ?? [];
  const forbidden = status.isError && errorCode(status.error) === 'FORBIDDEN';

  return (
    <SectionCard title="Thermal print bridge" titleLevel={2}>
      <div className="space-y-6">
        <p className="text-sm text-text-body">
          A print bridge is a small program on the computer the thermal printer is connected to. It
          collects receipts and test pages from DevFathom and passes them to that printer, so staff
          don’t need the print dialog. DevFathom cannot see paper: nothing here confirms that a page
          came out.
        </p>

        <section aria-labelledby={`${ids}-status`} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id={`${ids}-status`} className="text-sm font-semibold text-text-strong">
              Bridge status for {branchName}
            </h3>
            {status.isSuccess ? (
              <Button
                type="button"
                size="touch"
                variant="outline"
                disabled={status.isFetching}
                onClick={() => void status.refetch()}
              >
                {status.isFetching ? 'Refreshing…' : 'Refresh status'}
              </Button>
            ) : null}
          </div>
          {status.isPending ? (
            <p role="status" className="text-sm text-text-muted">
              Checking the print bridge for {branchName}…
            </p>
          ) : forbidden ? (
            <p role="alert" className="text-sm text-text-body">
              You need counter access at {branchName} to see its print bridge.
            </p>
          ) : status.isError ? (
            <div className="space-y-3">
              <p role="alert" className="text-sm text-text-body">
                The bridge status could not be loaded. Nothing was changed.
              </p>
              <Button
                type="button"
                size="touch"
                variant="outline"
                onClick={() => void status.refetch()}
              >
                Try again
              </Button>
            </div>
          ) : activeBridges.length === 0 ? (
            <div className="rounded-md border border-border-subtle bg-surface-page px-4 py-3">
              <p className="text-sm font-semibold text-text-strong">
                No print bridge is enrolled for {branchName}
              </p>
              <p className="mt-1 text-sm text-text-body">
                {canEdit
                  ? 'Install the bridge on the computer the thermal printer is connected to, then enroll it below.'
                  : 'Install the bridge on the computer the thermal printer is connected to, then ask a workspace administrator to enroll it.'}
              </p>
            </div>
          ) : (
            <>
              <ul className="space-y-2" aria-label={`Print bridges for ${branchName}`}>
                {activeBridges.map((bridge) => (
                  <li
                    key={bridge.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle bg-surface-page px-4 py-3"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold break-words text-text-strong">
                        {bridge.name}
                      </span>
                      <span className="block font-mono text-xs text-text-muted">
                        {bridge.lastSeenAt ? (
                          <>
                            Last seen{' '}
                            <time dateTime={bridge.lastSeenAt}>{when(bridge.lastSeenAt)}</time>
                          </>
                        ) : (
                          'Not seen yet'
                        )}
                      </span>
                    </span>
                    <StatusPill
                      status={bridge.online ? 'online' : 'offline'}
                      tone={bridge.online ? 'success' : 'warning'}
                      label={bridge.online ? 'Online' : 'Offline'}
                    />
                  </li>
                ))}
              </ul>
              <p className="text-xs text-text-muted">
                Online means the bridge program checked in recently. It does not mean the printer
                has paper or is switched on.
              </p>
            </>
          )}
        </section>

        {!forbidden ? (
          <BridgeTestPage
            branchId={branchId}
            savedPaper={savedPaper}
            canEdit={canEdit}
            statusReady={status.isSuccess}
            bridges={activeBridges}
          />
        ) : null}

        {canEdit ? <BridgeAdmin branchId={branchId} branchName={branchName} /> : null}
      </div>
    </SectionCard>
  );
}

type StatusBridge = { id: string; name: string; online: boolean };

function BridgeTestPage({
  branchId,
  savedPaper,
  canEdit,
  statusReady,
  bridges,
}: {
  branchId: string;
  savedPaper: ThermalBridgePanelProps['savedPaper'];
  canEdit: boolean;
  statusReady: boolean;
  bridges: StatusBridge[];
}) {
  const ids = useId();
  const utils = trpc.useUtils();
  const enqueue = trpc.pharmacyPrinting.enqueueTestPage.useMutation();
  const retry = trpc.pharmacyPrinting.retryJob.useMutation();
  const [run, setRun] = useState<TestRun>({ kind: 'idle' });
  const [choice, setChoice] = useState('');
  const [paperChecked, setPaperChecked] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const online = bridges.filter((bridge) => bridge.online);
  const many = bridges.length > 1;
  const chosen = online.find((bridge) => bridge.id === choice) ?? online[0];

  const queuedJob = run.kind === 'queued' ? run.job : null;
  const jobQuery = trpc.pharmacyPrinting.jobStatus.useQuery(
    { branchId, jobId: queuedJob?.id ?? '' },
    {
      enabled: Boolean(queuedJob),
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: (query) => {
        const state = (query.state.data as PrintJobView | undefined)?.state ?? queuedJob?.state;
        return state && !isPrintJobSettled(state) ? PRINT_JOB_POLL_MS : false;
      },
    }
  );
  const job = queuedJob ? ((jobQuery.data as PrintJobView | undefined) ?? queuedJob) : null;
  const inFlight = !!job && !isPrintJobSettled(job.state);

  const blocked =
    savedPaper.output === 'A4'
      ? 'This branch prints on A4; use the browser test print above.'
      : !statusReady
        ? 'Waiting for the bridge status.'
        : bridges.length === 0
          ? canEdit
            ? 'Enroll a print bridge below first.'
            : 'No print bridge is enrolled for this branch. Ask a workspace administrator to enroll one.'
          : online.length === 0
            ? 'No print bridge is online. Start the bridge program on the printer’s computer, then refresh the status.'
            : null;
  const disabled = !!blocked || enqueue.isPending || retry.isPending || inFlight;
  const reasonId = `${ids}-reason`;

  async function send(request: TestRequest) {
    setRetryError(null);
    setPaperChecked(false);
    try {
      const result = (await enqueue.mutateAsync({ branchId, ...request })) as EnqueueTestResult;
      setRun(
        result.status === 'QUEUED'
          ? { kind: 'queued', job: result.job, replayed: result.replayed }
          : { kind: 'fallback', code: result.code }
      );
    } catch (error) {
      const code = errorCode(error);
      setRun(
        code && DEFINITIVE.has(code)
          ? { kind: 'error', message: errorMessage(error, 'The test page was not sent.') }
          : { kind: 'uncertain', request }
      );
    }
  }

  function sendNew() {
    if (disabled || !chosen) return;
    // One key per click; only "Try again" for this same click reuses it.
    void send({
      paper: savedPaper.paper,
      requestKey: newPrintRequestKey(),
      ...(many ? { bridgeId: chosen.id } : {}),
    });
  }

  async function retryJob() {
    if (!job) return;
    setRetryError(null);
    try {
      const result = await retry.mutateAsync({
        branchId,
        jobId: job.id,
        confirmNoPaperPrinted: job.retryRequiresPaperCheck ? paperChecked : false,
      });
      // Replace the settled poll result so polling resumes from the new state.
      utils.pharmacyPrinting.jobStatus.setData({ branchId, jobId: job.id }, result);
      setPaperChecked(false);
      setRun({ kind: 'queued', job: result as PrintJobView, replayed: false });
    } catch (error) {
      setRetryError(
        errorMessage(
          error,
          'The retry did not reach DevFathom. Check your connection and try again.'
        )
      );
    }
  }

  const stateText = job ? PRINT_JOB_STATE_TEXT[job.state] : null;

  return (
    <section aria-labelledby={`${ids}-heading`} className="space-y-3">
      <h3 id={`${ids}-heading`} className="text-sm font-semibold text-text-strong">
        Test page through the bridge
      </h3>
      <p className="text-sm text-text-body">
        Sends a test page — not a receipt — on the saved {PAPER_TEXT[savedPaper.paper]}, without the
        print dialog.
      </p>
      {many && savedPaper.output === 'THERMAL' ? (
        <div className="max-w-md space-y-2">
          <label htmlFor={`${ids}-bridge`} className="block text-sm font-semibold text-text-strong">
            Bridge
          </label>
          <select
            id={`${ids}-bridge`}
            className={FIELD}
            value={chosen?.id ?? ''}
            disabled={online.length === 0 || enqueue.isPending || inFlight}
            onChange={(event) => setChoice(event.target.value)}
          >
            {bridges.map((bridge) => (
              <option key={bridge.id} value={bridge.id} disabled={!bridge.online}>
                {bridge.name}
                {bridge.online ? '' : ' (offline)'}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <Button
        type="button"
        size="touch"
        disabled={disabled}
        aria-describedby={blocked ? reasonId : undefined}
        onClick={sendNew}
      >
        {enqueue.isPending ? 'Sending…' : 'Send test page to thermal printer'}
      </Button>
      {blocked ? (
        <p id={reasonId} className="text-sm text-text-muted">
          {blocked}
        </p>
      ) : null}

      <div role="status" className="space-y-2 text-sm text-text-body">
        {job && stateText ? (
          <>
            <StatusPill status={job.state} tone={stateText.tone} label={stateText.label} />
            <p>{stateText.detail}</p>
            {run.kind === 'queued' && run.replayed ? (
              <p className="text-text-muted">
                DevFathom had already received this request, so this is the same job, not a new one.
              </p>
            ) : null}
            {jobQuery.isError && inFlight ? (
              <p className="text-text-muted">
                The latest status could not be loaded. DevFathom keeps checking.
              </p>
            ) : null}
          </>
        ) : null}
        {run.kind === 'fallback' ? <p>{fallbackText(run.code)}</p> : null}
      </div>
      {run.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {run.message}
        </p>
      ) : null}
      {run.kind === 'uncertain' ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            DevFathom did not answer, so the test page may or may not have been queued. Try again:
            it reuses this same request, so it cannot be queued twice.
          </p>
          <Button
            type="button"
            size="touch"
            variant="outline"
            disabled={enqueue.isPending}
            onClick={() => void send(run.request)}
          >
            Try again
          </Button>
        </div>
      ) : null}

      {job?.retryable ? (
        <div className="space-y-3">
          {job.retryRequiresPaperCheck ? (
            <label className={CHECK}>
              <input
                type="checkbox"
                required
                checked={paperChecked}
                onChange={(event) => setPaperChecked(event.target.checked)}
                className="mt-1 size-4 shrink-0 accent-primary"
              />
              <span className="text-sm font-semibold text-text-strong">
                I checked the printer: no test page came out
              </span>
            </label>
          ) : null}
          <Button
            type="button"
            size="touch"
            variant="outline"
            disabled={retry.isPending || (job.retryRequiresPaperCheck && !paperChecked)}
            onClick={() => void retryJob()}
          >
            {retry.isPending ? 'Sending again…' : 'Send the same test page again'}
          </Button>
          {retryError ? (
            <p role="alert" className="text-sm text-destructive">
              {retryError}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function BridgeAdmin({ branchId, branchName }: { branchId: string; branchName: string }) {
  const ids = useId();
  const utils = trpc.useUtils();
  const list = trpc.pharmacyPrinting.bridges.useQuery(
    { branchId },
    { enabled: Boolean(branchId), retry: false, refetchOnWindowFocus: false }
  );
  // gcTime 0: the shown-once credential must not linger in the mutation cache.
  const enroll = trpc.pharmacyPrinting.enrollBridge.useMutation({ gcTime: 0 });
  const revoke = trpc.pharmacyPrinting.revokeBridge.useMutation();
  const { reset: resetEnroll } = enroll;

  const [name, setName] = useState('');
  const [connection, setConnection] = useState<ConnectionValue>('usb-windows');
  const [target, setTarget] = useState('');
  const [errors, setErrors] = useState<{ name?: string; target?: string; form?: string }>({});
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // Unmount (including a branch change, which remounts this panel) drops the credential.
  useEffect(() => () => resetEnroll(), [resetEnroll]);

  const preset = CONNECTIONS.find((row) => row.value === connection) ?? CONNECTIONS[0];

  function refresh() {
    void utils.pharmacyPrinting.printerStatus.invalidate({ branchId });
    void utils.pharmacyPrinting.bridges.invalidate({ branchId });
  }

  async function submit() {
    const trimmed = name.trim();
    const next: typeof errors = {};
    if (!trimmed || trimmed.length > 80) next.name = NAME_ERROR;
    if (!target || target.length > 128) next.target = 'Enter the printer target for this bridge.';
    setErrors(next);
    if (next.name || next.target) return;
    try {
      const result = await enroll.mutateAsync({ branchId, name: trimmed, printerId: target });
      setRevealed({
        bridgeName: result.bridge.name,
        credential: result.credential,
        notice: result.notice,
      });
      // The credential now lives only in this component's state.
      resetEnroll();
      setCopyNote(null);
      setName('');
      setTarget('');
      refresh();
    } catch (error) {
      const code = errorCode(error);
      const message = errorMessage(error, 'The bridge was not enrolled. Try again.');
      if (code === 'BAD_REQUEST') {
        setErrors(message === NAME_ERROR ? { name: message } : { target: message });
      } else if (code === 'FORBIDDEN' || code === 'UNAUTHORIZED') {
        setErrors({ form: 'You don’t have permission to enroll a print bridge.' });
      } else {
        setErrors({ form: 'The bridge was not enrolled. Try again.' });
      }
    }
  }

  async function copy(credential: string) {
    try {
      await navigator.clipboard.writeText(credential);
      setCopyNote('Copied. Paste it into the bridge’s token file now.');
    } catch {
      setCopyNote('Copying didn’t work here. Select the credential and copy it by hand.');
    }
  }

  function dismiss() {
    resetEnroll();
    setRevealed(null);
    setCopyNote(null);
  }

  async function confirmRevoke(bridgeId: string) {
    setRevokeError(null);
    try {
      await revoke.mutateAsync({ branchId, bridgeId });
      setConfirming(null);
      refresh();
    } catch (error) {
      setRevokeError(errorMessage(error, 'The bridge was not revoked. Try again.'));
    }
  }

  const nameError = `${ids}-name-error`;
  const targetHint = `${ids}-target-hint`;
  const targetError = `${ids}-target-error`;

  return (
    <>
      {revealed ? (
        <section
          aria-labelledby={`${ids}-credential`}
          className="space-y-3 rounded-md border border-border-strong bg-surface-page px-4 py-4"
        >
          <h3 id={`${ids}-credential`} className="text-sm font-semibold text-text-strong">
            Credential for {revealed.bridgeName} — shown once
          </h3>
          <p className="text-sm text-text-body">{revealed.notice}</p>
          <p className="text-sm text-text-body">
            Anyone with this credential can collect this branch’s print jobs. Don’t paste it into
            chat or email.
          </p>
          <label htmlFor={`${ids}-secret`} className="block text-sm font-semibold text-text-strong">
            Bridge credential
          </label>
          <input
            id={`${ids}-secret`}
            readOnly
            value={revealed.credential}
            autoComplete="off"
            spellCheck={false}
            className={`${FIELD} font-mono`}
            onFocus={(event) => event.currentTarget.select()}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="touch"
              variant="outline"
              onClick={() => void copy(revealed.credential)}
            >
              Copy credential
            </Button>
            <Button type="button" size="touch" onClick={dismiss}>
              I’ve stored it
            </Button>
          </div>
          {copyNote ? (
            <p role="status" className="text-sm text-text-body">
              {copyNote}
            </p>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby={`${ids}-manage`} className="space-y-3">
        <h3 id={`${ids}-manage`} className="text-sm font-semibold text-text-strong">
          Enrolled bridges
        </h3>
        {list.isPending ? (
          <p role="status" className="text-sm text-text-muted">
            Loading enrolled bridges…
          </p>
        ) : list.isError ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-text-body">
              {errorCode(list.error) === 'FORBIDDEN'
                ? 'Only a workspace administrator can manage print bridges.'
                : 'Enrolled bridges could not be loaded. Nothing was changed.'}
            </p>
            {errorCode(list.error) !== 'FORBIDDEN' ? (
              <Button
                type="button"
                size="touch"
                variant="outline"
                onClick={() => void list.refetch()}
              >
                Try again
              </Button>
            ) : null}
          </div>
        ) : !list.data?.length ? (
          <p className="text-sm text-text-muted">No bridge has been enrolled for {branchName}.</p>
        ) : (
          <ul className="space-y-2" aria-label={`Enrolled bridges for ${branchName}`}>
            {list.data.map((bridge) => {
              const revoked = bridge.status === 'REVOKED';
              return (
                <li
                  key={bridge.id}
                  className={
                    revoked
                      ? 'space-y-3 rounded-md border border-border-subtle bg-surface-sunken px-4 py-3 text-text-muted'
                      : 'space-y-3 rounded-md border border-border-subtle bg-surface-page px-4 py-3'
                  }
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="min-w-0 space-y-0.5">
                      <span
                        className={`block text-sm font-semibold break-words ${revoked ? 'text-text-muted' : 'text-text-strong'}`}
                      >
                        {bridge.name}
                      </span>
                      <span className="block font-mono text-xs break-all text-text-muted">
                        {bridge.printerId}
                      </span>
                      <span className="block font-mono text-xs text-text-muted">
                        Enrolled <time dateTime={bridge.createdAt}>{when(bridge.createdAt)}</time>
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      <StatusPill
                        status={bridge.status}
                        tone={revoked ? 'neutral' : 'success'}
                        label={revoked ? 'Revoked' : 'Active'}
                      />
                      {!revoked && confirming !== bridge.id ? (
                        <Button
                          type="button"
                          size="touch"
                          variant="outline"
                          onClick={() => {
                            setConfirming(bridge.id);
                            setRevokeError(null);
                          }}
                        >
                          Revoke…
                        </Button>
                      ) : null}
                    </span>
                  </div>
                  {!revoked && confirming === bridge.id ? (
                    <div
                      role="group"
                      aria-labelledby={`${ids}-confirm-${bridge.id}`}
                      className="space-y-3 border-t border-border-subtle pt-3"
                    >
                      <p id={`${ids}-confirm-${bridge.id}`} className="text-sm text-text-body">
                        Revoke {bridge.name}? Its credential stops working and jobs stop going to
                        this bridge straight away. To use that computer again, enroll it as a new
                        bridge and store the new credential on it.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="touch"
                          variant="destructive"
                          disabled={revoke.isPending}
                          onClick={() => void confirmRevoke(bridge.id)}
                        >
                          {revoke.isPending ? 'Revoking…' : 'Revoke bridge'}
                        </Button>
                        <Button
                          type="button"
                          size="touch"
                          variant="outline"
                          disabled={revoke.isPending}
                          onClick={() => {
                            setConfirming(null);
                            setRevokeError(null);
                          }}
                        >
                          Keep bridge
                        </Button>
                      </div>
                      {revokeError ? (
                        <p role="alert" className="text-sm text-destructive">
                          {revokeError}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby={`${ids}-enroll`} className="space-y-3">
        <h3 id={`${ids}-enroll`} className="text-sm font-semibold text-text-strong">
          Enroll a bridge
        </h3>
        <form
          noValidate
          className="grid max-w-2xl gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-2">
            <label htmlFor={`${ids}-name`} className="block text-sm font-semibold text-text-strong">
              Bridge name
            </label>
            <input
              id={`${ids}-name`}
              className={FIELD}
              value={name}
              maxLength={80}
              autoComplete="off"
              placeholder="Front counter"
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? nameError : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setErrors((prev) => ({ ...prev, name: undefined, form: undefined }));
              }}
            />
            {errors.name ? (
              <p id={nameError} className="text-sm text-destructive">
                {errors.name}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <label
              htmlFor={`${ids}-connection`}
              className="block text-sm font-semibold text-text-strong"
            >
              Connection
            </label>
            <select
              id={`${ids}-connection`}
              className={FIELD}
              value={connection}
              onChange={(event) => setConnection(event.target.value as ConnectionValue)}
            >
              {CONNECTIONS.map((row) => (
                <option key={row.value} value={row.value}>
                  {row.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <label
              htmlFor={`${ids}-target`}
              className="block text-sm font-semibold text-text-strong"
            >
              Printer target
            </label>
            <input
              id={`${ids}-target`}
              className={`${FIELD} font-mono`}
              value={target}
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
              placeholder={preset.placeholder}
              aria-invalid={errors.target ? true : undefined}
              aria-describedby={errors.target ? `${targetError} ${targetHint}` : targetHint}
              onChange={(event) => {
                setTarget(event.target.value);
                setErrors((prev) => ({ ...prev, target: undefined, form: undefined }));
              }}
            />
            <p id={targetHint} className="text-xs text-text-muted">
              {preset.hint} For example {preset.placeholder}. The bridge computer checks the target
              again before sending anything; enrolling does not test the printer.
            </p>
            {errors.target ? (
              <p id={targetError} className="text-sm text-destructive">
                {errors.target}
              </p>
            ) : null}
          </div>
          {errors.form ? (
            <p role="alert" className="text-sm text-destructive">
              {errors.form}
            </p>
          ) : null}
          <div>
            <Button type="submit" size="touch" disabled={enroll.isPending}>
              {enroll.isPending ? 'Enrolling…' : 'Enroll bridge'}
            </Button>
          </div>
        </form>
      </section>
    </>
  );
}
