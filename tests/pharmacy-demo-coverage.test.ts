// WHA-1392: expected scenarios only. Passing is NOT demo-package or live acceptance.
// Bind these independent expectations to immutable helper results when Desktop delivers them.
// No seed entrypoint, database client, regulatory fixture or external effect is imported.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
// Unchanged support source: 5b00a056775fad283ed305e9e582effcc224b534.
import type { DemoGap, DemoPlannedRecord, PharmacyDemoContext, PharmacyDemoPlan,
  PharmacyDemoResult } from '../scripts/pharmacy-demo-contract';
import { packConversions } from '../src/lib/pharmacy/pack-conversion';
import { receiptLineQuantities, receiptLineUnitCostMinor } from '../src/lib/pharmacy/receiving';

const namespace = 'ph-demo:oracle-only';
const at = new Date('2026-09-07T07:00:00.000Z'); // 12:00 Asia/Karachi

describe('PH-DEMO expected stock and PKR identities (not executed workflows)', () => {
  it('derives canonical stock from pack facts, including bonus and quarantine', () => {
    const [pack] = packConversions([
      { id: `${namespace}:box`, level: 'BOX', unitsPerParent: 10,
        parentPackLevelId: null, effectiveFrom: new Date('2026-01-01'), effectiveTo: null },
    ], at);
    const input = { receivedPacks: 10, bonusPacks: 2,
      canonicalUnitsPerPack: pack.canonicalUnitsPerPack, rejectedCanonicalUnits: 5 };
    expect(receiptLineQuantities(input)).toEqual({ receivedCanonicalUnits: 100,
      bonusCanonicalUnits: 20, arrivedCanonicalUnits: 120,
      acceptedCanonicalUnits: 115, rejectedCanonicalUnits: 5 });
    expect(receiptLineUnitCostMinor({ ...input, invoicedPricePerPackMinor: 1200 })).toBe(100);
    // PKR 120 invoice / 120 units = PKR 1 per unit; bonus adds no revenue.
  });

  it.each([0, 1.5, -10])('refuses unusable conversion %s instead of inventing stock', (conversion) => {
    expect(() => receiptLineQuantities({ receivedPacks: 10, bonusPacks: 2,
      canonicalUnitsPerPack: conversion, rejectedCanonicalUnits: 0 }))
      .toThrow('MISSING_PACK_CONVERSION');
  });

  // Independent expected event deltas: receipt, sale, customer return to quarantine,
  // supplier return. No assertion that any helper actually posts these events yet.
  const events = [
    { available: 115, quarantine: 5, outside: -120 },
    { available: -20, quarantine: 0, outside: 20 },
    { available: 0, quarantine: 2, outside: -2 },
    { available: 0, quarantine: -5, outside: 5 },
  ] satisfies DemoPlannedRecord['expectedFacts'][];
  function assertStock(rows: typeof events) {
    let available = 0, quarantine = 0;
    for (const row of rows) {
      expect(row.available + row.quarantine + row.outside).toBe(0);
      available += row.available;
      quarantine += row.quarantine;
      expect(available).toBeGreaterThanOrEqual(0);
      expect(quarantine).toBeGreaterThanOrEqual(0);
    }
    expect({ available, quarantine }).toEqual({ available: 95, quarantine: 2 });
  }
  it('conserves 120 received units through sale and both return directions', () => assertStock(events));
  it('detects bonus omission and unsafe returned-stock availability', () => {
    expect(() => assertStock(events.map((e, i) => i === 0 ? { ...e, available: 95 } : e))).toThrow();
    expect(() => assertStock(events.map((e, i) => i === 2
      ? { ...e, available: 2, quarantine: 0 } : e))).toThrow();
  });

  // Signed debit-positive account deltas, PKR minor units. Sale gross 4000,
  // discount 200, tender 3800; return revenue 380 and allocated lot cost 200.
  const postings = [
    { inventory: 12000, payable: -12000, cash: 0, revenue: 0, discount: 0, cogs: 0 },
    { inventory: -2000, payable: 0, cash: 3800, revenue: -4000, discount: 200, cogs: 2000 },
    { inventory: 200, payable: 0, cash: -380, revenue: 400, discount: -20, cogs: -200 },
    { inventory: -500, payable: 500, cash: 0, revenue: 0, discount: 0, cogs: 0 },
  ] satisfies DemoPlannedRecord['expectedFacts'][];
  function assertMoney(rows: typeof postings) {
    for (const row of rows) {
      expect(Object.values(row).every(Number.isSafeInteger)).toBe(true);
      expect(Object.values(row).reduce((a, b) => a + b, 0)).toBe(0);
    }
    const sum = (account: keyof typeof postings[number]) => rows.reduce((n, r) => n + r[account], 0);
    expect(sum('inventory')).toBe(9700); // 97 units at allocated lot cost 100
    expect(sum('payable')).toBe(-11500);
    expect(sum('cash')).toBe(3420);
    expect(-sum('revenue') - sum('discount')).toBe(3420);
    expect(sum('cogs')).toBe(1800);
    expect(-sum('revenue') - sum('discount') - sum('cogs')).toBe(1620);
  }
  it('reconciles balanced entries, inventory, payable, net revenue and margin', () => assertMoney(postings));
  it('detects a balanced but incorrect bonus-revenue posting', () => {
    expect(() => assertMoney(postings.map((e, i) => i === 0
      ? { ...e, inventory: 14000, revenue: -2000 } : e))).toThrow();
  });
  it('detects a missing cash refund even when aggregate revenue looks correct', () => {
    expect(() => assertMoney(postings.map((e, i) => i === 2 ? { ...e, cash: 0 } : e))).toThrow();
  });
});

