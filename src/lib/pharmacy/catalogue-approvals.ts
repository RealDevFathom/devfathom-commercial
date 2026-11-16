import 'server-only';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { Prisma } from '@/generated/prisma/client';
import { PharmacyProductClassError, validateRetailFields } from './product-class';
import { isSoloPharmacyOwner } from './solo-owner';
import { verifyOwnerExportPin } from './owner-data-export-pin';

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
// Neither product family nor saleability can be changed here. Publication retains
// its registration, strength, presentation and reviewed-provenance requirements.
export const catalogueChanges = z
  .object({
    productName: z.string().trim().min(1).max(300).optional(),
    brandName: nullableText(300),
    manufacturer: nullableText(300),
    marketingAuthorizationHolder: nullableText(300),
    drapRegistrationNumber: nullableText(100),
    drapRegistrationStatus: nullableText(100),
    rx: z.boolean().optional(),
    otc: z.boolean().optional(),
    restricted: z.boolean().optional(),
    controlled: z.boolean().optional(),
    highAlert: z.boolean().optional(),
    lasa: z.boolean().optional(),
    coldChain: z.boolean().optional(),
    retailPriceMinor: z.number().int().positive().max(2147483647).nullable().optional(),
    retailCategory: nullableText(200),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Supply at least one catalogue edit.');

type Scope = { organizationId: string; actorId: string; actorOrganizationId?: string | null };

export async function requireIndependentCatalogueReviewer(
  db: ScopedDb,
  scope: Scope,
  editorIds: Array<string | null>,
  soloPin?: string
): Promise<boolean> {
  if (!editorIds.includes(scope.actorId)) return false;
  if (
    !soloPin ||
    !(await isSoloPharmacyOwner(db, {
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      actorOrganizationId: scope.actorOrganizationId,
    }))
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message:
        'Another reviewer must approve this edit. A solo owner may enter their own fresh PIN.',
    });
  }
  // A separate transaction commits failed guesses and their durable lockout.
  if (
    (await verifyOwnerExportPin({
      organizationId: scope.organizationId,
      userId: scope.actorId,
      pin: soloPin,
    })) !== 'OK'
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Fresh owner PIN verification failed.' });
  }
  return true;
}

export async function recordCatalogueApproval(
  db: ScopedDb,
  scope: Scope,
  targetId: string,
  solo: boolean
) {
  await db.auditLog.create({
    data: {
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      actorType: 'USER',
      source: 'TRPC',
      category: 'PHARMACY_CATALOGUE',
      operation: 'UPDATE',
      action: solo ? 'pharmacy.catalogueSoloOwnerApproval' : 'pharmacy.catalogueApproval',
      targetType: 'PharmacyCatalogueEdit',
      targetId,
      metadata: { soloOwner: solo, pinVerified: solo },
    },
  });
}

function validatedChanges(
  medicine: { productFamily: string; saleable: boolean; drapRegistrationNumber: string | null },
  raw: unknown
) {
  const changes = catalogueChanges.parse(raw);
  try {
    const retail = validateRetailFields({
      productFamily: medicine.productFamily,
      retailPriceMinor: changes.retailPriceMinor,
      retailCategory: changes.retailCategory,
    });
    if ('retailCategory' in changes) changes.retailCategory = retail.retailCategory;
  } catch (error) {
    if (error instanceof PharmacyProductClassError)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Invalid retail details for this product.',
      });
    throw error;
  }
  if (
    medicine.saleable &&
    medicine.productFamily !== 'FRONT_SHOP' &&
    'drapRegistrationNumber' in changes &&
    !changes.drapRegistrationNumber?.trim()
  )
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'A published medicine requires its registration.',
    });
  return changes;
}

export async function submitCatalogueEdit(
  db: ScopedDb,
  scope: Scope,
  medicineId: string,
  rawChanges: unknown
) {
  const medicine = await db.medicine.findFirst({ where: { id: medicineId } });
  if (!medicine) throw new TRPCError({ code: 'NOT_FOUND', message: 'Catalogue item not found.' });
  const changes = validatedChanges(medicine, rawChanges);
  return db.pharmacyCatalogueEdit.create({
    data: {
      medicineId,
      editorId: scope.actorId,
      changes: changes as Prisma.InputJsonObject,
      expectedUpdatedAt: medicine.updatedAt,
    },
  });
}

export async function decideCatalogueEdit(
  db: ScopedDb,
  scope: Scope,
  input: { editId: string; decision: 'APPROVE' | 'REJECT'; soloPin?: string },
  applyCommand?: (tx: ScopedDb, operation: string, payload: Prisma.JsonValue) => Promise<unknown>
) {
  return db.$transaction(async (tx) => {
    const scoped = tx as ScopedDb;
    const proposal = await tx.pharmacyCatalogueEdit.findFirst({ where: { id: input.editId } });
    if (!proposal) throw new TRPCError({ code: 'NOT_FOUND', message: 'Catalogue edit not found.' });
    if (proposal.status !== 'PENDING')
      throw new TRPCError({ code: 'CONFLICT', message: 'Catalogue edit already reviewed.' });
    const solo =
      input.decision === 'APPROVE' &&
      (await requireIndependentCatalogueReviewer(
        scoped,
        scope,
        [proposal.editorId],
        input.soloPin
      ));
    const at = new Date();
    if (solo)
      await tx.$queryRaw`SELECT set_config('app.pharmacy_catalogue_solo_pin_user_id', ${scope.actorId}, true)`;
    // Claim before applying, so simultaneous decisions cannot both publish. All
    // writes, including audit, roll back together if the item has changed.
    const claimed = await tx.pharmacyCatalogueEdit.updateMany({
      where: { id: proposal.id, status: 'PENDING' },
      data: {
        status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        reviewerId: scope.actorId,
        reviewedAt: at,
        soloPinVerifiedAt: solo ? at : null,
      },
    });
    if (claimed.count !== 1)
      throw new TRPCError({ code: 'CONFLICT', message: 'Catalogue edit already reviewed.' });
    if (input.decision === 'APPROVE') {
      const medicine = await tx.medicine.findFirst({ where: { id: proposal.medicineId } });
      if (!medicine)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Catalogue item not found.' });
      const changes =
        proposal.operation === 'UPDATE_MEDICINE'
          ? validatedChanges(medicine, proposal.changes)
          : { updatedAt: at };
      const updated = await tx.medicine.updateMany({
        where: { id: medicine.id, updatedAt: proposal.expectedUpdatedAt },
        data: changes,
      });
      if (updated.count !== 1)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Catalogue item changed. Submit a new edit for review.',
        });
      if (proposal.operation !== 'UPDATE_MEDICINE') {
        if (!applyCommand)
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unsupported catalogue edit.' });
        await applyCommand(scoped, proposal.operation, proposal.changes);
      }
      await recordCatalogueApproval(scoped, scope, proposal.id, solo);
    }
    return { id: proposal.id, status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
  });
}
