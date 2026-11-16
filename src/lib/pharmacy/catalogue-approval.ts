import 'server-only';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
type CatalogueDb = ScopedDb | Prisma.TransactionClient;
import { soloOwnerApprovalAllowed } from './purchase-approval';
import { verifyOwnerExportPin } from './owner-data-export-pin';
import { validateRetailFields } from './product-class';

export const catalogueChanges = z
  .object({
    productName: z.string().trim().min(1).max(300).optional(),
    brandName: z.string().trim().max(300).nullable().optional(),
    manufacturer: z.string().trim().max(300).nullable().optional(),
    marketingAuthorizationHolder: z.string().trim().max(300).nullable().optional(),
    drapRegistrationNumber: z.string().trim().max(100).nullable().optional(),
    drapRegistrationStatus: z.string().trim().max(100).nullable().optional(),
    rx: z.boolean().optional(),
    otc: z.boolean().optional(),
    restricted: z.boolean().optional(),
    controlled: z.boolean().optional(),
    highAlert: z.boolean().optional(),
    lasa: z.boolean().optional(),
    coldChain: z.boolean().optional(),
    retailPriceMinor: z.number().int().positive().max(2_147_483_647).nullable().optional(),
    retailCategory: z.string().trim().max(200).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Select at least one change.');

/** A PIN is consumed by this request only; never accept a cached client proof. */
export async function authorizeCatalogueReview(
  db: CatalogueDb,
  input: {
    organizationId: string;
    reviewerId: string;
    editorIds: Array<string | null>;
    pin?: string;
  }
) {
  if (input.editorIds.some((id) => !id)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The editor is unknown. Submit a new catalogue proposal before approval.',
    });
  }
  if (!input.editorIds.includes(input.reviewerId)) return false;
  if (
    !(await soloOwnerApprovalAllowed(db, input.organizationId, input.reviewerId)) ||
    !input.pin ||
    (await verifyOwnerExportPin({
      organizationId: input.organizationId,
      userId: input.reviewerId,
      pin: input.pin,
    })) !== 'OK'
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message:
        'A different reviewer is required. Only a solo owner may approve their own edit with a fresh valid PIN.',
    });
  }
  return true;
}

export async function recordCatalogueApproval(
  db: CatalogueDb,
  input: {
    organizationId: string;
    reviewerId: string;
    targetId: string;
    editorIds: string[];
    soloOwner: boolean;
  }
) {
  await db.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorId: input.reviewerId,
      actorType: 'USER',
      source: 'TRPC',
      category: 'PHARMACY_CATALOGUE',
      operation: 'OTHER',
      action: 'pharmacy.catalogueApproval',
      targetType: 'CatalogueProposal',
      targetId: input.targetId,
      metadata: {
        editorIds: input.editorIds,
        reviewerId: input.reviewerId,
        policy: input.soloOwner ? 'PHARMACY_SOLO_OWNER_PIN' : 'DIFFERENT_REVIEWER',
        pinVerified: input.soloOwner,
      },
    },
  });
}

export async function submitCatalogueEdit(
  db: CatalogueDb,
  input: {
    organizationId: string;
    editorId: string;
    medicineId: string;
    changes: z.infer<typeof catalogueChanges>;
  }
) {
  const changes = catalogueChanges.parse(input.changes);
  const medicine = await db.medicine.findFirst({
    where: { id: input.medicineId, organizationId: input.organizationId },
  });
  if (!medicine) throw new TRPCError({ code: 'NOT_FOUND', message: 'Medicine not found.' });
  if ('retailPriceMinor' in changes || 'retailCategory' in changes) {
    validateRetailFields({
      productFamily: medicine.productFamily,
      retailPriceMinor: changes.retailPriceMinor,
      retailCategory: changes.retailCategory,
    });
  }
  return db.pharmacyCatalogueEdit.create({
    data: {
      organizationId: input.organizationId,
      medicineId: medicine.id,
      editorId: input.editorId,
      changes,
      baseUpdatedAt: medicine.updatedAt,
    },
  });
}
