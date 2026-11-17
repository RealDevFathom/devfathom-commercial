import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import type {
  LostDemandAdvice,
  LostDemandTrigger,
  LostDemandTriggerConfig,
} from '@/lib/pharmacy/lost-demand-advice';
import { PurchasingActionForm } from '../_components/action-form';
import { EmptyState } from '../_components/console-chrome';
import { CONTROL, SubmitButton, TextField } from '../_components/form-controls';
import { bps, money, type Notice } from '../_lib/console';
import {
  draftLostDemandOrder,
  ignoreLostDemandAdvice,
  requestLostDemandTransfer,
  saveLostDemandTriggers,
} from './lost-demand-actions';

const TRIGGER_LABEL: Record<LostDemandTrigger, string> = {
  REQUEST_COUNT: 'Repeat requests',
  ESTIMATED_LOSS: 'Estimated loss',
  WALK_OUT_RATE: 'Walk-outs',
};

const TABLE_LABEL = 'px-3 py-2 font-mono text-xs tracking-wide text-text-muted uppercase';

export type LostDemandPanelState =
  | {
      kind: 'ready';
      branchId: string;
      branchName: string;
      advice: LostDemandAdvice[];
      config: LostDemandTriggerConfig;
    }
  | { kind: 'unavailable' }
  | { kind: 'unselected' };

/**
 * DEV-80 — lost-demand procurement advice. Each card offers Draft PO, Transfer
 * request and Ignore; every action creates a draft or a note only, and the order
 * still needs a permitted person's approval before anything can be sent.
 */
export function LostDemandAdvicePanel({
  state,
  notice = null,
}: {
  state: LostDemandPanelState;
  notice?: Notice | null;
}) {
  return (
    <SectionCard
      eyebrow="Lost demand · Draft only"
      title="Procurement advice from lost sales"
      titleLevel={2}
    >
      <p className="max-w-3xl text-sm text-text-muted">
        Raised when this branch&apos;s configured triggers fire on recorded lost requests. Figures
        are estimates from recorded sales and requests. Actions create drafts only; nothing is
        approved or sent to a distributor from here.
      </p>
      {state.kind === 'unselected' ? (
        <p className="mt-4 text-sm text-text-muted" role="status">
          Choose a branch to see its lost-demand advice.
        </p>
      ) : state.kind === 'unavailable' ? (
        <p className="mt-4 text-sm text-text-muted" role="status">
          Lost-demand advice could not be read. Your orders and requisitions are unaffected; reload
          the page to retry.
        </p>
      ) : state.advice.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            title={`No advice for ${state.branchName}`}
            detail="No lost-demand trigger has fired for this branch, or every card was already acted on. New advice appears when counter staff record requests the branch could not fill."
          />
        </div>
      ) : (
        <ul className="mt-4 space-y-4">
          {state.advice.map((card) => (
            <AdviceCard branchId={state.branchId} card={card} key={card.demandKey} />
          ))}
        </ul>
      )}
      {state.kind === 'ready' ? (
        <TriggerSettings
          branchId={state.branchId}
          branchName={state.branchName}
          config={state.config}
          notice={notice}
        />
      ) : null}
    </SectionCard>
  );
}

/** Rupees with up to two decimals, exactly as `moneyFieldMinor` reads them back. */
function rupees(minor: number) {
  return minor % 100 ? (minor / 100).toFixed(2) : String(minor / 100);
}

/**
 * The branch's trigger thresholds and planning assumptions. Research figures are
 * only the starting defaults. Saving needs purchase-approval permission, which the
 * server checks; a member without it is told so by the save result.
 */
