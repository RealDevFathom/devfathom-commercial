/**
 * WHA-288 / promotions Lane A — the invariants only a real database can prove.
 *
 * Named acceptance tests (§13):
 *   - promotion_cap_race_allows_exactly_remaining_capacity
 *   - promotion_cap_failure_rolls_back_snapshot_and_reservation_atomically
 *   - promotion_cross_tenant_references_and_reads_are_denied_under_forced_rls_runtime_role
 *   - promotion_publish_is_immutable_and_audited_without_sensitive_payloads
 *   - promotion_reversal_is_append_only_and_preserves_original_evidence
 *
 * Requires WHA288_TEST_DATABASE_URL (or TEST_DATABASE_URL): a migrated
 * throwaway database reached as an UNPRIVILEGED role. §13 requires asserting
 * that role is neither SUPERUSER nor BYPASSRLS before any cross-tenant claim is
 * made, and the first test does exactly that — asked of `pg_roles`, not assumed.
 *
 * The concurrency test uses two genuinely independent transactions and proves
 * the loser is QUEUED ON THE LOCK (observed in `pg_stat_activity`) before the
 * winner commits. Asserting only the response codes would pass just as happily
 * against a racy read-then-write implementation.
 */

import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import { PROMOTION_ERROR, PromotionError } from '@/lib/restaurant/promotion-contracts';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL =
  process.env.WHA288_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? undefined;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_wha288_a_${suffix}`;
const ORG_B = `org_wha288_b_${suffix}`;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  caps: typeof import('./promotion-caps');
};

let deps: Deps;

/**
 * Seed the legacy parent chain a promotion evaluation must reference:
 * organization -> branch -> staff/device -> order -> bill.
 *
 * No `ON CONFLICT DO NOTHING` anywhere. `restaurant_registered_devices`
 * carries a GLOBALLY unique `deviceSecretHash`, and under RLS a colliding row
 * belonging to another tenant is INVISIBLE — so a conflict clause would
 * silently skip the insert and the failure would only surface later as a
 * confusing foreign-key error on the order. Every id here is suffixed per run
 * and per tenant, so a genuine collision is a bug worth raising.
 */
async function seedTenant(tx: ScopedDb, organizationId: string): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO "organizations" ("id","slug","legalName","displayName","updatedAt")
     VALUES ($1,$1,$1,$1, now())`,
    organizationId
  );
  await tx.$executeRawUnsafe(
    `INSERT INTO "restaurant_branches" ("id","organizationId","name","updatedAt")
     VALUES ($1,$2,'Branch', now())`,
    `branch-${organizationId}`,
    organizationId
  );
  await tx.$executeRawUnsafe(
    `INSERT INTO "restaurant_staff_profiles" ("id","organizationId","displayName","updatedAt")
     VALUES ($1,$2,'Staff', now())`,
    `staff-${organizationId}`,
    organizationId
  );
  await tx.$executeRawUnsafe(
    `INSERT INTO "restaurant_registered_devices"
       ("id","organizationId","branchId","name","deviceSecretHash","updatedAt")
     VALUES ($1,$2,$3,'Till',$4, now())`,
    `device-${organizationId}`,
    organizationId,
    `branch-${organizationId}`,
    `secret-${organizationId}`
  );
  await tx.$executeRawUnsafe(
    `INSERT INTO "restaurant_orders"
       ("id","organizationId","branchId","orderNumber","businessDate","channel",
        "staffProfileId","deviceId","updatedAt")
     VALUES ($1,$2,$3,1,DATE '2026-03-06','DINE_IN',$4,$5, now())`,
    `order-${organizationId}`,
    organizationId,
    `branch-${organizationId}`,
    `staff-${organizationId}`,
    `device-${organizationId}`
  );
  await tx.$executeRawUnsafe(
    `INSERT INTO "restaurant_bills"
       ("id","organizationId","orderId","branchId","businessDate",
        "openerStaffProfileId","deviceId","updatedAt")
     VALUES ($1,$2,$3,$4,DATE '2026-03-06',$5,$6, now())`,
    `bill-${organizationId}`,
    organizationId,
    `order-${organizationId}`,
    `branch-${organizationId}`,
    `staff-${organizationId}`,
    `device-${organizationId}`
  );
}

