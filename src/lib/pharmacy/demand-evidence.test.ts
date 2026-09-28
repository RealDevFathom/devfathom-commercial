import { describe, expect, it } from 'vitest';
import {
  backtestDemandEvidence,
  forecastDemandEvidence,
  type DemandEvidenceDay,
  type DemandEvidenceInput,
} from './demand-evidence';

const observed = (
  date: string,
  units: number,
  knownAt = `${date}T23:59:59Z`
): DemandEvidenceDay => ({ date, knownAt, state: 'OBSERVED', units });
const input: DemandEvidenceInput = {
  scope: { organizationId: 'org', branchId: 'branch', medicineId: 'medicine' },
  source: { kind: 'SYNTHETIC_FIXTURE', reference: 'unit-test', asOf: '2026-09-12T00:00:00Z' },
  originDate: '2026-09-12',
  historyStartDate: '2026-09-05',
  horizonDays: 2,
  method: 'RECENT_MEAN',
  days: [observed('2026-09-10', 4), observed('2026-09-11', 4)],
};

describe('calendar demand evidence', () => {
  it('preserves unknown days; closed and censored days do not dilute an observed mean', () => {
    const result = forecastDemandEvidence({
      ...input,
      days: [
        observed('2026-09-05', 8),
        { date: '2026-09-06', knownAt: '2026-09-07T00:00:00Z', state: 'CLOSED' },
        { date: '2026-09-07', knownAt: '2026-09-08T00:00:00Z', state: 'UNKNOWN' },
        {
          date: '2026-09-08',
          knownAt: '2026-09-09T00:00:00Z',
          state: 'STOCKOUT_CENSORED',
          units: 100,
        },
        observed('2026-09-11', 0),
      ],
    });
    expect(result.coverage).toEqual({
      observedDays: 2,
      unknownDays: 3,
      closedDays: 1,
      censoredDays: 1,
      excludedFutureOrUnavailableRows: 0,
    });
    expect(result.days.map((day) => day.units)).toEqual([4, 4]);
    expect(result.source.kind).toBe('SYNTHETIC_FIXTURE');
    expect(result.unknowns).toContain('Latent demand on stockout-censored days is unknown.');
  });

  it('excludes future observations and retrospectively available corrections', () => {
    const result = forecastDemandEvidence({
      ...input,
      days: [
        observed('2026-09-10', 4),
        observed('2026-09-11', 900, '2026-09-13T00:00:00Z'),
        observed('2026-09-12', 800),
      ],
    });
    expect(result.days.map((day) => day.units)).toEqual([4, 4]);
    expect(result.coverage.excludedFutureOrUnavailableRows).toBe(2);
    expect(result.days[0]!.evidenceDates).toEqual(['2026-09-10']);
  });

  it('honors an earlier source snapshot cutoff', () => {
    const result = forecastDemandEvidence({
      ...input,
      source: { ...input.source, asOf: '2026-09-11T00:00:00Z' },
      days: [observed('2026-09-10', 3), observed('2026-09-11', 500)],
    });
    expect(result.days[0]!.units).toBe(3);
  });

  it('uses dated weekly matches without compressing gaps or learning from future days', () => {
    const result = forecastDemandEvidence({
      ...input,
      method: 'WEEKLY_SEASONAL_NAIVE',
      horizonDays: 9,
      days: [observed('2026-09-05', 2), observed('2026-09-07', 10), observed('2026-09-12', 900)],
    });
    expect(result.days[0]).toMatchObject({
      units: 2,
      method: 'WEEKLY_SEASONAL_NAIVE',
      evidenceDates: ['2026-09-05'],
    });
    expect(result.days[1]).toMatchObject({ units: 6, method: 'RECENT_MEAN' });
    expect(result.days[2]!.units).toBe(10);
    expect(result.days[7]!.units).toBe(2);
  });

  it('keeps absent history unavailable but permits closures known at origin', () => {
    const result = forecastDemandEvidence({
      ...input,
      days: [],
      closures: [
        { date: '2026-09-12', knownAt: '2026-09-11T00:00:00Z' },
        { date: '2026-09-13', knownAt: '2026-09-13T00:00:00Z' },
      ],
    });
    expect(result.days.map((day) => [day.units, day.method])).toEqual([
      [0, 'KNOWN_CLOSED'],
      [null, 'UNAVAILABLE'],
    ]);
  });

  it('rounds fractional daily means upward to integer units', () => {
    const result = forecastDemandEvidence({
      ...input,
      days: [observed('2026-09-10', 0), observed('2026-09-11', 1)],
    });
    expect(result.days[0]!.units).toBe(1);
  });

  it.each([
    { originDate: '2026-02-30' },
    { historyStartDate: '2026-09-12' },
    { horizonDays: 0 },
    { horizonDays: 367 },
    { horizonDays: 1.5 },
    { days: [observed('2026-09-10', -1)] },
    { days: [observed('2026-09-10', 0.5)] },
    { days: [observed('2026-09-10', 1), observed('2026-09-10', 2)] },
    { days: [observed('2026-09-10', Number.MAX_SAFE_INTEGER), observed('2026-09-11', 1)] },
    { source: { ...input.source, asOf: '2026-09-12T00:00:00' } },
    { source: { ...input.source, asOf: '2026-02-30T00:00:00Z' } },
  ])('rejects invalid boundaries, duplicates and unsafe arithmetic: %j', (change) => {
    expect(() => forecastDemandEvidence({ ...input, ...change })).toThrow(RangeError);
  });
});

