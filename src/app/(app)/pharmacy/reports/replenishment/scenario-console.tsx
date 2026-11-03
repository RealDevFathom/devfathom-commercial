'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

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
import { reportDate, reportLabel, reportMoney } from '@/lib/pharmacy/report-presentation';
import { demandDateAfter, demandDateMs, demandInstantMs } from '@/lib/pharmacy/demand-evidence';
import type {
  PharmacyReplenishmentReport,
  PharmacyReplenishmentReportInput,
} from '@/lib/pharmacy/replenishment-report';
import { trpc } from '@/lib/trpc';

type Props = {
  organizationId: string;
  tenantCurrency: string;
  tenantTimezone: string;
  branches: { id: string; name: string }[];
  financial: boolean;
  initialBranchId: string;
  invalidInitialBranch: boolean;
  today: string;
};
type Medicine = { id: string; productName: string };
type State = 'idle' | 'loading' | 'ready' | 'error' | 'denied' | 'stale';
const selectClass =
  'mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50';
const numericFields = [
  ['dailyDemandUnits', 'Expected daily demand (units)', false, 0],
  ['currentQuantityUnits', 'Current order quantity (units)', false, 0],
  ['proposedQuantityUnits', 'Proposed order quantity (units)', false, 0],
  ['currentUnitPriceMinor', 'Current selling price', false, 0],
  ['proposedUnitPriceMinor', 'Proposed selling price', false, 0],
  ['salesGoalMinor', 'Sales target', true, 0],
  ['marginGoalMinor', 'Margin target', true, 0],
  ['packSize', 'Order pack size (units)', false, 1],
  ['minimumOrderUnits', 'Minimum order (units)', false, 0],
  ['unitCostMinor', 'Cost per unit', true, 0],
  ['budgetMinor', 'Order budget', true, 0],
  ['storageLimitUnits', 'Space for additional stock (units)', true, 0],
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

function calendarDate(value: string) {
  // API calendar dates must not move when the tenant timezone changes.
  try {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(
      demandDateMs(value)
    );
  } catch {
    return 'Date unavailable';
  }
}

function ReferenceDetails({ children }: { children: ReactNode }) {
  return (
    <details className="mt-4 min-w-0 break-words text-sm text-text-muted">
      <summary className="min-h-11 cursor-pointer py-3 font-medium focus-visible:outline-2 focus-visible:outline-ring">
        References and calculation details
      </summary>
      <div className="space-y-2">{children}</div>
    </details>
  );
}

const statusLabels: Record<string, string> = {
    REDACTED: 'Financial access required',
    NOT_REQUESTED: 'No order comparison requested',
    AVAILABLE: 'Ready',
    UNKNOWN: 'Not enough records',
    INSUFFICIENT_EVIDENCE: 'More records needed',
    INSUFFICIENT_STOCK_EVIDENCE: 'More stock records needed',
    CENSORED_STOCKOUT: 'Demand affected by stockouts',
    STOCKOUT_CENSORED: 'Demand affected by stockouts',
};
const statusLabel = (value: string) => statusLabels[value] ?? reportLabel(value);

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
  tenantCurrency,
  tenantTimezone,
  branches,
  financial,
  initialBranchId,
  invalidInitialBranch,
  today,
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
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeMedicine, setActiveMedicine] = useState(-1);
  const medicineInput = useRef<HTMLInputElement>(null);
  const medicineList = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const query = search.trim();
    if (!branchId || medicineId || query.length < 2 || query.length > 200) return;
    const version = ++searchVersion.current;
    const timer = setTimeout(async () => {
      setSearchState('loading');
      try {
        const result = await utils.client.pharmacyMedicine.search.query({ query, limit: 25 });
        if (version !== searchVersion.current) return;
        setMedicines(result.map(({ id, productName }) => ({ id, productName })));
        setSearchState('ready');
      } catch (error) {
        if (version === searchVersion.current) setSearchState(denied(error) ? 'denied' : 'error');
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      searchVersion.current++;
    };
  }, [branchId, search, medicineId, searchAttempt, utils.client]);
  useEffect(() => {
    if (searchOpen && activeMedicine >= 0)
      medicineList.current?.children[activeMedicine]?.scrollIntoView({ block: 'nearest' });
  }, [searchOpen, activeMedicine]);
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
    currency: tenantCurrency,
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
  function selectMedicine(medicine: Medicine) {
    edited();
    searchVersion.current++;
    setMedicineId(medicine.id);
    setSearch(medicine.productName);
    medicineInput.current?.focus();
    setSearchOpen(false);
    setActiveMedicine(-1);
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
            'Use an ISO instant with timezone, for example 2026-09-16T12:00:00Z, or leave blank for unknown.';
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
        firstInvalid === 'medicineId' ? medicineInput.current : form.elements.namedItem(firstInvalid);
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
          [
            errors[key] && `replenishment-${key}-error`,
            optional && 'replenishment-unknown-help',
            key.endsWith('Minor') && `replenishment-${key}-money`,
            (key === 'arrivalAt' || key === 'expiresAt') && 'replenishment-instant-help',
          ].filter(Boolean).join(' ') || undefined
        }
      />
      {key.endsWith('Minor') && (
        <p id={`replenishment-${key}-money`} className="mt-1 text-sm text-text-muted">
          Enter whole hundredths: 100 = {reportMoney(100, draft.currency)}.
          {draft[key].trim() && ` Entered amount: ${reportMoney(Number(draft[key]), draft.currency)}.`}
        </p>
      )}
      {(key === 'arrivalAt' || key === 'expiresAt') && draft[key].trim() && (
        <p className="mt-1 text-sm text-text-muted">
          In {tenantTimezone}: {reportDate(draft[key], tenantTimezone)}
        </p>
      )}
      {errors[key] && (
        <span id={`replenishment-${key}-error`} className="mt-1 block text-destructive">
          {errors[key]}
        </span>
      )}
    </div>
  );
  if (!branches.length)
    return (
      <SectionCard title="No branches available" titleLevel={2}>
        <p role="status" className="text-sm text-text-muted">
          Ask your administrator to make an active branch available before reading this report.
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
              setSearchOpen(false);
              setActiveMedicine(-1);
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
        <div className="mt-4">
          <label htmlFor="replenishment-medicine-search" className="text-sm text-text-body">
            Find medicine
          </label>
          <Input
            ref={medicineInput}
            id="replenishment-medicine-search"
            className="mt-1 min-h-11"
            role="combobox"
            aria-autocomplete="list"
            aria-required="true"
            aria-expanded={searchOpen}
            aria-controls={searchOpen ? 'replenishment-medicine-list' : undefined}
            aria-activedescendant={
              searchOpen && activeMedicine >= 0
                ? `replenishment-medicine-option-${activeMedicine}`
                : undefined
            }
            aria-invalid={Boolean(errors.medicineId)}
            aria-describedby={
              errors.medicineId
                ? 'replenishment-medicine-status replenishment-medicine-error'
                : 'replenishment-medicine-status'
            }
            autoComplete="off"
            value={search}
            maxLength={200}
            disabled={!branchId}
            onFocus={() => setSearchOpen(search.trim().length >= 2)}
            onClick={() => setSearchOpen(search.trim().length >= 2)}
            onBlur={() => {
              setSearchOpen(false);
              setActiveMedicine(-1);
            }}
            onChange={(event) => {
              edited();
              searchVersion.current++;
              setSearch(event.target.value);
              setMedicineId('');
              setMedicines([]);
              setSearchState('idle');
              setSearchOpen(event.target.value.trim().length >= 2);
              setActiveMedicine(-1);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                setSearchOpen(false);
                setActiveMedicine(-1);
              } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (!medicines.length) return;
                setSearchOpen(true);
                setActiveMedicine((current) =>
                  event.key === 'ArrowDown'
                    ? (current + 1) % medicines.length
                    : (current <= 0 ? medicines.length : current) - 1
                );
              } else if (event.key === 'Enter') {
                event.preventDefault();
                if (searchOpen && medicines[activeMedicine])
                  selectMedicine(medicines[activeMedicine]);
              }
            }}
          />
          <input
            type="hidden"
            name="medicineId"
            form="replenishment-report-form"
            value={medicineId}
          />
          {searchOpen && (
            <ul
              ref={medicineList}
              id="replenishment-medicine-list"
              role="listbox"
              aria-label="Medicine matches"
              aria-busy={searchState === 'loading'}
              className="mt-1 max-h-72 overflow-y-auto rounded-md border border-input bg-surface-raised p-1"
            >
              {medicines.map((medicine, index) => (
                <li
                  key={medicine.id}
                  id={`replenishment-medicine-option-${index}`}
                  role="option"
                  aria-selected={medicine.id === medicineId}
                  className={`min-h-11 cursor-pointer break-words rounded-sm px-3 py-3 text-sm text-text-strong hover:bg-muted ${activeMedicine === index ? 'bg-muted outline-2 outline-ring -outline-offset-2' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectMedicine(medicine)}
                >
                  {medicine.productName}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div
          id="replenishment-medicine-status"
          className="mt-3 text-sm text-text-muted"
          role="status"
        >
          {searchState === 'idle' &&
            (!branchId
              ? 'Select an authorized branch to find a medicine.'
              : search.trim().length < 2
                ? 'Type at least 2 characters to find a medicine.'
                : 'Waiting to search…')}
          {searchState === 'loading' && 'Searching permitted medicines…'}
          {searchState === 'ready' &&
            (medicines.length
              ? `${medicines.length} matches (maximum 25). Refine the search if needed.`
              : 'No matching medicines. Try another name or alias.')}
          {searchState === 'error' && 'Medicine search unavailable. Retry the search.'}
          {searchState === 'denied' &&
            'Medicine search access denied. Ask your workspace administrator to check access.'}
        </div>
        {(searchState === 'error' || searchState === 'denied') && (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => {
              setSearchState('idle');
              setSearchAttempt((attempt) => attempt + 1);
              medicineInput.current?.focus();
            }}
          >
            Retry medicine search
          </Button>
        )}
        {errors.medicineId && (
          <p id="replenishment-medicine-error" className="text-sm text-destructive">
            {errors.medicineId}
          </p>
        )}
      </SectionCard>
      <form id="replenishment-report-form" onSubmit={submit} noValidate className="space-y-6">
        <SectionCard title="History and forecast" titleLevel={2}>
          <div className="grid gap-4 md:grid-cols-2">
            {field('historyStartDate', 'History start date', 'date')}
            {field('originDate', 'History end date (not included)', 'date')}
            {field('horizonDays', 'Days to plan ahead', 'number', false, 1, 366)}
            <label className="text-sm text-text-body">
              Forecast method
              <select
                name="method"
                value={draft.method}
                className={selectClass}
                onChange={(event) => change('method', event.target.value)}
              >
                <option value="RECENT_MEAN">Recent daily average</option>
                <option value="WEEKLY_SEASONAL_NAIVE">Repeat the weekly pattern</option>
              </select>
            </label>
          </div>
          <p className="mt-4 text-sm text-text-muted">
            Choose 1–90 days of history and plan 1–366 days ahead. The end date is not included.
            History and forecast dates use UTC calendar days; sales retain their recorded business
            dates. Recorded times are shown in {tenantTimezone}.
          </p>
          <ReferenceDetails>
            <p>
              Recent daily average uses RECENT_MEAN; repeating the weekly pattern uses
              WEEKLY_SEASONAL_NAIVE. Timezone display does not change the API's UTC date boundaries.
              Current records cannot reconstruct earlier versions.
            </p>
          </ReferenceDetails>
        </SectionCard>
        <SectionCard title="Compare order options" titleLevel={2}>
          {!canPlan ? (
            <>
              <StatusPill status="Financial access required" tone="neutral" />
              <p className="mt-3 text-sm text-text-muted">
                You can view stock and demand records. Comparing orders and viewing money amounts
                requires financial report access.
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
                Compare a proposed order
              </label>
              <p className="mt-2 text-sm text-text-muted">
                Compare your current order quantity with a proposed order using expected daily
                demand. Order quantity is what you plan to buy, not stock already on hand. Prices,
                targets and demand are your assumptions, not recorded facts or guaranteed results.
              </p>
              {manual && (
                <div className="mt-4 space-y-4">
                  <p id="replenishment-unknown-help" className="text-sm text-text-muted">
                    Leave optional cost, budget, space, arrival and expiry blank if unknown.
                    Entering 0 means you expect zero. Currency starts with your workspace setting
                    ({tenantCurrency || 'not configured'}); you can change it for this comparison.
                  </p>
                  <p id="replenishment-instant-help" className="text-sm text-text-muted">
                    Arrival and expiry need a date, time and timezone offset, for example
                    2026-11-04T09:00:00+00:00. The preview uses {tenantTimezone}. Plan start dates
                    remain UTC calendar days.
                  </p>
                  <div className="grid gap-4 md:grid-cols-2">
                    {field('planningOrigin', 'Plan start date (future day)', 'date')}
                    {field('currency', 'Scenario currency')}
                    {numericFields.map(([key, label, optional, min]) =>
                      field(key, label + (optional ? ' (optional)' : ''), 'number', optional, min)
                    )}
                    {field('arrivalAt', 'Expected arrival (optional)', 'text', true)}
                    {field('expiresAt', 'Expected expiry (optional)', 'text', true)}
                  </div>
                  <ReferenceDetails>
                    <p>
                      Basis: USER_SUPPLIED_ASSUMPTIONS. Money inputs remain integer minor units
                      (hundredths); blank optional values remain null. Arrival and expiry are ISO
                      instants with an explicit offset. The API uses a future UTC planning origin.
                    </p>
                  </ReferenceDetails>
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
            'Inputs changed. Previous results are hidden; read again for your current choices.'}
          {state === 'loading' &&
            'Reading your stock and demand records. Editing inputs cancels this result.'}
          {state === 'error' &&
            'The report could not load. Check your dates and order assumptions, then retry. No data was changed.'}
          {state === 'denied' &&
            'Report access denied or session expired. Ask your workspace administrator to check access, then retry.'}
          {state === 'ready' &&
            'Report ready. Review when records were read and any missing information below.'}
        </p>
      </SectionCard>
      {report && (
        <ReportEvidence
          report={report}
          financial={financial}
          tenantCurrency={tenantCurrency}
          tenantTimezone={tenantTimezone}
          branchName={branches.find((branch) => branch.id === branchId)?.name || 'Selected branch'}
          medicineName={
            medicines.find((medicine) => medicine.id === medicineId)?.productName || 'Selected medicine'
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
  tenantCurrency,
  tenantTimezone,
}: {
  report: PharmacyReplenishmentReport;
  financial: boolean;
  branchName: string;
  medicineName: string;
  tenantCurrency: string;
  tenantTimezone: string;
}) {
  const { demand, supply, supplyCoverage } = report.observations;
  const decision =
    financial && report.permissions.financial && report.planning.status === 'AVAILABLE'
      ? report.planning.decision
      : null;
  const currency = decision?.money.currency || tenantCurrency;
  return (
    <div className="min-w-0 space-y-6">
      <SectionCard title="Recorded demand" titleLevel={2}>
        <p className="break-words text-sm text-text-body">
          {branchName} · {medicineName}
        </p>
        <p className="mt-2 text-sm text-text-muted">
          Report read: {reportDate(report.readAt, tenantTimezone)} ({tenantTimezone}). History:
          {' '}{calendarDate(demand.period.startDate)} to{' '}
          {calendarDate(demand.period.endDateExclusive)} (end date not included).
        </p>
        <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Recorded medicine use" value={units(demand.consumption.observedCanonicalUnits)} sub="Units, by recorded business date" />
          <Stat label="Days with demand records" value={demand.coverage.observedDemandDays} sub={`Of ${demand.coverage.requestedDays} requested UTC days`} />
          <Stat label="Days without enough information" value={demand.coverage.unknownDays} />
          <Stat label="Days affected by stockouts" value={demand.coverage.censoredDays} />
        </div>
        <p className="mt-4 text-sm text-text-muted">
          Recorded medicine use may understate demand when stock ran out. No recorded use does not
          mean no demand. Read times do not guarantee that every record has arrived.
        </p>
        <p className="mt-2 text-sm text-text-muted">
          Included lines: {demand.coverage.qualifyingLineCount}; excluded lines: {demand.coverage.excludedLineCount}.
          Days with recorded use: {demand.coverage.businessConsumptionDays} by business date;
          {' '}{demand.coverage.utcConsumptionDays} by UTC day.
        </p>
        <ReferenceDetails>
          <p>Branch reference: {report.scope.branchId}. Medicine reference: {report.scope.medicineId}.</p>
          <p>Demand source: {demand.provenance.kind} · {demand.provenance.reference}.</p>
          <p>Source read: {reportDate(demand.provenance.readAt, tenantTimezone)} ({tenantTimezone}). Sources: {demand.provenance.sources.join(', ')}.</p>
          <p>Consumption is not uncensored demand. Historical versions are unavailable; timestamps are not an ingestion watermark.</p>
        </ReferenceDetails>
        <details className="mt-4">
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
            Daily demand records (UTC dates)
          </summary>
          {demand.days.length ? (
            <Table>
              <TableHeader><TableRow>
                <TableHead>Day (UTC)</TableHead><TableHead>Record status</TableHead>
                <TableHead className="text-right">Recorded use (units)</TableHead>
              </TableRow></TableHeader>
              <TableBody>{demand.days.map((day) => (
                <TableRow key={day.date}>
                  <TableCell>{calendarDate(day.date)}</TableCell>
                  <TableCell><span title={day.state}>{statusLabel(day.state)}</span></TableCell>
                  <TableCell className="text-right tabular-nums">{units(day.observedCanonicalUnits)}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          ) : <p className="text-sm text-text-muted">No daily records returned. Demand remains unknown.</p>}
        </details>
      </SectionCard>
      <SectionCard title="Stock and incoming deliveries" titleLevel={2}>
        <StatusPill status={`Stock records: ${statusLabel(supplyCoverage.status)}`} tone="warning" />
        <p className="mt-3 text-sm text-text-body">
          Included batches: {supplyCoverage.recordedEligibleLots}; excluded stock records: {supply.excludedStock.length};
          incoming delivery records: {supply.inbound.length}. These counts do not guarantee complete
          stock records or confirmed deliveries.
        </p>
        <p className="mt-2 text-sm text-text-muted">
          Stock read: {reportDate(supply.inventorySource.asOf, tenantTimezone)} ({tenantTimezone}).
          Space for additional stock: {units(supply.constraints.storageLimitUnits)} units.
          Demand and stock were read separately, so they may reflect different moments.
        </p>
        {!supply.stock.length && <p className="mt-2 text-sm text-text-muted">
          Available stock quantity is unknown. No usable stock records were returned; this does not mean stock is zero.
        </p>}
        <ReferenceDetails>
          <p>Stock coverage: {supplyCoverage.status}. {supplyCoverage.reason}</p>
          <p>Stock source: {supply.inventorySource.kind} · {supply.inventorySource.reference}.</p>
        </ReferenceDetails>
      </SectionCard>
      <SectionCard title="Demand forecast" titleLevel={2}>
        <div className="flex flex-wrap gap-3">
          <StatusPill status={`Forecast: ${statusLabel(report.forecast.status)}`} tone="warning" />
          <StatusPill status={`Historical check: ${statusLabel(report.backtest.status)}`} tone="warning" />
        </div>
        {!report.forecast.result && <p className="mt-3 text-sm text-text-muted">
          More demand history unaffected by stockouts is needed for a forecast. Missing estimates have not been replaced with zero.
        </p>}
        {report.forecast.result && <>
          <p className="mt-3 text-sm text-text-muted">
            Estimated demand from {calendarDate(report.forecast.result.period.startDate)} to{' '}
            {calendarDate(report.forecast.result.period.endDateExclusive)} (end date not included).
          </p>
          <Table>
            <TableHeader><TableRow><TableHead>Day (UTC)</TableHead><TableHead className="text-right">Estimated units</TableHead></TableRow></TableHeader>
            <TableBody>{report.forecast.result.days.map((day) => (
              <TableRow key={day.date}><TableCell>{calendarDate(day.date)}</TableCell><TableCell className="text-right">{units(day.units)}</TableCell></TableRow>
            ))}</TableBody>
          </Table>
          <ReferenceDetails>
            <p>{report.forecast.result.label} · {report.forecast.result.source.kind}.</p>
            {[...report.forecast.result.assumptions, ...report.forecast.result.unknowns].map((reason, index) => <p key={index}>{reason}</p>)}
          </ReferenceDetails>
        </>}
        <p className="mt-3 text-sm text-text-muted">
          There is not enough historical data to check past forecast accuracy. An order comparison is an estimate, not proof of past performance.
        </p>
        <ReferenceDetails>
          <p>Forecast status: {report.forecast.status}. Backtest status: {report.backtest.status}.</p>
          {report.backtest.reasons.map((reason, index) => <p key={index}>{reason}</p>)}
        </ReferenceDetails>
      </SectionCard>
      <SectionCard title="Order comparison" titleLevel={2}>
        <StatusPill status={statusLabel(!financial || !report.permissions.financial ? 'REDACTED' : report.planning.status)} tone="neutral" />
        <p className="mt-3 text-sm text-text-muted">
          This comparison does not place an order, reserve stock or approve a purchase.
        </p>
        {(!financial || !report.permissions.financial || report.planning.status === 'REDACTED') && <p className="mt-2 text-sm text-text-muted">
          Financial report access is required to compare orders and view money amounts.
        </p>}
        {financial && report.permissions.financial && report.planning.status === 'NOT_REQUESTED' && <p className="mt-2 text-sm text-text-muted">
          Turn on “Compare a proposed order” and enter your assumptions to compare order quantities.
        </p>}
        {report.planning.status === 'INSUFFICIENT_STOCK_EVIDENCE' && <p className="mt-2 text-sm text-text-muted">
          More usable stock records are needed. Unknown stock cannot be treated as zero stock.
        </p>}
        <ReferenceDetails><p>Planning status: {report.planning.status}. Basis: {report.planning.basis}.</p></ReferenceDetails>
        {decision && <>
          <p className="mt-3 text-sm text-text-body">
            Expected daily demand: {report.planning.dailyDemandUnits} units. Plan dates:
            {' '}{calendarDate(decision.demand.period.startDate)} to{' '}
            {calendarDate(decision.demand.period.endDateExclusive)} (end date not included).
          </p>
          <p className="mt-2 text-sm text-text-muted">
            Scenario currency: {currency || 'not configured'}. Results use your assumptions and the
            available stock records; those records may be incomplete.
          </p>
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            {decision.scenarios.map((scenario) => (
              <article key={scenario.policy} className="min-w-0 space-y-3 rounded-md border border-border-subtle p-4">
                <h3 className="font-semibold text-text-strong">{reportLabel(scenario.policy).replace(/policy/i, 'order')}</h3>
                <StatusPill status={statusLabel(scenario.order.status)} tone="neutral" />
                <dl className="space-y-2 text-sm text-text-body">
                  <div><dt>Requested order (units)</dt><dd className="tabular-nums">{scenario.order.requestedUnits}</dd></div>
                  <div><dt>Possible order (units)</dt><dd className="tabular-nums">{units(scenario.order.quantityUnits)}</dd></div>
                  <div><dt>Cash needed for order</dt><dd className="break-words tabular-nums">{reportMoney(scenario.order.committedCashMinor, currency)}</dd></div>
                  {scenario.outcome && ([
                    ['Estimated shortage (units)', scenario.outcome.shortageUnits],
                    ['Estimated expiry loss (units)', scenario.outcome.expiredUnits],
                    ['Estimated stock left (units)', scenario.outcome.endingStockUnits],
                    ['Awaiting delivery (units)', scenario.outcome.pendingInboundUnits],
                  ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="tabular-nums">{value}</dd></div>)}
                </dl>
                {!scenario.outcome && <p className="text-sm text-text-muted">An outcome cannot be estimated: information is missing or the order cannot be fulfilled.</p>}
                <ReferenceDetails>
                  <p>Policy: {scenario.policy}. Order status: {scenario.order.status}.</p>
                  {scenario.order.reasons.map((reason, index) => <p key={index}>{reason}</p>)}
                </ReferenceDetails>
              </article>
            ))}
          </div>
          {report.planning.goalComparison && <div className="mt-5">
            <h3 className="font-semibold text-text-strong">Sales and margin targets</h3>
            <Table>
              <TableHeader><TableRow>
                <TableHead>Order option</TableHead><TableHead className="text-right">Selling price</TableHead>
                <TableHead className="text-right">Estimated sales</TableHead><TableHead className="text-right">Estimated margin</TableHead><TableHead>Targets</TableHead>
              </TableRow></TableHeader>
              <TableBody>{report.planning.goalComparison.scenarios.map((estimate) => (
                <TableRow key={estimate.policy}>
                  <TableCell>{reportLabel(estimate.policy).replace(/policy/i, 'order')}</TableCell>
                  <TableCell className="text-right tabular-nums">{reportMoney(estimate.assumptions.unitPriceMinor, currency)}</TableCell>
                  <TableCell className="text-right tabular-nums">{reportMoney(estimate.salesMinor, currency)}</TableCell>
                  <TableCell className="text-right tabular-nums">{reportMoney(estimate.marginMinor, currency)}</TableCell>
                  <TableCell>Sales: {goalResult(estimate.goals.salesMet)}; margin: {goalResult(estimate.goals.marginMet)}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
            <ReferenceDetails><p>{report.planning.goalComparison.label}. {report.planning.goalComparison.definition}</p></ReferenceDetails>
          </div>}
          <ReferenceDetails>
            <p>{decision.label}. Currency: {decision.money.currency} (scenario assumption).</p>
            <p>{decision.money.definition} Coverage: {decision.money.coverage}.</p>
            {[...decision.assumptions, ...decision.unknowns].map((reason, index) => <p key={index}>{reason}</p>)}
          </ReferenceDetails>
        </>}
      </SectionCard>
      <SectionCard title="Missing information and limits" titleLevel={2}>
        <p className="text-sm text-text-muted">Review these details before using the estimates. Missing information is not treated as zero.</p>
        <ReferenceDetails>
          <ul className="list-disc space-y-2 pl-5">{Array.from(new Set([...demand.missingInputs, ...supply.limitations, ...report.limitations])).map((reason) => <li key={reason}>{reason}</li>)}</ul>
        </ReferenceDetails>
      </SectionCard>
    </div>
  );
}

function goalResult(value: boolean | null) {
  return value === null ? 'not evaluated' : value ? 'met' : 'not met';
}
