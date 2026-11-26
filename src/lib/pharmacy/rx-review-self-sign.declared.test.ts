import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DEV-960 — a declared solo sign-off. With colleagues on the branch's staff list, the pharmacist
 * who rang up a prescription line signs it alone only with the owner's "One pharmacist per shift"
 * setting on at that branch and the current on-duty declaration. The audit entry is the same
 * self-approved, PIN-verified entry the database requires, plus the declared marker and the other
 * eligible signers. With the setting off nothing changes; controlled lines and people without the
 * dispensing right are refused as before.
 */
vi.mock('server-only', () => ({}));
const abac = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@/lib/abac', () => ({
  subjectFromSession: (row: { id: string }) => ({ id: row.id }),
  can: vi.fn(async (subject: { id: string }) => abac.allowed.has(subject.id)),
}));

import { RX_ON_DUTY_DECLARATION } from './rx-solo-shift';
import {
  assertRxSelfSignAllowed,
  RX_SELF_SIGN_AUDIT_ACTION,
  RX_SELF_SIGN_POLICY,
  RxSelfSignError,
  selfSignRxReview,
} from './rx-review-self-sign';

const ORG = 'org-1';
const BRANCH = 'branch-1';
const SELLER = 'user-seller';
const COLLEAGUE = 'user-colleague';
const CASHIER = 'user-cashier';
const DECLARATION = {
  onlyPharmacistOnDuty: true as const,
  version: RX_ON_DUTY_DECLARATION.version,
};

const member = (id: string, name: string) => ({
  id,
  name,
  organizationId: ORG,
  role: 'EMPLOYEE',
  department: 'LEADERSHIP',
  status: 'ACTIVE',
});

function fixture(
  options: {
    colleagues?: Array<ReturnType<typeof member>>;
    policy?: { enabled: boolean; version: number } | null;
    controlled?: boolean;
    requester?: string;
  } = {}
) {
  const queries: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const decisions: Array<Record<string, unknown>> = [];
  const people = new Map(
    [member(SELLER, 'Seller'), member(CASHIER, 'Cashier'), ...(options.colleagues ?? [])].map(
      (row) => [row.id, row]
    )
  );
  const db = {
    pharmacyBranchAssignment: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { organizationId: string; branchId: string; userId: string };
        }) =>
          where.organizationId === ORG && where.branchId === BRANCH && people.has(where.userId)
            ? { branchId: BRANCH }
            : null
      ),
    },
    $queryRaw: vi.fn(async (query: { strings?: readonly string[] } | TemplateStringsArray) => {
      const text = (
        'strings' in query && query.strings ? query.strings : (query as TemplateStringsArray)
      ).join('?');
      queries.push(text);
      if (text.includes('pharmacy_rx_solo_shift_policy_changes'))
        return options.policy ? [options.policy] : [];
      return [];
    }),
    pharmacyPharmacistReviewItem: {
      findFirst: vi.fn(async () => ({
        id: 'review-1',
        saleLineId: 'line-1',
        requestedByUserId: options.requester ?? SELLER,
      })),
    },
    pharmacySaleLine: {
      findFirst: vi.fn(async () => ({
        id: 'line-1',
        saleId: 'sale-1',
        branchId: BRANCH,
        medicine: { controlled: options.controlled ?? false },
      })),
    },
    pharmacyPharmacistReviewDecision: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        decisions.push(args.data);
        return { id: 'decision-1', ...args.data };
      }),
    },
    auditLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        audits.push(args.data);
        return { id: `audit-${audits.length}` };
      }),
    },
    user: {
      findFirst: vi.fn(
        async (args: { where: { id: string } }) => people.get(args.where.id) ?? null
      ),
      findMany: vi.fn(async (args: { where: { id: { not: string } } }) =>
        [...people.values()].filter((row) => row.id !== args.where.id.not)
      ),
    },
  };
  return { db: db as never, raw: db, queries, audits, decisions };
}

const seller = { id: SELLER, role: 'EMPLOYEE', department: 'LEADERSHIP', status: 'ACTIVE' };
const colleague = member(COLLEAGUE, 'Colleague');

beforeEach(() => {
  // The seller and the colleague hold the dispensing right; the cashier does not.
  abac.allowed = new Set([SELLER, COLLEAGUE]);
});

async function refusal(run: Promise<unknown>) {
  try {
    await run;
  } catch (error) {
    if (error instanceof RxSelfSignError) return error.reason;
    throw error;
  }
  return null;
}

