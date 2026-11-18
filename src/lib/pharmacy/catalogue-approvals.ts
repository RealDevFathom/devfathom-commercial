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
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'Supply at least one catalogue edit.'
  );

type Scope = {
  organizationId: string;
  actorId: string;
  actorOrganizationId?: string | null;
};

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
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Fresh owner PIN verification failed.',
    });
  }
  return true;
}

export async function recordCatalogueApproval(
  db: ScopedDb,
  scope: Scope,
  targetId: string,
  solo: boolean,
  targetType = 'PharmacyCatalogueEdit'
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
      targetType,
      targetId,
      metadata: { soloOwner: solo, pinVerified: solo },
    },
  });
}

function validatedChanges(
  medicine: {
    productFamily: string;
    saleable: boolean;
    drapRegistrationNumber: string | null;
  },
  raw: unknown
) {
  const parsed = catalogueChanges.safeParse(raw);
  // Report an out-of-range or unknown field as a validation error, not a server fault.
  if (!parsed.success)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: parsed.error.issues[0]?.message ?? 'Invalid catalogue edit.',
    });
  const changes = parsed.data;
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

export const STALE_EDIT_MESSAGE =
  'This edit is out of date: the catalogue item changed after it was submitted. Reject it and submit a new edit.';

/**
 * Pending edits, each marked `stale` when the item has changed since the edit was
 * submitted (for example because another edit on it was approved). A stale edit
 * can only be rejected; approving it is refused on the server.
 */
export async function listPendingCatalogueEdits(db: ScopedDb) {
  const edits = await db.pharmacyCatalogueEdit.findMany({
    where: { status: 'PENDING' },
    include: {
      medicine: { select: { productName: true, updatedAt: true } },
      editor: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: 250,
  });
  // Pack, barcode and printed-MRP commands carry only record ids. Resolve them to
  // the pack and presentation a reviewer can recognise before approving.
  const commands = edits.map((edit) => commandIds(edit.operation, edit.changes));
  const packIds = [...new Set(commands.flatMap((ids) => ids.packs))];
  const presentationIds = [...new Set(commands.flatMap((ids) => ids.presentations))];
  const [packs, presentations] = await Promise.all([
    packIds.length
      ? db.packLevel.findMany({
          where: { id: { in: packIds } },
          include: { presentation: { select: { presentation: true } } },
        })
      : [],
    presentationIds.length
      ? db.presentation.findMany({ where: { id: { in: presentationIds } } })
      : [],
  ]);
  const packLabel = new Map(
    packs.map((pack) => [
      pack.id,
      `${pack.level} (${pack.unitsPerParent} per pack), ${pack.presentation.presentation}`,
    ])
  );
  const presentationLabel = new Map(presentations.map((item) => [item.id, item.presentation]));
  return edits.map(({ medicine, ...edit }, index) => ({
    ...edit,
    // A new ingredient belongs to no medicine yet, so it cannot go out of date.
    medicine: { productName: medicine?.productName ?? 'New ingredient' },
    stale: medicine ? medicine.updatedAt.getTime() !== edit.expectedUpdatedAt.getTime() : false,
    targets: [
      ...commands[index]!.presentations.map((id) => ({
        label: 'Presentation',
        value: presentationLabel.get(id) ?? 'Presentation not found',
      })),
      ...commands[index]!.packs.map((id) => ({
        label: 'Pack',
        value: packLabel.get(id) ?? 'Pack not found',
      })),
    ],
  }));
}

function commandIds(operation: string | undefined, changes: unknown) {
  const input =
    operation && operation !== 'UPDATE_MEDICINE' && changes && typeof changes === 'object'
      ? (changes as { json?: Record<string, unknown> }).json
      : undefined;
  const text = (value: unknown) => (typeof value === 'string' && value ? [value] : []);
  if (!input) return { packs: [] as string[], presentations: [] as string[] };
  return {
    presentations: text(input.presentationId),
    packs: [
      // revisePackLevel identifies the pack it revises by `id`.
      ...text(operation === 'revisePackLevel' ? input.id : undefined),
      ...text(input.packLevelId),
      ...text(input.parentPackLevelId),
    ],
  };
}

export async function submitCatalogueEdit(
  db: ScopedDb,
  scope: Scope,
  medicineId: string,
  rawChanges: unknown
) {
  const medicine = await db.medicine.findFirst({ where: { id: medicineId } });
  if (!medicine)
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Catalogue item not found.',
    });
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
    const proposal = await tx.pharmacyCatalogueEdit.findFirst({
      where: { id: input.editId },
    });
    if (!proposal)
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Catalogue edit not found.',
      });
    if (proposal.status !== 'PENDING')
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Catalogue edit already reviewed.',
      });
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
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Catalogue edit already reviewed.',
      });
    let staleEdits = 0;
    const medicineId = proposal.medicineId;
    if (input.decision === 'APPROVE' && medicineId === null) {
      // DEV-19: a queued new ingredient names no medicine; only that command may.
      if (proposal.operation !== 'createIngredient' || !applyCommand)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Unsupported catalogue edit.',
        });
      await applyCommand(scoped, proposal.operation, proposal.changes);
      await recordCatalogueApproval(scoped, scope, proposal.id, solo);
    } else if (input.decision === 'APPROVE' && medicineId !== null) {
      const medicine = await tx.medicine.findFirst({
        where: { id: medicineId },
      });
      if (!medicine)
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Catalogue item not found.',
        });
      const changes =
        proposal.operation === 'UPDATE_MEDICINE'
          ? validatedChanges(medicine, proposal.changes)
          : {};
      const updatedAt = new Date(Math.max(at.getTime(), proposal.expectedUpdatedAt.getTime() + 1));
      const updated = await tx.medicine.updateMany({
        where: { id: medicine.id, updatedAt: proposal.expectedUpdatedAt },
        data: { ...changes, updatedAt },
      });
      if (updated.count !== 1)
        throw new TRPCError({
          code: 'CONFLICT',
          message: STALE_EDIT_MESSAGE,
        });
      if (proposal.operation !== 'UPDATE_MEDICINE') {
        if (!applyCommand)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Unsupported catalogue edit.',
          });
        await applyCommand(scoped, proposal.operation, proposal.changes);
      }
      await recordCatalogueApproval(scoped, scope, proposal.id, solo);
      // Every other pending edit on this item was submitted against the version
      // this approval just replaced, so none of them can be approved any more.
      staleEdits = await tx.pharmacyCatalogueEdit.count({
        where: { medicineId: medicine.id, status: 'PENDING', id: { not: proposal.id } },
      });
    }
    return {
      id: proposal.id,
      status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      staleEdits,
    };
  });
}
