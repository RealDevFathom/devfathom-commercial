import { describe, expect, it } from 'vitest';
import { summarizeRepeatPurchasing } from '../src/lib/pharmacy/repeat-purchasing';
import { marginComparisonPeriods } from '../src/lib/pharmacy/finance-reports';
import { executePharmacyDemoRetention, planPharmacyDemoRetention } from './pharmacy-demo-retention';
import type { PharmacyDemoContext, PharmacyDemoPlan, PharmacyDemoResult } from './pharmacy-demo-contract';

const input: PharmacyDemoContext = { organizationId: 'existing-org', branchId: 'existing-branch',
  ownerUserId: 'existing-owner', namespace: 'phdemo_0123456789abcdef01234567_', businessDate: '2026-09-07',
  scenarioAt: '2026-09-07T12:00:00.000Z', timezone: 'Asia/Karachi', currency: 'PKR',
  actors: [], references: [], modules: [] };
const plan = () => planPharmacyDemoRetention(input);

describe('canonical namespace planner compatibility', () => {
  it('preserves canonical namespace identity, reference prefixes and digest input', () => {
    const before = JSON.stringify(input);
    const p = plan();
    expect(p.namespace).toBe(input.namespace);
    expect(p.target.namespace).toBe(input.namespace);
    expect(p.records).toEqual([]);
    expect(p.personas.every((persona) => persona.ref.startsWith(`${input.namespace}:retention:`))).toBe(true);
    expect(p.expectedReceipts.every((receipt) => receipt.id.startsWith(`${input.namespace}:retention:`))).toBe(true);
    expect(plan().digest).toBe(p.digest);
    const other = planPharmacyDemoRetention({ ...input, namespace: 'phdemo_ffffffffffffffffffffffff_' });
    expect(other.namespace).toBe('phdemo_ffffffffffffffffffffffff_');
    expect(other.digest).not.toBe(p.digest);
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each(['demo-retention', 'phdemo_0123456789ABCDEF01234567_',
    'phdemo_0123456789abcdef0123456_', 'phdemo_0123456789abcdef012345678_',
    'phdemo_0123456789abcdef01234567', ' phdemo_0123456789abcdef01234567_',
    'phdemo_0123456789abcdef01234567_\n', '=phdemo_0123456789abcdef01234567_'])
  ('rejects noncanonical namespace without normalization: %j', (namespace) => {
    expect(() => planPharmacyDemoRetention({ ...input, namespace })).toThrow('canonical');
  });
});

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
    expect(planPharmacyDemoRetention({ currency, ...rest }).digest).toBe(plan().digest);
    expect(plan().digest).toMatch(/^[a-f0-9]{64}$/);
    expect(planPharmacyDemoRetention({ ...input, branchId: 'other' }).digest).not.toBe(plan().digest);
    expect(plan().personas).toHaveLength(6);
    for (const persona of plan().personas) {
      expect(persona.ref.startsWith(`${input.namespace}:retention:`)).toBe(true);
      expect(persona.displayName.startsWith('DEMO ')).toBe(true);
      expect(Object.keys(persona).sort()).toEqual(['displayName', 'ref', 'status']);
    }
  });
  it('exposes the shared plan without advertising expected fixtures as executable records', () => {
    const p: PharmacyDemoPlan = plan();
    expect(p.lane).toBe('retention');
    expect(p.namespace).toBe(input.namespace);
    expect(p.records).toEqual([]);
    expect(p.gaps.map((gap) => [gap.function, gap.status])).toEqual([
      ['repeat-purchasing', 'UNSEEDED'], ['recovery', 'UNSEEDED'],
      ['gross-margin-comparison', 'UNSEEDED'],
    ]);
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
    const result: PharmacyDemoResult = await executePharmacyDemoRetention(input);
    expect(result).toEqual({ status: 'refused', unmetPrerequisites: plan().prerequisites });
    if (result.status !== 'refused') throw new Error('Expected refusal');
    expect(result.unmetPrerequisites.join(' ')).toContain('LOYALTY consent');
    expect(JSON.stringify(input)).toBe(before);
  });
  it('does not treat manually supplied actor and approval facts as execution authority', async () => {
    const supplied: PharmacyDemoContext = { ...input,
      actors: [{ userId: 'demo-user', actorId: 'demo-actor', organizationId: input.organizationId,
        branchId: input.branchId, active: true, synthetic: true, capabilities: ['*'] }],
      references: [{ kind: 'medicine', id: 'demo-medicine', organizationId: input.organizationId,
        branchId: input.branchId, approved: true, observedHash: 'unverified' }],
      modules: [{ key: 'pharmacy', enabled: true }],
    };
    const before = JSON.stringify(supplied);
    expect(await executePharmacyDemoRetention(supplied)).toEqual({
      status: 'refused', unmetPrerequisites: plan().prerequisites,
    });
    expect(JSON.stringify(supplied)).toBe(before);
  });
});
