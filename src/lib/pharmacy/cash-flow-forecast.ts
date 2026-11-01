/**
 * FIN-G14 cash planning. This is deliberately separate from the accounting
 * projection: every future amount is supplied by the caller and is labelled
 * as an estimate. No forecast is posted to the ledger.
 */

const DAY_MS = 86_400_000;
const BPS = 10_000;
const HORIZONS = [30, 60, 90] as const;

export type CashEstimate = {
  id: string;
  date: string;
  amountMinor: number;
};

export type ForecastPayable = {
  id: string;
  dueDate: string;
  amountMinor: number;
  earlyPayDate?: string;
  earlyPayDiscountBps?: number;
};

export type CashFlowForecastInput = {
  asOfDate: string;
  openingCashMinor: number;
  minimumCashReserveMinor: number;
  annualCashValueBps: number;
  salesCashEstimates: readonly CashEstimate[];
  khataCollectionEstimates: readonly CashEstimate[];
  payables: readonly ForecastPayable[];
};

type PayableDecision = {
  id: string;
  dueDate: string;
  scheduledDate: string;
  grossAmountMinor: number;
  scheduledAmountMinor: number;
  discountSavingMinor: number;
  keepCashCostMinor: number;
  recommendation: 'PAY_EARLY' | 'PAY_ON_DUE_DATE';
  reason: 'DISCOUNT_EXCEEDS_CASH_VALUE' | 'KEEP_CASH' | 'CASH_RESERVE' | 'NO_EARLY_TERMS';
};

function dateMs(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError(`${field} must be YYYY-MM-DD`);
  const valueMs = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(valueMs) || new Date(valueMs).toISOString().slice(0, 10) !== value)
    throw new RangeError(`${field} must be a valid UTC calendar date`);
  return valueMs;
}

function integer(value: number, field: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new RangeError(`${field} must be a safe integer of at least ${minimum}`);
}

function withinForecast(date: string, originMs: number) {
  const days = (dateMs(date, 'estimate date') - originMs) / DAY_MS;
  return days >= 1 && days <= 90;
}

function sum(values: readonly number[]) {
  return values.reduce((total, value) => {
    const next = total + value;
    if (!Number.isSafeInteger(next))
      throw new RangeError('Forecast total exceeds safe integer range');
    return next;
  }, 0);
}

function multiplyDivide(
  value: number,
  multiplier: number,
  divisor: number,
  roundUp = false,
  factor = 1
) {
  const numerator = BigInt(value) * BigInt(multiplier) * BigInt(factor);
  const denominator = BigInt(divisor);
  const result = roundUp
    ? (numerator + denominator - BigInt(1)) / denominator
    : numerator / denominator;
  const number = Number(result);
  if (!Number.isSafeInteger(number))
    throw new RangeError('Forecast amount exceeds safe integer range');
  return number;
}