describe('rolling origin demand backtest', () => {
  it('returns null WAPE for zero actual while retaining absolute error and bias', () => {
    const result = backtestDemandEvidence({
      ...input,
      origins: ['2026-09-11'],
      horizonDays: 1,
      days: [observed('2026-09-10', 4), observed('2026-09-11', 0)],
    });
    expect(result.metrics.RECENT_MEAN).toEqual({
      sampleCount: 1,
      maeUnits: 4,
      biasUnits: 4,
      wapePercent: null,
    });
    expect(result.metrics.WEEKLY_SEASONAL_NAIVE).toEqual(result.metrics.RECENT_MEAN);
  });

  it('compares identical eligible dates chronologically and reports unavailable actuals', () => {
    const result = backtestDemandEvidence({
      ...input,
      origins: ['2026-09-09', '2026-09-10'],
      horizonDays: 2,
      days: [
        observed('2026-09-05', 4),
        observed('2026-09-09', 6),
        {
          date: '2026-09-10',
          knownAt: '2026-09-11T00:00:00Z',
          state: 'STOCKOUT_CENSORED',
          units: 99,
        },
        { date: '2026-09-11', knownAt: '2026-09-12T00:00:00Z', state: 'UNKNOWN' },
      ],
    });
    expect(result.metrics.RECENT_MEAN).toEqual({
      sampleCount: 1,
      maeUnits: 2,
      biasUnits: -2,
      wapePercent: (2 / 6) * 100,
    });
    expect(result.metrics.WEEKLY_SEASONAL_NAIVE.sampleCount).toBe(1);
    expect(result.excludedPairs).toBe(3);
    expect(result.folds[0]!.days[0]).toMatchObject({ recentMeanUnits: 4, actualUnits: 6 });
    expect(result.folds[1]!.days[0]).toMatchObject({
      recentMeanUnits: 5,
      actualUnits: null,
      scored: false,
    });
  });

  it('returns unavailable metrics when no pair has both history and observed actual', () => {
    const result = backtestDemandEvidence({ ...input, origins: ['2026-09-11'], days: [] });
    expect(result.metrics.RECENT_MEAN).toEqual({
      sampleCount: 0,
      maeUnits: null,
      biasUnits: null,
      wapePercent: null,
    });
  });

  it('rejects duplicate and decreasing origins', () => {
    for (const origins of [
      ['2026-09-11', '2026-09-10'],
      ['2026-09-11', '2026-09-11'],
    ]) {
      expect(() => backtestDemandEvidence({ ...input, origins })).toThrow(
        'Backtest origins must increase'
      );
    }
  });
});
