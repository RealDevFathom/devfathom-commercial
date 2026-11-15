'use client';

import { tenderTotalsSchema } from '@/lib/pharmacy/manual-payments';

import { useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useEntitlements } from '@/components/entitlements-provider';
import { evaluateSessionUser } from '@/lib/auth/session-state';
import { isModuleGranted } from '@/lib/module-catalog';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { CashCloseCheckPanel } from './cash-close-check-panel';
import { formatMinor, type CounterReceiptLocale } from '@/lib/pharmacy/counter-receipt';
import { printCounterBrowserZReport } from '@/lib/pharmacy/counter-browser-print';
import { counterErrorMessage } from '@/lib/pharmacy/counter-messages';
import { workspaceTimezone, workspaceToday } from '@/lib/timezone';

/**
 * "Opened 09:12 by Ayesha Karim", or just the time when the opener is no longer a
 * member. The time is read in the workspace's zone, never the viewer's browser's;
 * a stored zone the browser refuses reads as UTC rather than taking the screen down.
 */
export function drawerOpenedLabel(
  drawer: { openedAt: Date | string; openedBy: string | null },
  timeZone: string
): string {
  const time = new Date(drawer.openedAt).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: workspaceTimezone(timeZone),
  });
  return drawer.openedBy ? `Opened ${time} by ${drawer.openedBy}` : `Opened ${time}`;
}