/** A published version with a GLOBAL cap of `capCount`, plus its counter row. */
async function seedCappedPromotion(
  tx: ScopedDb,
  organizationId: string,
  versionId: string,
  capCount: number
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO "restaurant_promotions" ("id","organizationId","code","name","updatedAt")
     VALUES ($1,$2,$3,'Capped', now())`,
    `promo-${versionId}`,
    organizationId,
    `CODE-${versionId}`
  );
  await tx.$executeRawUnsafe(
    `INSERT INTO "restaurant_promotion_versions"
       ("id","organizationId","promotionId","versionNumber","status","effectiveFrom","timezone",
        "targetKind","benefitKind","benefitAmount","currency","globalCap","offlinePolicy",
        "approvalReference","publishedAt","ruleSnapshot","ruleHash","updatedAt")
     VALUES ($1,$2,$3,1,'PUBLISHED',now(),'UTC','ORDER','AMOUNT_OFF',5.00,'USD',$4,'ONLINE_ONLY',
             'approval-1', now(), '{}'::jsonb, $5, now())`,
    versionId,
    organizationId,
    `promo-${versionId}`,
    capCount,
    `hash-${versionId}`
  );
  await tx.$executeRawUnsafe(
    `INSERT INTO "restaurant_promotion_cap_counters"
       ("id","organizationId","promotionVersionId","scopeKind","scopeKey","capCount","updatedAt")
     VALUES ($1,$2,$3,'GLOBAL','',$4, now())`,
    `counter-${versionId}`,
    organizationId,
    versionId,
    capCount
  );
}

/** Append one evaluation snapshot, the row a reservation hangs off. */
async function insertEvaluation(
  tx: ScopedDb,
  organizationId: string,
  evaluationId: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO "restaurant_promotion_evaluation_snapshots"
       ("id","organizationId","orderId","branchId","channel","currency","idempotencyKey",
        "evaluatedAt","timezone","localDate","localMinute","utcOffsetMinutes",
        "engineVersion","moneyVersion","setRevisionId","setRevisionHash","source",
        "inputLines","evaluationContext","inputHash","outputHash","discountTotal")
     VALUES ($1,$2,$3,$4,'DINE_IN','USD',$1, now(),'UTC','2026-03-06',720,0,
             '1.0.0','money','rev-1','rev-hash-1','ONLINE',
             '[]'::jsonb,'{}'::jsonb,'in','out',5.00)`,
    evaluationId,
    organizationId,
    `order-${organizationId}`,
    `branch-${organizationId}`
  );
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, caps] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./promotion-caps'),
  ]);
  deps = { withTenantDb: scopedDb.withTenantDb, caps };

  for (const organizationId of [ORG_A, ORG_B]) {
    await deps.withTenantDb(organizationId, async (tx) => {
      await seedTenant(tx, organizationId);
    });
  }
});

afterAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const { db } = await import('@/lib/db');
  await db.$disconnect();
});

