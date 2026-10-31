import { describe, expect, it } from 'vitest';

import {
  FBR_TIER1_CRITERIA,
  FBR_TIER1_DISCLAIMER,
  FBR_TIER1_ELECTRICITY_THRESHOLD_RUPEES,
  FBR_TIER1_HEADLINES,
  FBR_TIER1_TURNOVER_THRESHOLD_RUPEES,
  evaluateFbrTier1,
  fbrTier1RecheckDueAt,
  isFbrTier1RecheckDue,
  parseStoredFbrTier1Answers,
  type FbrTier1Answers,
} from './fbr-tier1';

/** A small neighbourhood store: no criterion applies. */
const neighbourhood: FbrTier1Answers = {
  chainOutlet: 'NO',
  airConditionedMallOrPlaza: 'NO',
  electricityBillRupees12Months: 300_000,
  wholesaleAndRetail: 'NO',
  bankCardPos: 'NO',
  otherNotifiedCategory: 'NO',
  annualTurnoverRupees: 20_000_000,
};

describe('#709 FBR Tier-1 self-check', () => {
  it('returns Not Tier-1 only when every criterion is answered and none applies', () => {
    const evaluation = evaluateFbrTier1(neighbourhood);
    expect(evaluation.result).toBe('NOT_TIER_1');
    expect(evaluation.headline).toBe('Not Tier-1');
    expect(evaluation.criteria.every((criterion) => criterion.outcome === 'NOT_MET')).toBe(true);
  });

  it.each<[string, Partial<FbrTier1Answers>]>([
    ['chain membership', { chainOutlet: 'YES' }],
    ['an air-conditioned mall or plaza', { airConditionedMallOrPlaza: 'YES' }],
    [
      'electricity above Rs 1.2M in 12 months',
      { electricityBillRupees12Months: FBR_TIER1_ELECTRICITY_THRESHOLD_RUPEES + 1 },
    ],
    ['wholesale activity', { wholesaleAndRetail: 'YES' }],
    ['a bank or authorized provider card-payment POS', { bankCardPos: 'YES' }],
    ['another confirmed FBR-notified category', { otherNotifiedCategory: 'YES' }],
  ])('%s alone triggers Tier-1', (_label, change) => {
    const evaluation = evaluateFbrTier1({ ...neighbourhood, ...change });
    expect(evaluation.result).toBe('TIER_1');
    expect(evaluation.headline).toBe('Tier-1: FBR integration required');
  });

  it('a confirmed criterion triggers Tier-1 even when every other answer is unknown', () => {
    const evaluation = evaluateFbrTier1({
      chainOutlet: 'UNSURE',
      airConditionedMallOrPlaza: 'UNSURE',
      electricityBillRupees12Months: null,
      wholesaleAndRetail: 'YES',
      bankCardPos: 'UNSURE',
      otherNotifiedCategory: 'UNSURE',
      annualTurnoverRupees: null,
    });
    expect(evaluation.result).toBe('TIER_1');
  });

  it('an electricity bill of exactly Rs 1.2M does not exceed the threshold', () => {
    expect(
      evaluateFbrTier1({
        ...neighbourhood,
        electricityBillRupees12Months: FBR_TIER1_ELECTRICITY_THRESHOLD_RUPEES,
      }).result
    ).toBe('NOT_TIER_1');
  });

  it.each<[string, Partial<FbrTier1Answers>]>([
    ['an unsure chain answer', { chainOutlet: 'UNSURE' }],
    ['an unsure mall answer', { airConditionedMallOrPlaza: 'UNSURE' }],
    ['an unknown electricity bill', { electricityBillRupees12Months: null }],
    ['an unsure wholesale answer', { wholesaleAndRetail: 'UNSURE' }],
    ['an unsure card-payment POS answer', { bankCardPos: 'UNSURE' }],
    ['unassessed notification-dependent categories', { otherNotifiedCategory: 'UNSURE' }],
    ['an unknown turnover', { annualTurnoverRupees: null }],
  ])('%s, with nothing else applying, is Unsure — never Not Tier-1', (_label, change) => {
    const evaluation = evaluateFbrTier1({ ...neighbourhood, ...change });
    expect(evaluation.result).toBe('UNSURE');
    expect(evaluation.headline).toBe('Unsure: ask your tax adviser');
  });

  it('the unconfirmed turnover test alone yields Unsure, not Tier-1', () => {
    const evaluation = evaluateFbrTier1({
      ...neighbourhood,
      annualTurnoverRupees: FBR_TIER1_TURNOVER_THRESHOLD_RUPEES + 1,
    });
    expect(evaluation.result).toBe('UNSURE');
    expect(evaluation.criteria.find((c) => c.key === 'annualTurnover')).toMatchObject({
      outcome: 'MET',
      confirmed: false,
    });
  });

  it('the turnover test alone triggers Tier-1 once it is marked confirmed', () => {
    const confirmed = FBR_TIER1_CRITERIA.map((criterion) =>
      criterion.key === 'annualTurnover' ? { ...criterion, confirmed: true } : criterion
    );
    expect(
      evaluateFbrTier1(
        { ...neighbourhood, annualTurnoverRupees: FBR_TIER1_TURNOVER_THRESHOLD_RUPEES + 1 },
        confirmed
      ).result
    ).toBe('TIER_1');
  });

  it('cites a dated source for every criterion and flags the vendor claim', () => {
    expect(FBR_TIER1_CRITERIA.map((criterion) => criterion.key)).toEqual([
      'chainOutlet',
      'airConditionedMallOrPlaza',
      'electricityBill12Months',
      'wholesaleAndRetail',
      'bankCardPos',
      'otherNotifiedCategory',
      'annualTurnover',
    ]);
    for (const criterion of FBR_TIER1_CRITERIA) {
      expect(criterion.source.url).toMatch(/^https:\/\//);
      expect(criterion.source.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(criterion.confirmed).toBe(criterion.source.kind === 'FACT');
    }
    const evaluation = evaluateFbrTier1(neighbourhood);
    expect(evaluation.criteria.every((criterion) => criterion.source.date)).toBe(true);
  });

  it('says it is not tax advice on every result', () => {
    expect(FBR_TIER1_DISCLAIMER).toMatch(/not tax advice/i);
    for (const answers of [
      neighbourhood,
      { ...neighbourhood, chainOutlet: 'YES' as const },
      { ...neighbourhood, chainOutlet: 'UNSURE' as const },
    ]) {
      expect(evaluateFbrTier1(answers).disclaimer).toBe(FBR_TIER1_DISCLAIMER);
    }
    expect(Object.values(FBR_TIER1_HEADLINES)).toEqual([
      'Tier-1: FBR integration required',
      'Not Tier-1',
      'Unsure: ask your tax adviser',
    ]);
  });

  it('asks again twelve months after the last answer', () => {
    const assessedAt = new Date('2026-10-31T09:00:00.000Z');
    expect(fbrTier1RecheckDueAt(assessedAt).toISOString()).toBe('2027-10-31T09:00:00.000Z');
    expect(isFbrTier1RecheckDue(null, assessedAt)).toBe(true);
    expect(isFbrTier1RecheckDue(assessedAt, new Date('2027-10-30T09:00:00.000Z'))).toBe(false);
    expect(isFbrTier1RecheckDue(assessedAt, new Date('2027-10-31T09:00:00.000Z'))).toBe(true);
    // A leap day re-asks on the last day of the next February.
    expect(fbrTier1RecheckDueAt(new Date('2028-02-29T00:00:00.000Z')).toISOString()).toBe(
      '2029-02-28T00:00:00.000Z'
    );
  });

  it('reads stored answers back, and refuses a malformed row', () => {
    expect(parseStoredFbrTier1Answers(neighbourhood)).toEqual(neighbourhood);
    expect(
      parseStoredFbrTier1Answers({
        ...neighbourhood,
        electricityBillRupees12Months: null,
        annualTurnoverRupees: null,
      })
    ).toMatchObject({ electricityBillRupees12Months: null, annualTurnoverRupees: null });
    expect(parseStoredFbrTier1Answers(null)).toBeNull();
    expect(parseStoredFbrTier1Answers([])).toBeNull();
    expect(parseStoredFbrTier1Answers({ ...neighbourhood, chainOutlet: 'MAYBE' })).toBeNull();
    expect(parseStoredFbrTier1Answers({ ...neighbourhood, bankCardPos: 'MAYBE' })).toBeNull();
    expect(
      parseStoredFbrTier1Answers({ ...neighbourhood, otherNotifiedCategory: null })
    ).toBeNull();
    expect(
      parseStoredFbrTier1Answers({ ...neighbourhood, electricityBillRupees12Months: -1 })
    ).toBeNull();
    const missing: Record<string, unknown> = { ...neighbourhood };
    delete missing.annualTurnoverRupees;
    expect(parseStoredFbrTier1Answers(missing)).toBeNull();
  });

  it('treats omitted categories on legacy answers as unknown, never as No', () => {
    const legacy: Record<string, unknown> = { ...neighbourhood };
    delete legacy.bankCardPos;
    delete legacy.otherNotifiedCategory;
    const answers = parseStoredFbrTier1Answers(legacy);
    expect(answers).toEqual({
      ...neighbourhood,
      bankCardPos: 'UNSURE',
      otherNotifiedCategory: 'UNSURE',
    });
    expect(evaluateFbrTier1(answers!).result).toBe('UNSURE');
    expect(evaluateFbrTier1({ ...answers!, chainOutlet: 'YES' }).result).toBe('TIER_1');
  });
});
