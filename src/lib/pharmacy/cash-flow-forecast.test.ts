import { describe, expect, it } from 'vitest';
import { forecastPharmacyCashFlow, type CashFlowForecastInput } from './cash-flow-forecast';

const fixture: CashFlowForecastInput = {
  asOfDate: '2026-10-29',
  openingCashMinor: 1_000_000,
  minimumCashReserveMinor: 100_000,
  annualCashValueBps: 1_200,
  salesCashEstimates: [
    { id: 'sales-30', date: '2026-11-28', amountMinor: 300_000 },
    { id: 'sales-60', date: '2026-12-28', amountMinor: 400_000 },
    { id: 'sales-90', date: '2027-01-27', amountMinor: 500_000 },
  ],
  khataCollectionEstimates: [
    { id: 'khata-1', date: '2026-11-10', amountMinor: 100_000 },
    { id: 'khata-2', date: '2027-01-01', amountMinor: 200_000 },
  ],
  payables: [
    { id: 'due-first', dueDate: '2026-11-08', amountMinor: 200_000 },
    {
      id: 'discounted',
      dueDate: '2026-12-28',
      amountMinor: 400_000,
      earlyPayDate: '2026-11-28',
      earlyPayDiscountBps: 200,
    },
    { id: 'due-90', dueDate: '2027-01-27', amountMinor: 150_000 },
  ],
};

describe('30/60/90 pharmacy cash-flow forecast', () => {
  it('matches the fixture and marks every result as an estimate', () => {
    const result = forecastPharmacyCashFlow(fixture);
    expect(result.status).toBe('ESTIMATE');
    expect(result.windows).toEqual([
      {
        days: 30,
        through: '2026-11-28',
        salesInflowsMinor: 300_000,
        khataInflowsMinor: 100_000,
        payableOutflowsMinor: 592_000,
        closingCashMinor: 808_000,
      },
      {
        days: 60,
        through: '2026-12-28',
        salesInflowsMinor: 700_000,
        khataInflowsMinor: 100_000,
        payableOutflowsMinor: 592_000,
        closingCashMinor: 1_208_000,
      },
      {
        days: 90,
        through: '2027-01-27',
        salesInflowsMinor: 1_200_000,
        khataInflowsMinor: 300_000,
        payableOutflowsMinor: 742_000,
        closingCashMinor: 1_758_000,
      },
    ]);
  });

  it('schedules every payable no later than its due date and takes a worthwhile discount', () => {
    const schedule = forecastPharmacyCashFlow(fixture).payablesSchedule;
    expect(schedule.every((item) => item.scheduledDate <= item.dueDate)).toBe(true);
    expect(schedule.find((item) => item.id === 'discounted')).toMatchObject({
      scheduledDate: '2026-11-28',
      scheduledAmountMinor: 392_000,
      discountSavingMinor: 8_000,
      keepCashCostMinor: 3_867,
      recommendation: 'PAY_EARLY',
      reason: 'DISCOUNT_EXCEEDS_CASH_VALUE',
    });
  });

  it('keeps cash when its configured value exceeds the discount', () => {
    const result = forecastPharmacyCashFlow({ ...fixture, annualCashValueBps: 5_000 });
    expect(result.payablesSchedule.find((item) => item.id === 'discounted')).toMatchObject({
      scheduledDate: '2026-12-28',
      scheduledAmountMinor: 400_000,
      recommendation: 'PAY_ON_DUE_DATE',
      reason: 'KEEP_CASH',
    });
  });

  it('preserves the configured reserve but never pushes a payment past its due date', () => {
    const result = forecastPharmacyCashFlow({ ...fixture, openingCashMinor: 300_000 });
    expect(result.payablesSchedule.find((item) => item.id === 'discounted')).toMatchObject({
      scheduledDate: '2026-12-28',
      recommendation: 'PAY_ON_DUE_DATE',
      reason: 'CASH_RESERVE',
    });
  });

  it('rejects invalid early-payment terms', () => {
    expect(() =>
      forecastPharmacyCashFlow({
        ...fixture,
        payables: [
          {
            id: 'bad',
            dueDate: '2026-11-10',
            earlyPayDate: '2026-11-11',
            amountMinor: 1,
            earlyPayDiscountBps: 100,
          },
        ],
      })
    ).toThrow(/before dueDate/);
  });
});