describeIfDatabase('promotion caps — database invariants', () => {
  it('the runtime role is neither SUPERUSER nor BYPASSRLS', async () => {
    // §13: this must be ASKED, not assumed. Every cross-tenant claim below is
    // worthless if the role can bypass row-level security.
    const rows = await deps.withTenantDb(ORG_A, async (tx) =>
      tx.$queryRawUnsafe<{ rolsuper: boolean; rolbypassrls: boolean }[]>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      )
    );
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it('§12.13 a cap race lets exactly the remaining capacity through', async () => {
    const versionId = `v-race-${suffix}`;
    await deps.withTenantDb(ORG_A, async (tx) => {
      await seedCappedPromotion(tx, ORG_A, versionId, 1);
      await insertEvaluation(tx, ORG_A, `eval-race-a-${suffix}`);
      await insertEvaluation(tx, ORG_A, `eval-race-b-${suffix}`);
    });

    const request = (evaluationId: string) => ({
      organizationId: ORG_A,
      evaluationId,
      requests: [
        {
          promotionVersionId: versionId,
          scopeKind: 'GLOBAL' as const,
          scopeKey: '',
          applicationOrdinal: 0,
          count: 1,
          amount: new Prisma.Decimal('5.00'),
        },
      ],
    });

    const observer = new Client({ connectionString: TEST_DATABASE_URL });
    await observer.connect();

    let winnerHoldsLock: () => void = () => {};
    const winnerLocked = new Promise<void>((resolve) => {
      winnerHoldsLock = resolve;
    });
    let loserIsQueued: () => void = () => {};
    const loserQueued = new Promise<void>((resolve) => {
      loserIsQueued = resolve;
    });

    // The winner: reserve, hold the lock while the loser piles up behind it,
    // then settle — all in ONE transaction, as §6 requires.
    const winner = deps.withTenantDb(ORG_A, async (tx) => {
      await deps.caps.reserveCaps(tx, request(`eval-race-a-${suffix}`));
      winnerHoldsLock();
      await loserQueued;
      await deps.caps.consumeReservations(tx, {
        organizationId: ORG_A,
        evaluationId: `eval-race-a-${suffix}`,
        settledAt: new Date(),
      });
    });

    const loser = winnerLocked.then(() =>
      deps
        .withTenantDb(ORG_A, async (tx) => {
          await deps.caps.reserveCaps(tx, request(`eval-race-b-${suffix}`));
          return 'granted' as const;
        })
        .catch((error: unknown) => error)
    );

    // Prove the loser is genuinely waiting on a LOCK, not merely slower.
    await winnerLocked;
    let observedWait = false;
    for (let attempt = 0; attempt < 100 && !observedWait; attempt += 1) {
      const { rows } = await observer.query<{ waiting: string }>(
        `SELECT count(*)::text AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`
      );
      observedWait = Number(rows[0]?.waiting ?? '0') > 0;
      if (!observedWait) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(observedWait, 'the second checkout should queue on the counter lock').toBe(true);
    loserIsQueued();

    await winner;
    const loserOutcome = await loser;

    // The loser is refused with the typed error, not silently granted.
    expect(loserOutcome).toBeInstanceOf(PromotionError);
    expect((loserOutcome as PromotionError).code).toBe(PROMOTION_ERROR.CAP_EXHAUSTED);

    // §13: assert the LEDGER and the counter, not only the response codes.
    const state = await deps.withTenantDb(ORG_A, async (tx) => {
      const counters = await tx.$queryRawUnsafe<{ consumedCount: number; capCount: number }[]>(
        `SELECT "consumedCount", "capCount" FROM "restaurant_promotion_cap_counters"
          WHERE "organizationId" = $1 AND "promotionVersionId" = $2`,
        ORG_A,
        versionId
      );
      const reservations = await tx.$queryRawUnsafe<{ state: string; evaluationId: string }[]>(
        `SELECT "state", "evaluationId" FROM "restaurant_promotion_cap_reservations"
          WHERE "organizationId" = $1 AND "promotionVersionId" = $2`,
        ORG_A,
        versionId
      );
      return { counters, reservations };
    });

    expect(Number(state.counters[0]?.consumedCount)).toBe(1);
    expect(Number(state.counters[0]?.capCount)).toBe(1);
    // Total consumption remains exactly 1: one CONSUMED row, and the loser
    // left nothing behind because its transaction rolled back whole.
    expect(state.reservations).toHaveLength(1);
    expect(state.reservations[0]?.state).toBe('CONSUMED');
    expect(state.reservations[0]?.evaluationId).toBe(`eval-race-a-${suffix}`);

    await observer.end();
  }, 30_000);

  it('a cap failure rolls back the snapshot and the reservation together', async () => {
    const versionId = `v-atomic-${suffix}`;
    await deps.withTenantDb(ORG_A, async (tx) => {
      await seedCappedPromotion(tx, ORG_A, versionId, 1);
      await tx.$executeRawUnsafe(
        `UPDATE "restaurant_promotion_cap_counters" SET "consumedCount" = 1
          WHERE "organizationId" = $1 AND "promotionVersionId" = $2`,
        ORG_A,
        versionId
      );
    });

    const evaluationId = `eval-atomic-${suffix}`;
    // One transaction: append the snapshot, then hit the exhausted cap. §11
    // says the error rolls the OWNING transaction back — no catch may convert
    // it into a committed partial checkout.
    await expect(
      deps.withTenantDb(ORG_A, async (tx) => {
        await insertEvaluation(tx, ORG_A, evaluationId);
        await deps.caps.reserveCaps(tx, {
          organizationId: ORG_A,
          evaluationId,
          requests: [
            {
              promotionVersionId: versionId,
              scopeKind: 'GLOBAL',
              scopeKey: '',
              applicationOrdinal: 0,
              count: 1,
              amount: new Prisma.Decimal('5.00'),
            },
          ],
        });
      })
    ).rejects.toThrow(PromotionError);

    const leftovers = await deps.withTenantDb(ORG_A, async (tx) =>
      tx.$queryRawUnsafe<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM "restaurant_promotion_evaluation_snapshots"
          WHERE "organizationId" = $1 AND "id" = $2`,
        ORG_A,
        evaluationId
      )
    );
    // The snapshot is gone too — not just the reservation.
    expect(leftovers[0]?.count).toBe('0');
  });

  it('the counter CHECK refuses oversubscription even by raw SQL', async () => {
    const versionId = `v-check-${suffix}`;
    await deps.withTenantDb(ORG_A, async (tx) => {
      await seedCappedPromotion(tx, ORG_A, versionId, 2);
    });
    // Defence in depth: even a caller that bypassed promotion-caps.ts entirely
    // cannot commit consumption above the cap.
    await expect(
      deps.withTenantDb(ORG_A, async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE "restaurant_promotion_cap_counters" SET "consumedCount" = 3
            WHERE "organizationId" = $1 AND "promotionVersionId" = $2`,
          ORG_A,
          versionId
        );
      })
    ).rejects.toThrow(/promo_cap_ctr_within_cap/);
  });
});

