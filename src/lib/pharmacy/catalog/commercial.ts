import 'server-only';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { can, type Subject } from '@/lib/abac';
import type { AuthzDb } from '@/lib/authz';
import { assertSaleable, PharmacyMedicineError } from '@/lib/pharmacy/medicine';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * Catalogue preload: every write that sets a bundled-catalogue price or changes a
 * catalogue medicine's availability lives here, and every one is branch-scoped.
 *
 * ONE TRANSACTION (CAT-SEC-04). Each writer runs authorization, the setting change,
 * every conditional price write and the audit insert inside one transaction that is
 * tenant-scoped (withTenantDb) and branch-scoped (`app.current_branch_id` is bound for
 * its duration). Any failure, including a failed audit insert, rolls all of it back.
 *
 * AUTHORIZATION (CAT-SEC-01). `authorizeCatalogBranch` runs the central `can()` for
 * `pharmacy:catalog-settings` with the branch as a resource attribute, then requires the
 * caller's active assignment to that active branch (no administrator bypass). `can()`
 * fails closed on a missing user, an explicit DENY or a lookup error. Nothing is read
 * or written before both pass.
 *
 * BRANCH SCOPE (CAT-SEC-03). Applied prices and the default-price setting are keyed by
 * branch, filtered by branch in every predicate, audited with the branch, and guarded
 * by forced RLS that admits only a caller assigned to the row's branch.
 *
 * RACES AND RETRIES. Lock order is fixed: branch setting, then medicine, then pack and
 * branch price. A pack price write is a compare-and-set against the values the caller
 * last read. The bulk default application locks its whole target set first and writes it
 * in one statement per kind, all or nothing. Row ids are deterministic and every writer
 * is idempotent: a retry of an applied change writes nothing and records no second audit.
 *
 * SALEABILITY. Availability is organization-wide. A catalogue medicine may be saleable
 * only while some branch holds a positive selling price on a current pack of it (counts
 * and guards maintained by the database, 20261023150300). Making it saleable here also
 * needs that price in the caller's branch and the regulated `assertSaleable` rules.
 */

export const CATALOG_SETTINGS_CAPABILITY = 'pharmacy:catalog-settings' as const;

export type CatalogActor = { organizationId: string; subject: Subject };

const MAX_MINOR = 2_147_483_647;
const entityId = z.string().trim().min(1).max(128);
const minorAmount = z.number().int().nonnegative().max(MAX_MINOR);
/** A selling price is a positive amount; `null` removes it. */
const sellingAmount = z.number().int().positive().max(MAX_MINOR);

export const catalogDefaultPricesInput = z
  .object({ branchId: entityId, enabled: z.boolean() })
  .strict();
export type CatalogDefaultPricesInput = z.infer<typeof catalogDefaultPricesInput>;

export const catalogPackPriceInput = z
  .object({
    branchId: entityId,
    packLevelId: entityId,
    sellingPriceMinor: sellingAmount.nullable(),
    purchasePriceMinor: minorAmount.nullable(),
    /** The branch's values as the caller last read them; the write applies only if they hold. */
    expected: z
      .object({
        sellingPriceMinor: sellingAmount.nullable(),
        purchasePriceMinor: minorAmount.nullable(),
      })
      .strict(),
  })
  .strict();
export type CatalogPackPriceInput = z.infer<typeof catalogPackPriceInput>;

export const catalogAvailabilityInput = z
  .object({ branchId: entityId, medicineId: entityId, saleable: z.boolean() })
  .strict();
export type CatalogAvailabilityInput = z.infer<typeof catalogAvailabilityInput>;

export const catalogMedicineInput = z.object({ branchId: entityId, medicineId: entityId }).strict();
export type CatalogMedicineInput = z.infer<typeof catalogMedicineInput>;

function forbidden(message = 'You do not have permission for this action.'): TRPCError {
  return new TRPCError({ code: 'FORBIDDEN', message });
}

function badRequest(message: string): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message });
}

function notFound(message: string): TRPCError {
  return new TRPCError({ code: 'NOT_FOUND', message });
}

