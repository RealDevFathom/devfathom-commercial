import { describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '@/generated/prisma/client';

vi.mock('./regulatory', () => ({
  assertStoredBranchMayOperate: vi.fn(async () => undefined),
  BranchOperationDeniedError: class extends Error {},
}));

import { evaluatePharmacyReadiness, evaluateReadiness, type PharmacyReadiness } from './onboarding';
import {
  PHARMACY_GATE_GUIDANCE,
  SUPPLIER_CHECKS_OFF_GUIDANCE,
  pharmacyOnboardingChecklist,
} from './onboarding-checklist';

/**
 * DEV-753 — the PARTIES_AND_BALANCES onboarding gate follows the owner's supplier
 * checks. ON (and any missing or unreadable policy) still needs an authorized,
 * active supplier; OFF counts an active supplier whether or not it is authorized,
 * and the checklist then asks for neither an authorization nor a licence.
 */

const ORG = 'org-dev753';
const GATE = 'PARTIES_AND_BALANCES';
const FORBIDDEN_OFF_WORDS = /verified|licen[cs]|authori[sz]/i;

type SupplierRow = { organizationId: string; authorized: boolean; active: boolean };
type PolicyRead = { rows: readonly object[] } | { error: Error };

const unauthorizedActive: SupplierRow = { organizationId: ORG, authorized: false, active: true };
const authorizedInactive: SupplierRow = { organizationId: ORG, authorized: true, active: false };

const policyRow = (checksEnabled: boolean) => ({
  checksEnabled,
  version: 3,
  updatedAt: new Date('2026-11-01T00:00:00.000Z'),
  updatedByUserId: 'owner-1',
});

/**
 * A database holding these suppliers and this owner-policy read. The supplier count
 * applies the evaluator's own `where` to the rows, so the gate's answer comes from
 * the filter the evaluator chose rather than from a canned number.
 */
function readinessDb(suppliers: readonly SupplierRow[], policy: PolicyRead) {
  return {
    $queryRaw: vi.fn(async (query: { values: unknown[] }) => {
      if ('error' in policy) throw policy.error;
      // The policy row is this organization's, or there is none.
      return query.values.includes(ORG) ? policy.rows : [];
    }),
    organization: {
      findUnique: vi.fn(async () => ({ packageId: 'pharmacy', package: { vertical: 'PHARMACY' } })),
    },
    pharmacyOnboardingGateState: { findMany: vi.fn(async () => []) },
    branchRegulatoryProfile: { findFirst: vi.fn(async () => ({ branchId: 'branch-1' })) },
    organizationRole: { count: vi.fn(async () => 0) },
    medicinePublicationEntry: { count: vi.fn(async () => 0) },
    pharmacyInventoryLot: { count: vi.fn(async () => 0) },
    pharmacySupplier: {
      count: vi.fn(
        async ({ where }: { where: Partial<SupplierRow> }) =>
          suppliers.filter((row) =>
            (Object.keys(where) as (keyof SupplierRow)[]).every((key) => row[key] === where[key])
          ).length
      ),
    },
  } as unknown as PrismaClient;
}

function supplierGate(readiness: PharmacyReadiness) {
  return readiness.gates.find((gate) => gate.gate === GATE)!;
}

function supplierRow(readiness: PharmacyReadiness) {
  return pharmacyOnboardingChecklist(readiness).items.find((item) => item.key === GATE)!;
}

describe('supplier gate with the owner switch off', () => {
  it('counts an active supplier that is not authorized and words the row without authorization', async () => {
    const readiness = await evaluatePharmacyReadiness(
      readinessDb([unauthorizedActive], { rows: [policyRow(false)] }),
      ORG
    );

    expect(readiness.supplierChecksEnabled).toBe(false);
    expect(supplierGate(readiness)).toMatchObject({ status: 'PASSED', p0: true });
    expect(readiness.blocking).not.toContain(GATE);

    const row = supplierRow(readiness);
    expect(row).toMatchObject({ key: GATE, state: 'DONE', blocksActivation: false });
    expect(row.why).toBe(SUPPLIER_CHECKS_OFF_GUIDANCE.done);
    expect(row.why).not.toMatch(FORBIDDEN_OFF_WORDS);
  });

  it('still requires the supplier to be active, and asks only for an active one', async () => {
    const readiness = await evaluatePharmacyReadiness(
      readinessDb([authorizedInactive], { rows: [policyRow(false)] }),
      ORG
    );

    expect(supplierGate(readiness)).toMatchObject({ status: 'NOT_STARTED', p0: true });
    expect(readiness.blocking).toContain(GATE);

    const row = supplierRow(readiness);
    expect(row).toMatchObject({ state: 'NEEDS_YOU', blocksActivation: true });
    expect(row.why).toBe(SUPPLIER_CHECKS_OFF_GUIDANCE.todo);
    expect(row.why).not.toMatch(FORBIDDEN_OFF_WORDS);
  });
});

describe('supplier gate with the checks on, missing or unreadable', () => {
  it.each<[string, PolicyRead]>([
    ['stored on', { rows: [policyRow(true)] }],
    ['no policy row (default)', { rows: [] }],
    ['an unreadable policy', { error: new Error('relation is unavailable') }],
    ['a malformed row', { rows: [{ checksEnabled: 'false', version: 3 }] }],
  ])('does not count an unauthorized active supplier with %s', async (_label, policy) => {
    const readiness = await evaluatePharmacyReadiness(
      readinessDb([unauthorizedActive], policy),
      ORG
    );

    expect(readiness.supplierChecksEnabled).toBe(true);
    expect(supplierGate(readiness)).toMatchObject({ status: 'NOT_STARTED', p0: true });
    expect(readiness.blocking).toContain(GATE);
    expect(supplierRow(readiness).why).toBe(PHARMACY_GATE_GUIDANCE[GATE].todo);
  });

  it('passes on an authorized active supplier with today’s wording', async () => {
    const readiness = await evaluatePharmacyReadiness(
      readinessDb([{ organizationId: ORG, authorized: true, active: true }], { rows: [] }),
      ORG
    );

    expect(supplierGate(readiness).status).toBe('PASSED');
    expect(supplierRow(readiness).why).toBe('An authorized supplier is on file.');
  });

  it('keeps today’s to-do wording', () => {
    expect(PHARMACY_GATE_GUIDANCE[GATE].todo).toBe(
      'Add at least one authorized, active supplier so purchasing and returns have a counterparty.'
    );
  });
});

describe('supplier row copy from a readiness value', () => {
  it('reads an absent supplierChecksEnabled as on', () => {
    const readiness = evaluateReadiness(ORG, [], {});
    expect(readiness.supplierChecksEnabled).toBeUndefined();
    expect(supplierRow(readiness).why).toBe(PHARMACY_GATE_GUIDANCE[GATE].todo);
  });

  it('keeps the downgrade explanation when a recorded PASSED is not backed, even with checks off', () => {
    const readiness: PharmacyReadiness = {
      ...evaluateReadiness(
        ORG,
        [{ gate: GATE, status: 'PASSED', evidenceRef: 'ref', actorId: 'user-1' }],
        {}
      ),
      supplierChecksEnabled: false,
    };

    expect(supplierGate(readiness).downgradeReason).toBe('EVIDENCE_ABSENT');
    expect(supplierRow(readiness).why).toContain('You marked this done');
  });
});
