import 'server-only';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { can, type Subject } from '@/lib/abac';
import type { AuthzDb } from '@/lib/authz';
import { assertSaleable, PharmacyMedicineError } from '@/lib/pharmacy/medicine';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * Catalogue preload hold fix: every write that sets a bundled-catalogue price or
 * changes a catalogue medicine's availability lives here.
 *
 * AUTHORIZATION. Each writer starts with `assertCatalogSettingsCapability`, which
 * runs `can()` against the tenant database before any read or write and throws
 * FORBIDDEN on a denial. `can()` denies on a missing user, an explicit DENY or a
 * failed lookup, so this fails closed. The router guards the same capability; the
 * in-function check keeps any other caller from reaching a writer without it.
 *
 * RACES. Writers lock in one order (tenant catalogue setting, then medicine, then
 * pack). A pack price write is a compare-and-set against the values the caller
 * last read, so concurrent writers never lose an update: one wins and the others
 * get CONFLICT. Default prices are applied by one set-based UPDATE per column;
 * READ COMMITTED re-checks its `price IS NULL` predicate on any row a concurrent
 * writer changed first, so an owner-entered price is never replaced.
 *
 * SALEABILITY. A catalogue medicine is created unsaleable and becomes saleable
 * only through `setCatalogMedicineAvailability` (capability, a positive selling
 * price on its current pack, and the regulated rules of `assertSaleable`) or a
 * reviewed publication that meets the same price rule. Migration 20261023150200
 * enforces the price invariant in the database for every writer.
 */

export const CATALOG_SETTINGS_CAPABILITY = 'pharmacy:catalog-settings' as const;

export type CatalogActor = { organizationId: string; subject: Subject };

const MAX_MINOR = 2_147_483_647;
const minorAmount = z.number().int().nonnegative().max(MAX_MINOR);

export const catalogPackPriceInput = z
  .object({
    packLevelId: z.string().trim().min(1).max(128),
    /** A tenant selling price is positive; `null` removes it. */
    sellingPriceMinor: z.number().int().positive().max(MAX_MINOR).nullable(),
    purchasePriceMinor: minorAmount.nullable(),
    /** The values the caller last read; the write applies only if they still hold. */
    expected: z
      .object({
        sellingPriceMinor: minorAmount.nullable(),
        purchasePriceMinor: minorAmount.nullable(),
      })
      .strict(),
  })
  .strict();
export type CatalogPackPriceInput = z.infer<typeof catalogPackPriceInput>;

export const catalogAvailabilityInput = z
  .object({ medicineId: z.string().trim().min(1).max(128), saleable: z.boolean() })
  .strict();
export type CatalogAvailabilityInput = z.infer<typeof catalogAvailabilityInput>;

type RawQueryDb = Pick<Prisma.TransactionClient, '$queryRaw'>;

function badRequest(message: string): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message });
}

function packNotFound(): TRPCError {
  return new TRPCError({ code: 'NOT_FOUND', message: 'Catalogue pack not found.' });
}

function priceConflict(): TRPCError {
  return new TRPCError({
    code: 'CONFLICT',
    message: 'This pack price changed after it was read. Reload it and try again.',
  });
}

/** Server-side, fail-closed capability check shared by every catalogue writer. */
export async function assertCatalogSettingsCapability(
  db: ScopedDb,
  actor: CatalogActor
): Promise<void> {
  let allowed = false;
  try {
    allowed = await can(
      actor.subject,
      CATALOG_SETTINGS_CAPABILITY,
      { type: 'PharmacyCatalog', organizationId: actor.organizationId },
      { db: db as unknown as AuthzDb }
    );
  } catch {
    allowed = false;
  }
  if (!allowed) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
  }
}

/**
 * Create the tenant's catalogue setting if it is missing, then hold its row for
 * the rest of the transaction. The default-price toggle and the catalogue seed
 * both take this lock, so packs a seed creates are either seeded with the defaults
 * (toggle already on) or covered by the toggle's own update (toggle afterwards).
 */