// Opt-in immutable review input; the original 16 checks remain runnable alone.
// No absent-source imports or skipped/failing placeholders in the private checkout.
const reviewRoot = process.env.PHARMACY_DEMO_REVIEW_ROOT;
if (reviewRoot) {
  const { summarizeRepeatPurchasing } = await import(/* @vite-ignore */ `${reviewRoot}/src/lib/pharmacy/repeat-purchasing.ts`);
  const runner = await import(/* @vite-ignore */ `${reviewRoot}/scripts/seed-pharmacy-demo.ts`);
  const inventory = await import(/* @vite-ignore */ `${reviewRoot}/scripts/pharmacy-demo-inventory.ts`);
  const finance = await import(/* @vite-ignore */ `${reviewRoot}/scripts/pharmacy-demo-finance.ts`);
  const retention = await import(/* @vite-ignore */ `${reviewRoot}/scripts/pharmacy-demo-retention.ts`);
  const contract = await import(/* @vite-ignore */ `${reviewRoot}/scripts/pharmacy-demo-contract.ts`);
  const context: PharmacyDemoContext = {
    organizationId: 'oracle-org', branchId: 'oracle-branch', ownerUserId: 'oracle-owner',
    namespace: 'unused', businessDate: '2026-09-07', scenarioAt: at.toISOString(),
    timezone: 'Asia/Karachi', currency: 'PKR', actors: [], references: [], modules: [],
  };
  const inventoryFacts = { ...context, namespace: 'demo:oracle', actorId: 'oracle-actor',
    purchasingEntitled: false, organizationPurchaser: false,
    approvedCatalog: { medicineId: 'oracle-medicine', presentationId: 'oracle-presentation',
      packLevelId: 'oracle-pack', stockLocationId: 'oracle-location', canonicalUnitsPerPack: 10 },
    supplier: { id: 'oracle-supplier', authorized: false, licences: [] },
    orderedPacks: 10, listPricePerPackMinor: 1200 };

  describe('delivered source characterization — NOT composed seed acceptance', () => {
    it('pins every consumed root/helper source blob to the review manifest', async () => {
      const manifest = JSON.parse(await readFile(`${reviewRoot}/../review-provenance.json`, 'utf8'));
      expect(Object.keys(manifest)).toHaveLength(9);
      for (const [path, entry] of Object.entries(manifest)) {
        const actual = createHash('sha256').update(await readFile(`${reviewRoot}/${path}`)).digest('hex');
        expect(actual).toBe((entry as { sha256: string }).sha256);
      }
      expect(manifest['scripts/seed-pharmacy-demo.ts'].commit)
        .toBe('72ac8671086a4d7c46ab2075d80685bb50a508e4');
      expect(manifest['scripts/pharmacy-demo-contract.ts'].commit)
        .toBe('5b00a056775fad283ed305e9e582effcc224b534');
    });

    it('records the actual root namespace incompatibility in all three delivered planners', () => {
      const target = { environment: 'disposable', targetKey: 'oracle-only', ...context };
      const rootNamespace = runner.targetNamespace(target);
      expect(rootNamespace).toMatch(/^phdemo_[a-f0-9]{24}_$/);
      expect(runner.targetNamespace({ ...target, businessDate: '2026-09-08' })).toBe(rootNamespace);
      expect(runner.targetNamespace({ ...target, branchId: 'other' })).not.toBe(rootNamespace);
      expect(inventory.planInventoryDemo({ ...inventoryFacts, namespace: rootNamespace }).unmet)
        .toContain('INVALID_NAMESPACE');
      expect(() => finance.planPharmacyDemoFinance({ ...context, namespace: rootNamespace }))
        .toThrow('INVALID_DEMO_NAMESPACE');
      expect(() => retention.planPharmacyDemoRetention({ ...context, namespace: rootNamespace }))
        .toThrow('Use a bounded demo- namespace.');
      // Characterizes an integration defect; this passing check is NOT acceptance.
    });

    it('root produces zero records/writes and refuses apply despite valid synthetic JSON', async () => {
      const target = { environment: 'disposable', targetKey: 'oracle-only',
        organizationId: context.organizationId, branchId: context.branchId,
        ownerUserId: context.ownerUserId, vertical: 'PHARMACY', currency: 'PKR',
        timezone: context.timezone, businessDate: context.businessDate,
        scenarioAt: context.scenarioAt, namespace: '' };
      target.namespace = runner.targetNamespace(target);
      const evidence = { version: contract.PHARMACY_DEMO_VERSION, target,
        observed: { environment: target.environment, targetKey: target.targetKey,
          observedAt: '2026-09-07T06:55:00.000Z', organizationId: context.organizationId,
          vertical: 'PHARMACY', organizationActive: true, branchId: context.branchId,
          branchActive: true, currency: 'PKR', timezone: context.timezone,
          owners: [{ userId: context.ownerUserId, email: 'owner@chaichowk.pk', active: true,
            role: 'ADMIN', branchIds: [context.branchId],
            capabilities: ['reports:operational', 'reports:financial'] }],
          runtimeRole: { superuser: false, bypassRls: false, forceRls: true },
          schemaSha256: contract.SCHEMA_SHA256, migrationsSha256: contract.MIGRATIONS_SHA256,
          migrationCount: 106, actors: [], references: [], modules: [] },
        history: { namespace: target.namespace, receiptPresent: false,
          tombstonePresent: false, namespaceRecordCount: 0 },
        confirmation: { workspaceConfirmed: true, approvalReference: 'oracle-not-approval',
          evidenceDigest: '', expiresAt: '2026-09-07T07:30:00.000Z' } };
      evidence.confirmation.evidenceDigest = runner.evidenceDigest(evidence);
      const report = runner.dryRun(evidence, at);
      expect(report).toMatchObject({ writes: 0, plannedRecords: 0,
        applyEnabled: false, liveTargetVerified: false, receipt: { seedReceipt: false } });
      expect(report.coverage).toHaveLength(10);
      expect(report.unmetPrerequisites.references).toHaveLength(5);
      const output: string[] = [];
      expect(await runner.main(['--apply'], (line: string) => output.push(line))).toBe(2);
      expect(JSON.parse(output[0])).toMatchObject({ code: 'APPLY_DISABLED', writes: 0 });
    });

    it('inventory only projects a draft; finance arithmetic does not prove stock or cash', async () => {
      const draft = inventory.planInventoryDemo(inventoryFacts);
      expect(draft.expected).toEqual({ status: 'DRAFT', canonicalUnits: 100,
        grossMinor: 12000, deliveredStock: [] });
      expect(draft.unmet).toContain('PURCHASING_CAPABILITY_REQUIRED');
      expect(draft.unmet).toContain('APPROVED_SUPPLIER_LICENCE_REQUIRED');
      expect(draft).not.toHaveProperty('records'); // Known older structural contract.
      const row = { key: 'oracle-retained-line', revenueMinor: 3600,
        discountMinor: 180, cogsMinor: 1800, grossMarginMinor: 1620 };
      expect(finance.inspectPharmacyDemoJournalArithmetic([row], [row.key]))
        .toMatchObject({ moneyStockReconciled: false, drawerProof: false,
          journalInspection: 'JOURNAL_ARITHMETIC_ONLY', rows: [row] });
      expect(() => finance.inspectPharmacyDemoJournalArithmetic(
        [{ ...row, grossMarginMinor: 1621 }], [row.key])).toThrow('JOURNAL_MARGIN_MISMATCH');
      const input = { ...context, namespace: 'pharmacy-demo:oracle' };
      const plan = finance.planPharmacyDemoFinance(input);
      expect(plan.records).toEqual([]);
      expect(plan.examples).toEqual([]);
      expect((await finance.executePharmacyDemoFinance(input, undefined, plan.digest)).status)
        .toBe('refused');
    });

    it('retention cases reconcile through the real pure report but cannot seed receipts', async () => {
      const input = { ...context, namespace: 'demo-oracle' };
      const plan = retention.planPharmacyDemoRetention(input);
      expect(plan.records).toEqual([]);
      expect(plan.expectedReceipts).toHaveLength(14);
      const report = summarizeRepeatPurchasing(plan.expectedReceipts,
        input.organizationId, plan.filters, at);
      expect(report).toMatchObject({ enrolledCustomers: 4, completedReceipts: 11,
        identifiedReceipts: 10, anonymousReceipts: 1 });
      expect(report.horizons.map((h: { days: number; eligible: number; repeated: number; immature: number }) =>
        [h.days, h.eligible, h.repeated, h.immature]))
        .toEqual([[30, 3, 1, 1], [60, 3, 1, 1], [90, 3, 1, 1]]);
      expect(await retention.executePharmacyDemoRetention(input))
        .toEqual({ status: 'refused', unmetPrerequisites: plan.prerequisites });
      expect(plan.margin.status).toBe('UNSEEDED');
    });
  });
}

