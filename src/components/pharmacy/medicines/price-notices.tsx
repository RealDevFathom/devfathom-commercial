'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';
import type { priceIntelligence, priceOverrides } from '@/lib/pharmacy/pricing';
import { formatUtcInstant } from '@/lib/utc-instant';

type PriceData = Awaited<ReturnType<typeof priceIntelligence>>;
const money = (minor: number | null) =>
  minor === null
    ? 'Not set'
    : new Intl.NumberFormat('en-PK', {
        style: 'currency',
        currency: 'PKR',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(minor / 100);
const cell = (value: unknown) => {
  const text = value == null ? '' : String(value);
  return `"${(/^[\s]*[=+@-]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
};
export function pricesCsv(data: PriceData) {
  const header = [
    'Medicine',
    'Aliases',
    'Presentation',
    'Pack',
    'Units per pack',
    'Policy source',
    'Effective date',
    'Current confirmed MRP PKR',
    'Current selling PKR',
    'Variance PKR',
    'Variance %',
    'Derived unit MRP PKR',
    'Derived unit selling PKR',
  ];
  const amount = (v: number | null) => (v === null ? null : v / 100);
  return (
    '\uFEFF' +
    [
      header,
      ...data.packRows.map((r) => [
        r.medicine,
        r.aliases.join(' / '),
        r.presentation,
        r.packLevel,
        r.units,
        r.source,
        r.effectiveDate.toISOString(),
        amount(r.confirmedMrpMinor),
        amount(r.sellingPriceMinor),
        amount(r.amountMinor),
        r.percent,
        amount(r.mrpUnitMinor),
        amount(r.sellingUnitMinor),
      ]),
    ]
      .map((row) => row.map(cell).join(','))
      .join('\r\n')
  );
}

export function PriceNoticesView({
  data,
  loading,
  error,
  forbidden,
  pending,
  mutationError,
  onRetry,
  onConfirm,
}: {
  data?: PriceData;
  loading?: boolean;
  error?: boolean;
  forbidden?: boolean;
  pending?: boolean;
  mutationError?: string;
  onRetry: () => void;
  onConfirm: (ids: string[]) => Promise<unknown>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [review, setReview] = useState(false);
  const [success, setSuccess] = useState(false);
  if (forbidden)
    return (
      <SectionCard title="Price review permission required" titleLevel={2}>
        <p role="alert">Ask your administrator for pharmacy safety access.</p>
      </SectionCard>
    );
  if (loading)
    return (
      <SectionCard title="Loading price notices" titleLevel={2}>
        <p role="status">Loading presentation mappings and current pack policies…</p>
      </SectionCard>
    );
  if (error || !data)
    return (
      <SectionCard title="Price notices unavailable" titleLevel={2}>
        <p role="alert">Could not load price policies. Retry before confirming notices.</p>
        <Button variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </SectionCard>
    );
  const eligible = data.rows.filter((r) => r.eligible && r.proposalId);
  const ids = selected.filter((id) => eligible.some((r) => r.proposalId === id));
  const mapping = data.rows.filter((r) => r.status === 'NEEDS_MAPPING');
  const mapped = data.rows.filter((r) => r.status !== 'NEEDS_MAPPING');
  const exportCsv = () => {
    const url = URL.createObjectURL(
      new Blob([pricesCsv(data)], { type: 'text/csv;charset=utf-8;' })
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'medicine-pack-prices.csv';
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="min-w-0 space-y-6">
      <SectionCard title="Current organization pack prices" titleLevel={2}>
        <p className="mb-4 text-sm text-text-muted">
          One row per currently priced pack, including manual policies. Future prices remain
          scheduled. Variance compares selling policy with confirmed MRP for the same pack.
        </p>
        {!data.packRows.length ? (
          <p>No current organization pack policies.</p>
        ) : (
          <div
            tabIndex={0}
            role="region"
            aria-label="Current organization pack price variance, PKR"
            className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <table className="w-full text-sm">
              <caption className="sr-only">Current pack variance, PKR</caption>
              <thead className="border-b border-border-default text-left font-mono text-xs uppercase">
                <tr>
                  {[
                    'Medicine / presentation',
                    'Pack',
                    'Policy / effective',
                    'Confirmed MRP',
                    'Selling policy',
                    'Variance',
                  ].map((h) => (
                    <th key={h} scope="col" className="p-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.packRows.map((r) => (
                  <tr key={r.id} className="border-b border-border-subtle hover:bg-surface-sunken">
                    <td className="p-3">
                      <span className="font-medium">{r.medicine}</span>
                      <div dir="auto">{r.aliases.join(' / ')}</div>
                      <div className="text-text-muted">{r.presentation}</div>
                    </td>
                    <td className="p-3">
                      {r.packLevel}
                      <div className="text-text-muted">
                        {r.units === null ? 'Conversion unavailable' : `${r.units} UNIT`}
                      </div>
                    </td>
                    <td className="p-3">
                      {r.source}
                      <div className="whitespace-nowrap text-text-muted">
                        {r.effectiveDate.toISOString().slice(0, 10)}
                      </div>
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {money(r.confirmedMrpMinor)}
                      <div className="text-xs text-text-muted">{money(r.mrpUnitMinor)} / UNIT</div>
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {money(r.sellingPriceMinor)}
                      <div className="text-xs text-text-muted">
                        {money(r.sellingUnitMinor)} / UNIT
                      </div>
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {r.amountMinor === null ? 'Unknown' : money(r.amountMinor)}
                      <div>{r.percent === null ? '—' : `${r.percent.toFixed(2)}%`}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
      <SectionCard title="DRAP price notices" titleLevel={2}>
        <p className="mb-4 text-sm text-text-muted">
          Current prices as of {formatUtcInstant(data.asOf)}. Variance = selling − confirmed MRP for
          the same pack. Missing selling policies remain unknown. Unit amounts are derived previews.
        </p>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Button
            disabled={!ids.length || pending || review}
            onClick={() => {
              setReview(true);
              setSuccess(false);
            }}
          >
            Review {ids.length} selected
          </Button>
          <Button variant="outline" disabled={!data.packRows.length || pending} onClick={exportCsv}>
            Export CSV
          </Button>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              disabled={!eligible.length || pending || review}
              checked={eligible.length > 0 && ids.length === eligible.length}
              onChange={(e) =>
                setSelected(
                  e.target.checked ? eligible.slice(0, 100).map((r) => r.proposalId!) : []
                )
              }
            />
            Select eligible notices (up to 100)
          </label>
        </div>
        {review && (
          <div
            className="mb-4 space-y-3 rounded-md border border-border-default bg-surface-sunken p-4"
            aria-label="Confirm selected notices"
          >
            <h3 className="font-semibold">Confirm {ids.length} pack price updates?</h3>
            <p className="text-sm">
              All selected updates are atomic and audited. Future effective dates stay scheduled.
              Branch overrides retain their prices and require review against the new organization
              version.
            </p>
            <ul className="text-sm">
              {eligible
                .filter((r) => ids.includes(r.proposalId!))
                .map((r) => (
                  <li key={r.id}>
                    {r.reference}: {r.presentation} / {r.packLevel} — {money(r.notifiedMrpMinor)},
                    effective {r.effectiveDate?.toISOString().slice(0, 10)}
                  </li>
                ))}
            </ul>
            <div className="flex flex-wrap gap-3">
              <Button
                disabled={pending || !ids.length}
                onClick={async () => {
                  try {
                    await onConfirm(ids);
                    setSelected([]);
                    setReview(false);
                    setSuccess(true);
                  } catch {
                    /* Mutation error remains visible; selection preserved. */
                  }
                }}
              >
                {pending ? 'Confirming…' : 'Confirm pack prices'}
              </Button>
              <Button variant="outline" disabled={pending} onClick={() => setReview(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {mutationError && (
          <p role="alert" className="mb-4 text-destructive">
            {mutationError}
          </p>
        )}
        {success && (
          <p role="status" className="mb-4">
            Selected notices confirmed. Effective dates preserved.
          </p>
        )}
        {!data.rows.length && (
          <p role="status">
            No DRAP price notices yet. Import regulator notices with a named presentation and BOX,
            STRIP, or UNIT pack through the price notice ingestion service.
          </p>
        )}
        {!!mapped.length && (
          <div
            tabIndex={0}
            role="region"
            aria-label="Mapped DRAP pack price notices, PKR"
            className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <table className="w-full text-sm">
              <caption className="sr-only">Mapped pack price notices, PKR</caption>
              <thead className="border-b border-border-default text-left font-mono text-xs uppercase">
                <tr>
                  {[
                    'Select',
                    'Medicine / presentation',
                    'Notice / effective',
                    'Pack',
                    'Notified MRP',
                    'Status',
                  ].map((h) => (
                    <th key={h} scope="col" className="p-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {mapped.map((r) => (
                  <tr key={r.id} className="border-b border-border-subtle hover:bg-surface-sunken">
                    <td className="p-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.reference}`}
                        disabled={
                          !r.eligible ||
                          pending ||
                          review ||
                          (!ids.includes(r.proposalId!) && ids.length >= 100)
                        }
                        checked={ids.includes(r.proposalId!)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...ids, r.proposalId!]
                              : ids.filter((id) => id !== r.proposalId)
                          )
                        }
                      />
                    </td>
                    <td className="p-3">
                      <span className="font-medium">{r.medicine}</span>
                      <div dir="auto">{r.aliases.join(' / ')}</div>
                      <div className="text-text-muted">{r.presentation}</div>
                    </td>
                    <td className="p-3">
                      {r.reference}
                      <div className="whitespace-nowrap text-text-muted">
                        {r.effectiveDate?.toISOString().slice(0, 10)}
                      </div>
                    </td>
                    <td className="p-3">
                      {r.packLevel}
                      <div className="text-text-muted">{r.units} UNIT</div>
                    </td>
                    <td className="p-3 text-right tabular-nums">{money(r.notifiedMrpMinor)}</td>
                    <td className="p-3">
                      <StatusPill
                        status={
                          r.status === 'CONFIRMED'
                            ? r.effectiveDate && r.effectiveDate > data.asOf
                              ? 'scheduled'
                              : 'confirmed'
                            : 'pending'
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
      <SectionCard title={`Needs mapping (${mapping.length})`} titleLevel={2}>
        <p className="mb-3 text-sm text-text-muted">
          Missing, unmatched, or ambiguous presentation/pack identities cannot be confirmed. Review
          catalog mapping with an administrator. Keep the original source reference and payload
          unchanged; unresolved notices remain blocked pending a supported mapping correction.
        </p>
        {!mapping.length ? (
          <p>No notices need mapping.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {mapping.map((r) => (
              <li key={r.id} className="py-3">
                <span className="font-medium">
                  {r.reference} — {r.medicine}
                </span>
                <p>
                  {r.presentation} / {r.packLevel}
                </p>
                <StatusPill status="blocked" label="Needs mapping" />
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

export function PriceOverridesView({
  data,
  loading,
  error,
  forbidden,
  onRetry,
}: {
  data?: Awaited<ReturnType<typeof priceOverrides>>;
  loading?: boolean;
  error?: boolean;
  forbidden?: boolean;
  onRetry: () => void;
}) {
  return (
    <SectionCard title="Preserved branch overrides" titleLevel={2}>
      {forbidden ? (
        <p>Administrator access is required to view branch overrides.</p>
      ) : loading ? (
        <p role="status">Loading branch overrides…</p>
      ) : error || !data ? (
        <div>
          <p role="alert">Could not load branch overrides.</p>
          <Button variant="outline" onClick={onRetry}>
            Retry overrides
          </Button>
        </div>
      ) : !data.length ? (
        <p>No branch overrides.</p>
      ) : (
        <>
          <p className="mb-4 text-sm text-text-muted">
            Override versions retain their prices. Review flags compare each version with the latest
            organization policy, including scheduled changes.
          </p>
          <div
            tabIndex={0}
            role="region"
            aria-label="Preserved branch override versions, PKR"
            className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <table className="w-full text-sm">
              <caption className="sr-only">Preserved branch override versions, PKR</caption>
              <thead className="border-b border-border-default text-left font-mono text-xs uppercase">
                <tr>
                  {[
                    'Branch',
                    'Medicine / presentation / pack',
                    'Effective',
                    'Override MRP',
                    'Override selling',
                    'Review',
                  ].map((h) => (
                    <th key={h} scope="col" className="p-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((r) => (
                  <tr key={r.id} className="border-b border-border-subtle hover:bg-surface-sunken">
                    <td className="p-3">{r.branchName}</td>
                    <td className="p-3">
                      {r.medicine}
                      <div className="text-text-muted">
                        {r.presentation} / {r.packLevel}
                      </div>
                    </td>
                    <td className="whitespace-nowrap p-3">
                      {r.effectiveFrom.toISOString().slice(0, 10)}
                    </td>
                    <td className="p-3 text-right tabular-nums">{money(r.mrpMinor)}</td>
                    <td className="p-3 text-right tabular-nums">{money(r.sellingPriceMinor)}</td>
                    <td className="p-3">
                      <StatusPill
                        status={r.needsReview ? 'review' : 'confirmed'}
                        label={r.needsReview ? 'Needs review' : 'Reviewed'}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SectionCard>
  );
}

export function PriceNotices() {
  const query = trpc.pharmacyMedicine.priceNotices.useQuery();
  const mutation = trpc.pharmacyMedicine.confirmPrices.useMutation();
  const overrides = trpc.pharmacyMedicine.priceOverrides.useQuery(
    {},
    { retry: false, enabled: !!query.data }
  );
  return (
    <div className="min-w-0 space-y-6">
      <PriceNoticesView
        data={query.data}
        loading={query.isLoading}
        error={query.isError}
        forbidden={
          query.error?.data?.code === 'FORBIDDEN' || query.error?.data?.code === 'UNAUTHORIZED'
        }
        pending={mutation.isPending}
        mutationError={mutation.error?.message}
        onRetry={() => void query.refetch()}
        onConfirm={async (ids) => {
          await mutation.mutateAsync({ proposalIds: ids });
          await Promise.all([query.refetch(), overrides.refetch()]);
        }}
      />
      {query.data && (
        <PriceOverridesView
          data={overrides.data}
          loading={overrides.isLoading}
          error={overrides.isError}
          forbidden={
            overrides.error?.data?.code === 'FORBIDDEN' ||
            overrides.error?.data?.code === 'UNAUTHORIZED'
          }
          onRetry={() => void overrides.refetch()}
        />
      )}
    </div>
  );
}
