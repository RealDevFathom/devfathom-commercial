/**
 * SOP-1 / WHA-224 — job roles and both SOP assignment modes, against migrated
 * PostgreSQL with FORCED row-level security.
 *
 * These cases only mean anything against a real database: the multi-role union is
 * a join, the audit trail's immutability is a policy omission, the claim race is a
 * row lock, and branch isolation is an RLS predicate. A mocked client would assert
 * that the code calls Prisma, not that any of the invariants hold. Skipped (never
 * silently passed) when the database URLs are absent.
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.M8_TEST_OWNER_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha224_${suffix}`;
const otherOrgId = `org_wha224_other_${suffix}`;
const ids = {
  branchA: `branch_a_${suffix}`,
  branchB: `branch_b_${suffix}`,
  sam: `staff_sam_${suffix}`,
  jo: `staff_jo_${suffix}`,
  admin: `staff_admin_${suffix}`,
};

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  jobRoles: typeof import('./job-roles');
  sopAssignment: typeof import('./sop-assignment');
  sopTemplates: typeof import('./sop-templates');
  packs: typeof import('./sop-template-packs');
  generation: typeof import('./sop-occurrence-generation');
};

let deps: Deps;
/** Role ids seeded in beforeAll, keyed by role key. */
const roleIds: Record<string, string> = {};