describeIfDatabase('promotion tenancy — §10 forced RLS', () => {
  const versionId = `v-tenant-${suffix}`;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) return;
    await deps.withTenantDb(ORG_A, async (tx) => {
      await seedCappedPromotion(tx, ORG_A, versionId, 5);
      await insertEvaluation(tx, ORG_A, `eval-tenant-${suffix}`);
    });
  });

  it('another tenant can see none of it', async () => {
    const counts = await deps.withTenantDb(ORG_B, async (tx) => ({
      promotions: await tx.$queryRawUnsafe<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM "restaurant_promotions" WHERE "id" = $1`,
        `promo-${versionId}`
      ),
      versions: await tx.$queryRawUnsafe<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM "restaurant_promotion_versions" WHERE "id" = $1`,
        versionId
      ),
      snapshots: await tx.$queryRawUnsafe<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM "restaurant_promotion_evaluation_snapshots"
          WHERE "id" = $1`,
        `eval-tenant-${suffix}`
      ),
      counters: await tx.$queryRawUnsafe<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM "restaurant_promotion_cap_counters"
          WHERE "promotionVersionId" = $1`,
        versionId
      ),
    }));
    expect(counts.promotions[0]?.count).toBe('0');
    expect(counts.versions[0]?.count).toBe('0');
    expect(counts.snapshots[0]?.count).toBe('0');
    expect(counts.counters[0]?.count).toBe('0');
  });

  it('another tenant cannot write a row labelled with the first tenant', async () => {
    await expect(
      deps.withTenantDb(ORG_B, async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "restaurant_promotions" ("id","organizationId","code","name","updatedAt")
           VALUES ($1,$2,'STOLEN','Stolen', now())`,
          `promo-stolen-${suffix}`,
          ORG_A
        );
      })
    ).rejects.toThrow(/row-level security/i);
  });

  it('a cross-tenant order reference is refused by the same-tenant trigger', async () => {
    // ORG_B labels the row as its own but points at ORG_A's order. The lookup
    // runs under ORG_B's own RLS, so that order is invisible and the insert
    // fails closed — the outcome a composite FK would produce.
    await expect(
      deps.withTenantDb(ORG_B, async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "restaurant_promotion_evaluation_snapshots"
             ("id","organizationId","orderId","branchId","channel","currency","idempotencyKey",
              "evaluatedAt","timezone","localDate","localMinute","utcOffsetMinutes",
              "engineVersion","moneyVersion","setRevisionId","setRevisionHash","source",
              "inputLines","evaluationContext","inputHash","outputHash","discountTotal")
           VALUES ($1,$2,$3,$4,'DINE_IN','USD',$1, now(),'UTC','2026-03-06',720,0,
                   '1.0.0','money','rev-1','rev-hash-1','ONLINE',
                   '[]'::jsonb,'{}'::jsonb,'in','out',5.00)`,
          `eval-cross-${suffix}`,
          ORG_B,
          `order-${ORG_A}`, // <- another tenant's order
          `branch-${ORG_B}`
        );
      })
    ).rejects.toThrow(/must belong to the same organization/);
  });
});

