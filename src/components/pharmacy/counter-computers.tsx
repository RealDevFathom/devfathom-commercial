'use client';

import { useCallback, useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { unsettledCommands } from '@/lib/pharmacy/counter-command-queue';
import {
  forgetCounterEnrolment,
  indexedDbDeviceKeyBackend,
  readCounterEnrolment,
  saveCounterEnrolment,
  type CounterEnrolment,
} from '@/lib/pharmacy/counter-device-store';
import { importCounterSigningKey } from '@/lib/pharmacy/counter-device-signing';
import {
  openCounterRuntime,
  prepareCounterForOffline,
  type PrepareGrant,
  type PrepareReport,
} from '@/lib/pharmacy/counter-offline-session';
import {
  bindCounterBrowser,
  counterSetupMessage,
  unbindCounterBrowser,
} from '@/lib/pharmacy/counter-offline-transport';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { clearCounterShell } from '@/lib/pharmacy/counter-shell';
import { ed25519Supported } from '@/lib/pharmacy/counter-snapshot-verifier';
import { trpc } from '@/lib/trpc';

import {
  browserCounterOfflineDeps,
  useCounterEnrolment,
} from './counter/use-counter-offline';

const controlClass =
  'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-body outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60';

type Notice = { tone: 'status' | 'alert'; text: string };

function errorText(error: unknown, fallback: string): string {
  const code = (error as { data?: { code?: string } } | null)?.data?.code;
  if (code === 'FORBIDDEN')
    return 'Your account cannot manage the counters of this branch. Ask the owner to assign you to it.';
  if (code === 'CONFLICT') return 'This counter is revoked, so it cannot be changed any more.';
  if (code === 'NOT_FOUND') return 'This counter no longer exists at this branch. Refresh the list.';
  return fallback;
}

function when(value: string | null, empty: string): string {
  if (!value) return empty;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? empty : date.toLocaleString();
}

function NoticeLine({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <p
      role={notice.tone}
      className={notice.tone === 'alert' ? 'text-sm text-destructive' : 'text-sm text-text-body'}
    >
      {notice.text}
    </p>
  );
}

/**
 * Bind a secret enrol/rotate just returned to THIS browser: a non-extractable
 * signing key in its own IndexedDB store and the httpOnly device cookie. The
 * string is dropped when this function returns; it is never written anywhere.
 */
async function adoptSecretOnThisComputer(
  secret: string,
  enrolment: CounterEnrolment
): Promise<void> {
  const signingKey = await importCounterSigningKey(secret);
  await bindCounterBrowser(secret);
  await saveCounterEnrolment(indexedDbDeviceKeyBackend(), { ...enrolment, signingKey });
}

/** Everything this browser holds as the counter, gone: data, key, cookie, stored page. */
async function forgetThisComputer(enrolment: CounterEnrolment): Promise<void> {
  try {
    const opened = await openCounterRuntime(enrolment, browserCounterOfflineDeps(), false);
    await opened.runtime.revoke();
    opened.runtime.close();
  } catch {
    // Nothing stored, or storage blocked: there is nothing left to purge.
  }
  await forgetCounterEnrolment(indexedDbDeviceKeyBackend(), enrolment.organizationId).catch(
    () => undefined
  );
  await unbindCounterBrowser().catch(() => undefined);
  await clearCounterShell();
}

/** Sales this browser composed offline and has not sent yet. */
async function unsentOnThisComputer(enrolment: CounterEnrolment): Promise<number | null> {
  try {
    const opened = await openCounterRuntime(enrolment, browserCounterOfflineDeps(), false);
    const queue = opened.runtime.snapshot().queue;
    opened.runtime.close();
    // An unreadable document may hold unsent sales nobody can count: say so.
    if (opened.hydrated === 'unrecoverable') return null;
    return queue ? unsettledCommands(queue).length : 0;
  } catch {
    return null;
  }
}

function EnrolThisComputer({
  organizationId,
  branchId,
  branchName,
  onDone,
}: {
  organizationId: string;
  branchId: string;
  branchName: string;
  onDone: (message: string) => void;
}) {
  const enroll = trpc.pharmacyOffline.enroll.useMutation({ retry: false, gcTime: 0 });
  const revoke = trpc.pharmacyOffline.revoke.useMutation({ retry: false });
  const [name, setName] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const busy = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || !name.trim()) return;
    busy.current = true;
    setNotice(null);
    try {
      if (typeof indexedDB === 'undefined' || !(await ed25519Supported())) {
        setNotice({
          tone: 'alert',
          text: 'This browser cannot keep a counter key or check a signed price list, so it cannot be an offline counter. Use an up-to-date Chrome, Edge or Firefox. Nothing was enrolled.',
        });
        return;
      }
      const result = await enroll.mutateAsync({ branchId, name: name.trim() });
      const enrolment: CounterEnrolment = {
        organizationId,
        branchId: result.device.branchId,
        deviceId: result.device.id,
        name: result.device.name,
        enrolledAt: new Date().toISOString(),
      };
      try {
        await adoptSecretOnThisComputer(result.secret, enrolment);
      } catch (error) {
        // Never leave a usable counter nobody holds: revoke the one just made.
        await revoke.mutateAsync({ branchId, deviceId: result.device.id }).catch(() => undefined);
        setNotice({
          tone: 'alert',
          text: `${counterSetupMessage(error)} Enrolment did not finish on this computer, so the new counter was revoked.`,
        });
        return;
      }
      setName('');
      // This form unmounts once the browser is enrolled, so the parent says it.
      onDone(
        `This computer is now the counter ${enrolment.name} of ${branchName}. Prepare it for offline below.`
      );
    } catch (error) {
      setNotice({
        tone: 'alert',
        text: errorText(error, 'This computer was not enrolled. Check the connection and try again.'),
      });
    } finally {
      busy.current = false;
      enroll.reset();
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <p className="max-w-prose text-sm text-text-muted">
        Enrol the computer you are using now as a counter of {branchName}. Its drawer, receipt
        numbers and offline price list then belong to this counter. Enrol before the shift starts:
        a drawer already open on this computer stays under its old name until it is closed.
      </p>
      <div className="max-w-md">
        <Label htmlFor="counter-computer-name">Counter name</Label>
        <Input
          id="counter-computer-name"
          className="mt-1 min-h-11 bg-surface-raised"
          value={name}
          maxLength={100}
          required
          placeholder="Front counter 1"
          disabled={enroll.isPending}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <Button type="submit" className="min-h-11" disabled={enroll.isPending || !name.trim()}>
        {enroll.isPending ? 'Enrolling…' : 'Enrol this computer'}
      </Button>
      <NoticeLine notice={notice} />
    </form>
  );
}

