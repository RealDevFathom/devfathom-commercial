'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import type {
  LostDemandAdvice,
  LostDemandTriggerConfig,
} from '@/lib/pharmacy/lost-demand-procurement';

export type DemandActionState = { message: string; success: boolean; reviewHref?: string };
export type DemandFormAction = (
  state: DemandActionState,
  data: FormData
) => Promise<DemandActionState>;
const initial: DemandActionState = { message: '', success: false };
const selectClass =
  'min-h-11 w-full min-w-0 rounded-md border border-border bg-surface-card px-3 text-sm text-text-body focus-visible:outline-2 focus-visible:outline-ring';

function AdviceForm({ advice, action }: { advice: LostDemandAdvice; action: DemandFormAction }) {
  const [state, submit, pending] = useActionState(action, initial);
  const money = (value: number | null | undefined) =>
    value == null ? 'unknown' : (value / 100).toFixed(2);
  return (
    <article className="min-w-0 space-y-3 border-t border-border pt-4">
      <h3 className="font-medium text-text-strong">{advice.name ?? advice.medicineId}</h3>
      <p className="text-sm text-text-muted">{advice.method}</p>
      <p className="text-sm text-text-body">
        Suggested shortfall: {advice.quantity.requiredUnits} canonical units.
      </p>
      <ul className="space-y-2 text-sm text-text-body" aria-label="Distributor terms">
        {advice.distributors.map((row) => (
          <li key={row.supplierId}>
            {row.name ?? row.supplierId}: last pack price {money(row.lastPricePerPackMinor)};
            current quote {money(row.quotePricePerPackMinor)}; lead time{' '}
            {row.leadTimeDays ?? 'unknown'} days;
            {row.scheme
              ? ` buy ${row.scheme.buyPacks}, get ${row.scheme.freePacks} free`
              : ' no bonus scheme'}
            . Suggested {row.quantity?.orderedPacks ?? 0} paid + {row.quantity?.bonusPacks ?? 0}{' '}
            bonus packs ({row.quantity?.suppliedUnits ?? 0} units).
          </li>
        ))}
      </ul>
      {!advice.distributors.length ? (
        <p className="text-sm text-text-muted">
          No eligible distributor with a current quote. Record supplier terms in purchasing first.
        </p>
      ) : null}
      <p className="text-sm text-text-muted">
        Prices are recorded minor-unit amounts divided by 100; verify quote currency before
        approval.
      </p>
      <p className="text-sm text-text-body">
        Same salt/strength alternates, ranked by recorded margin:
      </p>
      {advice.alternates.length ? (
        <ul className="text-sm text-text-body">
          {advice.alternates.map((row) => (
            <li key={row.medicineId}>
              {row.name ?? row.medicineId} · margin{' '}
              {row.marginBps == null ? 'unknown' : `${(row.marginBps / 100).toFixed(2)}%`}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-text-muted">
          No stocked equivalent with matching form and route.
        </p>
      )}
      <p className="text-sm text-text-muted">
        Alternates require pharmacist review before substitution.
      </p>
      <form
        action={submit}
        aria-label={`Procurement action for ${advice.name ?? advice.medicineId}`}
      >
        <input type="hidden" name="adviceId" value={advice.id} />
        <input type="hidden" name="branchId" value={advice.branchId} />
        <fieldset disabled={pending || state.success} className="min-w-0 space-y-3">
          <label className="block text-sm text-text-body">
            Distributor
            <select
              name="supplierId"
              className={selectClass}
              defaultValue={
                advice.distributors.find((row) => (row.quantity?.orderedPacks ?? 0) > 0)
                  ?.supplierId ?? ''
              }
            >
              <option value="">Choose distributor</option>
              {advice.distributors.map((row) => (
                <option key={row.supplierId} value={row.supplierId}>
                  {row.name ?? row.supplierId} · {row.quantity?.orderedPacks ?? 0} paid packs
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm text-text-body">
            Transfer from surplus branch
            <select
              name="fromBranchId"
              className={selectClass}
              defaultValue={advice.transfers[0]?.fromBranchId ?? ''}
            >
              <option value="">No transfer selected</option>
              {advice.transfers.map((row) => (
                <option key={row.fromBranchId} value={row.fromBranchId}>
                  {row.name ?? row.fromBranchId} · {row.surplusUnits} surplus units
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm text-text-body">
            Your fresh operator PIN
            <Input
              name="pin"
              type="password"
              inputMode="numeric"
              pattern="[0-9]{4,8}"
              minLength={4}
              maxLength={8}
              required
              autoComplete="off"
              className="min-h-11"
            />
          </label>
          <p className="text-sm text-text-muted">
            Requires procurement permission for PO/Ignore, inventory permission for Transfer, and
            your linked operator PIN. Drafts need separate approval; no order is sent and no stock
            is moved.{' '}
            <Link
              href="/pharmacy/settings/pin"
              className="text-text-strong underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Set up or reset your approval PIN
            </Link>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              name="action"
              value="DRAFT_PO"
              className="min-h-11"
              disabled={!advice.distributors.some((row) => (row.quantity?.orderedPacks ?? 0) > 0)}
            >
              {pending ? 'Saving…' : 'Draft PO'}
            </Button>
            <Button
              type="submit"
              name="action"
              value="DRAFT_TRANSFER"
              variant="outline"
              className="min-h-11"
              disabled={!advice.transfers.some((row) => row.lines?.length)}
            >
              Draft Transfer
            </Button>
            <Button
              type="submit"
              name="action"
              value="IGNORE"
              variant="outline"
              className="min-h-11"
            >
              Ignore
            </Button>
          </div>
        </fieldset>
        {state.success && state.reviewHref ? (
          <Link
            href={state.reviewHref}
            className={buttonVariants({ variant: 'outline', className: 'mt-3 min-h-11' })}
          >
            Open saved draft
          </Link>
        ) : null}
        {state.message ? (
          <p role={state.success ? 'status' : 'alert'} className="mt-3 text-sm text-text-body">
            {state.message}
          </p>
        ) : null}
      </form>
    </article>
  );
}

function ConfigForm({
  config,
  branchId,
  action,
}: {
  config: LostDemandTriggerConfig;
  branchId: string;
  action: DemandFormAction;
}) {
  const [state, submit, pending] = useActionState(action, initial);
  const fields = [
    ['requestsInWindow', 'Request threshold', 1, 2147483647],
    ['requestWindowDays', 'Request and walk-out window (days)', 1, 365],
    ['estimatedLossMinor', 'Estimated loss threshold (minor units)', 1, Number.MAX_SAFE_INTEGER],
    ['lossWindowDays', 'Loss window (days)', 1, 365],
    ['walkOutRateBps', 'Walk-out threshold (basis points; 1000 = 10%)', 0, 10000],
  ] as const;
  return (
    <details className="rounded-md border border-border p-4">
      <summary className="cursor-pointer text-sm font-medium text-text-strong focus-visible:outline-2 focus-visible:outline-ring">
        Branch trigger settings
      </summary>
      <form action={submit} className="mt-4 space-y-3">
        <input type="hidden" name="branchId" value={branchId} />
        <fieldset disabled={pending} className="grid min-w-0 gap-3 sm:grid-cols-2">
          {fields.map(([name, label, min, max]) => (
            <label key={name} className="min-w-0 text-sm text-text-body">
              {label}
              <Input
                type="number"
                name={name}
                min={min}
                max={max}
                step={1}
                defaultValue={config[name]}
                required
                className="min-h-11"
              />
            </label>
          ))}
          <Button type="submit" className="min-h-11 self-end">
            {pending ? 'Saving…' : 'Save branch thresholds'}
          </Button>
        </fieldset>
        {state.message ? (
          <p role={state.success ? 'status' : 'alert'} className="text-sm text-text-body">
            {state.message}
          </p>
        ) : null}
      </form>
    </details>
  );
}

export function LostDemandWorkflow({
  advice,
  branchId,
  config,
  financial,
  configure,
  act,
  save,
}: {
  advice: LostDemandAdvice[] | null;
  branchId: string;
  config: LostDemandTriggerConfig | null;
  financial: boolean;
  configure: boolean;
  act: DemandFormAction;
  save: DemandFormAction;
}) {
  return (
    <SectionCard title="Lost-demand procurement" titleLevel={2}>
      <div className="min-w-0 space-y-4">
        {!financial ? (
          <p className="text-sm text-text-muted">
            Financial report access is required to review quantities and distributor terms.
          </p>
        ) : advice === null ? (
          <p role="alert" className="text-sm text-text-muted">
            Procurement advice unavailable. Refresh to retry or ask your administrator to verify
            report access.
          </p>
        ) : advice.length ? (
          advice.map((row) => <AdviceForm key={row.id} advice={row} action={act} />)
        ) : (
          <p role="status" className="text-sm text-text-muted">
            No unreviewed procurement advice for this branch. New evidence is evaluated on refresh.
          </p>
        )}
        {configure && config ? (
          <ConfigForm config={config} branchId={branchId} action={save} />
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Link
            href="/pharmacy/purchasing"
            className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
          >
            Review purchase drafts
          </Link>
          <Link
            href={`/pharmacy/inventory/transfers?branch=${encodeURIComponent(branchId)}`}
            className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
          >
            Review transfer drafts
          </Link>
        </div>
      </div>
    </SectionCard>
  );
}