describe('PH-DEMO expected cohort identities (not report execution)', () => {
  // First observed qualifying originals; elapsed UTC days, NOT local calendar days.
  // Anonymous receipts contribute only to identity coverage. No clinical identities.
  const customers = [
    { id: `${namespace}:a`, ageDays: 100, repeatAfterDays: 30 },
    { id: `${namespace}:b`, ageDays: 70, repeatAfterDays: 45 },
    { id: `${namespace}:c`, ageDays: 40, repeatAfterDays: null },
    { id: `${namespace}:d`, ageDays: 10, repeatAfterDays: 5 },
  ];
  it.each([
    { days: 30, eligible: 3, repeated: 1, immature: 1 },
    { days: 60, eligible: 2, repeated: 2, immature: 2 },
    { days: 90, eligible: 1, repeated: 1, immature: 3 },
  ])('uses mature identified customers for $days-day denominator', (expected) => {
    const eligible = customers.filter(c => c.ageDays >= expected.days);
    const repeated = eligible.filter(c => c.repeatAfterDays !== null
      && c.repeatAfterDays > 0 && c.repeatAfterDays <= expected.days);
    expect({ days: expected.days, eligible: eligible.length, repeated: repeated.length,
      immature: customers.length - eligible.length }).toEqual(expected);
    expect(new Set(customers.map(c => c.id)).size).toBe(4);
  });
  it('keeps receipt identity coverage distinct from person repeat rates', () => {
    const identifiedReceipts = 7, anonymousReceipts = 2;
    expect(identifiedReceipts / (identifiedReceipts + anonymousReceipts) * 100).toBeCloseTo(77.7777778);
    expect(customers.filter(c => c.ageDays >= 30).length).toBe(3);
    expect(at.toISOString()).toBe('2026-09-07T07:00:00.000Z');
  });
});

