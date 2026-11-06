import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PharmacyReplenishmentReport,
  PharmacyReplenishmentReportInput,
} from '@/lib/pharmacy/replenishment-report';
import { plainReason, replenishmentDates } from './replenishment-labels';

/**
 * DEV-596: the replenishment report speaks plainly. Raw enum values and statistics terms never
 * reach the page, and dates are picked on the workspace's calendar (Asia/Karachi here) and sent
 * as the day labels the server reads.
 */
const h = vi.hoisted(() => ({
  search: vi.fn(),
  replenishment: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      client: {
        pharmacyMedicine: { search: { query: h.search } },
        pharmacyReports: { replenishment: { query: h.replenishment } },
      },
    }),
  },
}));

import { ScenarioConsole } from './scenario-console';

const RAW_ENUM = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
const JARGON = [
  'Weekly seasonal naive',
  'Recent mean',
  'History end',
  'forecast origin',
  'exclusive',
  'UTC',
  'ISO instant',
  'minor units',
  'provenance',
  'censored',
  'Backtest',
  'REDACTED',
  'UNKNOWN',
];

function report(input: PharmacyReplenishmentReportInput) {
  const scope = { organizationId: 'org-1', branchId: input.branchId, medicineId: input.medicineId };
  return {
    scope,
    readAt: '2026-11-02T10:00:00.000Z',
    permissions: { operational: true, financial: true },
    observations: {
      demand: {
        scope,
        period: { startDate: input.historyStartDate, endDateExclusive: input.originDate },
        provenance: {
          kind: 'OBSERVED_TRANSACTIONS',
          readAt: '2026-11-02T10:00:00.000Z',
          reference: 'pharmacy_sales + pharmacy_sale_lines',
          historicalVersionsAvailable: false,
          sources: ['Current COMPLETED sales: businessDate, completedAt.'],
        },
        consumption: { timeBasis: 'SALE_BUSINESS_DATE', days: [], observedCanonicalUnits: 12 },
        days: [
          {
            date: '2026-10-28',
            observedCanonicalUnits: 5,
            lineCount: 2,
            timeBasis: 'UTC_DAY',
            state: 'UNKNOWN',
            stockoutEventCount: 0,
            estimatedDemandUnits: null,
            knownAt: null,
          },
          {
            date: '2026-10-29',
            observedCanonicalUnits: null,
            lineCount: 0,
            timeBasis: 'UTC_DAY',
            state: 'STOCKOUT_CENSORED',
            stockoutEventCount: 1,
            estimatedDemandUnits: null,
            knownAt: null,
          },
        ],
        coverage: {
          requestedDays: 14,
          businessConsumptionDays: 1,
          utcConsumptionDays: 1,
          observedDemandDays: 0,
          unknownDays: 13,
          censoredDays: 1,
          qualifyingLineCount: 2,
          excludedLineCount: 0,
        },
        missingInputs: [
          'Facts after readAt were excluded; prior versions cannot be reconstructed.',
        ],
        backtestEligibility: { eligible: false, reasons: [] },
      },
      supply: {
        scope,
        inventorySource: {
          kind: 'OBSERVED_TRANSACTIONS',
          reference: 'inventory',
          asOf: '2026-11-02T10:00:00.000Z',
        },
        stock: [{ inventoryLotId: 'lot-1' }],
        excludedStock: [],
        inbound: [],
        constraints: { budgetMinor: null, storageLimitUnits: null },
        limitations: ['Outstanding purchase units subtract only POSTED accepted receipt units.'],
      },
      supplyCoverage: {
        status: 'UNKNOWN',
        recordedEligibleLots: 1,
        reason: 'Stock completeness is unverified. Empty reads do not establish zero inventory.',
      },
    },
    forecast: { status: 'INSUFFICIENT_EVIDENCE', result: null },
    backtest: {
      status: 'INELIGIBLE',
      result: null,
      reasons: ['No complete uncensored demand days are established.'],
    },
    planning: {
      status: 'AVAILABLE',
      basis: 'USER_SUPPLIED_ASSUMPTIONS',
      dailyDemandUnits: 5,
      decision: {
        label: 'CONDITIONAL_SCENARIO',
        demand: { period: { startDate: '2026-11-04', endDateExclusive: '2026-11-11' } },
        money: {
          currency: 'PKR',
          scale: 'MINOR_UNITS',
          definition: 'Committed cash only.',
          coverage: 'SUPPLIED_ORDER_TERMS_ONLY',
        },
        scenarios: [
          {
            policy: 'NO_ORDER',
            order: {
              status: 'FEASIBLE',
              requestedUnits: 0,
              quantityUnits: 0,
              committedCashMinor: 0,
              reasons: [],
            },
            outcome: {
              demandUnits: 35,
              fulfilledUnits: 30,
              shortageUnits: 5,
              expiredUnits: 0,
              endingStockUnits: 0,
              pendingInboundUnits: 0,
            },
          },
          {
            policy: 'PROPOSED',
            order: {
              status: 'UNKNOWN',
              requestedUnits: 20,
              quantityUnits: null,
              committedCashMinor: null,
              reasons: ['Order arrival or expiry is unknown.'],
            },
            outcome: null,
          },
        ],
        assumptions: ['Order terms and currency are supplied scenario assumptions.'],
        unknowns: [
          'PROPOSED: arrival or expiry of the hypothetical order is unknown; inventory outcome unavailable.',
        ],
      },
      goalComparison: {
        label: 'ILLUSTRATIVE_ESTIMATE',
        definition: 'Illustrative.',
        scenarios: [
          {
            policy: 'NO_ORDER',
            label: 'ESTIMATE',
            assumptions: { unitPriceMinor: 1000, unitCostMinor: null },
            fulfilledUnits: 30,
            salesMinor: 30000,
            marginMinor: null,
            goals: { salesMinor: 20000, marginMinor: null, salesMet: true, marginMet: null },
          },
        ],
      },
    },
    limitations: ['Manual planning assumes a constant daily rate carried to a future UTC origin.'],
  } as unknown as PharmacyReplenishmentReport;
}