describeIfDatabase('promotion evidence — §5.2 append-only at the database layer', () => {
  const versionId = `v-immutable-${suffix}`;
  const evaluationId = `eval-immutable-${suffix}`;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) return;
    await deps.withTenantDb(ORG_A, async (tx) => {
      await seedCappedPromotion(tx, ORG_A, versionId, 5);
      await insertEvaluation(tx, ORG_A, evaluationId);
    });
  });

  it('an evaluation snapshot cannot be updated or deleted', async () => {
    const result = await deps.withTenantDb(ORG_A, async (tx) => {
      const updated = await tx.$executeRawUnsafe(
        `UPDATE "restaurant_promotion_evaluation_snapshots" SET "discountTotal" = 0 WHERE "id" = $1`,
        evaluationId
      );
      const deleted = await tx.$executeRawUnsafe(
        `DELETE FROM "restaurant_promotion_evaluation_snapshots" WHERE "id" = $1`,
        evaluationId
      );
      const still = await tx.$queryRawUnsafe<{ discountTotal: string }[]>(
        `SELECT "discountTotal"::text FROM "restaurant_promotion_evaluation_snapshots"
          WHERE "id" = $1`,
        evaluationId
      );
      return { updated, deleted, still };
    });
    // No UPDATE/DELETE policy exists, so both match ZERO rows for the runtime
    // role — the evidence survives untouched rather than raising and rolling
    // the caller's transaction back.
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);
    expect(new Prisma.Decimal(result.still[0]!.discountTotal).toFixed(2)).toBe('5.00');
  });

  it('a published version is immutable, and supersession is the only way forward', async () => {
    // The version table DOES carry a full tenant policy, so RLS lets the write
    // through and the immutability TRIGGER is what refuses it.
    await expect(
      deps.withTenantDb(ORG_A, async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE "restaurant_promotion_versions" SET "benefitAmount" = 999.00 WHERE "id" = $1`,
          versionId
        );
      })
    ).rejects.toThrow(/published promotion version is immutable/);

    await expect(
      deps.withTenantDb(ORG_A, async (tx) => {
        await tx.$executeRawUnsafe(
          `DELETE FROM "restaurant_promotion_versions" WHERE "id" = $1`,
          versionId
        );
      })
    ).rejects.toThrow(/cannot be deleted/);

    // Superseding it, unchanged, IS allowed — that is publication's forward path.
    await deps.withTenantDb(ORG_A, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE "restaurant_promotion_versions"
            SET "status" = 'SUPERSEDED', "supersededAt" = now() WHERE "id" = $1`,
        versionId
      );
    });
    const status = await deps.withTenantDb(ORG_A, async (tx) =>
      tx.$queryRawUnsafe<{ status: string }[]>(
        `SELECT "status" FROM "restaurant_promotion_versions" WHERE "id" = $1`,
        versionId
      )
    );
    expect(status[0]?.status).toBe('SUPERSEDED');
  });

  it('one promotion identity can hold at most one PUBLISHED version', async () => {
    const identity = `v-dup-${suffix}`;
    await deps.withTenantDb(ORG_A, async (tx) => {
      await seedCappedPromotion(tx, ORG_A, identity, 5);
    });
    // A second PUBLISHED version of the SAME identity cannot coexist, so a
    // botched two-statement publish aborts instead of double-applying.
    await expect(
      deps.withTenantDb(ORG_A, async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "restaurant_promotion_versions"
             ("id","organizationId","promotionId","versionNumber","status","effectiveFrom","timezone",
              "targetKind","benefitKind","benefitAmount","currency","offlinePolicy",
              "approvalReference","publishedAt","ruleSnapshot","ruleHash","updatedAt")
           VALUES ($1,$2,$3,2,'PUBLISHED',now(),'UTC','ORDER','AMOUNT_OFF',5.00,'USD','ONLINE_ONLY',
                   'approval-2', now(), '{}'::jsonb, 'hash-dup', now())`,
          `${identity}-second`,
          ORG_A,
          `promo-${identity}`
        );
      })
    ).rejects.toThrow(/promo_version_one_published_key/);
  });

  it('a settled cap reservation cannot be re-settled or deleted', async () => {
    const capVersion = `v-settle-${suffix}`;
    const settleEval = `eval-settle-${suffix}`;
    await deps.withTenantDb(ORG_A, async (tx) => {
      await seedCappedPromotion(tx, ORG_A, capVersion, 5);
      await insertEvaluation(tx, ORG_A, settleEval);
      await deps.caps.reserveCaps(tx, {
        organizationId: ORG_A,
        evaluationId: settleEval,
        requests: [
          {
            promotionVersionId: capVersion,
            scopeKind: 'GLOBAL',
            scopeKey: '',
            applicationOrdinal: 0,
            count: 1,
            amount: new Prisma.Decimal('5.00'),
          },
        ],
      });
      await deps.caps.consumeReservations(tx, {
        organizationId: ORG_A,
        evaluationId: settleEval,
        settledAt: new Date(),
      });
    });

    await expect(
      deps.withTenantDb(ORG_A, async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE "restaurant_promotion_cap_reservations"
              SET "state" = 'RELEASED', "releasedAt" = now()
            WHERE "organizationId" = $1 AND "evaluationId" = $2`,
          ORG_A,
          settleEval
        );
      })
    ).rejects.toThrow(/already settled/);

    // DELETE is refused one layer EARLIER than the trigger: the ledger carries
    // SELECT/INSERT/UPDATE policies and no DELETE policy, so the statement
    // matches zero rows for the runtime role and never reaches the trigger.
    // The trigger remains as defence in depth for any role that later gains a
    // DELETE policy.
    const afterDelete = await deps.withTenantDb(ORG_A, async (tx) => {
      const deleted = await tx.$executeRawUnsafe(
        `DELETE FROM "restaurant_promotion_cap_reservations"
          WHERE "organizationId" = $1 AND "evaluationId" = $2`,
        ORG_A,
        settleEval
      );
      const survivors = await tx.$queryRawUnsafe<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM "restaurant_promotion_cap_reservations"
          WHERE "organizationId" = $1 AND "evaluationId" = $2`,
        ORG_A,
        settleEval
      );
      return { deleted, survivors };
    });
    expect(afterDelete.deleted).toBe(0);
    expect(afterDelete.survivors[0]?.count).toBe('1');
  });

  it('replaying the same evaluation returns the original reservation, not a second slot', async () => {
    const replayVersion = `v-replay-${suffix}`;
    const replayEval = `eval-replay-${suffix}`;
    const request = {
      promotionVersionId: replayVersion,
      scopeKind: 'GLOBAL' as const,
      scopeKey: '',
      applicationOrdinal: 0,
      count: 1,
      amount: new Prisma.Decimal('5.00'),
    };
    await deps.withTenantDb(ORG_A, async (tx) => {
      await seedCappedPromotion(tx, ORG_A, replayVersion, 1);
      await insertEvaluation(tx, ORG_A, replayEval);
      await deps.caps.reserveCaps(tx, {
        organizationId: ORG_A,
        evaluationId: replayEval,
        requests: [request],
      });
      // The same evaluation, reserved again — the ledger's unique key makes it
      // a no-op rather than a second consumption of the last remaining slot.
      await deps.caps.reserveCaps(tx, {
        organizationId: ORG_A,
        evaluationId: replayEval,
        requests: [request],
      });
    });

    const rows = await deps.withTenantDb(ORG_A, async (tx) =>
      tx.$queryRawUnsafe<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM "restaurant_promotion_cap_reservations"
          WHERE "organizationId" = $1 AND "evaluationId" = $2`,
        ORG_A,
        replayEval
      )
    );
    expect(rows[0]?.count).toBe('1');
  });
});
