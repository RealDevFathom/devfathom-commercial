'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

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
import { ReportDetails } from '@/components/pharmacy/report-details';
import { pharmacyBusinessDayRange } from '@/lib/pharmacy/business-day';
import { workspaceInstantFromInput, workspaceZoneLabel } from '@/lib/timezone';
import { amountInputError, amountInputToMinor, amountInputUnit } from '@/lib/money-input';
import { demandDateAfter, demandDateMs, demandInstantMs } from '@/lib/pharmacy/demand-evidence';
import type {
  PharmacyReplenishmentReport,
  PharmacyReplenishmentReportInput,
} from '@/lib/pharmacy/replenishment-report';
import { trpc } from '@/lib/trpc';
import { SeasonalCalendarPanel } from './seasonal-calendar-panel';

type Props = {
  organizationId: string;
  branches: { id: string; name: string; businessDayEndsAtHistory?: unknown }[];
  financial: boolean;
  initialBranchId: string;
  invalidInitialBranch: boolean;
  today: string;
  /** The organisation's IANA zone: assumed arrival and expiry are typed on its clock. */
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
  ['currentUnitPriceMinor', 'Current selling price per unit', false, 0],
  ['proposedUnitPriceMinor', 'What-if selling price per unit', false, 0],
  ['salesGoalMinor', 'Sales goal', true, 0],
  ['marginGoalMinor', 'Margin goal', true, 0],
  ['packSize', 'Order pack size (units)', false, 1],
  ['minimumOrderUnits', 'Minimum order (units)', false, 0],
  ['unitCostMinor', 'Cost per unit', true, 0],
  ['budgetMinor', 'Order budget', true, 0],
  ['storageLimitUnits', 'Net additional storage capacity (units)', true, 0],
] as const;
type NumericKey = (typeof numericFields)[number][0];
/**
 * Money the owner types as an amount with up to two decimals ("125.50"); the
 * report still receives the integer minor units it always has.
 */
const moneyKeys = new Set<NumericKey>([
  'currentUnitPriceMinor',
  'proposedUnitPriceMinor',
  'salesGoalMinor',
  'marginGoalMinor',
  'unitCostMinor',
  'budgetMinor',
]);
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
      ])}
      {...props}
    />
  );
}

/**
 * The first day a scenario may start on: the shop's tomorrow, or, west of UTC late in the
 * shop's day, the day after, once the planning model's UTC midnight for tomorrow has passed.
 */