function tenant<T>(work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(orgId, work);
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL || !OWNER_DATABASE_URL) return;
  // The runtime role must NOT be the owner, or FORCE RLS proves nothing here.
  expect(OWNER_DATABASE_URL).not.toBe(TEST_DATABASE_URL);

  const owner = new Client({ connectionString: OWNER_DATABASE_URL });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query(`SET LOCAL app.is_platform_admin = 'true'`);
    await owner.query(
      `INSERT INTO "organizations"
        ("id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $2, 'SOP1 Test Co', 'SOP1 Test', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
              ($3, $4, 'SOP1 Other Co', 'SOP1 Other', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [orgId, `wha224-${suffix}`, otherOrgId, `wha224-other-${suffix}`]
    );
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await owner.end();
  }

  const [scopedDb, jobRoles, sopAssignment, sopTemplates, packs, generation] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./job-roles'),
    import('./sop-assignment'),
    import('./sop-templates'),
    import('./sop-template-packs'),
    import('./sop-occurrence-generation'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    jobRoles,
    sopAssignment,
    sopTemplates,
    packs,
    generation,
  };

  await tenant(async (tx) => {
    await tx.restaurantBranch.createMany({
      data: [
        { id: ids.branchA, name: 'Downtown', timezone: 'UTC', businessDayCutoff: '00:00' },
        { id: ids.branchB, name: 'Airport', timezone: 'UTC', businessDayCutoff: '00:00' },
      ],
    });
    await tx.restaurantStaffProfile.createMany({
      data: [
        { id: ids.sam, displayName: 'Sam', primaryBranchId: ids.branchA },
        { id: ids.jo, displayName: 'Jo', primaryBranchId: ids.branchA },
        { id: ids.admin, displayName: 'Admin', primaryBranchId: ids.branchA },
      ],
    });
    await deps.jobRoles.ensureDefaultJobRoles(tx);
    const roles = await tx.restaurantJobRole.findMany({ select: { id: true, key: true } });
    for (const role of roles) roleIds[role.key] = role.id;
  });
});

describeIfDatabase('SOP-1 job roles — the many-to-many holding', () => {
  it('seeds the ten vertical-supplied roles idempotently', async () => {
    const second = await tenant((tx) => deps.jobRoles.ensureDefaultJobRoles(tx));
    expect(second.created).toEqual([]);
    const roles = await tenant((tx) => deps.jobRoles.listJobRoles(tx));
    expect(roles.map((role) => role.key).sort()).toEqual([
      'accountant',
      'barista',
      'cashier',
      'delivery-rider',
      'host',
      'kitchen',
      'manager',
      'owner',
      'server',
      'shift-supervisor',
    ]);
    // Seeding is a create-if-missing, so a second pass must not duplicate a
    // capability row either — the union would still be correct, but the audit
    // story "when did this role gain this power" would not be.
    const cashier = roles.find((role) => role.key === 'cashier')!;
    expect(cashier.capabilities.map((row) => row.capability).sort()).toEqual([
      'cash:close',
      'cash:open',
      'customers:read',
      'menu:read',
      'orders:read',
      'orders:take',
      'payments:collect',
      'pos:operate',
      'sop:complete',
    ]);
    expect(cashier.isSystem).toBe(true);
  });

  it('lets ONE person hold TWO roles at once — the owner’s barista-plus-cashier case', async () => {
    await tenant(async (tx) => {
      await deps.jobRoles.grantJobRole(tx, {
        staffProfileId: ids.sam,
        jobRoleId: roleIds.barista!,
        branchId: ids.branchA,
        actorStaffProfileId: ids.admin,
      });
      await deps.jobRoles.grantJobRole(tx, {
        staffProfileId: ids.sam,
        jobRoleId: roleIds.cashier!,
        branchId: ids.branchA,
        actorStaffProfileId: ids.admin,
      });
    });

    const held = await tenant((tx) => deps.jobRoles.listStaffJobRoles(tx, ids.sam));
    expect(held.map((holding) => holding.jobRole.key).sort()).toEqual(['barista', 'cashier']);
  });

  it('resolves capabilities as a UNION over held roles plus direct grants', async () => {
    // barista and cashier overlap heavily (both take orders and read the menu);
    // manager adds a great deal more. Granting manager on top must ADD, and every
    // capability reachable by several roles must resolve exactly once.
    await tenant((tx) =>
      deps.jobRoles.grantJobRole(tx, {
        staffProfileId: ids.sam,
        jobRoleId: roleIds.manager!,
        branchId: ids.branchA,
        actorStaffProfileId: ids.admin,
      })
    );
    await tenant((tx) =>
      deps.jobRoles.setStaffCapabilityOverride(tx, {
        staffProfileId: ids.sam,
        branchId: ids.branchA,
        capability: 'sop:export',
        effect: 'ALLOW',
        actorStaffProfileId: ids.admin,
      })
    );

    const decision = await tenant((tx) =>
      deps.jobRoles.resolveStaffCapabilityDecision(tx, ids.sam, ids.branchA)
    );

    // The union is exactly what the three held roles grant, plus the direct grant —
    // computed from the SEEDED ROWS rather than the template constant, so this
    // asserts the join and not the catalogue.
    const heldRoleCapabilities = await tenant(async (tx) => {
      const rows = await tx.restaurantJobRoleCapability.findMany({
        where: { jobRoleId: { in: [roleIds.barista!, roleIds.cashier!, roleIds.manager!] } },
        select: { capability: true },
      });
      return new Set(rows.map((row) => row.capability));
    });
    expect([...decision.inherited].sort()).toEqual([...heldRoleCapabilities].sort());
    expect([...decision.allowed]).toEqual(['sop:export']);
    expect([...decision.denied]).toEqual([]);
    expect([...decision.effective].sort()).toEqual(
      [...new Set([...heldRoleCapabilities, 'sop:export'])].sort()
    );

    // Spot-check the three provenances by name so a silently emptied template
    // cannot make the set-equality above trivially true.
    expect(decision.effective.has('kitchen:operate')).toBe(true); // barista + manager
    expect(decision.effective.has('cash:open')).toBe(true); // cashier + manager
    expect(decision.effective.has('staff:manage')).toBe(true); // manager only
    expect(decision.effective.has('sop:export')).toBe(true); // direct grant only
    // Reachable from all three roles, and present once — it is a Set, by contract.
    expect([...decision.effective].filter((c) => c === 'menu:read')).toHaveLength(1);

    // The shorthand and the layered form must never disagree.
    const shorthand = await tenant((tx) =>
      deps.jobRoles.resolveStaffCapabilities(tx, ids.sam, ids.branchA)
    );
    expect([...shorthand].sort()).toEqual([...decision.effective].sort());
  });

  it('scopes holdings to the branch they were granted at', async () => {
    const atOtherBranch = await tenant((tx) =>
      deps.jobRoles.resolveStaffCapabilities(tx, ids.sam, ids.branchB)
    );
    expect([...atOtherBranch]).toEqual([]);
  });

  it('removes only what the multi-select drops, and only at that branch', async () => {
    // Sam also gets barista at branch B, so we can prove a branch-A save leaves it.
    await tenant((tx) =>
      deps.jobRoles.grantJobRole(tx, {
        staffProfileId: ids.sam,
        jobRoleId: roleIds.barista!,
        branchId: ids.branchB,
        actorStaffProfileId: ids.admin,
      })
    );

    const result = await tenant((tx) =>
      deps.jobRoles.setStaffJobRoles(tx, {
        staffProfileId: ids.sam,
        branchId: ids.branchA,
        jobRoleIds: [roleIds.barista!, roleIds.kitchen!],
        actorStaffProfileId: ids.admin,
      })
    );
    expect(result.granted).toEqual([roleIds.kitchen!]);
    expect(result.revoked.sort()).toEqual([roleIds.cashier!, roleIds.manager!].sort());

    const atA = await tenant((tx) =>
      deps.jobRoles.listStaffJobRoles(tx, ids.sam, { branchId: ids.branchA })
    );
    expect(atA.map((holding) => holding.jobRole.key).sort()).toEqual(['barista', 'kitchen']);

    const atB = await tenant((tx) =>
      deps.jobRoles.listStaffJobRoles(tx, ids.sam, { branchId: ids.branchB })
    );
    expect(atB.map((holding) => holding.jobRole.key)).toEqual(['barista']);

    // Revoking manager withdrew its capabilities; the direct grant survives.
    const capabilities = await tenant((tx) =>
      deps.jobRoles.resolveStaffCapabilities(tx, ids.sam, ids.branchA)
    );
    expect(capabilities.has('staff:manage')).toBe(false); // manager-only, withdrawn
    expect(capabilities.has('cash:open')).toBe(false); // cashier-only, withdrawn
    expect(capabilities.has('kitchen:operate')).toBe(true); // still barista + kitchen
    expect(capabilities.has('sop:export')).toBe(true); // the direct grant outlives both
  });

  it('is idempotent: re-granting an existing holding writes no second audit entry', async () => {
    const before = await tenant((tx) =>
      deps.jobRoles.listStaffJobRoleAudit(tx, ids.sam, { branchId: ids.branchA, take: 500 })
    );
    const result = await tenant((tx) =>
      deps.jobRoles.grantJobRole(tx, {
        staffProfileId: ids.sam,
        jobRoleId: roleIds.barista!,
        branchId: ids.branchA,
        actorStaffProfileId: ids.admin,
      })
    );
    expect(result.changed).toBe(false);
    const after = await tenant((tx) =>
      deps.jobRoles.listStaffJobRoleAudit(tx, ids.sam, { branchId: ids.branchA, take: 500 })
    );
    expect(after.length).toBe(before.length);
  });

  it('audits every grant and revoke, and the revoke record outlives the holding', async () => {
    const trail = await tenant((tx) =>
      deps.jobRoles.listStaffJobRoleAudit(tx, ids.sam, { branchId: ids.branchA, take: 500 })
    );
    const byKey = (key: string, change: string) =>
      trail.filter((entry) => entry.jobRoleKey === key && entry.change === change).length;

    expect(byKey('barista', 'GRANTED')).toBe(1);
    expect(byKey('cashier', 'GRANTED')).toBe(1);
    expect(byKey('cashier', 'REVOKED')).toBe(1);
    expect(byKey('manager', 'REVOKED')).toBe(1);
    expect(trail.every((entry) => entry.actorStaffProfileId === ids.admin)).toBe(true);

    // The cashier holding is gone, but the trail still explains that it existed.
    const held = await tenant((tx) =>
      deps.jobRoles.listStaffJobRoles(tx, ids.sam, { branchId: ids.branchA })
    );
    expect(held.some((holding) => holding.jobRole.key === 'cashier')).toBe(false);
  });

  it('DB-enforces the audit trail as append-only under forced RLS', async () => {
    const entry = await tenant((tx) =>
      tx.restaurantStaffJobRoleAudit.findFirst({ where: { staffProfileId: ids.sam } })
    );
    expect(entry).not.toBeNull();

    await expect(
      tenant((tx) =>
        tx.restaurantStaffJobRoleAudit.update({
          where: { id: entry!.id },
          data: { change: 'GRANTED' },
        })
      )
    ).rejects.toThrow();

    await expect(
      tenant((tx) => tx.restaurantStaffJobRoleAudit.delete({ where: { id: entry!.id } }))
    ).rejects.toThrow();

    const still = await tenant((tx) =>
      tx.restaurantStaffJobRoleAudit.findUnique({ where: { id: entry!.id } })
    );
    expect(still).not.toBeNull();
  });

  it('isolates job roles across tenants under forced RLS', async () => {
    const otherSees = await deps.withTenantDb(otherOrgId, (tx) =>
      tx.restaurantJobRole.findMany({ select: { id: true } })
    );
    expect(otherSees).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// B1 / WHA-285 — the per-person override layer.
//
// Jo and Admin both work branch B so the deny story can be told properly: it is
// only interesting if taking a capability from ONE holder demonstrably leaves it
// with the OTHER, and leaves the role itself alone.
// ---------------------------------------------------------------------------
describeIfDatabase('B1 per-person capability overrides', () => {
  const REFUND = 'payments:refund';
  const DISCOUNT = 'orders:discount';

  beforeAll(async () => {
    if (!TEST_DATABASE_URL || !OWNER_DATABASE_URL) return;
    await tenant(async (tx) => {
      for (const staffProfileId of [ids.jo, ids.admin]) {
        await deps.jobRoles.grantJobRole(tx, {
          staffProfileId,
          jobRoleId: roleIds.cashier!,
          branchId: ids.branchB,
          actorStaffProfileId: ids.admin,
        });
      }
    });
  });

  it('starts from a cashier who may take money but not discount or refund', async () => {
    const decision = await tenant((tx) =>
      deps.jobRoles.resolveStaffCapabilityDecision(tx, ids.jo, ids.branchB)
    );
    expect(decision.effective.has('payments:collect')).toBe(true);
    expect(decision.effective.has(DISCOUNT)).toBe(false);
    expect(decision.effective.has(REFUND)).toBe(false);
  });

  it('applies a DIRECT extra: this cashier alone may apply a discount', async () => {
    const result = await tenant((tx) =>
      deps.jobRoles.setStaffCapabilityOverride(tx, {
        staffProfileId: ids.jo,
        branchId: ids.branchB,
        capability: DISCOUNT,
        effect: 'ALLOW',
        actorStaffProfileId: ids.admin,
      })
    );
    expect(result.changed).toBe(true);

    expect(
      await tenant((tx) => deps.jobRoles.staffHasCapability(tx, ids.jo, ids.branchB, DISCOUNT))
    ).toBe(true);

    // The ROLE is untouched, so the other cashier at this branch still may not.
    const roleCapabilities = await tenant((tx) =>
      tx.restaurantJobRoleCapability.findMany({
        where: { jobRoleId: roleIds.cashier! },
        select: { capability: true },
      })
    );
    expect(roleCapabilities.map((row) => row.capability)).not.toContain(DISCOUNT);
    expect(
      await tenant((tx) => deps.jobRoles.staffHasCapability(tx, ids.admin, ids.branchB, DISCOUNT))
    ).toBe(false);
  });

  it('DENIES an INHERITED capability for one person, leaving the role and its other holders intact', async () => {
    // Both cashiers pick up shift-supervisor, which inherits refunds…
    await tenant(async (tx) => {
      for (const staffProfileId of [ids.jo, ids.admin]) {
        await deps.jobRoles.grantJobRole(tx, {
          staffProfileId,
          jobRoleId: roleIds['shift-supervisor']!,
          branchId: ids.branchB,
          actorStaffProfileId: ids.admin,
        });
      }
    });
    expect(
      await tenant((tx) => deps.jobRoles.staffHasCapability(tx, ids.jo, ids.branchB, REFUND))
    ).toBe(true);

    // …and Jo alone loses it.
    const result = await tenant((tx) =>
      deps.jobRoles.setStaffCapabilityOverride(tx, {
        staffProfileId: ids.jo,
        branchId: ids.branchB,
        capability: REFUND,
        effect: 'DENY',
        actorStaffProfileId: ids.admin,
      })
    );
    expect(result.changed).toBe(true);

    const decision = await tenant((tx) =>
      deps.jobRoles.resolveStaffCapabilityDecision(tx, ids.jo, ids.branchB)
    );
    // The provenance survives the subtraction: she still INHERITS it, and is
    // denied it. A console needs both halves to explain the gap.
    expect(decision.inherited.has(REFUND)).toBe(true);
    expect(decision.denied.has(REFUND)).toBe(true);
    expect(decision.effective.has(REFUND)).toBe(false);

    // The role still grants it, and the other holder still has it.
    const roleCapabilities = await tenant((tx) =>
      tx.restaurantJobRoleCapability.findMany({
        where: { jobRoleId: roleIds['shift-supervisor']! },
        select: { capability: true },
      })
    );
    expect(roleCapabilities.map((row) => row.capability)).toContain(REFUND);
    expect(
      await tenant((tx) => deps.jobRoles.staffHasCapability(tx, ids.admin, ids.branchB, REFUND))
    ).toBe(true);

    // Nothing else Jo inherited was collateral damage.
    expect(decision.effective.has('orders:void')).toBe(true);
    expect(decision.effective.has('payments:collect')).toBe(true);
  });

  it('is branch-scoped: a deny at one branch does not follow the person to another', async () => {
    await tenant((tx) =>
      deps.jobRoles.grantJobRole(tx, {
        staffProfileId: ids.jo,
        jobRoleId: roleIds['shift-supervisor']!,
        branchId: ids.branchA,
        actorStaffProfileId: ids.admin,
      })
    );
    expect(
      await tenant((tx) => deps.jobRoles.staffHasCapability(tx, ids.jo, ids.branchA, REFUND))
    ).toBe(true);
    expect(
      await tenant((tx) => deps.jobRoles.staffHasCapability(tx, ids.jo, ids.branchB, REFUND))
    ).toBe(false);
  });

  it('lets DENY beat a DIRECT allow — and refuses to store both at once', async () => {
    // Jo's discount override flips ALLOW → DENY. It is ONE row, so there is never
    // a moment where both effects exist and a tiebreak would be needed.
    const flipped = await tenant((tx) =>
      deps.jobRoles.setStaffCapabilityOverride(tx, {
        staffProfileId: ids.jo,
        branchId: ids.branchB,
        capability: DISCOUNT,
        effect: 'DENY',
        actorStaffProfileId: ids.admin,
      })
    );
    expect(flipped.changed).toBe(true);

    const rows = await tenant((tx) =>
      tx.restaurantStaffCapabilityGrant.findMany({
        where: { staffProfileId: ids.jo, branchId: ids.branchB, capability: DISCOUNT },
        select: { effect: true },
      })
    );
    expect(rows).toEqual([{ effect: 'DENY' }]);

    const decision = await tenant((tx) =>
      deps.jobRoles.resolveStaffCapabilityDecision(tx, ids.jo, ids.branchB)
    );
    expect(decision.allowed.has(DISCOUNT)).toBe(false);
    expect(decision.denied.has(DISCOUNT)).toBe(true);
    // shift-supervisor DOES inherit orders:discount, so this also proves the deny
    // outranks the role union, not merely the vanished direct grant.
    expect(decision.inherited.has(DISCOUNT)).toBe(true);
    expect(decision.effective.has(DISCOUNT)).toBe(false);

    // The DB, not the resolver, is what makes the ambiguity unrepresentable.
    await expect(
      tenant((tx) =>
        tx.restaurantStaffCapabilityGrant.create({
          data: {
            staffProfileId: ids.jo,
            branchId: ids.branchB,
            capability: DISCOUNT,
            effect: 'ALLOW',
          },
        })
      )
    ).rejects.toThrow();
  });

  it('re-asserting the same effect changes nothing and writes no second audit entry', async () => {
    const before = await tenant((tx) =>
      deps.jobRoles.listStaffCapabilityAudit(tx, ids.jo, { branchId: ids.branchB, take: 500 })
    );
    const again = await tenant((tx) =>
      deps.jobRoles.setStaffCapabilityOverride(tx, {
        staffProfileId: ids.jo,
        branchId: ids.branchB,
        capability: REFUND,
        effect: 'DENY',
        actorStaffProfileId: ids.admin,
      })
    );
    expect(again.changed).toBe(false);
    const after = await tenant((tx) =>
      deps.jobRoles.listStaffCapabilityAudit(tx, ids.jo, { branchId: ids.branchB, take: 500 })
    );
    expect(after.length).toBe(before.length);
  });

  it('clears an override so the person falls back to what their roles grant', async () => {
    const cleared = await tenant((tx) =>
      deps.jobRoles.clearStaffCapabilityOverride(tx, {
        staffProfileId: ids.jo,
        branchId: ids.branchB,
        capability: REFUND,
        actorStaffProfileId: ids.admin,
      })
    );
    expect(cleared.changed).toBe(true);
    expect(
      await tenant((tx) => deps.jobRoles.staffHasCapability(tx, ids.jo, ids.branchB, REFUND))
    ).toBe(true);

    // Idempotent: clearing what is not there is a no-op, not an error.
    const twice = await tenant((tx) =>
      deps.jobRoles.clearStaffCapabilityOverride(tx, {
        staffProfileId: ids.jo,
        branchId: ids.branchB,
        capability: REFUND,
        actorStaffProfileId: ids.admin,
      })
    );
    expect(twice.changed).toBe(false);
  });

  it('audits every override change, and the CLEARED record outlives the row it removed', async () => {
    const trail = await tenant((tx) =>
      deps.jobRoles.listStaffCapabilityAudit(tx, ids.jo, { branchId: ids.branchB, take: 500 })
    );
    const count = (capability: string, change: string) =>
      trail.filter((entry) => entry.capability === capability && entry.change === change).length;

    expect(count(DISCOUNT, 'ALLOWED')).toBe(1);
    expect(count(DISCOUNT, 'DENIED')).toBe(1);
    expect(count(REFUND, 'DENIED')).toBe(1);
    expect(count(REFUND, 'CLEARED')).toBe(1);
    expect(trail.every((entry) => entry.actorStaffProfileId === ids.admin)).toBe(true);

    // The refund override is gone; the trail still explains that it existed.
    const live = await tenant((tx) =>
      deps.jobRoles.listStaffCapabilityOverrides(tx, ids.jo, { branchId: ids.branchB })
    );
    expect(live.map((row) => row.capability)).toEqual([DISCOUNT]);
    expect(live[0]!.effect).toBe('DENY');
  });

  it('DB-enforces the override audit trail as append-only under forced RLS', async () => {
    const entry = await tenant((tx) =>
      tx.restaurantStaffCapabilityAudit.findFirst({ where: { staffProfileId: ids.jo } })
    );
    expect(entry).not.toBeNull();

    await expect(
      tenant((tx) =>
        tx.restaurantStaffCapabilityAudit.update({
          where: { id: entry!.id },
          data: { change: 'ALLOWED' },
        })
      )
    ).rejects.toThrow();

    await expect(
      tenant((tx) => tx.restaurantStaffCapabilityAudit.delete({ where: { id: entry!.id } }))
    ).rejects.toThrow();

    const still = await tenant((tx) =>
      tx.restaurantStaffCapabilityAudit.findUnique({ where: { id: entry!.id } })
    );
    expect(still).not.toBeNull();
  });

  it('isolates overrides and their audit across tenants under forced RLS', async () => {
    const [overrides, audits] = await deps.withTenantDb(otherOrgId, async (tx) => [
      await tx.restaurantStaffCapabilityGrant.findMany({ select: { id: true } }),
      await tx.restaurantStaffCapabilityAudit.findMany({ select: { id: true } }),
    ]);
    expect(overrides).toEqual([]);
    expect(audits).toEqual([]);

    // And the other tenant cannot deny OUR staff anything: the row would carry
    // ITS organizationId, which the composite tenant FK proves at COMMIT.
    await expect(
      deps.withTenantDb(otherOrgId, (tx) =>
        tx.restaurantStaffCapabilityAudit.create({
          data: {
            staffProfileId: ids.jo,
            branchId: ids.branchB,
            capability: REFUND,
            change: 'DENIED',
          },
        })
      )
    ).rejects.toThrow();

    // Our own resolution is unchanged by that attempt.
    expect(
      await tenant((tx) => deps.jobRoles.staffHasCapability(tx, ids.jo, ids.branchB, REFUND))
    ).toBe(true);
  });
});

describeIfDatabase('SOP-1 assignment pools — eligibility and claiming', () => {
  const templateIds: Record<string, string> = {};

  beforeAll(async () => {
    if (!TEST_DATABASE_URL || !OWNER_DATABASE_URL) return;
    // Jo is a barista at branch A too, so a pool has two eligible claimers.
    await tenant((tx) =>
      deps.jobRoles.grantJobRole(tx, {
        staffProfileId: ids.jo,
        jobRoleId: roleIds.barista!,
        branchId: ids.branchA,
        actorStaffProfileId: ids.admin,
      })
    );
    await tenant(async (tx) => {
      const installed = await deps.packs.installAllSopPacks(tx, { now: new Date() });
      for (const result of installed) templateIds[result.packKey] = result.templateId;
    });
  });

  it('installs all nine packs, published and idempotently', async () => {
    expect(deps.packs.SOP_TEMPLATE_PACKS).toHaveLength(9);
    expect(Object.keys(templateIds)).toHaveLength(9);

    const again = await tenant((tx) => deps.packs.installAllSopPacks(tx));
    expect(again.every((result) => !result.created)).toBe(true);

    const published = await tenant((tx) =>
      tx.restaurantSopTemplateVersion.count({ where: { status: 'PUBLISHED' } })
    );
    expect(published).toBe(9);
  });

  it('rejects an assignee target that is internally inconsistent (DB CHECK)', async () => {
    await expect(
      tenant((tx) =>
        tx.restaurantSopAssignment.create({
          data: {
            branchId: ids.branchA,
            templateId: templateIds['front-of-house-opening']!,
            startDate: new Date('2026-09-01T00:00:00.000Z'),
            assigneeTargetType: 'ROLE',
            // A ROLE target with no role id — exactly what the CHECK forbids.
            assigneeJobRoleId: null,
          },
        })
      )
    ).rejects.toThrow();
  });

  it('generates a DIRECT occurrence for a PERSON target', async () => {
    const assignment = await tenant((tx) =>
      deps.sopTemplates.createAssignment(tx, {
        branchId: ids.branchA,
        templateId: templateIds['front-of-house-closing']!,
        frequency: 'ONCE',
        interval: 1,
        daysOfWeek: [],
        monthDay: null,
        startDate: '2026-09-01',
        endDate: '2026-09-01',
        dueTimeMinutes: 600,
        windowMinutes: 120,
        graceMinutes: 15,
        assigneeTarget: { type: 'person', staffProfileId: ids.jo },
      })
    );

    await tenant((tx) =>
      deps.generation.generateDueSopOccurrences(tx, {
        now: new Date('2026-09-01T12:00:00.000Z'),
        lookbackDays: 0,
        horizonDays: 0,
      })
    );

    const occurrence = await tenant((tx) =>
      tx.restaurantSopOccurrence.findFirst({ where: { assignmentId: assignment.id } })
    );
    expect(occurrence?.assignedStaffProfileId).toBe(ids.jo);
    expect(occurrence?.poolJobRoleId).toBeNull();
    expect(occurrence?.claimedByStaffProfileId).toBeNull();
  });

  it('generates an UNCLAIMED POOL occurrence for a ROLE target, idempotently', async () => {
    const assignment = await tenant((tx) =>
      deps.sopTemplates.createAssignment(tx, {
        branchId: ids.branchA,
        templateId: templateIds['kitchen-opening-line-check']!,
        frequency: 'ONCE',
        interval: 1,
        daysOfWeek: [],
        monthDay: null,
        startDate: '2026-09-02',
        endDate: '2026-09-02',
        dueTimeMinutes: 480,
        windowMinutes: 120,
        graceMinutes: 15,
        assigneeTarget: { type: 'role', jobRoleId: roleIds.barista! },
      })
    );

    const opts = {
      now: new Date('2026-09-02T12:00:00.000Z'),
      lookbackDays: 0,
      horizonDays: 0,
    };
    const first = await tenant((tx) => deps.generation.generateDueSopOccurrences(tx, opts));
    const second = await tenant((tx) => deps.generation.generateDueSopOccurrences(tx, opts));
    expect(first.created).toBeGreaterThanOrEqual(1);
    // Re-running the same window creates nothing new — the idempotency guarantee.
    expect(second.created).toBe(0);

    const occurrences = await tenant((tx) =>
      tx.restaurantSopOccurrence.findMany({ where: { assignmentId: assignment.id } })
    );
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.poolJobRoleId).toBe(roleIds.barista);
    expect(occurrences[0]!.assignedStaffProfileId).toBeNull();
    expect(occurrences[0]!.claimedByStaffProfileId).toBeNull();
  });

  it('lets exactly ONE of two concurrent claimers win, and is idempotent on retry', async () => {
    const occurrence = await tenant((tx) =>
      tx.restaurantSopOccurrence.findFirst({
        where: { poolJobRoleId: roleIds.barista!, claimedByStaffProfileId: null },
      })
    );
    expect(occurrence).not.toBeNull();

    // Sam and Jo both hold barista at branch A and both go for it at once.
    const [samResult, joResult] = await Promise.all([
      tenant((tx) => deps.sopAssignment.claimSopOccurrence(tx, occurrence!.id, ids.sam)),
      tenant((tx) => deps.sopAssignment.claimSopOccurrence(tx, occurrence!.id, ids.jo)),
    ]);

    const outcomes = [samResult.status, joResult.status].sort();
    expect(outcomes).toEqual(['CLAIMED', 'CLAIMED_BY_OTHER']);

    const winner = samResult.status === 'CLAIMED' ? ids.sam : ids.jo;
    const loser = winner === ids.sam ? ids.jo : ids.sam;

    const settled = await tenant((tx) =>
      tx.restaurantSopOccurrence.findUnique({ where: { id: occurrence!.id } })
    );
    expect(settled?.claimedByStaffProfileId).toBe(winner);
    expect(settled?.claimedAt).not.toBeNull();

    // The winner retrying is success, not a conflict.
    const retry = await tenant((tx) =>
      deps.sopAssignment.claimSopOccurrence(tx, occurrence!.id, winner)
    );
    expect(retry.status).toBe('ALREADY_CLAIMED_BY_CALLER');

    // The loser is told plainly, and the claim does not move.
    const loserRetry = await tenant((tx) =>
      deps.sopAssignment.claimSopOccurrence(tx, occurrence!.id, loser)
    );
    expect(loserRetry.status).toBe('CLAIMED_BY_OTHER');
    const unchanged = await tenant((tx) =>
      tx.restaurantSopOccurrence.findUnique({ where: { id: occurrence!.id } })
    );
    expect(unchanged?.claimedByStaffProfileId).toBe(winner);
  });

  it('refuses a claim from someone who does not hold the pooled role', async () => {
    const assignment = await tenant((tx) =>
      deps.sopTemplates.createAssignment(tx, {
        branchId: ids.branchA,
        templateId: templateIds['equipment-maintenance']!,
        frequency: 'ONCE',
        interval: 1,
        daysOfWeek: [],
        monthDay: null,
        startDate: '2026-09-03',
        endDate: '2026-09-03',
        dueTimeMinutes: 600,
        windowMinutes: 120,
        graceMinutes: 15,
        // Nobody holds `manager` at branch A any more — it was revoked earlier.
        assigneeTarget: { type: 'role', jobRoleId: roleIds.manager! },
      })
    );
    await tenant((tx) =>
      deps.generation.generateDueSopOccurrences(tx, {
        now: new Date('2026-09-03T12:00:00.000Z'),
        lookbackDays: 0,
        horizonDays: 0,
      })
    );
    const occurrence = await tenant((tx) =>
      tx.restaurantSopOccurrence.findFirst({ where: { assignmentId: assignment.id } })
    );
    const outcome = await tenant((tx) =>
      deps.sopAssignment.claimSopOccurrence(tx, occurrence!.id, ids.sam)
    );
    expect(outcome).toEqual({ status: 'NOT_CLAIMABLE', reason: 'NOT_ELIGIBLE' });
  });

  it('UNIONS both assignment modes and de-duplicates — the same SOP arriving by both paths', async () => {
    // The owner's exact case: one template assigned to the `kitchen` ROLE and,
    // separately, DIRECTLY to Sam — who also holds `kitchen`. Sam must see the
    // work from both paths, with neither path's occurrence lost or doubled.
    const templateId = templateIds['health-and-hygiene']!;
    await tenant((tx) =>
      deps.sopTemplates.createAssignment(tx, {
        branchId: ids.branchA,
        templateId,
        frequency: 'ONCE',
        interval: 1,
        daysOfWeek: [],
        monthDay: null,
        startDate: '2026-09-04',
        endDate: '2026-09-04',
        dueTimeMinutes: 450,
        windowMinutes: 120,
        graceMinutes: 15,
        assigneeTarget: { type: 'role', jobRoleId: roleIds.kitchen! },
      })
    );
    await tenant((tx) =>
      deps.sopTemplates.createAssignment(tx, {
        branchId: ids.branchA,
        templateId,
        frequency: 'ONCE',
        interval: 1,
        daysOfWeek: [],
        monthDay: null,
        startDate: '2026-09-04',
        endDate: '2026-09-04',
        dueTimeMinutes: 450,
        windowMinutes: 120,
        graceMinutes: 15,
        assigneeTarget: { type: 'person', staffProfileId: ids.sam },
      })
    );

    await tenant((tx) =>
      deps.generation.generateDueSopOccurrences(tx, {
        now: new Date('2026-09-04T12:00:00.000Z'),
        lookbackDays: 0,
        horizonDays: 0,
      })
    );

    const businessDate = new Date('2026-09-04T00:00:00.000Z');
    const resolved = await tenant((tx) =>
      deps.sopAssignment.listStaffSopOccurrences(tx, ids.sam, {
        branchId: ids.branchA,
        businessDateFrom: businessDate,
        businessDateTo: businessDate,
      })
    );

    // Two assignments → two occurrences, each reaching Sam by exactly one path.
    expect(resolved).toHaveLength(2);
    expect(
      resolved
        .map((row) => row.paths)
        .flat()
        .sort()
    ).toEqual(['DIRECT', 'ROLE_POOL']);
    // De-duplication is real: every occurrence id appears once.
    expect(new Set(resolved.map((row) => row.occurrenceId)).size).toBe(2);

    // Jo holds barista but not kitchen, so only the pool item is invisible to her
    // and the direct one is Sam's alone — Jo sees neither.
    const joSees = await tenant((tx) =>
      deps.sopAssignment.listStaffSopOccurrences(tx, ids.jo, {
        branchId: ids.branchA,
        businessDateFrom: businessDate,
        businessDateTo: businessDate,
      })
    );
    expect(joSees).toEqual([]);
  });

  it('records BOTH paths on ONE occurrence when a single occurrence is reachable twice', async () => {
    // A pool occurrence Sam has claimed is reachable as CLAIMED; if he were also
    // its direct assignee it would carry both. Construct that directly to prove the
    // union collapses to one row with two paths rather than two rows.
    const templateId = templateIds['goods-receiving']!;
    const assignment = await tenant((tx) =>
      deps.sopTemplates.createAssignment(tx, {
        branchId: ids.branchA,
        templateId,
        frequency: 'ONCE',
        interval: 1,
        daysOfWeek: [],
        monthDay: null,
        startDate: '2026-09-05',
        endDate: '2026-09-05',
        dueTimeMinutes: 480,
        windowMinutes: 120,
        graceMinutes: 15,
        assigneeTarget: { type: 'role', jobRoleId: roleIds.kitchen! },
      })
    );
    await tenant((tx) =>
      deps.generation.generateDueSopOccurrences(tx, {
        now: new Date('2026-09-05T12:00:00.000Z'),
        lookbackDays: 0,
        horizonDays: 0,
      })
    );
    const occurrence = await tenant((tx) =>
      tx.restaurantSopOccurrence.findFirst({ where: { assignmentId: assignment.id } })
    );
    const claim = await tenant((tx) =>
      deps.sopAssignment.claimSopOccurrence(tx, occurrence!.id, ids.sam)
    );
    expect(claim.status).toBe('CLAIMED');

    const businessDate = new Date('2026-09-05T00:00:00.000Z');
    const resolved = await tenant((tx) =>
      deps.sopAssignment.listStaffSopOccurrences(tx, ids.sam, {
        branchId: ids.branchA,
        businessDateFrom: businessDate,
        businessDateTo: businessDate,
      })
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.paths).toEqual(['CLAIMED']);
    expect(resolved[0]!.claimedByStaffProfileId).toBe(ids.sam);

    // And it has left the claimable pool for everyone.
    const pool = await tenant((tx) =>
      deps.sopAssignment.listClaimablePoolOccurrences(tx, ids.jo, { branchId: ids.branchA })
    );
    expect(pool.some((row) => row.id === occurrence!.id)).toBe(false);
  });

  it('falls back to ALL branch holders when shift data is absent, and honours an empty on-duty set', async () => {
    const all = await tenant((tx) =>
      deps.jobRoles.listRoleHoldersAtBranch(tx, roleIds.barista!, ids.branchA)
    );
    expect(all.map((holder) => holder.staffProfileId).sort()).toEqual([ids.jo, ids.sam].sort());

    // Explicit null is "no shift data" → same fallback.
    const nullOnDuty = await tenant((tx) =>
      deps.jobRoles.listRoleHoldersAtBranch(tx, roleIds.barista!, ids.branchA, {
        onDutyStaffProfileIds: null,
      })
    );
    expect(nullOnDuty).toHaveLength(2);

    // An empty ARRAY is a real answer: nobody is on duty.
    const noneOnDuty = await tenant((tx) =>
      deps.jobRoles.listRoleHoldersAtBranch(tx, roleIds.barista!, ids.branchA, {
        onDutyStaffProfileIds: [],
      })
    );
    expect(noneOnDuty).toEqual([]);

    const onlyJo = await tenant((tx) =>
      deps.jobRoles.listRoleHoldersAtBranch(tx, roleIds.barista!, ids.branchA, {
        onDutyStaffProfileIds: [ids.jo],
      })
    );
    expect(onlyJo.map((holder) => holder.staffProfileId)).toEqual([ids.jo]);
  });

  it('keeps pools branch-isolated', async () => {
    const atBranchB = await tenant((tx) =>
      deps.sopAssignment.listClaimablePoolOccurrences(tx, ids.sam, { branchId: ids.branchB })
    );
    expect(atBranchB).toEqual([]);
  });
});
