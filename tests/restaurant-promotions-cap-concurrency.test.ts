/**
 * WHA-288 — the BINDING promotion cap concurrency battery.
 *
 * Requires TEST_DATABASE_URL (a migrated, disposable, local database). Skipped
 * when unavailable.
 *
 * The claim being proved: a redemption cap of N cannot be exceeded when W > N
 * checks race for it. Each writer runs in its OWN tenant-scoped transaction on
 * its own pooled connection, so these are genuinely concurrent INSERTs against
 * one cap key — not serialized calls dressed up as parallel ones.
 *
 * After the dust settles the assertions are exact, not approximate: EXACTLY N
 * redemptions exist, their ordinals are EXACTLY 1..N with no gap and no
 * duplicate, EXACTLY N writers were told they succeeded, and every writer that
 * failed failed with the cap error — never with a lost or double-counted claim.
 * A rolled-back writer must also leave no application row behind.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  claimCapSlots: (typeof import('@/lib/restaurant/promotion-caps'))['claimCapSlots'];
  claimCapSlotsWithRetry: (typeof import('@/lib/restaurant/promotion-caps'))['claimCapSlotsWithRetry'];
  planCapClaims: (typeof import('@/lib/restaurant/promotion-caps'))['planCapClaims'];
  PromotionCapExhaustedError: (typeof import('@/lib/restaurant/promotion-caps'))['PromotionCapExhaustedError'];
};

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha288_${suffix}`;
const ids = {
  branch: `branch_${suffix}`,
  staff: `staff_${suffix}`,
  device: `device_${suffix}`,
  product: `product_${suffix}`,
  promotion: `promotion_${suffix}`,
  version: `version_${suffix}`,
};

let deps: Deps;

/** W concurrent checks racing for a TOTAL cap of N. */
const WRITERS = 12;
const CAP = 5;

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, caps] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/promotion-caps'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    claimCapSlots: caps.claimCapSlots,
    claimCapSlotsWithRetry: caps.claimCapSlotsWithRetry,
    planCapClaims: caps.planCapClaims,
    PromotionCapExhaustedError: caps.PromotionCapExhaustedError,
  };

  await deps.withPlatformDb(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, $1, $1, 'ACTIVE', 'SHARED', now(), now())`,
      orgId
    );
  });

  await deps.withTenantDb(orgId, async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO "restaurant_branches" ("id","organizationId","name","updatedAt") VALUES ($1,$2,'Main',now())`,
      ids.branch,
      orgId
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "restaurant_staff_profiles" ("id","organizationId","displayName","primaryBranchId","updatedAt")
       VALUES ($1,$2,'Operator',$3,now())`,
      ids.staff,
      orgId,
      ids.branch
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "restaurant_registered_devices" ("id","organizationId","branchId","name","deviceSecretHash","updatedAt")
       VALUES ($1,$2,$3,'POS',$1,now())`,
      ids.device,
      orgId,
      ids.branch
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "restaurant_products" ("id","organizationId","name","updatedAt") VALUES ($1,$2,'Item',now())`,
      ids.product,
      orgId
    );
    // One order per writer — W separate checks, one shared TOTAL cap.
    for (let index = 0; index <= WRITERS; index += 1) {
      await tx.$executeRawUnsafe(
        `INSERT INTO "restaurant_orders"
           ("id","organizationId","branchId","orderNumber","businessDate","channel","staffProfileId","deviceId","updatedAt")
         VALUES ($1,$2,$3,$4,DATE '2030-01-01','DINE_IN',$5,$6,now())`,
        `order_${index}_${suffix}`,
        orgId,
        ids.branch,
        index + 1,
        ids.staff,
        ids.device
      );
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO "restaurant_promotions" ("id","organizationId","name","updatedAt") VALUES ($1,$2,'Cap fixture',now())`,
      ids.promotion,
      orgId
    );
    // The real authoring flow: a version is built while DRAFT, its caps are
    // attached, and only then is it activated. Attaching a cap to an ACTIVE
    // version is rejected by the child-freeze trigger — the rule is immutable
    // once it is in force.
    await tx.$executeRawUnsafe(
      `INSERT INTO "restaurant_promotion_versions"
         ("id","organizationId","promotionId","versionNumber","ruleCode",status,"effectiveFrom",
          "targetScope","benefitKind","benefitRate","updatedAt")
       VALUES ($1,$2,$3,1,'CAP_FIXTURE','DRAFT',TIMESTAMP '2020-01-01','ORDER','PERCENTAGE_OFF',0.1,now())`,
      ids.version,
      orgId,
      ids.promotion
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "restaurant_promotion_caps" ("id","organizationId","promotionVersionId",scope,"maxRedemptions")
       VALUES ($1,$2,$3,'TOTAL',$4)`,
      `cap_${suffix}`,
      orgId,
      ids.version,
      CAP
    );
    await tx.$executeRawUnsafe(
      `UPDATE "restaurant_promotion_versions" SET status='ACTIVE', "activatedAt"=now() WHERE "id"=$1`,
      ids.version
    );
  });
}, 120_000);

/** One writer: open a check's own transaction, write the application snapshot,
 * then claim the cap slot. A full cap or a lost ordinal race rolls the whole
 * transaction back, application row included. */
async function applyPromotionOnce(index: number): Promise<'CLAIMED' | 'EXHAUSTED'> {
  const applicationId = `application_${index}_${suffix}`;
  const claims = deps.planCapClaims(ids.version, [{ scope: 'TOTAL', maxRedemptions: CAP }], {
    orderId: `order_${index}_${suffix}`,
    customerId: null,
  });
  try {
    await deps.claimCapSlotsWithRetry(ids.version, () =>
      deps.withTenantDb(orgId, async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "restaurant_promotion_applications"
             ("id","organizationId","promotionId","promotionVersionId","versionNumber","ruleCode",
              "targetScope","benefitKind","benefitRate",authority,"orderId","branchId","businessDate",
              sequence,"discountAmount")
           VALUES ($1,$2,$3,$4,1,'CAP_FIXTURE','ORDER','PERCENTAGE_OFF',0.1,'AUTOMATIC',$5,$6,DATE '2030-01-01',1,10.00)`,
          applicationId,
          orgId,
          ids.promotion,
          ids.version,
          `order_${index}_${suffix}`,
          ids.branch
        );
        return deps.claimCapSlots(tx, {
          organizationId: orgId,
          promotionVersionId: ids.version,
          applicationId,
          claims,
          newId: (claim) => `redemption_${index}_${claim.scope}_${suffix}`,
        });
      })
    );
    return 'CLAIMED';
  } catch (error) {
    if (error instanceof deps.PromotionCapExhaustedError) return 'EXHAUSTED';
    throw error;
  }
}

