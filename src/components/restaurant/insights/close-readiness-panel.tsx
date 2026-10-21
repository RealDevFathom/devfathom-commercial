'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import type {
  ClosePacketEvidence,
  CloseReadinessStatus,
  PrepareClosePacketInput,
  RestaurantClosePacket,
} from '@/lib/restaurant/close-readiness';
import { trpc } from '@/lib/trpc';
import type { ValidationErrors } from '@/lib/validation-error';

type ReadState =
  | { kind: 'idle' | 'loading' }
  | { kind: 'error'; denied: boolean; dateError?: string }
  | { kind: 'success'; packet: RestaurantClosePacket };

const amountLabels = {
  grossSales: 'Gross sales',
  netSales: 'Net sales',
  refundTotal: 'Refund principal',
  tipTotal: 'Tips collected',
  cashExpected: 'Expected drawer cash',
  cashCounted: 'Counted drawer cash',
  cashVariance: 'Drawer cash variance',
} satisfies Record<
  keyof NonNullable<RestaurantClosePacket['financial']['data']>['amounts'],
  string
>;

const roleLabels = {
  FINANCE_MANAGER: 'Finance manager',
  CASHIER: 'Cashier',
  SHIFT_MANAGER: 'Shift manager',
} as const;

const routeLabels = {
  'restaurantBills.listBills': 'Review bills',
  'restaurantCash.listDrawerSessions': 'Review drawers',
  'restaurantCash.listDailyCloses': 'Review daily closes',
  'restaurantOrders.listOrders': 'Review orders',
  'restaurantReports.payments': 'Review payment reports',
} as const;

function ReadinessStatus({ status }: { status: CloseReadinessStatus }) {
  const labels = {
    READY: 'Checks passed at observation',
    BLOCKED: 'Blocked at observation',
    UNKNOWN: 'Unknown — evidence incomplete',
    ALREADY_CLOSED: 'Already closed at observation',
  };
  return (
    <StatusPill
      status={labels[status]}
      tone={status === 'BLOCKED' ? 'danger' : status === 'UNKNOWN' ? 'warning' : 'neutral'}
    />
  );
}

