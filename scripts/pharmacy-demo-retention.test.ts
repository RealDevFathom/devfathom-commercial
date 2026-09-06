import { describe, expect, it } from 'vitest';
import { summarizeRepeatPurchasing } from '../src/lib/pharmacy/repeat-purchasing';
import { marginComparisonPeriods } from '../src/lib/pharmacy/finance-reports';
import { executePharmacyDemoRetention, planPharmacyDemoRetention } from './pharmacy-demo-retention';

const input = { organizationId: 'existing-org', branchId: 'existing-branch',
  ownerUserId: 'existing-owner', namespace: 'demo-retention', businessDate: '2026-09-07',
  scenarioAt: '2026-09-07T12:00:00.000Z', timezone: 'Asia/Karachi', currency: 'PKR' as const };
const plan = () => planPharmacyDemoRetention(input);

describe('Pharmacy demo retention expected cases (no database writes)', () => {
  it('matches the existing repeat reference for all 14 cases and three horizons', () => {
    const p = plan();
    expect(p.expectedReceipts).toHaveLength(14);
    expect(summarizeRepeatPurchasing(p.expectedReceipts, input.organizationId, p.filters,
      new Date(input.scenarioAt))).toMatchObject(p.expected);
  });
  it('is deterministic, bounded, namespaced and sensitive to target facts', () => {
    expect(plan()).toEqual(plan());
    const { currency, ...rest } = input;
    expect(planPharmacyDemoRetention({ currency, ...rest }).hash).toBe(plan().hash);
    expect(plan().hash).toMatch(/^[a-f0-9]{64}$/);
    expect(planPharmacyDemoRetention({ ...input, branchId: 'other' }).hash).not.toBe(plan().hash);
    expect(plan().personas).toHaveLength(6);
    for (const persona of plan().personas) {
      expect(persona.ref.startsWith('demo-retention:retention:')).toBe(true);
      expect(persona.displayName.startsWith('DEMO ')).toBe(true);
      expect(Object.keys(persona).sort()).toEqual(['displayName', 'ref', 'status']);
    }
  });
  it.each(['=FORMULA', '+formula', '@address', 'demo-' + 'x'.repeat(49)])(
    'rejects unsafe or unbounded namespace %s', (namespace) => {
      expect(() => planPharmacyDemoRetention({ ...input, namespace })).toThrow();
    });
  it('rejects missing scope, invalid instants and inconsistent business dates', () => {
    for (const patch of [{ organizationId: '' }, { branchId: '' }, { ownerUserId: '' },
      { scenarioAt: 'invalid' }, { scenarioAt: '2026-09-07T12:00:00' },
      { businessDate: '2026-09-06' }, { timezone: 'invalid' }]) {
      expect(() => planPharmacyDemoRetention({ ...input, ...patch })).toThrow();
    }
  });
  it('uses UTC enrollment even when the target business date is the following day', () => {
    const p = planPharmacyDemoRetention({ ...input, scenarioAt: '2026-09-06T22:00:00Z' });
    expect(p.reportTimezone).toBe('UTC');
    expect(p.target.businessDate).toBe('2026-09-07');
    expect(summarizeRepeatPurchasing(p.expectedReceipts, input.organizationId, p.filters,
      new Date(p.target.scenarioAt))).toMatchObject(p.expected);
  });
  it('includes exact 30-day boundary, excludes one millisecond later at that horizon', () => {
    const p = plan();
    p.expectedReceipts[1].completedAt = new Date(p.expectedReceipts[1].completedAt!.getTime() + 1);
    const result = summarizeRepeatPurchasing(p.expectedReceipts, input.organizationId,
      p.filters, new Date(input.scenarioAt));
    expect(result.horizons.map((h) => h.repeated)).toEqual([0, 1, 1]);
  });
  it('returns unavailable rates with zero denominators, excludes other tenant and branch', () => {
    const p = plan();
    for (const rows of [[], p.expectedReceipts.map((r) => ({ ...r, organizationId: 'other' })),
      p.expectedReceipts.map((r) => ({ ...r, branchId: 'other' }))]) {
      const result = summarizeRepeatPurchasing(rows, input.organizationId, p.filters,
        new Date(input.scenarioAt));
      expect(result.horizons.every((h) => h.eligible === 0 && h.ratePercent === null)).toBe(true);
    }
  });
  it('matches existing equal-window margin contract without inventing ledger totals', () => {
    const margin = plan().margin;
    const periods = marginComparisonPeriods(new Date(margin.current.from), new Date(margin.current.to));
    expect(JSON.parse(JSON.stringify(periods))).toEqual({ previous: margin.previous, current: margin.current });
    expect(margin.status).toBe('UNSEEDED');
    expect(margin).not.toHaveProperty('grossMarginMinor');
  });
  it('refuses execution, preserving all coverage gaps and input without callbacks or writes', async () => {
    const before = JSON.stringify(input);
    const result = await executePharmacyDemoRetention(input);
    expect(result).toMatchObject({ status: 'UNSEEDED', planHash: plan().hash, writes: 0,
      coverage: { repeat: false, recovery: false, margin: false } });
    expect(result.reasons.join(' ')).toContain('LOYALTY consent');
    expect(JSON.stringify(input)).toBe(before);
  });
});