function firstPlanningDay(today: string): string {
  const tomorrow = demandDateAfter(today, 1);
  return demandDateMs(tomorrow) > Date.now() ? tomorrow : demandDateAfter(today, 2);
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeMedicine, setActiveMedicine] = useState(-1);
  const [searchRetry, setSearchRetry] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchId = useId();
  const resultsId = `${searchId}-medicines`;
  const searchStatusId = `${searchId}-status`;
  const listOpen = searchOpen && searchState === 'ready' && medicines.length > 0 && !medicineId;
  const activeOption = listOpen ? medicines[activeMedicine] : undefined;
  const [state, setState] = useState<State>('idle');
  const [manual, setManual] = useState(false);
  const [report, setReport] = useState<PharmacyReplenishmentReport | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Draft>({
    historyStartDate: demandDateAfter(today, -7),
    originDate: today,
    horizonDays: '7',
    method: 'RECENT_MEAN',
    planningOrigin: firstPlanningDay(today),
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
  function chooseMedicine(medicine: Medicine) {
    edited();
    searchVersion.current++;
    setMedicineId(medicine.id);
    setSearch(medicine.productName);
    setSearchState('idle');
    setSearchOpen(false);
    setActiveMedicine(-1);
    searchInput.current?.focus();
  }
  useEffect(() => {
    const query = search.trim();
    if (!branchId || !query || query.length > 200 || medicineId) return;

    const version = ++searchVersion.current;
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      try {
        const result = await utils.client.pharmacyMedicine.search.query(
          { query, limit: 25 },
          { signal: controller.signal }
        );
        if (controller.signal.aborted || version !== searchVersion.current) return;
        setMedicines(result.map(({ id, productName }) => ({ id, productName })));
        setActiveMedicine(-1);
        setSearchState('ready');
      } catch (error) {
        if (!controller.signal.aborted && version === searchVersion.current)
          setSearchState(denied(error) ? 'denied' : 'error');
      }
    }, 300);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [branchId, medicineId, search, searchRetry, utils.client.pharmacyMedicine.search]);
  useEffect(() => {
    if (listOpen && activeMedicine >= 0)
      document
        .getElementById(`${resultsId}-${activeMedicine}`)
        ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeMedicine, listOpen, resultsId]);
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
    const money = (key: NumericKey, optional: boolean) => {
      const parsed = amountInputToMinor(draft[key]);
      if (parsed.status === 'OK') return parsed.minor;
      if (parsed.status === 'EMPTY') {
        if (optional) return null;
        invalid[key] = 'Enter an amount, for example 125.50.';
      } else {
        invalid[key] =
          amountInputError(parsed.reason) + (optional ? ' Or leave blank for unknown.' : '');
      }
      return NaN;
    };
    const date = (key: keyof Draft) => {
      try {
        return demandDateMs(draft[key]);
      } catch {
        invalid[key] = 'Choose a valid date.';
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
    // Today is the shop's day: a day has begun once it starts on the organisation's clock,
    // the same check the server makes.
    // DEV-958A: the chosen branch's business day, which ends at its "day ends at" hour.
    const dayEnd = branches.find((branch) => branch.id === branchId)?.businessDayEndsAtHistory;
    const dayStart = (day: string) =>
      pharmacyBusinessDayRange(day, day, { timeZone, dayEnd }).from.getTime();
    if (Number.isFinite(origin) && dayStart(draft.originDate) > Date.now())
      invalid.originDate = 'History must end no later than today.';
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
      // As the server: the day must not have begun on the shop's clock or at the planning
      // model's UTC midnight.
      const planningStart = Number.isFinite(planningOrigin) ? dayStart(draft.planningOrigin) : NaN;
      if (
        Math.min(planningStart, planningOrigin) <= Date.now() ||
        planningStart > Date.now() + 31 * 86_400_000
      )
        invalid.planningOrigin = 'Choose a future day within the next 31 days.';
      const values = {} as Record<NumericKey, number | null>;
      for (const [key, , optional, minimum] of numericFields)
        values[key] = moneyKeys.has(key)
          ? money(key, optional)
          : integer(key, minimum, Number.MAX_SAFE_INTEGER, optional);
      if (!Number.isSafeInteger(values.dailyDemandUnits! * horizonDays))
        invalid.dailyDemandUnits = 'Demand across the horizon must be a safe whole-number total.';
      if (!/^[A-Z]{3}$/.test(draft.currency))
        invalid.currency = 'Enter a three-letter uppercase currency code.';
      const instant = (key: 'arrivalAt' | 'expiresAt') => {
        if (!draft[key].trim()) return null;
        try {
          // A date-and-time picker value has no zone: read it on the organisation's clock.
          const ms = demandInstantMs(workspaceInstantFromInput(draft[key].trim(), timeZone));
          if (key === 'arrivalAt' && ms < planningOrigin)
            invalid[key] = 'Arrival must be on or after the planning origin.';
          return new Date(ms).toISOString();
        } catch {
          invalid[key] = 'Choose a date and time, or leave blank for unknown.';
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
      const firstInvalid = Object.keys(invalid)[0];
      const control =
        firstInvalid === 'medicineId' ? searchInput.current : form.elements.namedItem(firstInvalid);
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
        type={type === 'decimal' ? 'text' : type}
        value={draft[key]}
        onChange={(event) => change(key, event.target.value)}
        className="mt-1 min-h-11"
        required={!optional}
        min={min}
        max={max}
        step={type === 'number' ? 1 : undefined}
        inputMode={type === 'decimal' ? 'decimal' : undefined}
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
          <StudioSelect
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
              setActiveMedicine(-1);
              setSearchOpen(false);
              setSearchState(event.target.value && search.trim() ? 'loading' : 'idle');
            }}
          >
            <option value="">Select an authorized branch</option>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </StudioSelect>
        </label>
        {errors.branchId && (
          <p id="replenishment-branch-error" className="text-sm text-destructive">
            {errors.branchId}
          </p>
        )}
        <div
          className="relative mt-4"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setSearchOpen(false);
          }}
        >
          <label className="block text-sm text-text-body">
            Find medicine
            <Input
              className="mt-1 min-h-11"
              name="medicineSearch"
              ref={searchInput}
              value={search}
              maxLength={200}
              disabled={!branchId}
              role="combobox"
              aria-autocomplete="list"
              aria-controls={listOpen ? resultsId : undefined}
              aria-expanded={listOpen}
              aria-activedescendant={activeOption ? `${resultsId}-${activeMedicine}` : undefined}
              aria-busy={searchState === 'loading'}
              autoComplete="off"
              aria-invalid={Boolean(errors.medicineId)}
              aria-describedby={`${searchStatusId}${errors.medicineId ? ' replenishment-medicine-error' : ''}`}
              placeholder="Start typing a medicine name"
              onFocus={() => {
                if (!medicineId) setSearchOpen(true);
              }}
              onKeyDown={(event) => {
                if (
                  event.nativeEvent.isComposing ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.altKey ||
                  event.shiftKey
                )
                  return;
                if (event.key === 'Escape' || event.key === 'Tab') {
                  if (event.key === 'Escape') event.preventDefault();
                  setSearchOpen(false);
                  setActiveMedicine(-1);
                } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  if (medicineId) return;
                  setSearchOpen(true);
                  if (medicines.length)
                    setActiveMedicine((index) =>
                      event.key === 'ArrowDown'
                        ? (index + 1) % medicines.length
                        : index <= 0
                          ? medicines.length - 1
                          : index - 1
                    );
                } else if ((event.key === 'Home' || event.key === 'End') && listOpen) {
                  event.preventDefault();
                  setActiveMedicine(event.key === 'Home' ? 0 : medicines.length - 1);
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  if (activeOption) chooseMedicine(activeOption);
                  else if (
                    !medicineId &&
                    search.trim() &&
                    search.trim().length <= 200 &&
                    (searchState === 'error' || searchState === 'denied' || searchState === 'idle')
                  ) {
                    setSearchOpen(true);
                    setSearchState('loading');
                    setSearchRetry((retry) => retry + 1);
                  }
                }
              }}
              onChange={(event) => {
                edited();
                searchVersion.current++;
                setSearch(event.target.value);
                setMedicineId('');
                setMedicines([]);
                setActiveMedicine(-1);
                setSearchOpen(true);
                setSearchState(
                  event.target.value.trim() && event.target.value.trim().length <= 200
                    ? 'loading'
                    : 'idle'
                );
              }}
            />
          </label>
          {listOpen && (
            <div
              id={resultsId}
              role="listbox"
              aria-label="Medicine results"
              className="absolute z-10 mt-1 max-h-64 w-full overflow-x-hidden overflow-y-auto rounded-md border border-border-default bg-surface-raised p-1 shadow-sm"
            >
              {medicines.map((medicine, index) => (
                <button
                  key={medicine.id}
                  id={`${resultsId}-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={activeMedicine === index}
                  className={`block min-h-11 w-full min-w-0 rounded-sm px-3 py-2 text-left text-sm whitespace-normal break-words text-text-strong hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-ring ${activeMedicine === index ? 'bg-surface-sunken' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveMedicine(index)}
                  onClick={() => chooseMedicine(medicine)}
                >
                  {medicine.productName}
                </button>
              ))}
            </div>
          )}
        </div>
        <div id={searchStatusId} className="mt-3 text-sm text-text-muted" role="status">
          {searchState === 'loading' && 'Searching permitted medicines…'}
          {searchState === 'ready' &&
            (medicines.length
              ? `${medicines.length} matches (maximum 25). Use arrow keys then Enter to select, or choose a result.`
              : 'No matching medicines. Try another name or alias.')}
          {searchState === 'error' &&
            'Medicine search unavailable. Press Enter in the search box to retry.'}
          {searchState === 'denied' &&
            'Medicine search access denied. Ask your workspace administrator to check access.'}
          {medicineId && `Selected ${search}.`}
        </div>
        {errors.medicineId && (
          <p id="replenishment-medicine-error" className="text-sm text-destructive">
            {errors.medicineId}
          </p>
        )}
      </SectionCard>
      <form id="replenishment-report-form" onSubmit={submit} noValidate className="space-y-6">
        <SectionCard title="Observation window" titleLevel={2}>
          <div className="grid gap-4 md:grid-cols-2">
            {field('historyStartDate', 'History start', 'date')}
            {field('originDate', 'Forecast from (history ends the day before)', 'date')}
            {field('horizonDays', 'Planning / forecast horizon (days)', 'number', false, 1, 366)}
            <label className="text-sm text-text-body">
              Forecast method
              <StudioSelect
                name="method"
                value={draft.method}
                className={selectClass}
                onChange={(event) => change('method', event.target.value)}
              >
                <option value="RECENT_MEAN">Based on recent days</option>
                <option value="WEEKLY_SEASONAL_NAIVE">Based on the same weekday last week</option>
              </StudioSelect>
            </label>
          </div>
          <p className="mt-4 text-sm text-text-muted">
            Use 1–90 history days and a 1–366 day horizon.
          </p>
          <ReportDetails>
            <p>
              Sales use business dates; demand coverage and the history use your organisation&apos;s
              days ({workspaceZoneLabel(timeZone)}). The planning scenario model counts its days
              midnight to midnight UTC. Current reads cannot reconstruct historical versions.
            </p>
          </ReportDetails>
        </SectionCard>
        <SectionCard title="Manual planning assumptions" titleLevel={2}>
          {!canPlan ? (
            <>
              <StatusPill status="REDACTED" tone="neutral" />
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
                Your settings: enter a constant daily demand and hypothetical order terms. Current
                policy means the order quantity you enter, not on-hand stock. These inputs are not
                observed demand or a forecast guarantee. Sales and margin goals and prices are
                configurable assumptions, never recorded facts.
              </p>
              {manual && (
                <div className="mt-4 space-y-4">
                  <p id="replenishment-unknown-help" className="text-sm text-text-muted">
                    Leave optional cost, budget, capacity, arrival and expiry blank when unknown. An
                    explicit 0 is a supplied assumption. Enter money in the scenario currency with
                    up to 2 decimals, for example 125.50. Arrival and expiry are on your
                    organisation&apos;s clock ({workspaceZoneLabel(timeZone)}).
                  </p>
                  <div className="grid gap-4 md:grid-cols-2">
                    {field('planningOrigin', 'Scenario starts on (a future day)', 'date')}
                    {field('currency', 'Scenario currency (three-letter code)')}
                    {numericFields.map(([key, label, optional, min]) =>
                      moneyKeys.has(key)
                        ? field(
                            key,
                            `${label} (${amountInputUnit(draft.currency)}${optional ? ', optional' : ''})`,
                            'decimal',
                            optional
                          )
                        : field(
                            key,
                            label + (optional ? ' (optional)' : ''),
                            'number',
                            optional,
                            min
                          )
                    )}
                    {field(
                      'arrivalAt',
                      'Assumed arrival (date and time, optional)',
                      'datetime-local',
                      true
                    )}
                    {field(
                      'expiresAt',
                      'Assumed expiry (date and time, optional)',
                      'datetime-local',
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
            ? 'Reading replenishment report…'
            : state === 'error' || state === 'denied'
              ? 'Retry replenishment report'
              : 'Read replenishment report'}
        </Button>
      </form>
      <SectionCard title="Report status" titleLevel={2} aria-busy={state === 'loading'}>
        <p
          role={state === 'error' || state === 'denied' ? 'alert' : 'status'}
          className="text-sm text-text-muted"
        >
          {state === 'idle' && 'Select a branch and medicine, review dates, then read the report.'}
          {state === 'stale' &&
            'Inputs changed. Previous results are hidden; read again for the active scope and assumptions.'}
          {state === 'loading' &&
            'Reading authorized evidence. Editing inputs discards this pending result.'}
          {state === 'error' &&
            'Replenishment evidence could not load for these inputs. Check dates and assumptions, then retry. No data was changed.'}
          {state === 'denied' &&
            'Report access denied or session expired. Ask your workspace administrator to check access, then retry.'}
          {state === 'ready' &&
            'Report read completed. Review source timestamps and missing prerequisites below.'}
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
      {branchId && <SeasonalCalendarPanel key={branchId} branchId={branchId} today={today} />}
    </div>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  OBSERVED_TRANSACTIONS: 'Recorded sales',
  MANUAL_SCENARIO: 'Your settings',
  SYNTHETIC_FIXTURE: 'Sample data',
};

function ReportEvidence({
  report,
  financial,
  branchName,
  medicineName,
  timeZone,
}: {
  report: PharmacyReplenishmentReport;
  financial: boolean;
  branchName: string;
  medicineName: string;
  timeZone?: string | null;
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
          As of report read: {report.readAt}. History: {demand.period.startDate} to{' '}
          {demand.period.endDateExclusive} (exclusive).
        </p>
        <p className="mt-2 break-words text-sm text-text-muted">
          Demand provenance: {SOURCE_LABELS[demand.provenance.kind] ?? demand.provenance.kind} ·{' '}
          {demand.provenance.reference}. Read at: {demand.provenance.readAt}. Sources:{' '}
          {demand.provenance.sources.join(', ')}.
        </p>
        <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Recorded consumption (business dates)"
            value={units(demand.consumption.observedCanonicalUnits)}
          />
          <Stat
            label="Observed demand days"
            value={demand.coverage.observedDemandDays}
            sub={`Of ${demand.coverage.requestedDays} requested days`}
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
          {demand.coverage.businessConsumptionDays}.
        </p>
        <ReportDetails>
          <p>
            Consumption days counted by completion time, midnight to midnight on your
            organisation&apos;s clock ({workspaceZoneLabel(timeZone)}):{' '}
            {demand.coverage.completionDayConsumptionDays}.
          </p>
        </ReportDetails>
        <details className="mt-4">
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
            Day by day
          </summary>
          {demand.days.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
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
        <StatusPill status={`${supplyCoverage.status} stock completeness`} tone="warning" />
        <p className="mt-3 text-sm text-text-muted">{supplyCoverage.reason}</p>
        <p className="mt-2 break-words text-sm text-text-muted">
          Supply provenance: {supply.inventorySource.kind} · {supply.inventorySource.reference}. As
          of: {supply.inventorySource.asOf}.
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
          <StatusPill status={`Forecast: ${report.forecast.status}`} tone="warning" />
          <StatusPill status={`Backtest: ${report.backtest.status}`} tone="warning" />
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
              {report.forecast.result.label === 'CONDITIONAL_SCENARIO'
                ? 'What-if scenario'
                : report.forecast.result.label}{' '}
              ·{' '}
              {SOURCE_LABELS[report.forecast.result.source.kind] ??
                report.forecast.result.source.kind}
              . Period: {report.forecast.result.period.startDate} to{' '}
              {report.forecast.result.period.endDateExclusive} (exclusive).
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
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
          status={!financial || !report.permissions.financial ? 'REDACTED' : report.planning.status}
          tone="neutral"
        />
        <p className="mt-3 text-sm text-text-muted">
          Based on:{' '}
          {report.planning.basis === 'USER_SUPPLIED_ASSUMPTIONS'
            ? 'Your settings'
            : report.planning.basis}
          . Read-only comparison; no order, reservation or approval is created.
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
              Period: {decision.demand.period.startDate} to{' '}
              {decision.demand.period.endDateExclusive} (exclusive).
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
                  <StatusPill status={scenario.order.status} tone="neutral" />
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