describe('PH-DEMO declared coverage gaps (not target validation)', () => {
  const gaps: DemoGap[] = ([
    ['approved medicine/presentation/pack/location/supplier references', 'OWNER-INPUT'],
    ['existing owner, service actor capabilities and observed entitlements', 'OWNER-INPUT'],
    ['regulatory, Rx, controlled, fiscal and provider evidence', 'UNSEEDED'],
    ['D07/D08/D11, first sale real inputs and hardware', 'OWNER-INPUT'],
    ['Local LAN owner@chaichowk.pk acceptance', 'UNSEEDED'],
    ['Azure STAGING owner@chaichowk.pk acceptance', 'UNSEEDED'],
  ] as const).map(([label, status]) => ({ function: label, status, reason: 'Awaiting owner evidence' }));
  it('retains explicit prerequisites without claiming posted or live coverage', () => {
    expect(gaps).toHaveLength(6);
    expect(gaps.every(({ function: label, status }) => label.length > 0
      && ['OWNER-INPUT', 'UNSEEDED'].includes(status))).toBe(true);
    expect(gaps.filter(({ function: label }) => label.includes('owner@chaichowk.pk'))).toHaveLength(2);
  });
});

describe('PH-DEMO contract envelope oracle (synthetic input, no helper execution)', () => {
  const context: PharmacyDemoContext = {
    organizationId: `${namespace}:org`, branchId: `${namespace}:branch`,
    ownerUserId: `${namespace}:owner`, namespace, businessDate: '2026-09-07',
    scenarioAt: at.toISOString(), timezone: 'Asia/Karachi', currency: 'PKR',
    actors: [], references: [], modules: [],
  };
  const gaps: DemoGap[] = [{ function: 'approved references and capable actors',
    status: 'OWNER-INPUT', reason: 'No target observations supplied' }];

  // Independent acceptance of the documented envelope, not a planner or fence.
  // Digest/hash algorithms and service-specific facts remain helper-owned.
  function assertEnvelope(plan: PharmacyDemoPlan) {
    expect(plan.namespace).toBe(context.namespace);
    expect(['inventory', 'finance', 'retention']).toContain(plan.lane);
    expect(plan.digest.trim().length).toBeGreaterThan(0);
    expect(plan.records.length).toBeLessThanOrEqual(100);
    expect(new Set(plan.records.map(r => r.id)).size).toBe(plan.records.length);
    expect(new Set(plan.records.map(r => r.key)).size).toBe(plan.records.length);
    for (const record of plan.records) {
      expect(record.id.startsWith(`${context.namespace}:`)).toBe(true);
      expect(record.key.startsWith(`${context.namespace}:`)).toBe(true);
      expect(record.expectedHash.trim().length).toBeGreaterThan(0);
    }
    for (const gap of plan.gaps) {
      expect(['UNSEEDED', 'OWNER-INPUT', 'DRAFT-ONLY']).toContain(gap.status);
      expect(gap.function.trim().length).toBeGreaterThan(0);
      expect(gap.reason.trim().length).toBeGreaterThan(0);
    }
  }
  const record: DemoPlannedRecord = {
    id: `${namespace}:receipt`, key: `${namespace}:receipt`, model: 'oracle-only',
    expectedHash: 'opaque-oracle-hash-not-helper-evidence',
    expectedFacts: { available: 115, quarantine: 5, outside: -120 },
  };
  const plan: PharmacyDemoPlan = { lane: 'inventory', namespace,
    digest: 'opaque-oracle-digest-not-helper-evidence', records: [record], gaps };

  it('accepts namespaced expected facts without declaring target authorization', () => {
    assertEnvelope(plan);
    expect(context.references).toEqual([]);
    expect(context.actors).toEqual([]);
    const expectedRefusal: PharmacyDemoResult = { status: 'refused',
      unmetPrerequisites: gaps.map(gap => `${gap.function}: ${gap.reason}`) };
    expect(expectedRefusal.unmetPrerequisites).toHaveLength(1);
    // Expected refusal only. No executor has produced this result.
  });
  it('rejects cross-namespace records, duplicate identities and overlarge plans', () => {
    expect(() => assertEnvelope({ ...plan, namespace: 'different-target' })).toThrow();
    expect(() => assertEnvelope({ ...plan, records: [{ ...record, id: 'legitimate-row' }] })).toThrow();
    expect(() => assertEnvelope({ ...plan, records: [{ ...record, key: 'other-target:key' }] })).toThrow();
    expect(() => assertEnvelope({ ...plan, records: [record, { ...record, key: `${namespace}:other` }] })).toThrow();
    expect(() => assertEnvelope({ ...plan, records: [record, { ...record, id: `${namespace}:other` }] })).toThrow();
    expect(() => assertEnvelope({ ...plan, records: Array.from({ length: 101 }, (_, i) => ({
      ...record, id: `${namespace}:${i}`, key: `${namespace}:${i}`,
    })) })).toThrow();
  });
});