function priceConflict(): TRPCError {
  return new TRPCError({
    code: 'CONFLICT',
    message: 'These branch prices changed after they were read. Reload them and try again.',
  });
}

/** PostgreSQL unique violation (23505), however the driver adapter wraps it. */
function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      code?: unknown;
      originalCode?: unknown;
      kind?: unknown;
      message?: unknown;
      meta?: unknown;
      cause?: unknown;
    };
    if (candidate.code === '23505' || candidate.originalCode === '23505') return true;
    if (candidate.kind === 'UniqueConstraintViolation') return true;
    if (/23505|duplicate key value|unique constraint/i.test(String(candidate.message ?? '')))
      return true;
    const meta = candidate.meta as { code?: unknown; driverAdapterError?: unknown } | undefined;
    if (meta?.code === '23505') return true;
    current = meta?.driverAdapterError ?? candidate.cause;
  }
  return false;
}

/** Central capability decision plus the caller's assignment to the active branch. */
async function authorizeCatalogBranch(
  db: ScopedDb,
  actor: CatalogActor,
  branchId: string
): Promise<void> {
  let allowed = false;
  try {
    allowed = await can(
      actor.subject,
      CATALOG_SETTINGS_CAPABILITY,
      { type: 'PharmacyCatalogBranch', organizationId: actor.organizationId, branchId },
      { db: db as unknown as AuthzDb }
    );
  } catch {
    allowed = false;
  }
  if (!allowed) throw forbidden();
  const assignment = await db.pharmacyBranchAssignment.findFirst({
    where: {
      organizationId: actor.organizationId,
      branchId,
      userId: actor.subject.id,
      active: true,
      branch: { organizationId: actor.organizationId, active: true },
    },
    select: { id: true },
  });
  if (!assignment) throw forbidden('Branch is outside your scope.');
}

/**
 * Confine this transaction's RLS to one branch and return the binding to restore. A
 * transaction already bound to another branch may not act for this one.
 */
async function bindBranch(db: ScopedDb, branchId: string): Promise<string> {
  const [bound] = await db.$queryRaw<{ branch: string | null }[]>(
    Prisma.sql`SELECT current_setting('app.current_branch_id', true) AS branch`
  );
  const previous = bound?.branch ?? '';
  if (previous !== '' && previous !== branchId) throw forbidden('Branch is outside your scope.');
  await db.$queryRaw(Prisma.sql`SELECT set_config('app.current_branch_id', ${branchId}, true)`);
  return previous;
}

/** Authorization, branch binding and `work` in one tenant-and-branch-scoped transaction. */
async function inCatalogBranchTransaction<T>(
  db: ScopedDb,
  actor: CatalogActor,
  branchId: string,
  work: (tx: ScopedDb) => Promise<T>
): Promise<T> {
  return db.$transaction(async (transaction) => {
    const tx = transaction as unknown as ScopedDb;
    await authorizeCatalogBranch(tx, actor, branchId);
    const previous = await bindBranch(tx, branchId);
    try {
      return await work(tx);
    } finally {
      // After a database error the transaction is aborted and rolls back anyway.
      await tx
        .$queryRaw(Prisma.sql`SELECT set_config('app.current_branch_id', ${previous}, true)`)
        .catch(() => undefined);
    }
  });
}

type CatalogAuditEntry = {
  action: string;
  targetType: string;
  targetId: string;
  branchId: string;
  changes: Prisma.InputJsonValue;
  result?: Prisma.InputJsonValue;
};

/** The audit row is written inside the same transaction as the change it records. */
async function writeCatalogAudit(db: ScopedDb, actor: CatalogActor, entry: CatalogAuditEntry) {
  await db.auditLog.create({
    data: {
      organizationId: actor.organizationId,
      actorId: actor.subject.id,
      source: 'TRPC',
      category: 'PHARMACY',
      operation: 'UPDATE',
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      changes: entry.changes,
      result: entry.result,
      metadata: { branchId: entry.branchId },
    },
  });
}