export function cashMinor(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) && amount <= 2147483647 ? amount : null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Optional deep link (e.g. Ask Fathom's cash-close drill-through): the branch and
// business day to open on. An unknown branch or malformed day falls back to defaults.
export type DayCloseInitial = { branch?: string; date?: string };

export function PharmacyDayCloseConsole({ initial }: { initial?: DayCloseInitial } = {}) {
  const { data: session, status } = useSession();
  const entitlements = useEntitlements();
  const user = session?.user;
  const sessionVerdict = evaluateSessionUser(user);
  const isAdmin = user?.role === 'ADMIN';
  const memberSession =
    status === 'authenticated' &&
    sessionVerdict.ok &&
    !isAdmin &&
    Boolean(user?.id) &&
    user?.organizationId === entitlements.organizationId &&
    isModuleGranted('pharmacy-counter', entitlements.enabledModules);
  // DEV-127: a non-administrator opens the console only when the server's own
  // day-close guard (`pharmacy:close` through the ABAC engine) admits them. The
  // procedures re-check it on every call; this only avoids a dead-end screen.
  const access = trpc.pharmacyAccess.navigation.useQuery(undefined, {
    enabled: memberSession,
    // As the rail does: a transient failure is retried; only a refusal is final.
    retry: (failures, error) => failures < 2 && error.data?.code !== 'FORBIDDEN',
    staleTime: 30_000,
  });
  // A cached answer for another signed-in identity cannot open the console.
  const closeGranted = Boolean(
    memberSession &&
    access.data?.userId === user?.id &&
    access.data?.capabilities.includes('pharmacy:close')
  );
  if (
    status !== 'authenticated' ||
    !sessionVerdict.ok ||
    !(isAdmin || closeGranted) ||
    user?.organizationId !== entitlements.organizationId ||
    !isModuleGranted('pharmacy-counter', entitlements.enabledModules)
  ) {
    let detail =
      'This day-close screen requires day-close permission. Ask your workspace administrator to review your day-close permission.';
    if (status === 'loading') {
      detail = 'Checking day-close access…';
    } else if (status !== 'authenticated') {
      detail = 'Sign in to this pharmacy workspace to reconcile and close a day.';
    } else if (!sessionVerdict.ok) {
      detail = sessionVerdict.message;
    } else if (user?.organizationId !== entitlements.organizationId) {
      detail = 'Sign in to this pharmacy workspace to reconcile and close a day.';
    } else if (!isModuleGranted('pharmacy-counter', entitlements.enabledModules)) {
      detail =
        'The Pharmacy Counter module is not enabled for this workspace. Ask your workspace administrator to enable it for day close.';
    } else if (memberSession && access.isLoading) {
      detail = 'Checking day-close access…';
    } else if (memberSession && access.isError && access.error?.data?.code !== 'FORBIDDEN') {
      // A network or server failure is not a missing permission.
      detail = 'Could not check day-close access. Reload the page to try again.';
    }
    return (
      <SectionCard title="Day close unavailable">
        <p role="status">{detail}</p>
      </SectionCard>
    );
  }
  return (
    <DayCloseBranches
      key={`${user.organizationId}:${user.id}`}
      initial={initial}
      ownerView={isAdmin}
    />
  );
}

function DayCloseBranches({
  initial,
  ownerView,
}: {
  initial?: DayCloseInitial;
  /** The owner-only cash-close anomaly check is offered to administrators only. */
  ownerView: boolean;
}) {
  const branches = trpc.pharmacySales.counterBranches.useQuery();
  const [selected, setSelected] = useState('');
  const [picked, setPicked] = useState<string | null>(
    initial?.date && DAY.test(initial.date) ? initial.date : null
  );
  const timeZone = branches.data?.timezone;
  // Until the operator picks a day: today in the workspace's zone, settled once
  // the zone is known, so a page left open past midnight keeps its day.
  const today = useMemo(() => (timeZone ? workspaceToday(timeZone) : ''), [timeZone]);
  const date = picked ?? today;
  const linked = branches.data?.branches.find((b) => b.id === initial?.branch)?.id;
  const branchId = selected || linked || branches.data?.branches[0]?.id || '';
  const currency = branches.data?.currency;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={currency ? `Pharmacy · ${currency}` : 'Pharmacy'}
        heading="Day close"
        description="Reconcile each drawer, record any variance, then lock the business day."
      />
      <SectionCard title="Business day" titleLevel={2}>
        <div className="flex flex-wrap gap-4">
          <label className="grid gap-2">
            Branch
            <select
              className="min-h-11 rounded-sm border border-border-default bg-surface-card px-3 focus-visible:outline-2 focus-visible:outline-ring"
              value={branchId}
              onChange={(e) => setSelected(e.target.value)}
              disabled={branches.isLoading || !branches.data?.branches.length}
            >
              {branches.data?.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-2">
            Business date
            <Input
              className="min-h-11"
              type="date"
              value={date}
              onChange={(e) => setPicked(e.target.value)}
            />
          </label>
        </div>
        {branches.isLoading && <p role="status">Loading pharmacy branches…</p>}
        {branches.error && (
          <p role="alert">
            Could not load branches.{' '}
            <Button variant="outline" onClick={() => void branches.refetch()}>
              Retry branches
            </Button>
          </p>
        )}
        {branches.isSuccess && !branches.data.branches.length && (
          <p>No active pharmacy branches are available.</p>
        )}
      </SectionCard>
      {branchId && currency && /^\d{4}-\d{2}-\d{2}$/.test(date) && (
        <DayCloseForm
          key={`${branchId}:${date}`}
          branchId={branchId}
          date={date}
          currency={currency}
          ownerView={ownerView}
        />
      )}
    </div>
  );
}

function DayCloseForm({
  branchId,
  date,
  currency,
  ownerView,
}: {
  branchId: string;
  date: string;
  currency: string;
  ownerView: boolean;
}) {
  const input = { branchId, businessDate: new Date(`${date}T00:00:00.000Z`) };
  const preview = trpc.pharmacySales.closePreview.useQuery(input, { refetchOnWindowFocus: false });
  const close = trpc.pharmacySales.closeDay.useMutation();
  const reopen = trpc.pharmacySales.reopenDay.useMutation();
  const [reopenReason, setReopenReason] = useState('');
  const [reopenPin, setReopenPin] = useState('');
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [locale, setLocale] = useState<CounterReceiptLocale>('en');
  const [printMessage, setPrintMessage] = useState('');
  if (preview.isLoading)
    return (
      <SectionCard>
        <p role="status">Loading cash movements and recorded close…</p>
      </SectionCard>
    );
  if (preview.error || !preview.data)
    return (
      <SectionCard>
        <p role="alert">{preview.error?.message || 'Could not load this day.'}</p>
        <Button variant="outline" onClick={() => void preview.refetch()}>
          Retry preview
        </Button>
      </SectionCard>
    );
  const data = preview.data;
  // DEV-631: a close the owner reopened for trading no longer locks the day; the
  // form offers the next close, which supersedes it.
  const reopened = close.data ? null : (data.close?.reopen ?? null);
  const report = close.data ?? (reopened ? null : data.close);
  // Only today's business day can be reopened. Read from the clock on every render, not
  // memoized, so a page left open past midnight never offers yesterday's reopen.
  const isToday = date === workspaceToday(data.timezone);
  const reopenPinValid = /^\d{4,8}$/.test(reopenPin);
  // A close cut after a reopen records the variance note, not a re-cut reason.
  const followsReopen = close.data ? Boolean(data.close?.reopen) : Boolean(data.closeFollowsReopen);
  const tenderTotals = tenderTotalsSchema.parse((report ? report.tenderTotals : data.tenderTotals) ?? []);
  const expected = report?.cashExpectedMinor ?? data.totals.cashExpectedMinor;
  const open = data.drawers.filter((d) => d.status === 'OPEN');
  const valid = open.every((d) => cashMinor(counts[d.id] ?? '') !== null);
  const counted =
    report?.cashCountedMinor ??
    data.drawers.reduce(
      (sum, d) =>
        sum + (d.status === 'OPEN' ? (cashMinor(counts[d.id] ?? '') ?? 0) : (d.countedMinor ?? 0)),
      0
    );
  const variance = counted - expected;
  const hasVariance = data.drawers.some(
    (d) =>
      (d.status === 'OPEN' ? cashMinor(counts[d.id] ?? '') : d.countedMinor) !== d.expectedMinor
  );
  const busy = close.isPending || reopen.isPending || preview.isFetching;
  // The counted total runs live from whatever has been entered so far, so a
  // partly counted day shows its running sum rather than nothing; the variance
  // waits for every drawer, because a partial count against the full expected
  // cash would read as a shortfall that is not there.
  const uncounted = data.drawers
    .map((d, i) => ({ d, n: i + 1 }))
    .filter(({ d }) => d.status === 'OPEN' && cashMinor(counts[d.id] ?? '') === null)
    .map(({ n }) => n);
  const anyCounted =
    data.drawers.some((d) => d.status !== 'OPEN') || uncounted.length < open.length;
  // Why the close button is disabled, in the order the operator has to fix it.
  const blockers = report
    ? []
    : [
        uncounted.length
          ? `Enter the counted cash for drawer ${uncounted.join(', ')}.`
          : hasVariance && !note.trim()
            ? 'Add a variance note: a drawer count differs from expected cash.'
            : '',
        confirmed
          ? ''
          : 'Tick the confirmation that every drawer is counted and locking stops trading.',
        preview.isFetching && !close.isPending ? 'Wait for the preview to finish refreshing.' : '',
      ].filter(Boolean);
  return (
    <div className="space-y-6">
      <SectionCard
        title="Cash reconciliation"
        titleLevel={2}
        actions={
          <StatusPill
            status={report ? 'Day closed' : reopened ? 'Reopened for trading' : 'Open day'}
            tone={report ? 'success' : reopened ? 'warning' : 'neutral'}
          />
        }
      >
        <dl className="grid gap-4 sm:grid-cols-3">
          {[
            ['Expected cash', formatMinor(expected)],
            [
              'Counted cash',
              valid || report || anyCounted ? formatMinor(counted) : 'Awaiting count',
            ],
            ['Variance', valid || report ? formatMinor(variance) : 'Awaiting count'],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-sm text-text-muted">
                {label} · {currency}
              </dt>
              <dd className="font-mono text-xl tabular-nums" data-testid={label}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
        {!report && !valid && anyCounted && (
          <p className="mt-2 text-sm text-text-muted" role="status">
            Running total so far: {open.length - uncounted.length} of {open.length} open{' '}
            {open.length === 1 ? 'drawer' : 'drawers'} counted.
          </p>
        )}
        <div className="mt-4 space-y-2" aria-label="Tender totals">
          {tenderTotals.map((row) => (
            <div key={row.type} className="space-y-1">
              <p className="text-sm text-text-body">
                <span className="font-medium">{row.type}</span> · Received {formatMinor(row.amountMinor)}
                {' '}· Refunds {formatMinor(row.refundMinor)} · Net {formatMinor(row.netMinor)} {currency}
              </p>
              {row.confirmers?.length ? (
                <ul className="ps-4 text-sm text-text-muted" aria-label={`${row.type} confirmed by`}>
                  {row.confirmers.map((confirmer, index) => (
                    <li key={confirmer.id ?? `${confirmer.name}-${index}`}>
                      Confirmed by {confirmer.name} · {confirmer.count}{' '}
                      {confirmer.count === 1 ? 'payment' : 'payments'} ·{' '}
                      {formatMinor(confirmer.amountMinor)} {currency}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
        {report ? (
          <div className="mt-4 space-y-3">
            <p role="status">
              Day closed. New tenders and drawer changes for this business date are blocked.
            </p>
            <p>
              {isToday
                ? 'The owner can reopen today for trading with a reason and their PIN; the next close then supersedes this report.'
                : "Only today's business day can be reopened for trading. Record anything late on an open business day."}{' '}
              Someone with day-close permission can re-record this close report with a reason, but
              that alone never reopens the day.
            </p>
            <p>
              {(report.supersedesCloseId || report.sequence > 1) && !followsReopen
                ? 'Reopen reason'
                : 'Variance note'}
              : {report.reason || 'No variance recorded.'}
            </p>
            {!report.isFinal && <p>Provisional report: migration reconciliation is pending.</p>}
            <label className="grid gap-2">
              Report language
              <select
                className="min-h-11 rounded-sm border border-border-default bg-surface-card px-3"
                value={locale}
                onChange={(e) => setLocale(e.target.value as CounterReceiptLocale)}
              >
                <option value="en">English</option>
                <option value="ur">اردو</option>
              </select>
            </label>
            <Button
              variant="outline"
              onClick={() => {
                try {
                  printCounterBrowserZReport(
                    { ...report, branchName: data.branchName, businessDate: date, currency },
                    locale
                  );
                  setPrintMessage(
                    'Print dialog requested. Confirm physical printing in your browser.'
                  );
                } catch (error) {
                  setPrintMessage(
                    error instanceof Error ? error.message : 'Printing failed. Retry.'
                  );
                }
              }}
            >
              Print Z-report
            </Button>
            <p role="status">{printMessage}</p>
            {isToday && ownerView && (
              <form
                className="grid gap-3 rounded-md border border-border-subtle p-4"
                aria-label="Reopen today for trading"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!reopenReason.trim() || !reopenPinValid || busy) return;
                  reopen.mutate(
                    { ...input, reason: reopenReason, ownerPin: reopenPin },
                    {
                      // The PIN is never kept after an attempt, accepted or refused.
                      onSettled: () => setReopenPin(''),
                      onSuccess: () => {
                        close.reset();
                        setReopenReason('');
                        setCounts({});
                        setNote('');
                        setConfirmed(false);
                        void preview.refetch();
                      },
                    }
                  );
                }}
              >
                <p className="font-medium text-text-strong">Reopen today for trading</p>
                <p className="text-sm text-text-muted">
                  Counters can open drawers and take payments for {date} again until you close and
                  lock the day again. The reopen is recorded with your name, the time and the
                  reason.
                </p>
                <label className="grid gap-2">
                  Reason for reopening
                  <Input
                    className="min-h-11"
                    maxLength={1000}
                    value={reopenReason}
                    disabled={busy}
                    onChange={(e) => setReopenReason(e.target.value)}
                  />
                </label>
                <label className="grid gap-2">
                  Your owner PIN
                  <Input
                    className="min-h-11"
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={8}
                    value={reopenPin}
                    disabled={busy}
                    aria-invalid={reopenPin !== '' && !reopenPinValid}
                    aria-describedby="day-reopen-pin-help"
                    onChange={(e) => setReopenPin(e.target.value.replace(/\D/g, ''))}
                  />
                </label>
                <p id="day-reopen-pin-help" className="-mt-1 text-sm text-text-muted">
                  Re-enter your 4 to 8 digit staff PIN to confirm this reopen.
                </p>
                {reopen.error && <p role="alert">{counterErrorMessage(reopen.error)}</p>}
                <div>
                  <Button
                    className="min-h-11"
                    type="submit"
                    variant="outline"
                    disabled={busy || !reopenReason.trim() || !reopenPinValid}
                  >
                    {reopen.isPending ? 'Reopening…' : 'Reopen day for trading'}
                  </Button>
                </div>
              </form>
            )}
          </div>
        ) : (
          <form
            className="mt-6 space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!valid || !confirmed || busy || (hasVariance && !note.trim())) return;
              close.mutate({
                ...input,
                sourceHash: data.totals.sourceHash,
                counts: open.map((d) => ({
                  drawerSessionId: d.id,
                  countedCashMinor: cashMinor(counts[d.id] ?? '')!,
                })),
                varianceNote: note,
              });
            }}
          >
            {reopened && (
              <p
                className="rounded-md border border-warning/30 bg-warning/10 p-4 text-sm text-text-strong"
                role="status"
              >
                Reopened for trading at{' '}
                {new Date(reopened.createdAt).toLocaleTimeString('en-GB', {
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZone: workspaceTimezone(data.timezone),
                })}
                : {reopened.reason}. Close and lock the day again when trading ends.
              </p>
            )}
            {!data.drawers.length && (
              <p>No drawers were opened for this date. You can record and lock an empty day.</p>
            )}
            {data.drawers.map((d, i) => (
              <div className="grid gap-2 border-b border-border-subtle pb-4" key={d.id}>
                <p className="text-sm">
                  {/* Named by who opened it and when; the device id names nothing to a cashier. */}
                  Drawer {i + 1} · {drawerOpenedLabel(d, data.timezone)} ·{' '}
                  {d.status === 'OPEN' ? 'Open' : 'Closed'}
                </p>
                <p className="text-sm">
                  Expected: {currency} {formatMinor(d.expectedMinor)}
                </p>
                {d.status === 'OPEN' ? (
                  <label className="grid gap-2">
                    Counted cash for drawer {i + 1} ({currency})
                    <Input
                      className="min-h-11"
                      inputMode="decimal"
                      value={counts[d.id] ?? ''}
                      disabled={busy}
                      aria-invalid={counts[d.id] !== undefined && cashMinor(counts[d.id]) === null}
                      onChange={(e) => {
                        setCounts({ ...counts, [d.id]: e.target.value });
                        setConfirmed(false);
                      }}
                    />
                    {counts[d.id] !== undefined && cashMinor(counts[d.id]) === null && (
                      <span className="text-sm text-destructive">
                        Enter a non-negative amount with at most two decimal places.
                      </span>
                    )}
                  </label>
                ) : (
                  <p>
                    Counted: {currency} {formatMinor(d.countedMinor ?? 0)}
                  </p>
                )}
              </div>
            ))}
            <label className="grid gap-2">
              Variance note
              <Input
                className="min-h-11"
                maxLength={1000}
                value={note}
                disabled={busy}
                required={hasVariance}
                onChange={(e) => setNote(e.target.value)}
              />
              <span className="text-sm text-text-muted">
                Required when any drawer count differs from expected cash.
              </span>
            </label>
            <div
              className="space-y-1 rounded-md border border-warning/30 bg-warning/10 p-4 text-sm text-text-strong"
              role="note"
              aria-label="Locking stops trading"
            >
              <p className="font-medium">Locking this day stops trading on it.</p>
              <p>
                Once locked, counters cannot take new payments, refunds or drawer changes for{' '}
                {date}. Only the owner can reopen today&apos;s business day for trading, with a
                reason; earlier days stay locked. Someone with day-close permission can later
                re-record the close report with a reason, but that alone never reopens the day.
              </p>
            </div>
            <label className="flex items-start gap-3">
              <input
                className="mt-1 size-5"
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              I have counted every drawer and understand that locking this day stops trading on it.
            </label>
            {close.error && <p role="alert">{counterErrorMessage(close.error)}</p>}
            <div className="flex flex-wrap gap-3">
              <Button
                className="min-h-11"
                type="submit"
                disabled={busy || !valid || !confirmed || (hasVariance && !note.trim())}
                aria-describedby={blockers.length ? 'day-close-blocked' : undefined}
              >
                {close.isPending ? 'Closing day…' : 'Close and lock day'}
              </Button>
              <Button
                className="min-h-11"
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setCounts({});
                  setConfirmed(false);
                  close.reset();
                  void preview.refetch();
                }}
              >
                Refresh preview
              </Button>
            </div>
            {blockers.length > 0 && (
              <div id="day-close-blocked" className="text-sm text-text-muted" role="status">
                <p>To close and lock this day:</p>
                <ul className="list-disc pl-5">
                  {blockers.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}
          </form>
        )}
      </SectionCard>
      {/* #728: once the day is closed, the owner sees the read-only anomaly check. */}
      {report && ownerView && <CashCloseCheckPanel branchId={branchId} date={date} />}
    </div>
  );
}