describeIfDatabase('promotion redemption caps under real concurrency', () => {
  it(`admits exactly ${CAP} of ${WRITERS} concurrent claims, with contiguous ordinals`, async () => {
    const outcomes = await Promise.all(
      Array.from({ length: WRITERS }, (_, index) => applyPromotionOnce(index))
    );

    expect(outcomes.filter((outcome) => outcome === 'CLAIMED')).toHaveLength(CAP);
    expect(outcomes.filter((outcome) => outcome === 'EXHAUSTED')).toHaveLength(WRITERS - CAP);

    const rows = await deps.withTenantDb(orgId, (tx) =>
      tx.$queryRawUnsafe<{ ordinal: number; applicationId: string }[]>(
        `SELECT "ordinal", "applicationId" FROM "restaurant_promotion_redemptions"
          WHERE "promotionVersionId" = $1 AND "capScope" = 'TOTAL' ORDER BY "ordinal"`,
        ids.version
      )
    );

    // Exactly the cap, no more and no fewer.
    expect(rows).toHaveLength(CAP);
    // Contiguous 1..CAP — no gap (a lost claim) and no duplicate (an over-claim).
    expect(rows.map((row) => Number(row.ordinal))).toEqual(
      Array.from({ length: CAP }, (_, index) => index + 1)
    );
    expect(new Set(rows.map((row) => row.applicationId)).size).toBe(CAP);

    // Every rolled-back writer left nothing behind: applications and redemptions
    // agree exactly.
    const applications = await deps.withTenantDb(orgId, (tx) =>
      tx.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) AS count FROM "restaurant_promotion_applications" WHERE "promotionVersionId" = $1`,
        ids.version
      )
    );
    expect(Number(applications[0]!.count)).toBe(CAP);
  }, 120_000);

  it('refuses a further claim once the cap is full, and the ledger does not move', async () => {
    const before = await deps.withTenantDb(orgId, (tx) =>
      tx.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) AS count FROM "restaurant_promotion_redemptions" WHERE "promotionVersionId" = $1`,
        ids.version
      )
    );
    expect(await applyPromotionOnce(WRITERS)).toBe('EXHAUSTED');
    const after = await deps.withTenantDb(orgId, (tx) =>
      tx.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) AS count FROM "restaurant_promotion_redemptions" WHERE "promotionVersionId" = $1`,
        ids.version
      )
    );
    expect(Number(after[0]!.count)).toBe(Number(before[0]!.count));
  }, 60_000);

  it('counts PER_ORDER caps per check, so separate checks do not consume each other', async () => {
    const perOrderVersion = `version_perorder_${suffix}`;
    await deps.withTenantDb(orgId, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "restaurant_promotion_versions"
           ("id","organizationId","promotionId","versionNumber","ruleCode",status,"effectiveFrom",
            "targetScope","benefitKind","benefitRate","updatedAt")
         VALUES ($1,$2,$3,2,'PER_ORDER_FIXTURE','DRAFT',TIMESTAMP '2020-01-01','ORDER','PERCENTAGE_OFF',0.1,now())`,
        perOrderVersion,
        orgId,
        ids.promotion
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "restaurant_promotion_caps" ("id","organizationId","promotionVersionId",scope,"maxRedemptions")
         VALUES ($1,$2,$3,'PER_ORDER',1)`,
        `cap_perorder_${suffix}`,
        orgId,
        perOrderVersion
      );
      await tx.$executeRawUnsafe(
        `UPDATE "restaurant_promotion_versions" SET status='ACTIVE', "activatedAt"=now() WHERE "id"=$1`,
        perOrderVersion
      );
    });

    const claimOn = async (orderIndex: number, sequence: number) => {
      const applicationId = `app_po_${orderIndex}_${sequence}_${suffix}`;
      return deps.withTenantDb(orgId, async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "restaurant_promotion_applications"
             ("id","organizationId","promotionId","promotionVersionId","versionNumber","ruleCode",
              "targetScope","benefitKind","benefitRate",authority,"orderId","branchId","businessDate",
              sequence,"discountAmount")
           VALUES ($1,$2,$3,$4,2,'PER_ORDER_FIXTURE','ORDER','PERCENTAGE_OFF',0.1,'AUTOMATIC',$5,$6,DATE '2030-01-01',$7,5.00)`,
          applicationId,
          orgId,
          ids.promotion,
          perOrderVersion,
          `order_${orderIndex}_${suffix}`,
          ids.branch,
          sequence
        );
        return deps.claimCapSlots(tx, {
          organizationId: orgId,
          promotionVersionId: perOrderVersion,
          applicationId,
          claims: deps.planCapClaims(perOrderVersion, [{ scope: 'PER_ORDER', maxRedemptions: 1 }], {
            orderId: `order_${orderIndex}_${suffix}`,
            customerId: null,
          }),
          newId: () => `redemption_po_${orderIndex}_${sequence}_${suffix}`,
        });
      });
    };

    // Two different checks each get their own slot 1 — the keys are disjoint.
    await expect(claimOn(0, 10)).resolves.toMatchObject([{ scope: 'PER_ORDER', ordinal: 1 }]);
    await expect(claimOn(1, 10)).resolves.toMatchObject([{ scope: 'PER_ORDER', ordinal: 1 }]);
    // A second claim on the SAME check is refused.
    await expect(claimOn(0, 11)).rejects.toBeInstanceOf(deps.PromotionCapExhaustedError);
  }, 60_000);
});