/** Create the branch setting if missing, then hold it (first lock of every writer). */
async function lockBranchSetting(
  db: ScopedDb,
  organizationId: string,
  branchId: string,
  mode: 'UPDATE' | 'SHARE'
): Promise<{ useCatalogDefaultPrices: boolean }> {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "pharmacy_catalog_branch_settings" ("organizationId", "branchId")
    VALUES (${organizationId}, ${branchId})
    ON CONFLICT ("organizationId", "branchId") DO NOTHING`);
  const lock = mode === 'UPDATE' ? Prisma.sql`FOR UPDATE` : Prisma.sql`FOR SHARE`;
  const [setting] = await db.$queryRaw<{ useCatalogDefaultPrices: boolean }[]>(Prisma.sql`
    SELECT "useCatalogDefaultPrices"
      FROM "pharmacy_catalog_branch_settings"
     WHERE "organizationId" = ${organizationId} AND "branchId" = ${branchId}
     ${lock}`);
  if (!setting) throw forbidden('Branch is outside your scope.');
  return setting;
}

type LockedMedicine = { id: string; saleable: boolean; catalogSellingPriceCount: number };

async function lockCatalogMedicine(
  db: ScopedDb,
  organizationId: string,
  medicineId: string
): Promise<LockedMedicine> {
  const [medicine] = await db.$queryRaw<LockedMedicine[]>(Prisma.sql`
    SELECT "id", "saleable", "catalogSellingPriceCount"
      FROM "pharmacy_medicines"
     WHERE "id" = ${medicineId}
       AND "organizationId" = ${organizationId}
       AND "catalogVersion" IS NOT NULL
       FOR NO KEY UPDATE`);
  if (!medicine) throw notFound('Catalogue medicine not found.');
  return medicine;
}

type PackTarget = {
  packLevelId: string;
  medicineId: string;
  defaultSale: number | null;
  defaultPurchase: number | null;
};
type BranchPriceRow = {
  id: string;
  packLevelId: string;
  sellingPriceMinor: number | null;
  purchasePriceMinor: number | null;
};
type NewPrice = {
  packLevelId: string;
  medicineId: string;
  selling: number | null;
  purchase: number | null;
};
type PriceFill = { id: string; selling: number | null; purchase: number | null };

/** What applying the reference defaults would write into one branch's existing prices. */
function defaultPricePlan(packs: PackTarget[], existing: BranchPriceRow[]) {
  const byPack = new Map(existing.map((row) => [row.packLevelId, row]));
  const toCreate: NewPrice[] = [];
  const toFill: PriceFill[] = [];
  for (const pack of packs) {
    const row = byPack.get(pack.packLevelId);
    if (!row) {
      toCreate.push({
        packLevelId: pack.packLevelId,
        medicineId: pack.medicineId,
        selling: pack.defaultSale,
        purchase: pack.defaultPurchase,
      });
      continue;
    }
    // Only an empty price is filled; a price the branch set is never replaced.
    const fillSelling = row.sellingPriceMinor === null && pack.defaultSale !== null;
    const fillPurchase = row.purchasePriceMinor === null && pack.defaultPurchase !== null;
    if (fillSelling || fillPurchase) {
      toFill.push({
        id: row.id,
        selling: fillSelling ? pack.defaultSale : null,
        purchase: fillPurchase ? pack.defaultPurchase : null,
      });
    }
  }
  return { toCreate, toFill };
}

/**
 * Turn "use catalogue default prices" on or off for one branch. Turning it on copies
 * each reference default into that branch only where the branch has no price of that
 * kind yet (and re-applying fills what a later catalogue seed added); turning it off
 * never erases a price. All or nothing, in one transaction.
 */
export async function setCatalogDefaultPrices(
  db: ScopedDb,
  actor: CatalogActor,
  input: CatalogDefaultPricesInput
) {
  const { organizationId } = actor;
  const { branchId, enabled } = input;
  return inCatalogBranchTransaction(db, actor, branchId, async (tx) => {
    const before = await lockBranchSetting(tx, organizationId, branchId, 'UPDATE');
    const settingChanged = before.useCatalogDefaultPrices !== enabled;
    if (settingChanged) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "pharmacy_catalog_branch_settings"
           SET "useCatalogDefaultPrices" = ${enabled},
               "enabledById" = CASE WHEN ${enabled} THEN ${actor.subject.id} ELSE NULL END,
               "enabledAt" = CASE WHEN ${enabled} THEN now() ELSE NULL END,
               "updatedAt" = now()
         WHERE "organizationId" = ${organizationId} AND "branchId" = ${branchId}`);
    }

    let toCreate: NewPrice[] = [];
    let toFill: PriceFill[] = [];
    if (enabled) {
      // Lock every target medicine (in id order), then its current packs, then the
      // branch's existing price rows. No conforming writer can change the target set
      // after this point.
      const medicines = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT medicine."id"
          FROM "pharmacy_medicines" medicine
         WHERE medicine."organizationId" = ${organizationId}
           AND medicine."catalogVersion" IS NOT NULL
           AND EXISTS (
             SELECT 1
               FROM "pharmacy_presentations" presentation
               JOIN "pharmacy_pack_levels" pack
                 ON pack."presentationId" = presentation."id"
                AND pack."organizationId" = presentation."organizationId"
              WHERE presentation."medicineId" = medicine."id"
                AND presentation."organizationId" = medicine."organizationId"
                AND pack."effectiveTo" IS NULL
                AND (pack."catalogDefaultSalePriceMinor" > 0
                     OR pack."catalogDefaultPurchasePriceMinor" IS NOT NULL))
         ORDER BY medicine."id"
           FOR NO KEY UPDATE OF medicine`);
      const medicineIds = medicines.map((medicine) => medicine.id);
      const packs =
        medicineIds.length === 0
          ? []
          : await tx.$queryRaw<PackTarget[]>(Prisma.sql`
              SELECT pack."id" AS "packLevelId",
                     presentation."medicineId",
                     CASE WHEN pack."catalogDefaultSalePriceMinor" > 0
                          THEN pack."catalogDefaultSalePriceMinor" END AS "defaultSale",
                     pack."catalogDefaultPurchasePriceMinor" AS "defaultPurchase"
                FROM "pharmacy_pack_levels" pack
                JOIN "pharmacy_presentations" presentation
                  ON presentation."id" = pack."presentationId"
                 AND presentation."organizationId" = pack."organizationId"
               WHERE presentation."medicineId" = ANY(${medicineIds}::text[])
                 AND pack."organizationId" = ${organizationId}
                 AND pack."effectiveTo" IS NULL
                 AND (pack."catalogDefaultSalePriceMinor" > 0
                      OR pack."catalogDefaultPurchasePriceMinor" IS NOT NULL)
               ORDER BY pack."id"
                 FOR SHARE OF pack`);
      const packIds = packs.map((pack) => pack.packLevelId);
      const existing =
        packIds.length === 0
          ? []
          : await tx.$queryRaw<BranchPriceRow[]>(Prisma.sql`
              SELECT "id", "packLevelId", "sellingPriceMinor", "purchasePriceMinor"
                FROM "pharmacy_catalog_branch_prices"
               WHERE "organizationId" = ${organizationId}
                 AND "branchId" = ${branchId}
                 AND "packLevelId" = ANY(${packIds}::text[])
               ORDER BY "id"
                 FOR UPDATE`);
      ({ toCreate, toFill } = defaultPricePlan(packs, existing));
      try {
        if (toCreate.length > 0) {
          const inserted = await tx.$executeRaw(Prisma.sql`
            INSERT INTO "pharmacy_catalog_branch_prices"
              ("id", "organizationId", "branchId", "medicineId", "packLevelId",
               "sellingPriceMinor", "purchasePriceMinor", "updatedById")
            SELECT 'cbp_' || md5(${organizationId} || ':' || ${branchId} || ':' || target."packLevelId"),
                   ${organizationId}, ${branchId}, target."medicineId", target."packLevelId",
                   target."selling", target."purchase", ${actor.subject.id}
              FROM jsonb_to_recordset(${JSON.stringify(toCreate)}::jsonb)
                AS target("packLevelId" TEXT, "medicineId" TEXT, "selling" INTEGER, "purchase" INTEGER)`);
          if (inserted !== toCreate.length) throw priceConflict();
        }
        if (toFill.length > 0) {
          const filled = await tx.$executeRaw(Prisma.sql`
            UPDATE "pharmacy_catalog_branch_prices" price
               SET "sellingPriceMinor" = COALESCE(price."sellingPriceMinor", target."selling"),
                   "purchasePriceMinor" = COALESCE(price."purchasePriceMinor", target."purchase"),
                   "updatedById" = ${actor.subject.id},
                   "updatedAt" = now()
              FROM jsonb_to_recordset(${JSON.stringify(toFill)}::jsonb)
                AS target("id" TEXT, "selling" INTEGER, "purchase" INTEGER)
             WHERE price."id" = target."id"
               AND price."organizationId" = ${organizationId}
               AND price."branchId" = ${branchId}`);
          if (filled !== toFill.length) throw priceConflict();
        }
      } catch (error) {
        // A writer that skipped the lock order created one of these rows in between:
        // the whole application fails and rolls back rather than landing partially.
        if (isUniqueViolation(error)) throw priceConflict();
        throw error;
      }
    }

    const applied = [...toCreate, ...toFill];
    const result = {
      branchId,
      enabled,
      changed: settingChanged || applied.length > 0,
      created: toCreate.length,
      filled: toFill.length,
      saleApplied: applied.filter((row) => row.selling !== null).length,
      purchaseApplied: applied.filter((row) => row.purchase !== null).length,
    };
    if (!result.changed) return result;
    await writeCatalogAudit(tx, actor, {
      action: 'pharmacyCatalog.setDefaultPrices',
      targetType: 'PharmacyCatalogBranchSetting',
      targetId: branchId,
      branchId,
      changes: {
        branchId,
        useCatalogDefaultPrices: { from: before.useCatalogDefaultPrices, to: enabled },
      },
      result,
    });
    return result;
  });
}

/** Compare-and-set one branch's selling/purchase price for a current catalogue pack. */
export async function setCatalogPackPrice(
  db: ScopedDb,
  actor: CatalogActor,
  input: CatalogPackPriceInput
) {
  const { organizationId } = actor;
  const { branchId, packLevelId } = input;
  return inCatalogBranchTransaction(db, actor, branchId, async (tx) => {
    await lockBranchSetting(tx, organizationId, branchId, 'SHARE');
    // Resolve the owning medicine without a lock, then lock medicine -> pack -> price.
    const [owner] = await tx.$queryRaw<{ medicineId: string }[]>(Prisma.sql`
      SELECT presentation."medicineId"
        FROM "pharmacy_pack_levels" pack
        JOIN "pharmacy_presentations" presentation
          ON presentation."id" = pack."presentationId"
         AND presentation."organizationId" = pack."organizationId"
       WHERE pack."id" = ${packLevelId} AND pack."organizationId" = ${organizationId}`);
    if (!owner) throw notFound('Catalogue pack not found.');
    const medicine = await lockCatalogMedicine(tx, organizationId, owner.medicineId);
    const [pack] = await tx.$queryRaw<{ id: string; effectiveTo: Date | null }[]>(Prisma.sql`
      SELECT pack."id", pack."effectiveTo"
        FROM "pharmacy_pack_levels" pack
        JOIN "pharmacy_presentations" presentation
          ON presentation."id" = pack."presentationId"
         AND presentation."organizationId" = pack."organizationId"
       WHERE pack."id" = ${packLevelId}
         AND pack."organizationId" = ${organizationId}
         AND presentation."medicineId" = ${medicine.id}
         FOR SHARE OF pack`);
    if (!pack) throw notFound('Catalogue pack not found.');
    if (pack.effectiveTo !== null) throw badRequest('Only the current pack version can be priced.');
    const [row] = await tx.$queryRaw<BranchPriceRow[]>(Prisma.sql`
      SELECT "id", "packLevelId", "sellingPriceMinor", "purchasePriceMinor"
        FROM "pharmacy_catalog_branch_prices"
       WHERE "organizationId" = ${organizationId}
         AND "branchId" = ${branchId}
         AND "packLevelId" = ${packLevelId}
         FOR UPDATE`);
    const current = {
      sellingPriceMinor: row?.sellingPriceMinor ?? null,
      purchasePriceMinor: row?.purchasePriceMinor ?? null,
    };
    const outcome = {
      branchId,
      packLevelId,
      medicineId: medicine.id,
      sellingPriceMinor: input.sellingPriceMinor,
      purchasePriceMinor: input.purchasePriceMinor,
    };
    // An identical retry finds its own write already applied: no second write or audit.
    if (
      current.sellingPriceMinor === input.sellingPriceMinor &&
      current.purchasePriceMinor === input.purchasePriceMinor
    ) {
      return { ...outcome, changed: false };
    }
    if (
      current.sellingPriceMinor !== input.expected.sellingPriceMinor ||
      current.purchasePriceMinor !== input.expected.purchasePriceMinor
    ) {
      throw priceConflict();
    }
    const losesCoverage = (current.sellingPriceMinor ?? 0) > 0 && input.sellingPriceMinor === null;
    if (losesCoverage && medicine.saleable && medicine.catalogSellingPriceCount <= 1) {
      throw badRequest(
        'Make this catalogue medicine unavailable before removing its last branch selling price.'
      );
    }
    try {
      if (row) {
        const updated = await tx.$executeRaw(Prisma.sql`
          UPDATE "pharmacy_catalog_branch_prices"
             SET "sellingPriceMinor" = ${input.sellingPriceMinor}::integer,
                 "purchasePriceMinor" = ${input.purchasePriceMinor}::integer,
                 "updatedById" = ${actor.subject.id},
                 "updatedAt" = now()
           WHERE "id" = ${row.id}
             AND "organizationId" = ${organizationId}
             AND "branchId" = ${branchId}
             AND "sellingPriceMinor" IS NOT DISTINCT FROM ${input.expected.sellingPriceMinor}::integer
             AND "purchasePriceMinor" IS NOT DISTINCT FROM ${input.expected.purchasePriceMinor}::integer`);
        if (updated !== 1) throw priceConflict();
      } else {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "pharmacy_catalog_branch_prices"
            ("id", "organizationId", "branchId", "medicineId", "packLevelId",
             "sellingPriceMinor", "purchasePriceMinor", "updatedById")
          VALUES ('cbp_' || md5(${organizationId} || ':' || ${branchId} || ':' || ${packLevelId}),
                  ${organizationId}, ${branchId}, ${medicine.id}, ${packLevelId},
                  ${input.sellingPriceMinor}::integer, ${input.purchasePriceMinor}::integer,
                  ${actor.subject.id})`);
      }
    } catch (error) {
      if (isUniqueViolation(error)) throw priceConflict();
      throw error;
    }
    await writeCatalogAudit(tx, actor, {
      action: 'pharmacyCatalog.setPackPrice',
      targetType: 'PharmacyCatalogBranchPrice',
      targetId: `${branchId}:${packLevelId}`,
      branchId,
      changes: {
        branchId,
        packLevelId,
        sellingPriceMinor: { from: current.sellingPriceMinor, to: input.sellingPriceMinor },
        purchasePriceMinor: { from: current.purchasePriceMinor, to: input.purchasePriceMinor },
      },
    });
    return { ...outcome, changed: true };
  });
}