describe('declared solo sign-off (DEV-960)', () => {
  it('signs with the setting on and the declaration, auditing the marker and who else was listed', async () => {
    const f = fixture({ colleagues: [colleague], policy: { enabled: true, version: 3 } });
    const now = new Date('2026-11-19T10:00:00.000Z');
    const signed = await selfSignRxReview(
      f.db,
      { organizationId: ORG, actor: seller, reviewItemId: 'review-1', declaration: DECLARATION },
      now
    );
    expect(f.audits).toHaveLength(1);
    expect(f.audits[0]).toMatchObject({
      organizationId: ORG,
      actorId: SELLER,
      action: RX_SELF_SIGN_AUDIT_ACTION,
      outcome: 'SUCCESS',
      targetType: 'PharmacyPharmacistReviewItem',
      targetId: 'review-1',
      metadata: {
        // Everything the database trigger requires, as for the staff-list solo rule.
        policy: RX_SELF_SIGN_POLICY,
        selfApproved: true,
        pinVerified: true,
        soloRule: true,
        approverId: SELLER,
        initiatedById: SELLER,
        approvedAt: now.toISOString(),
        reviewItemId: 'review-1',
        saleId: 'sale-1',
        saleLineId: 'line-1',
        branchId: BRANCH,
        // The declared marker and its evidence.
        declaredSolo: true,
        soloBasis: 'DECLARED_ON_DUTY',
        declaration: RX_ON_DUTY_DECLARATION.text,
        declarationVersion: RX_ON_DUTY_DECLARATION.version,
        soloShiftPolicyVersion: 3,
        otherEligibleSigners: [{ id: COLLEAGUE, name: 'Colleague' }],
      },
    });
    expect(f.decisions).toEqual([
      {
        organizationId: ORG,
        reviewItemId: 'review-1',
        kind: 'SIGN',
        actorUserId: SELLER,
        signedAt: now,
        selfApprovalAuditId: 'audit-1',
      },
    ]);
    expect(signed.declared).toEqual({
      policyVersion: 3,
      otherSigners: [{ id: COLLEAGUE, name: 'Colleague' }],
    });
    // The setting is read under the branch's setting lock, taken shared.
    expect(f.queries.some((text) => text.includes('pg_advisory_xact_lock_shared'))).toBe(true);
  });

  it('with the setting off, refuses a declaration exactly as a colleague on the list', async () => {
    for (const policy of [null, { enabled: false, version: 2 }]) {
      const f = fixture({ colleagues: [colleague], policy });
      const error = await selfSignRxReview(f.db, {
        organizationId: ORG,
        actor: seller,
        reviewItemId: 'review-1',
        declaration: DECLARATION,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RxSelfSignError);
      expect(error).toMatchObject({ reason: 'SECOND_PHARMACIST', askName: 'Colleague' });
      expect(f.audits).toEqual([]);
      expect(f.decisions).toEqual([]);
    }
  });

  it('with the setting on, still refuses without the declaration', async () => {
    const f = fixture({ colleagues: [colleague], policy: { enabled: true, version: 1 } });
    expect(
      await refusal(
        selfSignRxReview(f.db, { organizationId: ORG, actor: seller, reviewItemId: 'review-1' })
      )
    ).toBe('SECOND_PHARMACIST');
    expect(f.audits).toEqual([]);
  });

  it('refuses a declaration of another wording version', async () => {
    const f = fixture({ colleagues: [colleague], policy: { enabled: true, version: 1 } });
    expect(
      await refusal(
        assertRxSelfSignAllowed(f.db, {
          organizationId: ORG,
          actor: seller,
          reviewItemId: 'review-1',
          declaration: { onlyPharmacistOnDuty: true, version: 'rx-only-pharmacist-on-duty@0' },
        })
      )
    ).toBe('STALE_DECLARATION');
  });

  it('never self-signs a controlled medicine, whatever is declared', async () => {
    const f = fixture({
      colleagues: [colleague],
      policy: { enabled: true, version: 1 },
      controlled: true,
    });
    expect(
      await refusal(
        selfSignRxReview(f.db, {
          organizationId: ORG,
          actor: seller,
          reviewItemId: 'review-1',
          declaration: DECLARATION,
        })
      )
    ).toBe('CONTROLLED');
    expect(f.audits).toEqual([]);
  });

  it('refuses a cashier without the dispensing right, and anyone who did not ring it up', async () => {
    const asCashier = fixture({
      colleagues: [colleague],
      policy: { enabled: true, version: 1 },
      requester: CASHIER,
    });
    expect(
      await refusal(
        assertRxSelfSignAllowed(asCashier.db, {
          organizationId: ORG,
          actor: { id: CASHIER, status: 'ACTIVE' },
          reviewItemId: 'review-1',
          declaration: DECLARATION,
        })
      )
    ).toBe('NOT_ALLOWED');
    const notMine = fixture({ colleagues: [colleague], policy: { enabled: true, version: 1 } });
    expect(
      await refusal(
        assertRxSelfSignAllowed(notMine.db, {
          organizationId: ORG,
          actor: { id: COLLEAGUE, status: 'ACTIVE' },
          reviewItemId: 'review-1',
          declaration: DECLARATION,
        })
      )
    ).toBe('NOT_REQUESTER');
  });

  it('leaves the staff-list solo rule unchanged: no colleague, no setting read, no new marker', async () => {
    const f = fixture({ policy: { enabled: true, version: 1 } });
    const now = new Date('2026-11-19T10:00:00.000Z');
    // A declaration sent where nobody else could sign is the plain solo rule.
    for (const declaration of [undefined, DECLARATION]) {
      f.audits.length = 0;
      f.queries.length = 0;
      await selfSignRxReview(
        f.db,
        { organizationId: ORG, actor: seller, reviewItemId: 'review-1', declaration },
        now
      );
      expect(f.audits[0]).toMatchObject({
        description: 'Prescription line self-signed by a sole pharmacist with a fresh PIN',
      });
      expect(f.audits[0]!.metadata).toEqual({
        policy: RX_SELF_SIGN_POLICY,
        selfApproved: true,
        pinVerified: true,
        soloRule: true,
        approverId: SELLER,
        initiatedById: SELLER,
        approvedAt: now.toISOString(),
        reviewItemId: 'review-1',
        saleId: 'sale-1',
        saleLineId: 'line-1',
        branchId: BRANCH,
      });
      expect(f.queries.some((text) => text.includes('pharmacy_rx_solo_shift'))).toBe(false);
    }
  });
});