const branches = [{ id: 'branch-1', name: 'Main Branch' }];
// 02:30 on 3 Nov in Karachi, still 2 Nov in UTC: the 3 Nov label has not started yet.
const NOW = '2026-11-02T21:30:00.000Z';

function renderConsole(financial = true) {
  return render(
    <ScenarioConsole
      organizationId="org-1"
      branches={branches}
      financial={financial}
      initialBranchId="branch-1"
      invalidInitialBranch={false}
      timeZone="Asia/Karachi"
      now={NOW}
    />
  );
}

const byId = (id: string) => document.getElementById(`replenishment-${id}`) as HTMLInputElement;
const set = (element: Element, value: string) => fireEvent.change(element, { target: { value } });

async function chooseMedicine() {
  set(screen.getByRole('textbox', { name: 'Find medicine' }), 'pana');
  fireEvent.click(screen.getByRole('button', { name: 'Search medicines' }));
  await screen.findByRole('option', { name: 'Panadol' });
  set(document.querySelector('select[name="medicineId"]')!, 'med-1');
}

describe('Replenishment console (DEV-596)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    h.search.mockResolvedValue([{ id: 'med-1', productName: 'Panadol' }]);
    h.replenishment.mockImplementation(async (input: PharmacyReplenishmentReportInput) =>
      report(input)
    );
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('labels the form in plain words and never shows raw enum values', () => {
    renderConsole();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Compare order plans using my numbers' }));
    const text = document.body.textContent ?? '';
    for (const copy of [
      'Use sales from',
      'Forecast from',
      'Days to forecast',
      'Forecast based on',
      'Average of recent days',
      'Same weekday last week',
      'Dates are in Pakistan Standard Time.',
      'Your settings: enter the sales you expect',
      'Plan starts on',
      'Order arrives on (optional)',
    ])
      expect(text).toContain(copy);
    for (const copy of [...JARGON, 'USER_SUPPLIED_ASSUMPTIONS'])
      expect(text, copy).not.toContain(copy);
    expect(text).not.toMatch(RAW_ENUM);
    expect(byId('originDate').type).toBe('date');
    expect(byId('arrivalAt').type).toBe('date');
  });

  it('defaults Forecast from to the latest workspace day the server accepts', () => {
    renderConsole();
    // Karachi is already on 3 Nov, but that day's label starts at 05:00 local time.
    expect(byId('originDate').value).toBe('2026-11-02');
    expect(byId('originDate').max).toBe('2026-11-02');
    expect(byId('historyStartDate').value).toBe('2026-10-26');
  });

  it('submits the exact day labels and instants for dates picked in Karachi', async () => {
    renderConsole();
    await chooseMedicine();
    set(byId('historyStartDate'), '2026-10-16');
    set(byId('originDate'), '2026-10-30');
    set(byId('horizonDays'), '7');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Compare order plans using my numbers' }));
    set(byId('planningOrigin'), '2026-11-04');
    set(byId('currency'), 'PKR');
    for (const [key, value] of [
      ['dailyDemandUnits', '5'],
      ['currentQuantityUnits', '10'],
      ['proposedQuantityUnits', '20'],
      ['currentUnitPriceMinor', '1000'],
      ['proposedUnitPriceMinor', '900'],
      ['packSize', '1'],
      ['minimumOrderUnits', '0'],
    ])
      set(byId(key!), value!);
    set(byId('arrivalAt'), '2026-11-05');
    set(byId('expiresAt'), '2027-05-01');
    fireEvent.click(screen.getByRole('button', { name: 'Show report' }));
    await waitFor(() => expect(h.replenishment).toHaveBeenCalledTimes(1));
    const input = h.replenishment.mock.calls[0]![0] as PharmacyReplenishmentReportInput;
    expect(input).toMatchObject({
      branchId: 'branch-1',
      medicineId: 'med-1',
      historyStartDate: '2026-10-16',
      originDate: '2026-10-30',
      horizonDays: 7,
      method: 'RECENT_MEAN',
    });
    expect(input.manualScenario).toMatchObject({
      originDate: '2026-11-04',
      currency: 'PKR',
      orderTerms: {
        arrivalAt: '2026-11-05T00:00:00.000Z',
        expiresAt: '2027-05-01T00:00:00.000Z',
        unitCostMinor: null,
        budgetMinor: null,
        storageLimitUnits: null,
      },
    });

    // The report itself maps every server enum to words.
    await screen.findByText('Report ready. Read the notes with each section before acting.');
    const text = document.body.textContent ?? '';
    for (const copy of [
      'Sales from 16 Oct 2026 to 29 Oct 2026.',
      'Not enough sales data',
      'Accuracy not checked yet',
      'Stock count not confirmed',
      'Not confirmed',
      'No, it ran out',
      'Based on: Your settings.',
      "Don't order",
      'New order',
      'Needs more numbers',
      'Sales: met · Profit: not checked',
      'PKR 300.00',
      'New order: arrival or expiry of the hypothetical order is unknown',
      'subtract only posted accepted receipt units',
      'Facts after the read time were excluded',
    ])
      expect(text, copy).toContain(copy);
    expect(text).not.toMatch(RAW_ENUM);
    for (const copy of ['Weekly seasonal naive', 'REDACTED', 'INELIGIBLE', 'POSTED'])
      expect(text, copy).not.toContain(copy);
  });

  it('refuses a Karachi day the server would reject, in plain words', async () => {
    renderConsole();
    await chooseMedicine();
    set(byId('originDate'), '2026-11-03');
    fireEvent.click(screen.getByRole('button', { name: 'Show report' }));
    expect(await screen.findByText('Choose 2 Nov 2026 or an earlier date.')).toBeInTheDocument();
    expect(h.replenishment).not.toHaveBeenCalled();
  });

  it('hides planning for roles without finance access in plain words', () => {
    renderConsole(false);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Hidden for your role');
    expect(text).not.toContain('REDACTED');
  });
});

describe('replenishment dates and notes', () => {
  it('uses the workspace calendar for today, the plan window and the zone name', () => {
    // 21:00 on 2 Nov in New York is already 3 Nov in UTC: Forecast from stays on 2 Nov.
    const newYork = replenishmentDates('America/New_York', new Date('2026-11-03T02:00:00Z'));
    expect(newYork.latestForecastFrom).toBe('2026-11-02');
    expect(newYork.zoneName).toBe('Eastern Standard Time');
    const karachi = replenishmentDates('Asia/Karachi', new Date('2026-11-02T10:00:00Z'));
    expect(karachi).toMatchObject({
      latestForecastFrom: '2026-11-02',
      earliestPlanStart: '2026-11-03',
      defaultPlanStart: '2026-11-03',
      latestPlanStart: '2026-12-03',
      zoneName: 'Pakistan Standard Time',
    });
  });

  it('rewrites codes inside server notes', () => {
    expect(plainReason('NO_ORDER: arrival is unknown under MANUAL_SCENARIO and MOQ.')).toBe(
      "Don't order: arrival is unknown under your settings and minimum order."
    );
  });
});
