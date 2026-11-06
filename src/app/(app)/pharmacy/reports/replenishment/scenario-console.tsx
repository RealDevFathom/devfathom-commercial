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
import { demandDateAfter, demandDateMs } from '@/lib/pharmacy/demand-evidence';
import type {
  PharmacyReplenishmentReport,
  PharmacyReplenishmentReportInput,
} from '@/lib/pharmacy/replenishment-report';
import { trpc } from '@/lib/trpc';
import {
  backtestStatusLabels,
  dayLabel,
  dayStateLabel,
  forecastMethodLabels,
  forecastStatusLabels,
  goalResultLabel,
  labelFor,
  lastDayLabel,
  orderStatusLabels,
  planningBasisLabels,
  planningStatusLabels,
  plainReason,
  policyLabel,
  readTimeLabel,
  replenishmentDates,
  serverDay,
  serverDayStart,
  statusLabel,
  stockCheckLabels,
} from './replenishment-labels';

type Props = {
  organizationId: string;
  branches: { id: string; name: string }[];
  financial: boolean;
  initialBranchId: string;
  invalidInitialBranch: boolean;
  /** Workspace IANA zone: picked dates are the workspace's calendar days. */
  timeZone: string;
  /** Server render time (ISO), so server and browser agree on the default dates. */
  now: string;
};
type Medicine = { id: string; productName: string };
type State = 'idle' | 'loading' | 'ready' | 'error' | 'denied' | 'stale';
const selectClass =
  'mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50';