/** The regulated rules every path to `saleable` enforces, read from stored facts. */
async function assertMeetsSaleabilityRules(db: ScopedDb, medicineId: string): Promise<void> {
  const record = await db.medicine.findFirst({
    where: { id: medicineId },
    select: {
      productFamily: true,
      drapRegistrationNumber: true,
      presentations: { select: { id: true }, take: 1 },
      strengths: { select: { id: true }, take: 1 },
      provenance: {
        where: { status: { in: ['ACCEPTED', 'CORRECTED'] } },
        select: { field: true },
      },
    },
  });
  if (!record) throw notFound('Catalogue medicine not found.');
  try {
    assertSaleable({
      productFamily: record.productFamily,
      hasPresentation: record.presentations.length > 0,
      hasStrength: record.strengths.length > 0,
      hasRegistration: Boolean(record.drapRegistrationNumber),
      provenanceFields: new Set(record.provenance.map((assertion) => assertion.field)),
    });
  } catch (error) {
    if (error instanceof PharmacyMedicineError) {
      throw badRequest(
        'This medicine is not saleable yet: it needs a presentation, a strength and a DRAP registration accepted in catalogue review.'
      );
    }
    throw error;
  }
}

/** The one explicit way to change a catalogue medicine's availability. */
export async function setCatalogMedicineAvailability(
  db: ScopedDb,
  actor: CatalogActor,
  input: CatalogAvailabilityInput
) {
  const { organizationId } = actor;
  const { branchId } = input;
  return inCatalogBranchTransaction(db, actor, branchId, async (tx) => {
    await lockBranchSetting(tx, organizationId, branchId, 'SHARE');
    const medicine = await lockCatalogMedicine(tx, organizationId, input.medicineId);
    if (medicine.saleable === input.saleable) {
      return { branchId, medicineId: medicine.id, saleable: medicine.saleable, changed: false };
    }
    if (input.saleable) {
      const priced = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT price."id"
          FROM "pharmacy_catalog_branch_prices" price
          JOIN "pharmacy_pack_levels" pack
            ON pack."id" = price."packLevelId" AND pack."organizationId" = price."organizationId"
         WHERE price."organizationId" = ${organizationId}
           AND price."branchId" = ${branchId}
           AND price."medicineId" = ${medicine.id}
           AND price."sellingPriceMinor" > 0
           AND pack."effectiveTo" IS NULL
         LIMIT 1
           FOR SHARE OF price`);
      if (priced.length === 0) {
        throw badRequest(
          'Set a positive selling price for this branch before making this catalogue medicine available.'
        );
      }
      await assertMeetsSaleabilityRules(tx, medicine.id);
    }
    await tx.medicine.update({ where: { id: medicine.id }, data: { saleable: input.saleable } });
    await writeCatalogAudit(tx, actor, {
      action: 'pharmacyCatalog.setAvailability',
      targetType: 'Medicine',
      targetId: medicine.id,
      branchId,
      changes: { branchId, saleable: { from: medicine.saleable, to: input.saleable } },
    });
    return { branchId, medicineId: medicine.id, saleable: input.saleable, changed: true };
  });
}

/** One catalogue medicine with this branch's prices for its current packs. */
export async function catalogMedicineDetail(
  db: ScopedDb,
  actor: CatalogActor,
  input: CatalogMedicineInput
) {
  const { organizationId } = actor;
  return inCatalogBranchTransaction(db, actor, input.branchId, async (tx) => {
    const medicine = await tx.medicine.findFirst({
      where: { id: input.medicineId, organizationId, catalogVersion: { not: null } },
      select: {
        id: true,
        productName: true,
        saleable: true,
        catalogVersion: true,
        presentations: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            presentation: true,
            packLevels: {
              where: { effectiveTo: null },
              orderBy: { id: 'asc' },
              select: {
                id: true,
                level: true,
                unitsPerParent: true,
                catalogDefaultSalePriceMinor: true,
                catalogDefaultPurchasePriceMinor: true,
              },
            },
          },
        },
      },
    });
    if (!medicine) throw notFound('Catalogue medicine not found.');
    const prices = await tx.pharmacyCatalogBranchPrice.findMany({
      where: { organizationId, branchId: input.branchId, medicineId: medicine.id },
      select: { packLevelId: true, sellingPriceMinor: true, purchasePriceMinor: true },
    });
    const byPack = new Map(prices.map((price) => [price.packLevelId, price]));
    return {
      ...medicine,
      branchId: input.branchId,
      presentations: medicine.presentations.map((presentation) => ({
        ...presentation,
        packLevels: presentation.packLevels.map((pack) => ({
          ...pack,
          sellingPriceMinor: byPack.get(pack.id)?.sellingPriceMinor ?? null,
          purchasePriceMinor: byPack.get(pack.id)?.purchasePriceMinor ?? null,
        })),
      })),
    };
  });
}