function TriggerSettings({
  branchId,
  branchName,
  config,
  notice,
}: {
  branchId: string;
  branchName: string;
  config: LostDemandTriggerConfig;
  notice: Notice | null;
}) {
  return (
    <details className="mt-6 rounded-[var(--radius-md)] border border-border-subtle p-4">
      <summary className="cursor-pointer rounded-[var(--radius-xs)] text-sm font-medium text-text-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        Trigger settings for {branchName}
        <span className="mt-1 block text-xs font-normal text-text-muted">
          Advice appears when {config.requestCountThreshold}+ requests arrive in{' '}
          {config.requestWindowDays} days, OR {money(config.estimatedLossThresholdMinor)}+ is
          estimated lost in {config.lossWindowDays} days, OR walk-outs exceed{' '}
          {bps(config.walkOutRateThresholdBps)} of visits.
        </span>
      </summary>
      <PurchasingActionForm
        action={saveLostDemandTriggers}
        className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
        operation={{ resource: `lost-demand-triggers:${branchId}`, action: 'save' }}
      >
        <input name="branchId" type="hidden" value={branchId} />
        <TextField
          defaultValue={config.requestCountThreshold}
          inputMode="numeric"
          label="Requests"
          min={1}
          name="requestCountThreshold"
          notice={notice}
          required
          type="number"
        />
        <TextField
          defaultValue={config.requestWindowDays}
          hint="Days counted for requests and walk-outs"
          inputMode="numeric"
          label="Request window (days)"
          min={1}
          name="requestWindowDays"
          notice={notice}
          required
          type="number"
        />
        <TextField
          defaultValue={rupees(config.estimatedLossThresholdMinor)}
          inputMode="decimal"
          label="Estimated loss (PKR)"
          name="estimatedLossThreshold"
          notice={notice}
          required
        />
        <TextField
          defaultValue={config.lossWindowDays}
          inputMode="numeric"
          label="Loss window (days)"
          min={1}
          name="lossWindowDays"
          notice={notice}
          required
          type="number"
        />
        <TextField
          defaultValue={(config.walkOutRateThresholdBps / 100).toString()}
          hint="Share of visits that left without a sale"
          inputMode="decimal"
          label="Walk-out rate (%)"
          name="walkOutRatePercent"
          notice={notice}
          required
        />
        <TextField
          defaultValue={config.forecastWindowDays}
          hint="Sales history used for daily demand"
          inputMode="numeric"
          label="Forecast window (days)"
          min={7}
          name="forecastWindowDays"
          notice={notice}
          required
          type="number"
        />
        <TextField
          defaultValue={config.safetyStockDays}
          inputMode="numeric"
          label="Safety stock (days)"
          min={0}
          name="safetyStockDays"
          notice={notice}
          required
          type="number"
        />
        <TextField
          defaultValue={config.defaultLeadTimeDays}
          hint="Used when a distributor has no recorded delivery"
          inputMode="numeric"
          label="Default lead time (days)"
          min={0}
          name="defaultLeadTimeDays"
          notice={notice}
          required
          type="number"
        />
        <div className="sm:col-span-2 xl:col-span-4">
          <SubmitButton variant="secondary">Save triggers</SubmitButton>
        </div>
      </PurchasingActionForm>
    </details>
  );
}