const money = ' (in paisa or cents)';
const numericFields = [
  ['dailyDemandUnits', 'Expected sales per day (units)', false, 0],
  ['currentQuantityUnits', 'Your usual order (units)', false, 0],
  ['proposedQuantityUnits', 'New order to compare (units)', false, 0],
  ['currentUnitPriceMinor', `Selling price per unit now${money}`, false, 0],
  ['proposedUnitPriceMinor', `Selling price per unit to try${money}`, false, 0],
  ['salesGoalMinor', `Sales target${money}`, true, 0],
  ['marginGoalMinor', `Profit target${money}`, true, 0],
  ['packSize', 'Units per pack', false, 1],
  ['minimumOrderUnits', 'Minimum order (units)', false, 0],
  ['unitCostMinor', `Cost per unit${money}`, true, 0],
  ['budgetMinor', `Budget for this order${money}`, true, 0],
  ['storageLimitUnits', 'Extra shelf space (units)', true, 0],
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
        props.timeZone,
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
  timeZone,
  now,
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
  const [dates] = useState(() => replenishmentDates(timeZone, new Date(now)));
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
    historyStartDate: demandDateAfter(dates.latestForecastFrom, -7),
    originDate: dates.latestForecastFrom,
    horizonDays: '7',
    method: 'RECENT_MEAN',
    planningOrigin: dates.defaultPlanStart,
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
    // Re-read the clock: the latest day the server accepts moves while the page is open.
    const bounds = replenishmentDates(timeZone, new Date());
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
        const range =
          maximum === Number.MAX_SAFE_INTEGER
            ? `${minimum} or more`
            : `from ${minimum} to ${maximum}`;
        invalid[key] =
          `Enter a whole number ${range}${optional ? ', or leave it blank if you don’t know' : ''}.`;
      }
      return number;
    };
    const date = (key: keyof Draft) => {
      try {
        return demandDateMs(draft[key]);
      } catch {
        invalid[key] = 'Enter a valid date.';
        return NaN;
      }
    };
    if (!branches.some((branch) => branch.id === branchId))
      invalid.branchId = 'Choose one of your branches.';
    if (!medicines.some((medicine) => medicine.id === medicineId))
      invalid.medicineId = 'Search for a medicine and choose it.';
    const start = date('historyStartDate');
    const origin = date('originDate');
    const days = (origin - start) / 86_400_000;
    if (days < 1 || days > 90)
      invalid.historyStartDate = 'Choose a date 1 to 90 days before “Forecast from”.';
    if (origin > demandDateMs(bounds.latestForecastFrom))
      invalid.originDate = `Choose ${dayLabel(bounds.latestForecastFrom)} or an earlier date.`;
    const horizonDays = integer('horizonDays', 1, 366)!;
    const input: PharmacyReplenishmentReportInput = {
      branchId,
      medicineId,
      historyStartDate: Number.isNaN(start)
        ? draft.historyStartDate
        : serverDay(draft.historyStartDate),
      originDate: Number.isNaN(origin) ? draft.originDate : serverDay(draft.originDate),
      horizonDays,
      method: draft.method,
    };
    if (manual && canPlan) {
      const planningOrigin = date('planningOrigin');
      if (
        planningOrigin < demandDateMs(bounds.earliestPlanStart) ||
        planningOrigin > demandDateMs(bounds.latestPlanStart)
      )
        invalid.planningOrigin = `Choose a date from ${dayLabel(bounds.earliestPlanStart)} to ${dayLabel(bounds.latestPlanStart)}.`;
      const values = {} as Record<NumericKey, number | null>;
      for (const [key, , optional, minimum] of numericFields)
        values[key] = integer(key, minimum, Number.MAX_SAFE_INTEGER, optional);
      if (!Number.isSafeInteger(values.dailyDemandUnits! * horizonDays))
        invalid.dailyDemandUnits = 'Sales across all forecast days must be a smaller whole number.';
      if (!/^[A-Z]{3}$/.test(draft.currency))
        invalid.currency = 'Enter a three-letter currency code in capitals, for example PKR.';
      const day = (key: 'arrivalAt' | 'expiresAt') => {
        if (!draft[key].trim()) return null;
        const ms = date(key);
        if (Number.isNaN(ms)) return null;
        if (key === 'arrivalAt' && ms < planningOrigin)
          invalid[key] = 'Arrival can’t be before the plan starts.';
        return serverDayStart(draft[key]);
      };
      input.manualScenario = {
        originDate: Number.isNaN(planningOrigin)
          ? draft.planningOrigin
          : serverDay(draft.planningOrigin),
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
          arrivalAt: day('arrivalAt'),
          expiresAt: day('expiresAt'),
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
    min?: number | string,
    max?: number | string
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
      <SectionCard title="No branches to report on" titleLevel={2}>
        <p role="status" className="text-sm text-text-body">
          An administrator needs to make a branch available to you before you can see replenishment.
        </p>
      </SectionCard>
    );
  const historyLatest = (() => {
    try {
      return demandDateAfter(draft.originDate, -1);
    } catch {
      return undefined;
    }
  })();
  return (
    <div className="space-y-6">
      <SectionCard title="Branch and medicine" titleLevel={2}>
        {invalidInitialBranch && !branchId && (
          <p role="alert" className="mb-4 text-sm text-text-body">
            That branch isn’t available to you. Choose one of your branches.
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
            <option value="">Choose a branch</option>
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
        <div className="mt-3 text-sm text-text-body" role="status">
          {searchState === 'loading' && 'Searching medicines…'}
          {searchState === 'ready' &&
            (medicines.length
              ? `${medicines.length} matches (up to 25 shown). Type more of the name to narrow it down.`
              : 'No matching medicines. Try another name or spelling.')}
          {searchState === 'error' && 'Medicine search isn’t working right now. Try again.'}
          {searchState === 'denied' &&
            'You don’t have access to medicine search. Ask your workspace administrator.'}
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
            <option value="">Search, then choose a medicine</option>
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
        <SectionCard title="Dates" titleLevel={2}>
          <div className="grid gap-4 md:grid-cols-2">
            {field(
              'historyStartDate',
              'Use sales from',
              'date',
              false,
              (() => {
                try {
                  return demandDateAfter(draft.originDate, -90);
                } catch {
                  return undefined;
                }
              })(),
              historyLatest
            )}
            {field(
              'originDate',
              'Forecast from',
              'date',
              false,
              undefined,
              dates.latestForecastFrom
            )}
            {field('horizonDays', 'Days to forecast', 'number', false, 1, 366)}
            <label className="text-sm text-text-body">
              Forecast based on
              <select
                name="method"
                value={draft.method}
                className={selectClass}
                onChange={(event) => change('method', event.target.value)}
              >
                {(
                  Object.keys(forecastMethodLabels) as PharmacyReplenishmentReportInput['method'][]
                ).map((method) => (
                  <option key={method} value={method}>
                    {forecastMethodLabels[method]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="mt-4 text-sm text-text-body">
            Dates are in {dates.zoneName}. The forecast uses sales up to the day before “Forecast
            from”: up to 90 days of sales, forecasting up to 366 days ahead.
          </p>
        </SectionCard>
        <SectionCard title="Try your own order plan" titleLevel={2}>
          {!canPlan ? (
            <>
              <StatusPill status="Hidden for your role" tone="neutral" />
              <p className="mt-3 text-sm text-text-body">
                You can see sales and stock. Order plans need finance report access, so money
                figures are hidden.
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
                Compare order plans using my numbers
              </label>
              <p className="mt-2 text-sm text-text-body">
                {planningBasisLabels.USER_SUPPLIED_ASSUMPTIONS}: enter the sales you expect each day
                and the orders you want to compare. “Your usual order” is the amount you normally
                order, not the stock you have now. These numbers, prices and targets are your
                estimates, not recorded sales.
              </p>
              {manual && (
                <div className="mt-4 space-y-4">
                  <p id="replenishment-unknown-help" className="text-sm text-text-body">
                    Leave a box blank if you don’t know it: blank means unknown, while 0 means zero.
                    Enter money as whole paisa or cents in the currency you choose.
                  </p>
                  <div className="grid gap-4 md:grid-cols-2">
                    {field(
                      'planningOrigin',
                      'Plan starts on',
                      'date',
                      false,
                      dates.earliestPlanStart,
                      dates.latestPlanStart
                    )}
                    {field('currency', 'Currency (for example PKR)')}
                    {numericFields.map(([key, label, optional, min]) =>
                      field(key, label + (optional ? ' (optional)' : ''), 'number', optional, min)
                    )}
                    {field(
                      'arrivalAt',
                      'Order arrives on (optional)',
                      'date',
                      true,
                      draft.planningOrigin || undefined
                    )}
                    {field('expiresAt', 'Order expires on (optional)', 'date', true)}
                  </div>
                </div>
              )}
            </>
          )}
        </SectionCard>
        {Object.keys(errors).length > 0 && (
          <p role="alert" className="text-sm text-destructive">
            Fix the marked boxes, then show the report again.
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
          className="text-sm text-text-body"
        >
          {state === 'idle' &&
            'Choose a branch and medicine, check the dates, then show the report.'}
          {state === 'stale' && 'You changed something. Show the report again to update it.'}
          {state === 'loading' && 'Loading the report. Changing anything cancels this.'}
          {state === 'error' &&
            'The report couldn’t load for these choices. Check the dates and numbers, then try again. Nothing was changed.'}
          {state === 'denied' &&
            'You don’t have access to this report, or your session ended. Ask your workspace administrator, then try again.'}
          {state === 'ready' && 'Report ready. Read the notes with each section before acting.'}
        </p>
      </SectionCard>
      {report && (
        <ReportEvidence
          report={report}
          financial={financial}
          timeZone={timeZone}
          method={draft.method}
          branchName={branches.find((branch) => branch.id === branchId)?.name ?? 'Branch'}
          medicineName={
            medicines.find((medicine) => medicine.id === medicineId)?.productName ?? 'Medicine'
          }
        />
      )}
    </div>
  );
}

function ReportEvidence({
  report,
  financial,
  timeZone,
  method,
  branchName,
  medicineName,
}: {
  report: PharmacyReplenishmentReport;
  financial: boolean;
  timeZone: string;
  method: PharmacyReplenishmentReportInput['method'];
  branchName: string;
  medicineName: string;
}) {
  const { demand, supply, supplyCoverage } = report.observations;
  const decision =
    financial && report.permissions.financial && report.planning.status === 'AVAILABLE'
      ? report.planning.decision
      : null;
  const planning =
    !financial || !report.permissions.financial
      ? planningStatusLabels.REDACTED
      : statusLabel(planningStatusLabels, report.planning.status);
  const forecast = statusLabel(forecastStatusLabels, report.forecast.status);
  const backtest = statusLabel(backtestStatusLabels, report.backtest.status);
  const stock = labelFor(stockCheckLabels, supplyCoverage.status, {
    ...stockCheckLabels.UNKNOWN,
  });
  const notes = Array.from(
    new Set(
      [
        ...demand.missingInputs,
        ...supply.limitations,
        ...report.limitations,
        ...(report.forecast.result
          ? [...report.forecast.result.assumptions, ...report.forecast.result.unknowns]
          : []),
        ...report.backtest.reasons,
        ...(decision ? [...decision.assumptions, ...decision.unknowns] : []),
      ].map(plainReason)
    )
  );
  const currency = decision?.money.currency ?? '';
  const cash = (minor: number | null) =>
    minor === null ? 'Unknown' : `${currency} ${formatMinor(minor)}`.trim();
  return (
    <div className="space-y-6">
      <SectionCard title="Recorded sales" titleLevel={2}>
        <p className="text-sm text-text-body">
          {branchName} · {medicineName}
        </p>
        <p className="mt-2 break-words text-sm text-text-body">
          Sales from {dayLabel(demand.period.startDate)} to{' '}
          {lastDayLabel(demand.period.endDateExclusive)}. Checked{' '}
          {readTimeLabel(report.readAt, timeZone)}.
        </p>
        <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Units sold" value={units(demand.consumption.observedCanonicalUnits)} />
          <Stat
            label="Days with complete data"
            value={demand.coverage.observedDemandDays}
            sub={`Of ${demand.coverage.requestedDays} days`}
          />
          <Stat label="Days without data" value={demand.coverage.unknownDays} />
          <Stat label="Days it ran out" value={demand.coverage.censoredDays} />
        </div>
        <p className="mt-4 text-sm text-text-body">
          Units sold can be lower than real demand on days the medicine ran out. A day with no sales
          recorded isn’t counted as zero.
        </p>
        <p className="mt-2 text-sm text-text-body">
          Sales lines counted: {demand.coverage.qualifyingLineCount}. Left out:{' '}
          {demand.coverage.excludedLineCount}.
        </p>
        <details className="mt-4">
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-text-strong focus-visible:outline-2 focus-visible:outline-ring">
            Day by day
          </summary>
          {demand.days.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
                  <TableHead>In stock all day?</TableHead>
                  <TableHead className="text-right">Units sold</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {demand.days.map((day) => (
                  <TableRow key={day.date}>
                    <TableCell>{dayLabel(day.date)}</TableCell>
                    <TableCell>{dayStateLabel(day.state)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {units(day.observedCanonicalUnits)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-text-body">No day-by-day sales came back.</p>
          )}
        </details>
      </SectionCard>
      <SectionCard title="Stock on hand" titleLevel={2}>
        <StatusPill status={stock.label} tone={stock.tone} />
        <p className="mt-3 text-sm text-text-body">{stock.detail}</p>
        <p className="mt-3 text-sm text-text-body">
          Batches you can sell: {supplyCoverage.recordedEligibleLots}. Batches left out:{' '}
          {supply.excludedStock.length}. Deliveries on the way: {supply.inbound.length}.
        </p>
        {!supply.stock.length && (
          <p className="mt-2 text-sm text-text-body">
            No sellable batches are recorded for this medicine. Check the shelf before relying on
            this.
          </p>
        )}
        <p className="mt-2 text-sm text-text-body">
          Shelf space limit: {units(supply.constraints.storageLimitUnits)}.
        </p>
      </SectionCard>
      <SectionCard title="Forecast" titleLevel={2}>
        <div className="flex flex-wrap gap-3">
          <StatusPill status={forecast.label} tone={forecast.tone} />
          <StatusPill status={backtest.label} tone={backtest.tone} />
        </div>
        {!report.forecast.result && (
          <p className="mt-3 text-sm text-text-body">
            There isn’t enough complete sales data to forecast this medicine yet. Gaps are never
            filled with zeros.
          </p>
        )}
        {report.forecast.result && (
          <>
            <p className="mt-3 text-sm text-text-body">
              Based on {forecastMethodLabels[method].toLowerCase()}, from{' '}
              {dayLabel(report.forecast.result.period.startDate)} to{' '}
              {lastDayLabel(report.forecast.result.period.endDateExclusive)}.
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
                  <TableHead className="text-right">Expected units</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.forecast.result.days.map((day) => (
                  <TableRow key={day.date}>
                    <TableCell>{dayLabel(day.date)}</TableCell>
                    <TableCell className="text-right tabular-nums">{units(day.units)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
        <p className="mt-3 text-sm text-text-body">
          We can’t yet check this forecast against past sales, so treat it as a guide.
        </p>
      </SectionCard>
      <SectionCard title="Order plan" titleLevel={2}>
        <StatusPill status={planning.label} tone={planning.tone} />
        <p className="mt-3 text-sm text-text-body">
          Based on: {labelFor(planningBasisLabels, report.planning.basis, 'Your settings')}. This
          only compares plans; it doesn’t place an order.
        </p>
        {(!financial || !report.permissions.financial || report.planning.status === 'REDACTED') && (
          <p className="mt-2 text-sm text-text-body">
            Order plans need finance report access, so money figures are hidden.
          </p>
        )}
        {financial &&
          report.permissions.financial &&
          report.planning.status === 'NOT_REQUESTED' && (
            <p className="mt-2 text-sm text-text-body">
              Tick “Compare order plans using my numbers” above to compare orders.
            </p>
          )}
        {report.planning.status === 'INSUFFICIENT_STOCK_EVIDENCE' && (
          <p className="mt-2 text-sm text-text-body">
            No sellable stock is recorded for this medicine, so there is nothing to plan from.
            Missing stock is never treated as zero.
          </p>
        )}
        {decision && (
          <>
            <p className="mt-3 text-sm text-text-body">
              Expected sales: {report.planning.dailyDemandUnits} units a day, from{' '}
              {dayLabel(decision.demand.period.startDate)} to{' '}
              {lastDayLabel(decision.demand.period.endDateExclusive)}.
            </p>
            <p className="mt-2 text-sm text-text-body">
              Money is in {currency}, from the prices and costs you entered. Results use only the
              stock batches on record.
            </p>
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              {decision.scenarios.map((scenario) => {
                const order = labelFor(orderStatusLabels, scenario.order.status, {
                  ...orderStatusLabels.UNKNOWN,
                });
                return (
                  <article
                    key={scenario.policy}
                    className="space-y-3 rounded-md border border-border-subtle p-4"
                  >
                    <h3 className="font-semibold text-text-strong">
                      {policyLabel(scenario.policy)}
                    </h3>
                    <StatusPill status={order.label} tone={order.tone} />
                    <dl className="space-y-2 text-sm text-text-body">
                      <div>
                        <dt>Units asked for</dt>
                        <dd className="tabular-nums">{scenario.order.requestedUnits}</dd>
                      </div>
                      <div>
                        <dt>Units that fit your limits</dt>
                        <dd className="tabular-nums">{units(scenario.order.quantityUnits)}</dd>
                      </div>
                      <div>
                        <dt>Order cost</dt>
                        <dd className="tabular-nums">{cash(scenario.order.committedCashMinor)}</dd>
                      </div>
                      {scenario.outcome &&
                        (
                          [
                            ['Units short', scenario.outcome.shortageUnits],
                            ['Units that would expire', scenario.outcome.expiredUnits],
                            ['Units left at the end', scenario.outcome.endingStockUnits],
                            ['Units still on the way', scenario.outcome.pendingInboundUnits],
                          ] as const
                        ).map(([label, value]) => (
                          <div key={label}>
                            <dt>{label}</dt>
                            <dd className="tabular-nums">{value}</dd>
                          </div>
                        ))}
                    </dl>
                    {order.detail ? <p className="text-sm text-text-body">{order.detail}</p> : null}
                    {!scenario.outcome && (
                      <p className="text-sm text-text-body">
                        We can’t work out the result for this plan yet.
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
            {report.planning.goalComparison && (
              <div className="mt-5">
                <h3 className="font-semibold text-text-strong">Sales and profit targets</h3>
                <p className="mt-2 text-sm text-text-body">
                  Estimates from the prices and cost you entered, not recorded sales.
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Plan</TableHead>
                      <TableHead className="text-right">Price per unit</TableHead>
                      <TableHead className="text-right">Expected sales</TableHead>
                      <TableHead className="text-right">Expected profit</TableHead>
                      <TableHead>Targets</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.planning.goalComparison.scenarios.map((estimate) => (
                      <TableRow key={estimate.policy}>
                        <TableCell>{policyLabel(estimate.policy)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {cash(estimate.assumptions.unitPriceMinor)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {cash(estimate.salesMinor)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {cash(estimate.marginMinor)}
                        </TableCell>
                        <TableCell>
                          Sales: {goalResultLabel(estimate.goals.salesMet)} · Profit:{' '}
                          {goalResultLabel(estimate.goals.marginMet)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </SectionCard>
      <SectionCard title="Notes on this report" titleLevel={2}>
        <p className="text-sm text-text-body">
          This report reads your current records. It doesn’t change stock or create orders.
        </p>
        <details className="mt-2">
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-text-strong focus-visible:outline-2 focus-visible:outline-ring">
            Technical notes
          </summary>
          <ul className="list-disc space-y-2 pl-5 text-sm text-text-body">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      </SectionCard>
    </div>
  );
}