/** Build a deterministic, UTC-calendar 30/60/90-day cash estimate and payment plan. */
export function forecastPharmacyCashFlow(input: CashFlowForecastInput) {
  const originMs = dateMs(input.asOfDate, 'asOfDate');
  integer(input.openingCashMinor, 'openingCashMinor');
  integer(input.minimumCashReserveMinor, 'minimumCashReserveMinor');
  integer(input.annualCashValueBps, 'annualCashValueBps');

  for (const estimate of [...input.salesCashEstimates, ...input.khataCollectionEstimates]) {
    integer(estimate.amountMinor, `${estimate.id} amountMinor`);
    dateMs(estimate.date, `${estimate.id} date`);
  }

  const inflows = new Map<string, number>();
  for (const estimate of [...input.salesCashEstimates, ...input.khataCollectionEstimates]) {
    if (withinForecast(estimate.date, originMs))
      inflows.set(estimate.date, sum([inflows.get(estimate.date) ?? 0, estimate.amountMinor]));
  }

  const orderedPayables = [...input.payables].sort(
    (a, b) =>
      dateMs(a.dueDate, `${a.id} dueDate`) - dateMs(b.dueDate, `${b.id} dueDate`) ||
      a.id.localeCompare(b.id)
  );
  const validatedPayables = orderedPayables.map((payable) => {
    integer(payable.amountMinor, `${payable.id} amountMinor`, 1);
    integer(payable.earlyPayDiscountBps ?? 0, `${payable.id} earlyPayDiscountBps`);
    if ((payable.earlyPayDiscountBps ?? 0) > BPS)
      throw new RangeError(`${payable.id} earlyPayDiscountBps cannot exceed 10000`);
    const dueMs = dateMs(payable.dueDate, `${payable.id} dueDate`);
    if (dueMs <= originMs) throw new RangeError(`${payable.id} dueDate must be after asOfDate`);
    const earlyMs = payable.earlyPayDate
      ? dateMs(payable.earlyPayDate, `${payable.id} earlyPayDate`)
      : null;
    if (earlyMs !== null && (earlyMs <= originMs || earlyMs >= dueMs))
      throw new RangeError(`${payable.id} earlyPayDate must be after asOfDate and before dueDate`);
    return { payable, dueMs, earlyMs };
  });

  // Start with every bill paid on its due date. Accelerating a payment must
  // preserve the reserve throughout the interval before that due date, not
  // just on the early-payment date. Later decisions use the updated balances.
  const cashEvents = new Map<number, number>();
  for (const [date, amount] of inflows) cashEvents.set(dateMs(date, 'inflow date'), amount);
  for (const { payable, dueMs, earlyMs } of validatedPayables) {
    cashEvents.set(dueMs, sum([cashEvents.get(dueMs) ?? 0, -payable.amountMinor]));
    if (earlyMs !== null && !cashEvents.has(earlyMs)) cashEvents.set(earlyMs, 0);
  }
  const eventDates = [...cashEvents.keys()].sort((a, b) => a - b);
  const dateIndex = new Map(eventDates.map((date, index) => [date, index]));
  let cash = input.openingCashMinor;
  const cashByDate = eventDates.map((date) => {
    cash = sum([cash, cashEvents.get(date)!]);
    return cash;
  });
  const decisions: PayableDecision[] = [];

  for (const { payable, dueMs, earlyMs } of validatedPayables) {
    const discountSavingMinor = multiplyDivide(
      payable.amountMinor,
      payable.earlyPayDiscountBps ?? 0,
      BPS
    );
    const discountedAmount = payable.amountMinor - discountSavingMinor;
    const earlyDays = earlyMs === null ? 0 : (dueMs - earlyMs) / DAY_MS;
    const keepCashCostMinor = multiplyDivide(
      discountedAmount,
      input.annualCashValueBps,
      BPS * 365,
      true,
      earlyDays
    );
    const economical = earlyMs !== null && discountSavingMinor > keepCashCostMinor;
    const earlyIndex = earlyMs === null ? null : dateIndex.get(earlyMs)!;
    const dueIndex = dateIndex.get(dueMs)!;
    const affordable =
      economical &&
      cashByDate
        .slice(earlyIndex!, dueIndex)
        .every((balance) => balance - discountedAmount >= input.minimumCashReserveMinor);
    const payEarly = economical && affordable;
    if (payEarly) {
      for (let index = earlyIndex!; index < cashByDate.length; index++) {
        cashByDate[index] = sum([
          cashByDate[index],
          index < dueIndex ? -discountedAmount : discountSavingMinor,
        ]);
      }
    }
    const scheduledMs = payEarly ? earlyMs! : dueMs;
    decisions.push({
      id: payable.id,
      dueDate: payable.dueDate,
      scheduledDate: new Date(scheduledMs).toISOString().slice(0, 10),
      grossAmountMinor: payable.amountMinor,
      scheduledAmountMinor: payEarly ? discountedAmount : payable.amountMinor,
      discountSavingMinor,
      keepCashCostMinor,
      recommendation: payEarly ? 'PAY_EARLY' : 'PAY_ON_DUE_DATE',
      reason:
        earlyMs === null || discountSavingMinor === 0
          ? 'NO_EARLY_TERMS'
          : !economical
            ? 'KEEP_CASH'
            : !affordable
              ? 'CASH_RESERVE'
              : 'DISCOUNT_EXCEEDS_CASH_VALUE',
    });
  }

  const windows = HORIZONS.map((days) => {
    const endMs = originMs + days * DAY_MS;
    const through = new Date(endMs).toISOString().slice(0, 10);
    const salesInflowsMinor = sum(
      input.salesCashEstimates
        .filter((x) => withinForecast(x.date, originMs) && dateMs(x.date, 'date') <= endMs)
        .map((x) => x.amountMinor)
    );
    const khataInflowsMinor = sum(
      input.khataCollectionEstimates
        .filter((x) => withinForecast(x.date, originMs) && dateMs(x.date, 'date') <= endMs)
        .map((x) => x.amountMinor)
    );
    const payableOutflowsMinor = sum(
      decisions
        .filter((x) => dateMs(x.scheduledDate, 'scheduledDate') <= endMs)
        .map((x) => x.scheduledAmountMinor)
    );
    return {
      days,
      through,
      salesInflowsMinor,
      khataInflowsMinor,
      payableOutflowsMinor,
      closingCashMinor: sum([
        input.openingCashMinor,
        salesInflowsMinor,
        khataInflowsMinor,
        -payableOutflowsMinor,
      ]),
    };
  });

  return {
    status: 'ESTIMATE' as const,
    moneyUnit: 'integer_minor' as const,
    timezone: 'UTC' as const,
    asOfDate: input.asOfDate,
    assumptions: {
      minimumCashReserveMinor: input.minimumCashReserveMinor,
      annualCashValueBps: input.annualCashValueBps,
    },
    windows,
    payablesSchedule: decisions,
  };
}