export async function lockCatalogSetting(
  db: ScopedDb,
  organizationId: string
): Promise<{ useCatalogDefaultPrices: boolean }> {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "pharmacy_catalog_settings"
      ("organizationId", "useCatalogDefaultPrices", "createdAt", "updatedAt")
    VALUES (${organizationId}, false, now(), now())
    ON CONFLICT ("organizationId") DO NOTHING`);
  const [setting] = await db.$queryRaw<{ useCatalogDefaultPrices: boolean }[]>(Prisma.sql`
    SELECT "useCatalogDefaultPrices"
      FROM "pharmacy_catalog_settings"
     WHERE "organizationId" = ${organizationId}
       FOR UPDATE`);
  if (!setting) throw new Error('The catalogue setting is not visible in this tenant scope.');
  return setting;
}

/** A positive tenant selling price on an open (current) pack version of the medicine. */
export async function hasCurrentCatalogSellingPrice(
  db: RawQueryDb,
  organizationId: string,
  medicineId: string,
  exceptPackLevelId?: string
): Promise<boolean> {
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT pack."id"
      FROM "pharmacy_pack_levels" pack
      JOIN "pharmacy_presentations" presentation ON presentation."id" = pack."presentationId"
     WHERE presentation."medicineId" = ${medicineId}
       AND presentation."organizationId" = ${organizationId}
       AND pack."organizationId" = ${organizationId}
       AND pack."effectiveTo" IS NULL
       AND pack."sellingPriceMinor" > 0
       ${exceptPackLevelId ? Prisma.sql`AND pack."id" <> ${exceptPackLevelId}` : Prisma.empty}
     LIMIT 1`);
  return rows.length > 0;
}

type LockedMedicine = { id: string; saleable: boolean };

/** Lock a catalogue-origin medicine of this tenant (first lock after the setting). */
async function lockCatalogMedicine(
  db: ScopedDb,
  organizationId: string,
  medicineId: string
): Promise<LockedMedicine> {
  const [medicine] = await db.$queryRaw<LockedMedicine[]>(Prisma.sql`
    SELECT "id", "saleable"
      FROM "pharmacy_medicines"
     WHERE "id" = ${medicineId}
       AND "organizationId" = ${organizationId}
       AND "catalogVersion" IS NOT NULL
       FOR NO KEY UPDATE`);
  if (!medicine) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Catalogue medicine not found.' });
  }
  return medicine;
}

/**
 * Turn "use catalogue default prices" on or off. Turning it on copies each default
 * only where that pack's own price is still empty; turning it off never erases a
 * price. Concurrent toggles serialize on the setting row.
 */
export async function setCatalogDefaultPrices(db: ScopedDb, actor: CatalogActor, enabled: boolean) {
  await assertCatalogSettingsCapability(db, actor);
  const { organizationId } = actor;
  const before = await lockCatalogSetting(db, organizationId);
  await db.pharmacyCatalogSetting.update({
    where: { organizationId },
    data: {
      useCatalogDefaultPrices: enabled,
      enabledById: enabled ? actor.subject.id : null,
      enabledAt: enabled ? new Date() : null,
    },
  });
  let saleApplied = 0;
  let purchaseApplied = 0;
  if (enabled) {
    saleApplied = await db.$executeRaw(Prisma.sql`
      UPDATE "pharmacy_pack_levels"
         SET "sellingPriceMinor" = "catalogDefaultSalePriceMinor"
       WHERE "organizationId" = ${organizationId}
         AND "sellingPriceMinor" IS NULL
         AND "catalogDefaultSalePriceMinor" IS NOT NULL`);
    purchaseApplied = await db.$executeRaw(Prisma.sql`
      UPDATE "pharmacy_pack_levels"
         SET "purchasePriceMinor" = "catalogDefaultPurchasePriceMinor"
       WHERE "organizationId" = ${organizationId}
         AND "purchasePriceMinor" IS NULL
         AND "catalogDefaultPurchasePriceMinor" IS NOT NULL`);
  }
  await db.auditLog.create({
    data: {
      organizationId,
      actorId: actor.subject.id,
      source: 'TRPC',
      category: 'PHARMACY',
      operation: 'UPDATE',
      action: 'pharmacyCatalog.setDefaultPrices',
      targetType: 'PharmacyCatalogSetting',
      targetId: organizationId,
      changes: { useCatalogDefaultPrices: { from: before.useCatalogDefaultPrices, to: enabled } },
      result: { enabled, saleApplied, purchaseApplied },
    },
  });
  return { enabled, saleApplied, purchaseApplied };
}

