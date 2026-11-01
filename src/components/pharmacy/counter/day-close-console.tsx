'use client';

import { tenderTotalsSchema } from '@/lib/pharmacy/manual-payments';

import { useId, useMemo, useState } from 'react';
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
import { formatMinor, type CounterReceiptLocale } from '@/lib/pharmacy/counter-receipt';
import { printCounterBrowserZReport } from '@/lib/pharmacy/counter-browser-print';
import { counterErrorMessage } from '@/lib/pharmacy/counter-messages';
import { workspaceTimezone, workspaceToday } from '@/lib/timezone';
import {
  closeBlockingReasons,
  dayLockStatus,
  drawerStateLabel,
  hasCashVariance,
  isQuietDay,
  paymentSummary,
  paymentTypeLabel,
} from './day-close-status';

/**
 * What locking means, and who can act on a locked day. Matches the server: once
 * a close is recorded every sale, refund and drawer change for that date is
 * refused (requirePharmacyDayOpen), and a superseding re-close needs a written
 * reason and the same day-close access as this screen (requireCloseAccess).
 */
export const LOCK_CONSEQUENCE_COPY =
  'Locking cannot be undone. Once locked, no new sales, refunds or drawer changes can be recorded for this business date.';
export const RECLOSE_ACCESS_COPY =
  'Only workspace administrators, such as the owner, and staff whose role grants day-close permission can issue a corrected Z-report for a locked day, and it needs a written reason. A corrected report does not reopen the day for sales.';
export const REFRESH_PREVIEW_COPY =
  "Refresh preview re-reads this day's sales and drawer movements. It does not save or change anything, but it clears the counts typed here.";

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

export function PharmacyDayCloseConsole() {
  const { data: session, status } = useSession();
  const entitlements = useEntitlements();
  const user = session?.user;
  if (
    status !== 'authenticated' ||
    !evaluateSessionUser(user).ok ||
    user?.role !== 'ADMIN' ||
    user.organizationId !== entitlements.organizationId ||
    !isModuleGranted('pharmacy-counter', entitlements.enabledModules)
  ) {
    return (
      <SectionCard title="Day close unavailable">
        <p role="status">
          {status === 'loading'
            ? 'Checking day-close access…'
            : 'Sign in as a pharmacy administrator to reconcile and close a day.'}
        </p>
      </SectionCard>
    );
  }
  return <DayCloseBranches key={`${user.organizationId}:${user.id}`} />;
}

function DayCloseBranches() {
  const branches = trpc.pharmacySales.counterBranches.useQuery();
  const [selected, setSelected] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const timeZone = branches.data?.timezone;
  // Until the operator picks a day: today in the workspace's zone, settled once
  // the zone is known, so a page left open past midnight keeps its day.
  const today = useMemo(() => (timeZone ? workspaceToday(timeZone) : ''), [timeZone]);
  const date = picked ?? today;
  const branchId = selected || branches.data?.branches[0]?.id || '';
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
        />
      )}
    </div>
  );
}