function AdviceCard({ card, branchId }: { card: LostDemandAdvice; branchId: string }) {
  const canDraft = card.actions.includes('DRAFT_PURCHASE_ORDER');
  return (
    <li className="min-w-0 space-y-4 rounded-[var(--radius-md)] border border-border-subtle p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium break-words text-text-strong">{card.label}</h3>
          <p className="mt-1 text-sm break-words text-text-body">{card.summary}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {card.trigger.fired.map((fired) => (
            <StatusPill key={fired} status={fired} tone="warning" label={TRIGGER_LABEL[fired]} />
          ))}
        </div>
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-4">
        {[
          ['Forecast per day', `${card.dailyDemandUnits.toFixed(1)} units`],
          ['Safety stock', `${card.safetyStockUnits} units`],
          ['On hand', `${card.onHandUnits} units`],
          ['On order', `${card.onOrderUnits} units`],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="font-mono text-xs tracking-wide text-text-muted uppercase">
              {label}
            </dt>
            <dd className="mt-1 text-text-strong tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      {card.distributors.length ? (
        <div className="overflow-x-auto rounded-[var(--radius-sm)] border border-border-subtle">
          <table className="w-full min-w-[40rem] text-sm">
            <caption className="sr-only">Distributor options for {card.label}</caption>
            <thead>
              <tr className="border-b border-border-subtle text-left">
                <th className={TABLE_LABEL} scope="col">
                  Distributor
                </th>
                <th className={`${TABLE_LABEL} text-right`} scope="col">
                  Last price / pack
                </th>
                <th className={TABLE_LABEL} scope="col">
                  Scheme
                </th>
                <th className={`${TABLE_LABEL} text-right`} scope="col">
                  Lead time
                </th>
                <th className={`${TABLE_LABEL} text-right`} scope="col">
                  Suggested
                </th>
                <th className={`${TABLE_LABEL} text-right`} scope="col">
                  Est. cost
                </th>
                <th className={`${TABLE_LABEL} text-right`} scope="col">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {card.distributors.map((option) => (
                <tr
                  className="border-b border-border-subtle last:border-0 hover:bg-muted"
                  key={option.supplierId}
                >
                  <td className="px-3 py-2 text-text-strong">{option.supplierName}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {money(option.lastListPricePerPackMinor)}
                    {option.lastDiscountBps ? ` less ${bps(option.lastDiscountBps)}` : ''}
                  </td>
                  <td className="px-3 py-2">
                    {option.scheme
                      ? `${option.scheme.buyPacks} + ${option.scheme.bonusPacks} free`
                      : 'None'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {option.effectiveLeadTimeDays} d
                    {option.leadTimeSource === 'CONFIGURED_DEFAULT' ? ' (default)' : ''}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {option.quantity.orderedPacks} packs
                    {option.quantity.bonusPacks ? ` + ${option.quantity.bonusPacks} bonus` : ''}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {money(option.estimatedCostMinor)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {canDraft && option.quantity.orderedPacks > 0 ? (
                      <PurchasingActionForm
                        action={draftLostDemandOrder}
                        operation={{
                          resource: `lost-demand:${card.demandKey}:${option.supplierId}`,
                          action: 'draft-order',
                        }}
                      >
                        <input name="branchId" type="hidden" value={branchId} />
                        <input name="demandKey" type="hidden" value={card.demandKey} />
                        <input name="supplierId" type="hidden" value={option.supplierId} />
                        <SubmitButton variant="secondary">Draft PO</SubmitButton>
                      </PurchasingActionForm>
                    ) : (
                      <span className="text-text-muted">Covered</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {card.alternates.length ? (
        <div>
          <h4 className="font-mono text-xs tracking-wide text-text-muted uppercase">
            Same salt and strength
          </h4>
          <ul className="mt-2 space-y-1 text-sm">
            {card.alternates.map((alternate) => (
              <li className="flex flex-wrap justify-between gap-2" key={alternate.medicineId}>
                <span className="text-text-strong">{alternate.label}</span>
                <span className="text-text-muted tabular-nums">
                  {alternate.availableUnits} units on hand · margin{' '}
                  {alternate.marginPerUnitMinor === null
                    ? 'not yet sold'
                    : `${money(alternate.marginPerUnitMinor)} / unit`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {card.limitations.length ? (
        <ul className="space-y-1 text-xs text-text-muted">
          {card.limitations.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        {card.transfer ? (
          <PurchasingActionForm
            action={requestLostDemandTransfer}
            operation={{ resource: `lost-demand:${card.demandKey}`, action: 'request-transfer' }}
          >
            <input name="branchId" type="hidden" value={branchId} />
            <input name="demandKey" type="hidden" value={card.demandKey} />
            <input name="fromBranchId" type="hidden" value={card.transfer.fromBranchId} />
            <SubmitButton variant="secondary">
              Request {card.transfer.quantityUnits} units from {card.transfer.fromBranchName}
            </SubmitButton>
          </PurchasingActionForm>
        ) : null}
        <PurchasingActionForm
          action={ignoreLostDemandAdvice}
          className="flex flex-wrap items-end gap-3"
          operation={{ resource: `lost-demand:${card.demandKey}`, action: 'ignore' }}
        >
          <input name="branchId" type="hidden" value={branchId} />
          <input name="demandKey" type="hidden" value={card.demandKey} />
          <label className="text-sm font-medium text-text-body">
            <span className="block">Reason to ignore (optional)</span>
            <input className={`${CONTROL} mt-1 sm:w-56`} maxLength={500} name="reason" />
          </label>
          <SubmitButton variant="secondary">Ignore</SubmitButton>
        </PurchasingActionForm>
      </div>
    </li>
  );
}