/** Compare-and-set the tenant selling/purchase price of one current catalogue pack. */
export async function setCatalogPackPrice(
  db: ScopedDb,
  actor: CatalogActor,
  input: CatalogPackPriceInput
) {
  await assertCatalogSettingsCapability(db, actor);
  const { organizationId } = actor;
  // Resolve the owning medicine without a lock, then lock medicine -> pack.
  const [owner] = await db.$queryRaw<{ medicineId: string }[]>(Prisma.sql`
    SELECT presentation."medicineId"
      FROM "pharmacy_pack_levels" pack
      JOIN "pharmacy_presentations" presentation ON presentation."id" = pack."presentationId"
     WHERE pack."id" = ${input.packLevelId}
       AND pack."organizationId" = ${organizationId}
       AND presentation."organizationId" = ${organizationId}`);
  if (!owner) throw packNotFound();
  const medicine = await lockCatalogMedicine(db, organizationId, owner.medicineId);
  const [pack] = await db.$queryRaw<
    {
      id: string;
      effectiveTo: Date | null;
      sellingPriceMinor: number | null;
      purchasePriceMinor: number | null;
    }[]
  >(Prisma.sql`
    SELECT pack."id", pack."effectiveTo", pack."sellingPriceMinor", pack."purchasePriceMinor"
      FROM "pharmacy_pack_levels" pack
      JOIN "pharmacy_presentations" presentation ON presentation."id" = pack."presentationId"
     WHERE pack."id" = ${input.packLevelId}
       AND pack."organizationId" = ${organizationId}
       AND presentation."medicineId" = ${medicine.id}
       FOR UPDATE OF pack`);
  if (!pack) throw packNotFound();
  if (pack.effectiveTo !== null) throw badRequest('Only the current pack version can be priced.');
  if (
    pack.sellingPriceMinor !== input.expected.sellingPriceMinor ||
    pack.purchasePriceMinor !== input.expected.purchasePriceMinor
  ) {
    throw priceConflict();
  }
  if (
    medicine.saleable &&
    input.sellingPriceMinor === null &&
    !(await hasCurrentCatalogSellingPrice(db, organizationId, medicine.id, pack.id))
  ) {
    throw badRequest(
      'Make this catalogue medicine unavailable before removing its last selling price.'
    );
  }
  // The row is locked, so this guard only matters if a caller ever skips the lock.
  const updated = await db.packLevel.updateMany({
    where: {
      id: pack.id,
      organizationId,
      sellingPriceMinor: input.expected.sellingPriceMinor,
      purchasePriceMinor: input.expected.purchasePriceMinor,
    },
    data: {
      sellingPriceMinor: input.sellingPriceMinor,
      purchasePriceMinor: input.purchasePriceMinor,
    },
  });
  if (updated.count !== 1) throw priceConflict();
  await db.auditLog.create({
    data: {
      organizationId,
      actorId: actor.subject.id,
      source: 'TRPC',
      category: 'PHARMACY',
      operation: 'UPDATE',
      action: 'pharmacyCatalog.setPackPrice',
      targetType: 'PackLevel',
      targetId: pack.id,
      changes: {
        sellingPriceMinor: { from: pack.sellingPriceMinor, to: input.sellingPriceMinor },
        purchasePriceMinor: { from: pack.purchasePriceMinor, to: input.purchasePriceMinor },
      },
    },
  });
  return {
    packLevelId: pack.id,
    medicineId: medicine.id,
    sellingPriceMinor: input.sellingPriceMinor,
    purchasePriceMinor: input.purchasePriceMinor,
  };
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
  if (!record) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Catalogue medicine not found.' });
  }
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
  await assertCatalogSettingsCapability(db, actor);
  const { organizationId } = actor;
  const medicine = await lockCatalogMedicine(db, organizationId, input.medicineId);
  if (medicine.saleable === input.saleable) {
    return { medicineId: medicine.id, saleable: medicine.saleable, changed: false };
  }
  if (input.saleable) {
    if (!(await hasCurrentCatalogSellingPrice(db, organizationId, medicine.id))) {
      throw badRequest(
        'Set a positive selling price on the current pack before making this catalogue medicine available.'
      );
    }
    await assertMeetsSaleabilityRules(db, medicine.id);
  }
  await db.medicine.update({ where: { id: medicine.id }, data: { saleable: input.saleable } });
  await db.auditLog.create({
    data: {
      organizationId,
      actorId: actor.subject.id,
      source: 'TRPC',
      category: 'PHARMACY',
      operation: 'UPDATE',
      action: 'pharmacyCatalog.setAvailability',
      targetType: 'Medicine',
      targetId: medicine.id,
      changes: { saleable: { from: medicine.saleable, to: input.saleable } },
    },
  });
  return { medicineId: medicine.id, saleable: input.saleable, changed: true };
}

/** Current pack prices of one catalogue medicine, including the `expected` values. */
export async function catalogMedicineDetail(db: ScopedDb, actor: CatalogActor, medicineId: string) {
  await assertCatalogSettingsCapability(db, actor);
  const medicine = await db.medicine.findFirst({
    where: { id: medicineId, organizationId: actor.organizationId, catalogVersion: { not: null } },
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
              sellingPriceMinor: true,
              purchasePriceMinor: true,
              catalogDefaultSalePriceMinor: true,
              catalogDefaultPurchasePriceMinor: true,
            },
          },
        },
      },
    },
  });
  if (!medicine) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Catalogue medicine not found.' });
  }
  return medicine;
}
