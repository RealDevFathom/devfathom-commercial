'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { demandDateAfter, demandDateMs, demandInstantMs } from '@/lib/pharmacy/demand-evidence';
import type {
  PharmacyReplenishmentReport,
  PharmacyReplenishmentReportInput,
} from '@/lib/pharmacy/replenishment-report';
import { trpc } from '@/lib/trpc';
import { formatReportDateTime, formatReportWindow } from '../report-format';

type Props = {
  organizationId: string;
  branches: { id: string; name: string }[];
  financial: boolean;
  initialBranchId: string;
  invalidInitialBranch: boolean;
  today: string;
  /** Workspace IANA zone for displayed times; UTC when missing. */
  timeZone?: string | null;
};
type Medicine = { id: string; productName: string };
type State = 'idle' | 'loading' | 'ready' | 'error' | 'denied' | 'stale';
const selectClass =
  'mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50';
const numericFields = [
  ['dailyDemandUnits', 'Assumed daily demand (units)', false, 0],
  ['currentQuantityUnits', 'Current policy order (units)', false, 0],
  ['proposedQuantityUnits', 'Proposed policy order (units)', false, 0],
  ['currentUnitPriceMinor', 'Current unit selling price (minor units)', false, 0],
  ['proposedUnitPriceMinor', 'What-if unit selling price (minor units)', false, 0],
  ['salesGoalMinor', 'Sales goal (minor units)', true, 0],
  ['marginGoalMinor', 'Margin goal (minor units)', true, 0],
  ['packSize', 'Order pack size (units)', false, 1],
  ['minimumOrderUnits', 'Minimum order (units)', false, 0],
  ['unitCostMinor', 'Unit cost (integer minor units)', true, 0],
  ['budgetMinor', 'Order budget (integer minor units)', true, 0],
  ['storageLimitUnits', 'Net additional storage capacity (units)', true, 0],
] as const;
type NumericKey = (typeof numericFields)[number][0];
type Draft = Record<NumericKey, string> & {
  historyStartDate: string;
  originDate: string;
  horizonDays: string;
  method: PharmacyReplenishmentReportInput['method'];
  planningOrigin: string;
  currency: string;
  arrivalAt: string;
  expiresAt: string;
};
const denied = (error: unknown) => {
  const code = (error as { data?: { code?: string } } | null)?.data?.code;
  return code === 'FORBIDDEN' || code === 'UNAUTHORIZED';
};
const units = (value: number | null | undefined) => (value == null ? 'Unknown' : value);
const plainStatus = (value: string) => {
  const words = value.replaceAll('_', ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export function ScenarioConsole(props: Props) {
  // A server refresh that changes authority must discard all previous tenant/scope state.
  return (
    <ScenarioWorkspace
      key={JSON.stringify([
        props.organizationId,
        props.branches,
        props.financial,
        props.initialBranchId,
        props.invalidInitialBranch,
      ])}
      {...props}
    />
  );
}

function ScenarioWorkspace({
  organizationId,
  branches,
  financial,
  initialBranchId,
  invalidInitialBranch,
  today,
  timeZone,
}: Props) {
  const utils = trpc.useUtils();
  const reportVersion = useRef(0);
  const searchVersion = useRef(0);
  useEffect(
    () => () => {
      reportVersion.current++;
      searchVersion.current++;
    },
    []
  );
  const [branchId, setBranchId] = useState(initialBranchId);
  const [search, setSearch] = useState('');
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [medicineId, setMedicineId] = useState('');
  const [searchState, setSearchState] = useState<State>('idle');
  const [state, setState] = useState<State>('idle');
  const [manual, setManual] = useState(false);
  const [report, setReport] = useState<PharmacyReplenishmentReport | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Draft>({
    historyStartDate: demandDateAfter(today, -7),
    originDate: today,
    horizonDays: '7',
    method: 'RECENT_MEAN',
    planningOrigin: demandDateAfter(today, 1),
    currency: '',
    arrivalAt: '',
    expiresAt: '',
    dailyDemandUnits: '',
    currentQuantityUnits: '',
    proposedQuantityUnits: '',
    currentUnitPriceMinor: '',
    proposedUnitPriceMinor: '',
    salesGoalMinor: '',
    marginGoalMinor: '',
    packSize: '',
    minimumOrderUnits: '',
    unitCostMinor: '',
    budgetMinor: '',
    storageLimitUnits: '',
  });
  const canPlan = financial && report?.permissions.financial !== false;
  function edited() {
    reportVersion.current++;
    setReport(null);
    setState('stale');
    setErrors({});
  }
  function change(key: keyof Draft, value: string) {
    edited();
    setDraft((previous) => ({ ...previous, [key]: value }));
  }
  async function findMedicines(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!branchId || !search.trim() || search.trim().length > 200) return;
    edited();
    setMedicineId('');
    setMedicines([]);
    const version = ++searchVersion.current;
    setSearchState('loading');
    try {
      const result = await utils.client.pharmacyMedicine.search.query({
        query: search.trim(),
        limit: 25,
      });
      if (version !== searchVersion.current) return;
      setMedicines(result.map(({ id, productName }) => ({ id, productName })));
      setSearchState('ready');
    } catch (error) {
      if (version === searchVersion.current) setSearchState(denied(error) ? 'denied' : 'error');
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const invalid: Record<string, string> = {};
    const integer = (
      key: keyof Draft,
      minimum: number,
      maximum = Number.MAX_SAFE_INTEGER,
      optional = false
    ) => {
      const raw = draft[key].trim();
      if (!raw && optional) return null;
      const number = Number(raw);
      if (
        !/^\d+$/.test(raw) ||
        !Number.isSafeInteger(number) ||
        number < minimum ||
        number > maximum
      ) {
        invalid[key] =
          `Enter a whole number from ${minimum} to ${maximum}${optional ? ', or leave blank for unknown' : ''}.`;
      }
      return number;
    };
    const date = (key: keyof Draft) => {
      try {
        return demandDateMs(draft[key]);
      } catch {
        invalid[key] = 'Enter a valid UTC calendar date.';
        return NaN;
      }
    };
    if (!branches.some((branch) => branch.id === branchId))
      invalid.branchId = 'Select an authorized branch.';
    if (!medicines.some((medicine) => medicine.id === medicineId))
      invalid.medicineId = 'Search and select a medicine.';
    const start = date('historyStartDate');
    const origin = date('originDate');
    const days = (origin - start) / 86_400_000;
    if (days < 1 || days > 90)
      invalid.historyStartDate = 'Use 1 to 90 history days before the exclusive end.';
    if (origin > Date.now()) invalid.originDate = 'History must end no later than today (UTC).';
    const horizonDays = integer('horizonDays', 1, 366)!;
    const input: PharmacyReplenishmentReportInput = {
      branchId,
      medicineId,
      historyStartDate: draft.historyStartDate,
      originDate: draft.originDate,
      horizonDays,
      method: draft.method,
    };
    if (manual && canPlan) {
      const planningOrigin = date('planningOrigin');
      if (planningOrigin <= Date.now() || planningOrigin > Date.now() + 31 * 86_400_000)
        invalid.planningOrigin = 'Use a future UTC day within 31 days.';
      const values = {} as Record<NumericKey, number | null>;
      for (const [key, , optional, minimum] of numericFields)
        values[key] = integer(key, minimum, Number.MAX_SAFE_INTEGER, optional);
      if (!Number.isSafeInteger(values.dailyDemandUnits! * horizonDays))
        invalid.dailyDemandUnits = 'Demand across the horizon must be a safe whole-number total.';
      if (!/^[A-Z]{3}$/.test(draft.currency))
        invalid.currency = 'Enter a three-letter uppercase currency code.';
      const instant = (key: 'arrivalAt' | 'expiresAt') => {
        if (!draft[key].trim()) return null;
        try {
          const ms = demandInstantMs(draft[key].trim());
          if (key === 'arrivalAt' && ms < planningOrigin)
            invalid[key] = 'Arrival must be on or after the planning origin.';
          return new Date(ms).toISOString();
        } catch {
          invalid[key] =
            'Enter a date and time that includes a time zone, or leave blank if unknown.';
          return null;
        }
      };
      input.manualScenario = {
        originDate: draft.planningOrigin,
        dailyDemandUnits: values.dailyDemandUnits!,
        currentQuantityUnits: values.currentQuantityUnits!,
        proposedQuantityUnits: values.proposedQuantityUnits!,
        currency: draft.currency,
        goals: {
          salesMinor: values.salesGoalMinor,
          marginMinor: values.marginGoalMinor,
        },
        pricing: {
          currentUnitPriceMinor: values.currentUnitPriceMinor!,
          proposedUnitPriceMinor: values.proposedUnitPriceMinor!,
        },
        orderTerms: {
          packSize: values.packSize!,
          minimumOrderUnits: values.minimumOrderUnits!,
          unitCostMinor: values.unitCostMinor,
          budgetMinor: values.budgetMinor,
          storageLimitUnits: values.storageLimitUnits,
          arrivalAt: instant('arrivalAt'),
          expiresAt: instant('expiresAt'),
        },
      };
    }
    const version = ++reportVersion.current;
    setReport(null);
    setErrors(invalid);
    if (Object.keys(invalid).length) {
      setState('idle');
      const control = form.elements.namedItem(Object.keys(invalid)[0]);
      if (control instanceof HTMLElement) control.focus();
      return;
    }
    setState('loading');
    try {
      const result = await utils.client.pharmacyReports.replenishment.query(input);
      if (version !== reportVersion.current) return;
      if (
        [result.scope, result.observations.demand.scope, result.observations.supply.scope].some(
          (scope) =>
            scope.organizationId !== organizationId ||
            scope.branchId !== branchId ||
            scope.medicineId !== medicineId
        ) ||
        result.observations.demand.period.startDate !== input.historyStartDate ||
        result.observations.demand.period.endDateExclusive !== input.originDate ||
        !result.permissions.operational
      ) {
        setState('error');
        return;
      }
      setReport(result);
      setState('ready');
    } catch (error) {
      if (version === reportVersion.current) setState(denied(error) ? 'denied' : 'error');
    }
  }
  const field = (
    key: keyof Draft,
    label: string,
    type = 'text',
    optional = false,
    min?: number,
    max?: number
  ) => (
    <div className="text-sm text-text-body" key={key}>
      <label htmlFor={`replenishment-${key}`}>{label}</label>
      <Input
        id={`replenishment-${key}`}
        name={key}
        type={type}
        value={draft[key]}
        onChange={(event) => change(key, event.target.value)}
        className="mt-1 min-h-11"
        required={!optional}
        min={min}
        max={max}
        step={type === 'number' ? 1 : undefined}
        aria-invalid={Boolean(errors[key])}
        aria-describedby={
          errors[key]
            ? `replenishment-${key}-error`
            : optional
              ? 'replenishment-unknown-help'
              : undefined
        }
      />
      {errors[key] && (
        <span id={`replenishment-${key}-error`} className="mt-1 block text-destructive">
          {errors[key]}
        </span>
      )}
    </div>
  );
  if (!branches.length)
    return (
      <SectionCard title="No reportable branches" titleLevel={2}>
        <p role="status" className="text-sm text-text-muted">
          An administrator must make an active branch available before you can read replenishment
          evidence.
        </p>
      </SectionCard>
    );
  return (
    <div className="space-y-6">
      <SectionCard title="Report scope" titleLevel={2}>
        {invalidInitialBranch && !branchId && (
          <p role="alert" className="mb-4 text-sm text-text-muted">
            The requested branch is unavailable. Select an authorized branch.
          </p>
        )}
        <label className="block text-sm text-text-body">
          Branch
          <select
            name="branchId"
            form="replenishment-report-form"
            value={branchId}
            className={selectClass}
            aria-invalid={Boolean(errors.branchId)}
            aria-describedby={errors.branchId ? 'replenishment-branch-error' : undefined}
            onChange={(event) => {
              edited();
              searchVersion.current++;
              setBranchId(event.target.value);
              setMedicineId('');
              setMedicines([]);
              setSearchState('idle');
            }}
          >
            <option value="">Select an authorized branch</option>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </label>
        {errors.branchId && (
          <p id="replenishment-branch-error" className="text-sm text-destructive">
            {errors.branchId}
          </p>
        )}
        <form onSubmit={findMedicines} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="min-w-0 flex-1 text-sm text-text-body">
            Find medicine
            <Input
              className="mt-1 min-h-11"
              value={search}
              required
              maxLength={200}
              disabled={!branchId}
              onChange={(event) => {
                edited();
                searchVersion.current++;
                setSearch(event.target.value);
                setMedicineId('');
                setMedicines([]);
                setSearchState('idle');
              }}
            />
          </label>
          <Button
            type="submit"
            variant="outline"
            className="min-h-11"
            disabled={!branchId || !search.trim() || searchState === 'loading'}
          >
            Search medicines
          </Button>
        </form>
        <div className="mt-3 text-sm text-text-muted" role="status">
          {searchState === 'loading' && 'Searching permitted medicines…'}
          {searchState === 'ready' &&
            (medicines.length
              ? `${medicines.length} matches (maximum 25). Refine the search if needed.`
              : 'No matching medicines. Try another name or alias.')}
          {searchState === 'error' && 'Medicine search unavailable. Retry the search.'}
          {searchState === 'denied' &&
            'Medicine search access denied. Ask your workspace administrator to check access.'}
        </div>
        <label className="mt-4 block text-sm text-text-body">
          Medicine
          <select
            name="medicineId"
            form="replenishment-report-form"
            value={medicineId}
            className={selectClass}
            disabled={!medicines.length}
            aria-invalid={Boolean(errors.medicineId)}
            aria-describedby={errors.medicineId ? 'replenishment-medicine-error' : undefined}
            onChange={(event) => {
              edited();
              setMedicineId(event.target.value);
            }}
          >
            <option value="">Search and select a medicine</option>
            {medicines.map((medicine) => (
              <option key={medicine.id} value={medicine.id}>
                {medicine.productName}
              </option>
            ))}
          </select>
        </label>
        {errors.medicineId && (
          <p id="replenishment-medicine-error" className="text-sm text-destructive">
            {errors.medicineId}
          </p>
        )}
      </SectionCard>
      <form id="replenishment-report-form" onSubmit={submit} noValidate className="space-y-6">
        <SectionCard title="Observation window" titleLevel={2}>
          <div className="grid gap-4 md:grid-cols-2">
            {field('historyStartDate', 'History start (UTC)', 'date')}
            {field('originDate', 'History end / forecast origin (exclusive, UTC)', 'date')}
            {field('horizonDays', 'Planning / forecast horizon (days)', 'number', false, 1, 366)}
            <label className="text-sm text-text-body">
              Forecast method
              <select
                name="method"
                value={draft.method}
                className={selectClass}
                onChange={(event) => change('method', event.target.value)}
              >
                <option value="RECENT_MEAN">Recent mean</option>
                <option value="WEEKLY_SEASONAL_NAIVE">Weekly seasonal naive</option>
              </select>
            </label>
          </div>
          <p className="mt-4 text-sm text-text-muted">
            Use 1–90 history days and a 1–366 day horizon. Sales use business dates; demand coverage
            uses UTC days. Current reads cannot reconstruct historical versions.
          </p>
        </SectionCard>
        <SectionCard title="Manual planning assumptions" titleLevel={2}>
          {!canPlan ? (
            <>
              <StatusPill status="Hidden" tone="neutral" />
              <p className="mt-3 text-sm text-text-muted">
                Operational evidence is available. Planning requires financial report access;
                monetary results are withheld.
              </p>
            </>
          ) : (
            <>
              <label className="flex min-h-11 items-center gap-3 text-sm text-text-body">
                <input
                  type="checkbox"
                  checked={manual}
                  className="size-5 accent-primary focus-visible:outline-2 focus-visible:outline-ring"
                  onChange={(event) => {
                    edited();
                    setManual(event.target.checked);
                  }}
                />
                Include a user-supplied scenario
              </label>
              <p className="mt-2 text-sm text-text-muted">
                Your own assumptions: enter a steady daily demand and the order terms you want to
                compare. Current policy means the order quantity you enter, not stock on hand.
                These numbers, goals and prices are what-ifs, not recorded sales or a guaranteed
                forecast.
              </p>
              {manual && (
                <div className="mt-4 space-y-4">
                  <p id="replenishment-unknown-help" className="text-sm text-text-muted">
                    Leave optional cost, budget, capacity, arrival and expiry blank when unknown. An
                    explicit 0 is a supplied assumption. Money uses integer minor units in your
                    supplied currency. Arrival and expiry require an explicit timezone.
                  </p>
                  <div className="grid gap-4 md:grid-cols-2">
                    {field('planningOrigin', 'Scenario origin (future UTC day)', 'date')}
                    {field('currency', 'Scenario currency (three-letter code)')}
                    {numericFields.map(([key, label, optional, min]) =>
                      field(key, label + (optional ? ' (optional)' : ''), 'number', optional, min)
                    )}
                    {field(
                      'arrivalAt',
                      'Assumed arrival (date, time and time zone, optional)',
                      'text',
                      true
                    )}
                    {field(
                      'expiresAt',
                      'Assumed expiry (date, time and time zone, optional)',
                      'text',
                      true
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </SectionCard>
        {Object.keys(errors).length > 0 && (
          <p role="alert" className="text-sm text-destructive">
            Correct the marked inputs before requesting a report.
          </p>
        )}
        <Button
          type="submit"
          className="min-h-11"
          disabled={!branchId || !medicineId || state === 'loading'}
        >
          {state === 'loading'
            ? 'Loading report…'
            : state === 'error' || state === 'denied'
              ? 'Try again'
              : 'Show report'}
        </Button>
      </form>
      <SectionCard title="Report status" titleLevel={2} aria-busy={state === 'loading'}>
        <p
          role={state === 'error' || state === 'denied' ? 'alert' : 'status'}
          className="text-sm text-text-muted"
        >
          {state === 'idle' &&
            'Choose a branch and medicine, check the dates, then show the report.'}
          {state === 'stale' &&
            'Inputs changed. Show the report again to see results for the new inputs.'}
          {state === 'loading' && 'Loading the report. Changing inputs cancels it.'}
          {state === 'error' &&
            'The report could not load for these inputs. Check the dates and assumptions, then try again. No data was changed.'}
          {state === 'denied' &&
            "You don't have access to this report, or your session has ended. Ask the pharmacy owner to check your access, then try again."}
          {state === 'ready' && 'Report ready. Check the notes at the bottom for anything missing.'}
        </p>
      </SectionCard>
      {report && (
        <ReportEvidence
          report={report}
          financial={financial}
          timeZone={timeZone}
          branchName={branches.find((branch) => branch.id === branchId)?.name ?? branchId}
          medicineName={
            medicines.find((medicine) => medicine.id === medicineId)?.productName ?? medicineId
          }
        />
      )}
    </div>
  );
}

function ReportEvidence({
  report,
  financial,
  branchName,
  medicineName,
  timeZone,
}: {
  report: PharmacyReplenishmentReport;
  financial: boolean;
  timeZone?: string | null;
  branchName: string;
  medicineName: string;
}) {
  const { demand, supply, supplyCoverage } = report.observations;
  const decision =
    financial && report.permissions.financial && report.planning.status === 'AVAILABLE'
      ? report.planning.decision
      : null;
  return (
    <div className="space-y-6">
      <SectionCard title="Observed evidence" titleLevel={2}>
        <p className="text-sm text-text-body">
          {branchName} · {medicineName}
        </p>
        <p className="mt-2 break-words text-sm text-text-muted">
          History{' '}
          {formatReportWindow(
            `${demand.period.startDate}T00:00:00.000Z`,
            `${demand.period.endDateExclusive}T00:00:00.000Z`
          )}
          , from recorded sales and customer requests. Report loaded{' '}
          {formatReportDateTime(report.readAt, timeZone)}.
        </p>
        <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Recorded consumption (business dates)"
            value={units(demand.consumption.observedCanonicalUnits)}
          />
          <Stat
            label="Observed demand days"
            value={demand.coverage.observedDemandDays}
            sub={`Of ${demand.coverage.requestedDays} requested UTC days`}
          />
          <Stat label="Unknown demand days" value={demand.coverage.unknownDays} />
          <Stat label="Stockout-censored days" value={demand.coverage.censoredDays} />
        </div>
        <p className="mt-4 text-sm text-text-muted">
          Consumption is not uncensored demand. No recorded consumption does not establish zero
          demand. Historical versions are unavailable; timestamps are not an ingestion watermark.
        </p>
        <p className="mt-2 text-sm text-text-muted">
          Qualifying lines: {demand.coverage.qualifyingLineCount}; excluded lines:{' '}
          {demand.coverage.excludedLineCount}. Business-date consumption days:{' '}
          {demand.coverage.businessConsumptionDays}; UTC consumption days:{' '}
          {demand.coverage.utcConsumptionDays}.
        </p>
        <details className="mt-4">
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
            Daily UTC evidence
          </summary>
          {demand.days.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>UTC day</TableHead>
                  <TableHead>Demand state</TableHead>
                  <TableHead className="text-right">Recorded consumption units</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {demand.days.map((day) => (
                  <TableRow key={day.date}>
                    <TableCell>{day.date}</TableCell>
                    <TableCell>{day.state}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {units(day.observedCanonicalUnits)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-text-muted">
              No daily evidence returned. Coverage remains unknown.
            </p>
          )}
        </details>
      </SectionCard>
      <SectionCard title="Supply coverage" titleLevel={2}>
        <StatusPill status={`Stock data: ${plainStatus(supplyCoverage.status)}`} tone="warning" />
        <p className="mt-3 text-sm text-text-muted">{supplyCoverage.reason}</p>
        <p className="mt-2 break-words text-sm text-text-muted">
          Stock as of {formatReportDateTime(supply.inventorySource.asOf, timeZone)}.
        </p>
        <p className="mt-3 text-sm text-text-body">
          Recorded eligible lots: {supplyCoverage.recordedEligibleLots}; excluded stock records:{' '}
          {supply.excludedStock.length}; inbound records: {supply.inbound.length}. These are
          returned record counts, not complete stock or guaranteed receipts.
        </p>
        {!supply.stock.length && (
          <p className="mt-2 text-sm text-text-muted">
            Available stock quantity: Unknown. No eligible stock records returned; this does not
            establish zero inventory.
          </p>
        )}
        <p className="mt-2 text-sm text-text-muted">
          Net storage capacity: {units(supply.constraints.storageLimitUnits)}. Demand and supply are
          separate current reads, not an atomic snapshot.
        </p>
      </SectionCard>
      <SectionCard title="Forecast and backtest" titleLevel={2}>
        <div className="flex flex-wrap gap-3">
          <StatusPill status={`Forecast: ${plainStatus(report.forecast.status)}`} tone="warning" />
          <StatusPill status={`Backtest: ${plainStatus(report.backtest.status)}`} tone="warning" />
        </div>
        {!report.forecast.result && (
          <p className="mt-3 text-sm text-text-muted">
            Forecast unavailable: insufficient uncensored demand evidence. No forecast values have
            been filled with zeros.
          </p>
        )}
        {report.forecast.result && (
          <>
            <p className="mt-3 text-sm text-text-muted">
              {report.forecast.result.label}. Period{' '}
              {formatReportWindow(
                `${report.forecast.result.period.startDate}T00:00:00.000Z`,
                `${report.forecast.result.period.endDateExclusive}T00:00:00.000Z`
              )}
              .
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>UTC day</TableHead>
                  <TableHead className="text-right">Conditional units</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.forecast.result.days.map((day) => (
                  <TableRow key={day.date}>
                    <TableCell>{day.date}</TableCell>
                    <TableCell className="text-right">{units(day.units)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {[...report.forecast.result.assumptions, ...report.forecast.result.unknowns].map(
              (reason, index) => (
                <p key={index} className="mt-2 text-sm text-text-muted">
                  {reason}
                </p>
              )
            )}
          </>
        )}
        <p className="mt-3 text-sm text-text-muted">
          Backtest unavailable: no eligible historical replay. Scenario coverage is not empirical
          performance.
        </p>
        {report.backtest.reasons.map((reason, index) => (
          <p key={index} className="mt-2 text-sm text-text-muted">
            {reason}
          </p>
        ))}
      </SectionCard>
      <SectionCard title="Planning result" titleLevel={2}>
        <StatusPill
          status={
            !financial || !report.permissions.financial
              ? 'Hidden'
              : plainStatus(report.planning.status)
          }
          tone="neutral"
        />
        <p className="mt-3 text-sm text-text-muted">
          Based on your own assumptions. This only compares options; no order, reservation or
          approval is created.
        </p>
        {(!financial || !report.permissions.financial || report.planning.status === 'REDACTED') && (
          <p className="mt-2 text-sm text-text-muted">
            Planning is withheld without financial report access. Monetary values are redacted.
          </p>
        )}
        {financial &&
          report.permissions.financial &&
          report.planning.status === 'NOT_REQUESTED' && (
            <p className="mt-2 text-sm text-text-muted">
              Enable the manual scenario and supply assumptions to compare order policies.
            </p>
          )}
        {report.planning.status === 'INSUFFICIENT_STOCK_EVIDENCE' && (
          <p className="mt-2 text-sm text-text-muted">
            Planning unavailable: eligible stock evidence is missing. Unknown inventory cannot
            become a zero-stock scenario.
          </p>
        )}
        {decision && (
          <>
            <p className="mt-3 text-sm text-text-body">
              {decision.label} · Assumed daily demand: {report.planning.dailyDemandUnits} units.
              Period{' '}
              {formatReportWindow(
                `${decision.demand.period.startDate}T00:00:00.000Z`,
                `${decision.demand.period.endDateExclusive}T00:00:00.000Z`
              )}
              .
            </p>
            <p className="mt-2 text-sm text-text-muted">
              Currency: {decision.money.currency} (user supplied). {decision.money.definition}{' '}
              Coverage: {decision.money.coverage}. Conditional outcomes use only recorded eligible
              stock; completeness remains unknown.
            </p>
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              {decision.scenarios.map((scenario) => (
                <article
                  key={scenario.policy}
                  className="space-y-3 rounded-md border border-border-subtle p-4"
                >
                  <h3 className="font-semibold text-text-strong">
                    {scenario.policy.replaceAll('_', ' ')}
                  </h3>
                  <StatusPill status={plainStatus(scenario.order.status)} tone="neutral" />
                  <dl className="space-y-2 text-sm text-text-body">
                    <div>
                      <dt>Requested order units</dt>
                      <dd className="tabular-nums">{scenario.order.requestedUnits}</dd>
                    </div>
                    <div>
                      <dt>Feasible order units</dt>
                      <dd className="tabular-nums">{units(scenario.order.quantityUnits)}</dd>
                    </div>
                    <div>
                      <dt>Committed order cash</dt>
                      <dd className="tabular-nums">
                        {scenario.order.committedCashMinor === null
                          ? 'Unknown'
                          : `${decision.money.currency} ${formatMinor(scenario.order.committedCashMinor)}`}
                      </dd>
                    </div>
                    {scenario.outcome &&
                      (
                        [
                          ['Conditional shortage units', scenario.outcome.shortageUnits],
                          ['Conditional expired units', scenario.outcome.expiredUnits],
                          ['Conditional ending stock units', scenario.outcome.endingStockUnits],
                          ['Pending inbound units', scenario.outcome.pendingInboundUnits],
                        ] as const
                      ).map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd className="tabular-nums">{value}</dd>
                        </div>
                      ))}
                  </dl>
                  {!scenario.outcome && (
                    <p className="text-sm text-text-muted">
                      Outcome unknown: prerequisites are missing or the order is infeasible.
                    </p>
                  )}
                  {scenario.order.reasons.map((reason, index) => (
                    <p key={index} className="text-sm text-text-muted">
                      {reason}
                    </p>
                  ))}
                </article>
              ))}
            </div>
            {report.planning.goalComparison && (
              <div className="mt-5">
                <h3 className="font-semibold text-text-strong">Sales and margin goal what-if</h3>
                <p className="mt-2 text-sm text-text-muted">
                  {report.planning.goalComparison.label.replaceAll('_', ' ')}.{' '}
                  {report.planning.goalComparison.definition}
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Policy</TableHead>
                      <TableHead className="text-right">Unit price</TableHead>
                      <TableHead className="text-right">Sales estimate</TableHead>
                      <TableHead className="text-right">Margin estimate</TableHead>
                      <TableHead>Goal result</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.planning.goalComparison.scenarios.map((estimate) => (
                      <TableRow key={estimate.policy}>
                        <TableCell>{estimate.policy.replaceAll('_', ' ')}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {decision.money.currency}{' '}
                          {formatMinor(estimate.assumptions.unitPriceMinor)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {estimate.salesMinor === null
                            ? 'Unknown'
                            : `${decision.money.currency} ${formatMinor(estimate.salesMinor)}`}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {estimate.marginMinor === null
                            ? 'Unknown'
                            : `${decision.money.currency} ${formatMinor(estimate.marginMinor)}`}
                        </TableCell>
                        <TableCell>
                          Sales: {goalResult(estimate.goals.salesMet)}; margin:{' '}
                          {goalResult(estimate.goals.marginMet)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {[...decision.assumptions, ...decision.unknowns].map((reason, index) => (
              <p key={index} className="mt-2 text-sm text-text-muted">
                {reason}
              </p>
            ))}
          </>
        )}
      </SectionCard>
      <SectionCard title="Missing prerequisites and limits" titleLevel={2}>
        <ul className="list-disc space-y-2 pl-5 text-sm text-text-muted">
          {Array.from(
            new Set([...demand.missingInputs, ...supply.limitations, ...report.limitations])
          ).map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}

function goalResult(value: boolean | null) {
  return value === null ? 'not evaluated' : value ? 'met' : 'not met';
}