function Evidence({ title, items }: { title: string; items: ClosePacketEvidence[] }) {
  return (
    <div className="space-y-2">
      <h4 className="font-semibold text-text-strong">{title}</h4>
      {items.length === 0 ? (
        <p className="text-sm text-text-muted">None reported by this reader.</p>
      ) : (
        <ul className="space-y-4">
          {items.map((item) => (
            <li key={item.code} className="space-y-1 border-l border-border-default pl-3">
              <p className="text-sm text-text-strong">{item.message}</p>
              <p className="text-xs text-text-muted">
                Responsible role: {roleLabels[item.responsibleRole]}
              </p>
              <p className="break-words font-mono text-xs text-text-muted">
                {item.code} · Source: {item.source}
              </p>
              {item.recordIds.length > 0 ? (
                <details className="text-xs text-text-muted">
                  <summary className="cursor-pointer rounded-sm py-2 focus-visible:outline-2 focus-visible:outline-ring">
                    Observed record references ({item.recordIds.length})
                  </summary>
                  <p className="break-all font-mono">{item.recordIds.join(', ')}</p>
                </details>
              ) : null}
              {item.allowedExistingRoutes.length > 0 ? (
                <ul className="flex flex-wrap gap-x-4 gap-y-1">
                  {item.allowedExistingRoutes.map((route) => (
                    <li key={route.procedure}>
                      <a
                        href={route.href}
                        className="inline-flex min-h-11 items-center rounded-sm text-sm underline underline-offset-4 hover:text-text-strong focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        {routeLabels[route.procedure]}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PacketEvidence({ packet }: { packet: RestaurantClosePacket }) {
  const financial = packet.financial.data;
  const operational = packet.operational.data;
  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-md border border-border-default bg-surface-sunken p-4 text-sm">
        <StatusPill status="Not ready for unattended close" tone="warning" />
        <p>
          Terminal synchronization remains unknown. Financial checks do not establish complete
          operational handover.
        </p>
        <p className="break-words font-mono text-xs">
          Branch: {packet.scope.branchId} · Business date: {packet.period.from} to{' '}
          {packet.period.to} ({packet.period.basis})
        </p>
        <p className="break-words text-xs">As of (request): {packet.freshness.asOf}</p>
        <p className="break-words text-xs">
          Observed: {packet.freshness.startedAt} to {packet.freshness.completedAt}
        </p>
        <p className="break-words text-xs">
          Freshness window ends: {packet.freshness.expiresAt} · {packet.freshness.status}
        </p>
        <p className="text-text-muted">{packet.freshness.definition}</p>
        <p className="text-text-muted">
          This packet does not update automatically. Refresh before using its evidence. Source links
          open existing workspaces; select the same branch and business date there.
        </p>
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <SectionCard title="Financial readiness" titleLevel={3}>
          <div className="space-y-5">
            <ReadinessStatus status={packet.financial.status} />
            <Evidence title="Financial blockers" items={packet.financial.blockers} />
            <Evidence title="Missing financial evidence" items={packet.financial.missingEvidence} />
            {financial ? (
              <div className="space-y-4 text-sm">
                <p>Currency: {financial.currency ?? 'Unavailable'} · Decimal major amounts</p>
                <p className="text-xs text-text-muted">{financial.currencyBasis}</p>
                <p className="break-words text-xs text-text-muted">
                  Financial source: {financial.source}
                  {financial.existingCloseId
                    ? ` · Close: ${financial.existingCloseId}`
                    : ' · Live preview'}
                </p>
                <dl className="space-y-4">
                  {Object.entries(financial.amounts).map(([key, amount]) => (
                    <div key={key}>
                      <dt className="font-medium text-text-strong">
                        {amountLabels[key as keyof typeof amountLabels]}
                      </dt>
                      <dd className="break-words font-mono tabular-nums">
                        {amount.value === null
                          ? 'Unavailable'
                          : `${financial.currency ?? 'Currency unavailable'} ${amount.value}`}
                      </dd>
                      <dd className="text-xs text-text-muted">{amount.definition}</dd>
                    </div>
                  ))}
                </dl>
                <div className="space-y-1">
                  <h4 className="font-semibold">
                    Cash count coverage: {financial.cashCountCoverage.status}
                  </h4>
                  <p className="text-xs text-text-muted">
                    {financial.cashCountCoverage.definition}
                  </p>
                </div>
                <p className="text-xs text-text-muted">{financial.tenderDefinition}</p>
                {financial.reportFreshness ? (
                  <p className="text-xs text-text-muted">
                    Report coverage: {financial.reportFreshness.closedDayCount} closed days. Status:{' '}
                    {financial.reportFreshness.status}.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-text-muted">
                Financial data unavailable. No amounts are shown.
              </p>
            )}
          </div>
        </SectionCard>
        <SectionCard title="Operational handover" titleLevel={3}>
          <div className="space-y-5">
            <ReadinessStatus status={packet.operational.status} />
            <Evidence title="Handover blockers" items={packet.operational.blockers} />
            <Evidence
              title="Missing handover evidence"
              items={packet.operational.missingEvidence}
            />
            {operational ? (
              <div className="space-y-2 text-sm">
                <p>Orders without a live bill: {operational.unbilledOrders.count}</p>
                <p className="text-xs text-text-muted">{operational.unbilledOrders.definition}</p>
                {operational.unbilledOrders.truncated ? (
                  <p className="text-xs text-text-muted">
                    Record references are truncated by the reader.
                  </p>
                ) : null}
                <p>Terminal synchronization: {operational.terminalSynchronization}</p>
                <p>Staff clockouts: {operational.staffClockouts}</p>
              </div>
            ) : (
              <p className="text-sm text-text-muted">
                Operational data unavailable. No order count is inferred.
              </p>
            )}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

export function CloseReadinessPanel({
  organizationId,
  branchId,
  branchName,
  branchAvailable,
  businessDate,
  onBusinessDateChange,
}: {
  organizationId: string;
  branchId: string;
  branchName: string;
  branchAvailable: boolean;
  businessDate: string;
  onBusinessDateChange: (value: string) => void;
}) {
  const utils = trpc.useUtils();
  const [state, setState] = useState<ReadState>({ kind: 'idle' });
  const requestVersion = useRef(0);
  // Leaving this scope invalidates pending reads; late responses cannot restore old evidence.
  useEffect(
    () => () => {
      requestVersion.current += 1;
    },
    [branchId, businessDate, branchAvailable]
  );

  const prepare = async () => {
    if (!branchAvailable || !branchId || !businessDate || state.kind === 'loading') return;
    const version = ++requestVersion.current;
    const input: PrepareClosePacketInput = {
      branchId,
      businessDate,
      asOf: new Date().toISOString(),
    };
    setState({ kind: 'loading' });
    try {
      const packet: RestaurantClosePacket = await utils.restaurantInsights.prepareClosePacket.fetch(
        input,
        { staleTime: 0, retry: false }
      );
      if (requestVersion.current !== version) return;
      if (
        packet.scope.organizationId !== organizationId ||
        packet.scope.branchId !== input.branchId ||
        packet.period.from !== input.businessDate ||
        packet.period.to !== input.businessDate ||
        packet.freshness.asOf !== input.asOf
      ) {
        setState({ kind: 'error', denied: false });
        return;
      }
      setState({ kind: 'success', packet });
    } catch (error) {
      if (requestVersion.current !== version) return;
      const failure = error as {
        message?: string;
        data?: { code?: string; validation?: ValidationErrors | null };
      } | null;
      const code = failure?.data?.code;
      // The service resolves future dates using the branch timezone/cutoff. Its
      // domain errors have no validation fields; only these exact messages name the date.
      const dateError =
        code === 'BAD_REQUEST'
          ? failure?.data?.validation?.businessDate?.[0] ||
            (failure?.message === 'Cannot prepare a future branch business date.' ||
            failure?.message === 'Invalid business date.'
              ? failure.message
              : undefined)
          : undefined;
      setState({
        kind: 'error',
        denied: code === 'FORBIDDEN' || code === 'UNAUTHORIZED',
        dateError,
      });
    }
  };

  const visibleState = branchAvailable ? state : { kind: 'idle' as const };
  const dateError = visibleState.kind === 'error' ? visibleState.dateError : undefined;
  return (
    <SectionCard title="Prepare close packet" titleLevel={2}>
      <div className="space-y-5">
        <p className="text-sm text-text-muted">
          Prepare read-only financial and handover evidence for one branch business date.
          Preparation does not close the day or change any records.
        </p>
        <p className="break-words text-sm">
          Selected branch: {branchName || 'Choose a branch above'}
        </p>
        {branchId && !branchAvailable ? (
          <p role="alert" className="text-sm text-destructive">
            Selected branch is unavailable. Choose an active branch above before preparing; previous
            evidence is hidden.
          </p>
        ) : null}
        <div className="flex flex-wrap items-end gap-4">
          <label className="min-w-0 space-y-1.5">
            <span className="block font-mono text-xs font-semibold uppercase text-text-muted">
              Close business date
            </span>
            <Input
              type="date"
              value={businessDate}
              className="h-11"
              aria-invalid={Boolean(dateError)}
              aria-describedby={dateError ? 'close-date-help close-date-error' : 'close-date-help'}
              onChange={(event) => {
                requestVersion.current += 1;
                setState({ kind: 'idle' });
                onBusinessDateChange(event.target.value);
              }}
            />
          </label>
          <Button
            type="button"
            className="h-11"
            aria-disabled={
              !branchAvailable || !branchId || !businessDate || visibleState.kind === 'loading'
            }
            disabled={!branchAvailable || !branchId || !businessDate}
            onClick={() => void prepare()}
          >
            {visibleState.kind === 'loading'
              ? 'Preparing close packet…'
              : visibleState.kind === 'success'
                ? 'Refresh close packet'
                : visibleState.kind === 'error'
                  ? 'Retry close packet'
                  : 'Prepare close packet'}
          </Button>
        </div>
        <p id="close-date-help" className="text-xs text-text-muted">
          Choose the branch business date explicitly; device calendar date may differ. Report range
          filters do not change this single-day packet.
        </p>
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="text-sm text-text-muted"
        >
          {visibleState.kind === 'loading'
            ? 'Reading close evidence. Keep or change your inputs; no records are modified.'
            : visibleState.kind === 'success'
              ? 'Close packet prepared. Review financial readiness and operational handover separately.'
              : visibleState.kind === 'idle'
                ? 'No packet prepared for this selection.'
                : ''}
        </div>
        {visibleState.kind === 'error' ? (
          <div role="alert" className="space-y-2 text-sm">
            <StatusPill
              status={
                visibleState.denied
                  ? 'Permission denied'
                  : dateError
                    ? 'Invalid business date'
                    : 'Preparation failed'
              }
              tone="danger"
            />
            {dateError ? (
              <p id="close-date-error" className="text-destructive">
                {dateError}
              </p>
            ) : null}
            <p>
              {visibleState.denied
                ? 'Your current role or branch assignment does not permit this packet. Financial data is absent. Ask your administrator to review access, then retry.'
                : dateError
                  ? 'Choose a valid branch business date and prepare again. Your input is preserved; previous evidence is hidden.'
                  : 'Could not prepare matching close evidence. Retry the request. Your inputs are preserved; previous evidence is hidden.'}
            </p>
          </div>
        ) : null}
        {visibleState.kind === 'success' ? <PacketEvidence packet={visibleState.packet} /> : null}
      </div>
    </SectionCard>
  );
}