function DayCloseForm({
  branchId,
  date,
  currency,
}: {
  branchId: string;
  date: string;
  currency: string;
}) {
  const input = { branchId, businessDate: new Date(`${date}T00:00:00.000Z`) };
  const preview = trpc.pharmacySales.closePreview.useQuery(input, { refetchOnWindowFocus: false });
  const close = trpc.pharmacySales.closeDay.useMutation();
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [locale, setLocale] = useState<CounterReceiptLocale>('en');
  const [printMessage, setPrintMessage] = useState('');
  const ids = useId();
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
  const report = close.data ?? data.close;
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
  const countFor = (i: number) => cashMinor(counts[data.drawers[i].id] ?? '');
  const hasVariance = hasCashVariance(data.drawers, countFor);
  const blockers = closeBlockingReasons({ drawers: data.drawers, countFor, note, confirmed });
  const busy = close.isPending || preview.isFetching;
  const dayStatus = dayLockStatus(Boolean(report));
  const returnsMinor = report?.refundTotalMinor ?? data.totals.refundTotalMinor ?? 0;
  const summary = paymentSummary(tenderTotals, returnsMinor);
  const quietDay = isQuietDay({
    grossSalesMinor: report?.grossSalesMinor ?? data.totals.grossSalesMinor ?? 0,
    refundTotalMinor: returnsMinor,
    cashExpectedMinor: expected,
    tenderTotals,
  });
  const blockersId = `${ids}-blockers`;
  const lockHelpId = `${ids}-lock-help`;
  const noteHelpId = `${ids}-note-help`;
  const refreshHelpId = `${ids}-refresh-help`;
  return (
    <div className="space-y-6">
      <SectionCard
        title="Cash reconciliation"
        titleLevel={2}
        actions={<StatusPill status={dayStatus.label} tone={dayStatus.tone} />}
      >
        <dl className="grid gap-4 sm:grid-cols-3">
          {[
            ['Expected cash', formatMinor(expected)],
            ['Counted cash', valid || report ? formatMinor(counted) : 'Awaiting count'],
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
        <section className="mt-6 space-y-3" aria-labelledby={`${ids}-payments`}>
          <h3 id={`${ids}-payments`} className="text-sm font-medium text-text-strong">
            Payment types
          </h3>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {summary.map((row) => (
              <div key={row.label}>
                <dt className="text-sm text-text-muted">
                  {row.label} · {currency}
                </dt>
                <dd className="font-mono text-lg tabular-nums" data-testid={row.label}>
                  {formatMinor(row.amountMinor)}
                </dd>
              </div>
            ))}
          </dl>
          {tenderTotals.length > 0 && (
            <ul className="space-y-1" aria-label="Payment type totals">
              {tenderTotals.map((row) => (
                <li key={row.type} className="text-sm text-text-body">
                  <span className="font-medium">{paymentTypeLabel(row.type)}</span> · Received{' '}
                  {currency} {formatMinor(row.amountMinor)} · Refunds {currency}{' '}
                  {formatMinor(row.refundMinor)} · Net {currency} {formatMinor(row.netMinor)}
                </li>
              ))}
            </ul>
          )}
          {quietDay && (
            <p className="text-sm text-text-muted">
              Every total reads 0.00 because no completed sales, refunds or drawer cash movements
              are recorded for this business day yet.
            </p>
          )}
        </section>
        {report ? (
          <div className="mt-4 space-y-3">
            <p role="status">
              Day locked. New sales, payments and drawer changes for this business date are
              blocked.
            </p>
            <p className="text-sm text-text-muted">{RECLOSE_ACCESS_COPY}</p>
            <p>
              {report.supersedesCloseId || report.sequence > 1 ? 'Reopen reason' : 'Variance note'}:{' '}
              {report.reason || 'No variance recorded.'}
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
          </div>
        ) : (
          <form
            className="mt-6 space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (busy || blockers.length > 0) return;
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
            {!data.drawers.length && (
              <p>No drawers were opened for this date. You can record and lock an empty day.</p>
            )}
            {data.drawers.map((d, i) => (
              <div className="grid gap-2 border-b border-border-subtle pb-4" key={d.id}>
                <p className="text-sm">
                  {/* Named by who opened it and when; the device id names nothing to a cashier. */}
                  Drawer {i + 1} · {drawerOpenedLabel(d, data.timezone)} ·{' '}
                  {drawerStateLabel(d.status)}
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
              <span>
                Variance note
                {hasVariance && (
                  <span className="ml-2 text-sm font-medium text-destructive">(required)</span>
                )}
              </span>
              <Input
                className="min-h-11"
                maxLength={1000}
                value={note}
                disabled={busy}
                required={hasVariance}
                aria-required={hasVariance}
                aria-describedby={noteHelpId}
                onChange={(e) => setNote(e.target.value)}
              />
              <span id={noteHelpId} className="text-sm text-text-muted">
                {hasVariance
                  ? 'Required: counted cash differs from expected cash. Explain the difference.'
                  : 'Only needed when a drawer count differs from expected cash.'}
              </span>
            </label>
            <label className="flex items-start gap-3">
              <input
                className="mt-1 size-5"
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              I have counted every drawer. Close and lock this day against new sales and payments.
            </label>
            <div id={lockHelpId} className="space-y-1 text-sm text-text-muted">
              <p>{LOCK_CONSEQUENCE_COPY}</p>
              <p>{RECLOSE_ACCESS_COPY}</p>
            </div>
            {close.error && <p role="alert">{counterErrorMessage(close.error)}</p>}
            <div className="flex flex-wrap gap-3">
              <Button
                className="min-h-11"
                type="submit"
                disabled={busy || blockers.length > 0}
                aria-describedby={`${blockers.length ? `${blockersId} ` : ''}${lockHelpId}`}
              >
                {close.isPending ? 'Closing day…' : 'Close and lock day'}
              </Button>
              <Button
                className="min-h-11"
                type="button"
                variant="outline"
                disabled={busy}
                aria-describedby={refreshHelpId}
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
              <div id={blockersId} className="text-sm">
                <p className="font-medium text-text-strong">
                  Close and lock day is not available yet:
                </p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-text-body">
                  {blockers.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}
            <p id={refreshHelpId} className="text-sm text-text-muted">
              {REFRESH_PREVIEW_COPY}
            </p>
          </form>
        )}
      </SectionCard>
    </div>
  );
}