type PlanLot = {
  inventoryLotId: string;
  stockLocationId: string;
  locationName: string;
  medicineName: string;
  batchNumber: string | null;
  expiresAt: string;
  unitsPerPack: number;
  printedMrpMinor: number;
  onHandUnits: number;
  freeUnits: number;
  heldUnits: number;
  suggestedUnits: number;
};

function PrepareThisComputer({
  enrolment,
  branchName,
  onDone,
}: {
  enrolment: CounterEnrolment;
  branchName: string;
  onDone: () => void;
}) {
  const plan = trpc.pharmacyOffline.preparationPlan.useQuery(
    { branchId: enrolment.branchId, deviceId: enrolment.deviceId },
    { retry: false, staleTime: 0 }
  );
  const [units, setUnits] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<PrepareReport | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const lots: PlanLot[] = plan.data?.lots ?? [];
  const keyOf = (lot: PlanLot) => `${lot.inventoryLotId}:${lot.stockLocationId}`;
  const unitsFor = (lot: PlanLot) => units[keyOf(lot)] ?? String(lot.suggestedUnits);
  const invalid = lots.filter((lot) => {
    const value = unitsFor(lot).trim();
    if (value === '') return true;
    if (!/^\d+$/.test(value)) return true;
    return Number(value) > lot.freeUnits;
  });

  async function prepare() {
    if (running || invalid.length) return;
    setRunning(true);
    setNotice(null);
    setReport(null);
    try {
      const record = await readCounterEnrolment(indexedDbDeviceKeyBackend(), enrolment.organizationId);
      if (!record || record.deviceId !== enrolment.deviceId) {
        setNotice({
          tone: 'alert',
          text: "This computer's counter key is missing from the browser. Revoke this counter and enrol the computer again.",
        });
        return;
      }
      const deps = browserCounterOfflineDeps();
      const opened = await openCounterRuntime(record, deps, true);
      if (opened.hydrated === 'unrecoverable') {
        opened.runtime.close();
        setNotice({
          tone: 'alert',
          text: 'The offline data on this computer cannot be read, so nothing was reserved or changed. Revoke this counter and enrol the computer again.',
        });
        return;
      }
      if (!opened.sessionToken) {
        opened.runtime.close();
        setNotice({ tone: 'alert', text: counterSetupMessage(opened.error) });
        return;
      }
      const grants: PrepareGrant[] = lots
        .map((lot) => ({
          inventoryLotId: lot.inventoryLotId,
          stockLocationId: lot.stockLocationId,
          units: Number(unitsFor(lot).trim()),
        }))
        .filter((grant) => grant.units > 0);
      const result = await prepareCounterForOffline(opened.runtime, opened.sessionToken, deps, {
        grants,
      });
      opened.runtime.close();
      setReport(result);
      setUnits({});
      onDone();
      void plan.refetch();
    } catch (error) {
      setNotice({ tone: 'alert', text: counterSetupMessage(error) });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="max-w-prose text-sm text-text-muted">
        Reserves a block of receipt numbers for this counter and earmarks, for each listed
        over-the-counter batch, the units this counter may sell while the connection is down
        (suggested: half the units on hand, at most 20). Other counters cannot be given the same
        units. Until offline selling is switched on, online sales can still sell them.
        Prescription-only, controlled, restricted, high-alert and look-alike medicines are never
        listed. Revoking the counter hands its earmarked units back.
      </p>
      {plan.isLoading ? (
        <p className="text-sm text-text-muted" role="status">
          Loading the stock {branchName} can set aside…
        </p>
      ) : plan.isError ? (
        <div className="space-y-3">
          <p className="text-sm text-destructive" role="alert">
            {errorText(plan.error, 'The stock list could not be loaded. Nothing was changed.')}
          </p>
          <Button
            className="min-h-11"
            type="button"
            variant="outline"
            onClick={() => void plan.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : lots.length === 0 ? (
        <p className="text-sm text-text-body">
          No over-the-counter stock at {branchName} can be set aside for offline selling now. Receive
          stock first, or check that medicines are marked saleable.
        </p>
      ) : (
        <div className="max-h-[28rem] overflow-auto rounded-[var(--radius-sm)] border border-border-subtle">
          <table className="w-full min-w-[40rem] text-sm">
            <caption className="sr-only">Stock to set aside for offline selling</caption>
            <thead className="sticky top-0 bg-surface-sunken">
              <tr className="text-left">
                <th className="eyebrow px-3 py-2 font-normal">Medicine and batch</th>
                <th className="eyebrow px-3 py-2 text-right font-normal">Pack price</th>
                <th className="eyebrow px-3 py-2 text-right font-normal">On hand</th>
                <th className="eyebrow px-3 py-2 text-right font-normal">Free</th>
                <th className="eyebrow px-3 py-2 text-right font-normal">Set aside (units)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {lots.map((lot) => {
                const fieldId = `offline-units-${keyOf(lot)}`;
                const bad = invalid.includes(lot);
                return (
                  <tr key={keyOf(lot)} className="hover:bg-surface-sunken">
                    <td className="px-3 py-2">
                      <p className="font-medium text-text-strong">{lot.medicineName}</p>
                      <p className="text-xs text-text-muted">
                        Batch {lot.batchNumber ?? 'not recorded'} · {lot.locationName} · expires{' '}
                        {lot.expiresAt.slice(0, 10)}
                        {lot.heldUnits > 0 ? ` · this counter holds ${lot.heldUnits}` : ''}
                      </p>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      Rs {formatMinor(lot.printedMrpMinor)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{lot.onHandUnits}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{lot.freeUnits}</td>
                    <td className="px-3 py-2 text-right">
                      <Label htmlFor={fieldId} className="sr-only">
                        Units of {lot.medicineName} to set aside
                      </Label>
                      <Input
                        id={fieldId}
                        inputMode="numeric"
                        className="ml-auto min-h-11 w-24 bg-surface-raised text-right tabular-nums"
                        value={unitsFor(lot)}
                        aria-invalid={bad || undefined}
                        aria-describedby={bad ? `${fieldId}-error` : undefined}
                        disabled={running}
                        onChange={(event) =>
                          setUnits((current) => ({ ...current, [keyOf(lot)]: event.target.value }))
                        }
                      />
                      {bad ? (
                        <p id={`${fieldId}-error`} className="mt-1 text-xs text-destructive">
                          Whole units, at most {lot.freeUnits}.
                        </p>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {plan.data && lots.length >= plan.data.limit ? (
        <p className="text-sm text-text-muted">
          The first {plan.data.limit} batches, soonest expiry first, are listed. Prepare again
          afterwards to set aside more.
        </p>
      ) : null}
      <Button
        type="button"
        className="min-h-11"
        disabled={running || plan.isLoading || invalid.length > 0}
        onClick={() => void prepare()}
      >
        {running ? 'Preparing…' : 'Prepare this counter for offline'}
      </Button>
      {report ? (
        <div role="status" className="space-y-1 text-sm text-text-body">
          <p>
            {report.receipts === 'FAILED'
              ? 'Receipt numbers could not be reserved. '
              : report.receipts === 'RESERVED'
                ? 'A new block of receipt numbers was reserved. '
                : ''}
            This counter now holds {report.receiptNumbersLeft} receipt numbers and stock of{' '}
            {report.granted} more batch{report.granted === 1 ? '' : 'es'}.
          </p>
          {report.refused.length ? (
            <p>
              {report.refused.length} batch{report.refused.length === 1 ? ' was' : 'es were'} not
              set aside: {counterSetupMessage(report.refused[0]!.error)}
            </p>
          ) : null}
          {report.snapshots?.refused.length ? (
            <p>
              Part of the signed price list failed its check and was not used. Prepare again to
              fetch a fresh one.
            </p>
          ) : null}
        </div>
      ) : null}
      <NoticeLine notice={notice} />
    </div>
  );
}

type CounterRow = {
  id: string;
  name: string;
  status: 'ACTIVE' | 'REVOKED';
  revokedAt: string | null;
  lastSeenAt: string | null;
  enrolledAt: string;
  receiptNumbersLeft: number;
  offlineUnitsLeft: number;
  failedOfflineSales: number;
};

function BranchCounters({
  organizationId,
  branchId,
  branchName,
}: {
  organizationId: string;
  branchId: string;
  branchName: string;
}) {
  const utils = trpc.useUtils();
  const counters = trpc.pharmacyOffline.counters.useQuery({ branchId }, { retry: false });
  const rotate = trpc.pharmacyOffline.rotate.useMutation({ retry: false, gcTime: 0 });
  const revoke = trpc.pharmacyOffline.revoke.useMutation({ retry: false });
  const enrolment = useCounterEnrolment(organizationId);
  const thisComputer = enrolment && enrolment.branchId === branchId ? enrolment : null;
  const [confirming, setConfirming] = useState<{ id: string; unsent: number | null } | null>(
    null
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const busy = useRef(false);
  const refresh = useCallback(
    () => void utils.pharmacyOffline.counters.invalidate({ branchId }),
    [utils, branchId]
  );

  async function askRevoke(row: CounterRow) {
    setNotice(null);
    const unsent =
      thisComputer?.deviceId === row.id ? await unsentOnThisComputer(thisComputer) : null;
    setConfirming({ id: row.id, unsent });
  }

  async function confirmRevoke(row: CounterRow) {
    if (busy.current) return;
    busy.current = true;
    try {
      await revoke.mutateAsync({ branchId, deviceId: row.id });
      if (thisComputer?.deviceId === row.id) await forgetThisComputer(thisComputer);
      setNotice({
        tone: 'status',
        text: `${row.name} is revoked. The server refuses everything it sends from now on.`,
      });
    } catch (error) {
      setNotice({
        tone: 'alert',
        text: errorText(error, `${row.name} was not revoked. Refresh the list, then try again.`),
      });
    } finally {
      busy.current = false;
      setConfirming(null);
      refresh();
    }
  }

  async function rotateThisComputer(row: CounterRow) {
    if (busy.current || !thisComputer || thisComputer.deviceId !== row.id) return;
    busy.current = true;
    setNotice(null);
    try {
      const result = await rotate.mutateAsync({ branchId, deviceId: row.id });
      try {
        await adoptSecretOnThisComputer(result.secret, thisComputer);
        setNotice({
          tone: 'status',
          text: `${row.name} has a new credential. The old one no longer works anywhere.`,
        });
      } catch (error) {
        setNotice({
          tone: 'alert',
          text: `${counterSetupMessage(error)} The new credential could not be kept on this computer, so the old one no longer works either. Revoke this counter and enrol the computer again.`,
        });
      }
    } catch (error) {
      setNotice({
        tone: 'alert',
        text: errorText(error, 'The credential was not rotated. Nothing was changed.'),
      });
    } finally {
      busy.current = false;
      rotate.reset();
      refresh();
    }
  }

  const rows: CounterRow[] = counters.data ?? [];
  const pending = rotate.isPending || revoke.isPending;

  return (
    <div className="space-y-4">
      {counters.isLoading ? (
        <p className="text-sm text-text-muted" role="status">
          Loading counters…
        </p>
      ) : counters.isError ? (
        <div className="space-y-3">
          <p className="text-sm text-destructive" role="alert">
            {errorText(counters.error, 'Counters could not be loaded.')}
          </p>
          <Button
            className="min-h-11"
            type="button"
            variant="outline"
            onClick={() => void counters.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-text-body">
          No counter is enrolled at {branchName} yet. Enrol this computer above to start.
        </p>
      ) : (
        <ul aria-label={`Counters of ${branchName}`} className="divide-y divide-border-subtle">
          {rows.map((row) => {
            const mine = thisComputer?.deviceId === row.id;
            return (
              <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 space-y-1">
                  <p className="break-words text-sm font-semibold text-text-strong">{row.name}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {row.status === 'REVOKED' ? (
                      <StatusPill status="revoked" tone="neutral" label="Revoked" />
                    ) : (
                      <StatusPill status="active" tone="success" label="Active" />
                    )}
                    {mine ? (
                      <StatusPill status="this-computer" tone="neutral" label="This computer" />
                    ) : null}
                    {row.failedOfflineSales > 0 ? (
                      <StatusPill
                        status="needs-manager"
                        tone="warning"
                        label={`${row.failedOfflineSales} offline sale${row.failedOfflineSales === 1 ? '' : 's'} need a manager`}
                      />
                    ) : null}
                  </div>
                  <p className="text-xs text-text-muted">
                    Enrolled {when(row.enrolledAt, 'unknown')} ·{' '}
                    {row.status === 'REVOKED'
                      ? `revoked ${when(row.revokedAt, 'unknown')}`
                      : `${row.receiptNumbersLeft} receipt numbers and ${row.offlineUnitsLeft} offline units held`}{' '}
                    · last seen {when(row.lastSeenAt, 'not recorded yet')}
                  </p>
                </div>
                {row.status === 'ACTIVE' ? (
                  confirming?.id === row.id ? (
                    <div
                      className="flex max-w-xl flex-wrap items-center gap-2"
                      onKeyDown={(event) => {
                        if (event.key === 'Escape' && !pending) setConfirming(null);
                      }}
                    >
                      <p className="text-sm text-text-body" id={`revoke-counter-${row.id}`}>
                        {mine
                          ? confirming.unsent === null
                            ? 'Revoke this computer? Offline data on it could not be read; any sale it has not sent yet is lost.'
                            : confirming.unsent > 0
                              ? `This computer holds ${confirming.unsent} offline sale${confirming.unsent === 1 ? '' : 's'} not sent yet. Revoking deletes ${confirming.unsent === 1 ? 'it' : 'them'} from this computer and the server will refuse ${confirming.unsent === 1 ? 'it' : 'them'}. Connect and let ${confirming.unsent === 1 ? 'it' : 'them'} send first if you can.`
                              : 'Revoke this computer? It holds no unsent offline sales.'
                          : `Revoke ${row.name}? Sales it made offline and has not sent yet will be refused by the server. Let it come online and send them first if you can.`}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        autoFocus
                        disabled={pending}
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        className="min-h-11"
                        aria-describedby={`revoke-counter-${row.id}`}
                        disabled={pending}
                        onClick={() => void confirmRevoke(row)}
                      >
                        {revoke.isPending ? 'Revoking…' : 'Confirm revoke'}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {mine ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          disabled={pending}
                          onClick={() => void rotateThisComputer(row)}
                        >
                          {rotate.isPending ? 'Rotating…' : 'Rotate credential'}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        disabled={pending}
                        onClick={() => void askRevoke(row)}
                      >
                        Revoke
                      </Button>
                    </div>
                  )
                ) : mine ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={pending}
                    onClick={() =>
                      void forgetThisComputer(thisComputer!).then(
                        () =>
                          setNotice({
                            tone: 'status',
                            text: 'This computer no longer holds the revoked counter. You can enrol it again.',
                          })
                      )
                    }
                  >
                    Remove from this computer
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-text-muted">
        A counter&apos;s credential is rotated from the computer that holds it. Another computer is
        revoked here and enrolled again from that computer.
      </p>
      <NoticeLine notice={notice} />
    </div>
  );
}

/**
 * DEV-957 phase 1: enrol this computer as a pharmacy counter, list the branch's
 * counters, rotate and revoke them, and prepare this counter for offline. Every
 * procedure is administrator-only and branch-scoped on the server; `canManage`
 * only avoids a dead end for everyone else.
 */
export function PharmacyCounterComputersConsole({
  canManage,
  organizationId,
}: {
  canManage: boolean;
  organizationId: string;
}) {
  const utils = trpc.useUtils();
  const branchesQuery = trpc.pharmacySales.counterBranches.useQuery(undefined, {
    staleTime: 60_000,
    enabled: canManage,
  });
  const enrolment = useCounterEnrolment(organizationId);
  const branches = branchesQuery.data?.branches ?? [];
  const [selected, setSelected] = useState('');
  const preferred = enrolment?.branchId ?? '';
  const branchId = branches.some((branch) => branch.id === selected)
    ? selected
    : branches.some((branch) => branch.id === preferred)
      ? preferred
      : (branches[0]?.id ?? '');
  const branch = branches.find((candidate) => candidate.id === branchId);
  const refreshCounters = useCallback(
    () => void utils.pharmacyOffline.counters.invalidate(),
    [utils]
  );
  const [enrolledNotice, setEnrolledNotice] = useState<string | null>(null);

  if (!canManage)
    return (
      <SectionCard title="Counter computers" titleLevel={2}>
        <p className="text-sm text-text-body">
          Only a workspace administrator can enrol, prepare or revoke counter computers. Ask the
          owner or a manager with administrator access.
        </p>
      </SectionCard>
    );
  if (branchesQuery.isLoading)
    return (
      <SectionCard title="Counter computers" titleLevel={2}>
        <p className="text-sm text-text-muted" role="status">
          Loading branches…
        </p>
      </SectionCard>
    );
  if (branchesQuery.isError || !branch)
    return (
      <SectionCard title="Counter computers" titleLevel={2}>
        <p
          className={branchesQuery.isError ? 'text-sm text-destructive' : 'text-sm text-text-body'}
          role={branchesQuery.isError ? 'alert' : undefined}
        >
          {branchesQuery.isError
            ? 'Branches could not be loaded. Reload the page to try again.'
            : 'No active pharmacy branch is available. Add or activate a branch first.'}
        </p>
      </SectionCard>
    );

  const enrolledHere = enrolment && enrolment.branchId === branchId ? enrolment : null;
  const enrolledElsewhere = enrolment && !enrolledHere ? enrolment : null;

  return (
    <>
      <SectionCard title="This computer" titleLevel={2}>
        <div className="space-y-6">
          <div className="max-w-md">
            <Label htmlFor="counter-computers-branch">Branch</Label>
            <select
              id="counter-computers-branch"
              className={controlClass}
              value={branchId}
              onChange={(event) => setSelected(event.target.value)}
            >
              {branches.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} ({option.code})
                </option>
              ))}
            </select>
          </div>
          {enrolledHere ? (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status="enrolled" tone="success" label="Enrolled" />
                <p className="text-sm text-text-body">
                  This computer is the counter{' '}
                  <span className="font-semibold text-text-strong">{enrolledHere.name}</span> of{' '}
                  {branch.name}.
                </p>
              </div>
              {enrolledNotice ? (
                <p role="status" className="text-sm text-text-body">
                  {enrolledNotice}
                </p>
              ) : null}
              <div className="space-y-4 border-t border-border-subtle pt-6">
                <h3 className="text-base font-semibold text-text-strong">
                  Prepare this counter for offline
                </h3>
                <PrepareThisComputer
                  key={enrolledHere.deviceId}
                  enrolment={enrolledHere}
                  branchName={branch.name}
                  onDone={refreshCounters}
                />
              </div>
            </div>
          ) : enrolledElsewhere ? (
            <p className="text-sm text-text-body">
              This computer is already the counter {enrolledElsewhere.name} of another branch. To
              move it here, revoke it at that branch first, then enrol it here.
            </p>
          ) : (
            <EnrolThisComputer
              organizationId={organizationId}
              branchId={branchId}
              branchName={branch.name}
              onDone={(message) => {
                setEnrolledNotice(message);
                refreshCounters();
              }}
            />
          )}
        </div>
      </SectionCard>
      <SectionCard title={`Counters of ${branch.name}`} titleLevel={2}>
        <BranchCounters
          key={branchId}
          organizationId={organizationId}
          branchId={branchId}
          branchName={branch.name}
        />
      </SectionCard>
    </>
  );
}
