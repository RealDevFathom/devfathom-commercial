import superjson from 'superjson';
import type { TRPCContext } from '../trpc';
import {
  catalogueChanges,
  submitCatalogueEdit,
  decideCatalogueEdit,
  isOwnerWithoutOtherReviewer,
  requireIndependentCatalogueReviewer,
  recordCatalogueApproval,
  listPendingCatalogueEdits,
  NO_OTHER_REVIEWER,
} from '@/lib/pharmacy/catalogue-approvals';
import {
  confirmPriceChanges,
  priceIntelligence,
  priceOverrides,
  setManualPackPrice,
} from '@/lib/pharmacy/pricing';
import {
  dismissDrapPriceAlert,
  FileDrapNoticeSource,
  ingestDrapSource,
  listDrapPriceAlerts,
} from '@/lib/pharmacy/drap-monitoring';
import { CsvDrapNoticeSource, DrapSroCsvError } from '@/lib/pharmacy/drap-sro-csv';
import { PharmacyInventoryError } from '@/lib/pharmacy/inventory';
import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import {
  assertSaleable,
  isImportedIdentity,
  deriveLooseUnitPrice,
  medicineDuplicateKey,
  normalizeMedicineText,
  parseDefaultPackSize,
  parseSimpleMedicineStrength,
  PharmacyMedicineError,
} from '@/lib/pharmacy/medicine';
import { PharmacyProductClassError, validateRetailFields } from '@/lib/pharmacy/product-class';
import {
  configureManualReferenceConnector,
  proposedBoolean,
  REFERENCE_CONNECTORS,
  runManualReferenceConnector,
} from '@/lib/pharmacy/reference-connector-automation';
import {
  DRAP_REGISTRY_CONNECTOR_ID,
  REFERENCE_BATCH_MAX_ROWS,
  type ConnectorRights,
} from '@/lib/pharmacy/reference-connectors';
import { isEffective } from '@/lib/pharmacy/pack-conversion';
import { actorIsPharmacyOwner } from '@/lib/pharmacy/procurement-access';
import { can, subjectFromSession, type Action } from '@/lib/abac';
import {
  applyLegacyControlledToMedicine,
  hasControlledCorrection,
} from '@/lib/pharmacy/migration/legacy-controlled';
import {
  createStagedMedicinesChunk,
  STAGED_CREATION_OPERATION,
  stagedCreationProgress,
} from '@/lib/pharmacy/migration/staged-creation';
import { STAGING_MAX_ROWS } from '@/lib/pharmacy/migration/staging-input';
import { annotateAudit } from '../audit';
import {
  adminProcedure,
  auditedProtectedProcedure,
  capabilityProcedure,
  contextualCapabilityProcedure,
  router,
} from '../trpc';

const family = z.enum(['PHARMACEUTICAL', 'BIOLOGICAL', 'DEVICE', 'ALTERNATIVE', 'FRONT_SHOP']);
const boundedId = z.string().min(1).max(200);
const soloPinInput = z.string().min(1).max(64).optional();

type BoundedJsonValue = string | number | boolean | null | BoundedJsonValue[] | BoundedJsonObject;
type BoundedJsonObject = { [key: string]: BoundedJsonValue };

const jsonScalar = z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()]);

const MAX_ASSERTED_VALUE_NODES = 1_000;
const MAX_ASSERTED_VALUE_CHARACTERS = 20_000;

const assertedValueBudget = z.unknown().superRefine((value, ctx) => {
  const pending: unknown[] = [value];
  let nodes = 0;
  let characters = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;

    if (nodes > MAX_ASSERTED_VALUE_NODES) {
      ctx.addIssue({ code: 'custom', message: 'Must contain at most 1000 values' });
      return z.NEVER;
    }

    if (typeof current === 'string') characters += current.length;
    else if (Array.isArray(current)) {
      if (current.length > 20) {
        ctx.addIssue({ code: 'custom', message: 'Must contain at most 20 items' });
        return z.NEVER;
      }
      for (const child of current) pending.push(child);
    } else if (current !== null && typeof current === 'object') {
      const entries = Object.entries(current);
      if (entries.length > 20) {
        ctx.addIssue({ code: 'custom', message: 'Must contain at most 20 properties' });
        return z.NEVER;
      }
      for (const [key, child] of entries) {
        characters += key.length;
        pending.push(child);
      }
    }

    if (characters > MAX_ASSERTED_VALUE_CHARACTERS) {
      ctx.addIssue({ code: 'custom', message: 'Must contain at most 20000 characters' });
      return z.NEVER;
    }
  }
});

function boundedJsonValue(depth: number): z.ZodType<BoundedJsonValue> {
  if (depth === 0) return jsonScalar;

  const child = boundedJsonValue(depth - 1);
  return z.union([
    jsonScalar,
    z.array(child).max(20),
    z
      .record(z.string().min(1).max(100), child)
      .refine((value) => Object.keys(value).length <= 20, 'Must contain at most 20 properties'),
  ]);
}

// Check aggregate complexity before the recursive shape schema walks the full value.
const assertedValue = assertedValueBudget.pipe(boundedJsonValue(4));

// A new medicine is a review candidate: its author cannot declare a reviewer or a
// review outcome. Assertions are accepted, corrected or rejected only through
// recordReviewDecision, and the medicine becomes saleable only via publishAssertions.
const provenance = z
  .object({
    field: z.string().min(1).max(100),
    source: z.string().min(1).max(500),
    sourceType: z.enum(['REGULATOR', 'MANUFACTURER', 'SCRAPED', 'USER', 'IMPORT']),
    retrievedAt: z.date(),
    confidence: z.number().min(0).max(1).optional(),
    status: z.literal('UNREVIEWED'),
    assertedValue: assertedValue.optional(),
  })
  .strict();

const connectorRights = z
  .object({
    acquisition: z.string().min(1).max(500),
    cache: z.string().min(1).max(500),
    redistribution: z.string().min(1).max(500),
    deletion: z.string().min(1).max(500),
  })
  .strict();

const referenceField = z.enum([
  'productName',
  'brandName',
  'manufacturer',
  'drapRegistrationNumber',
  'strength',
  'dosageForm',
  'pack',
  'barcode',
  'alias',
  'rx',
  'restricted',
  'controlled',
]);

const referenceAssertion = z
  .object({
    field: referenceField,
    value: z.string().trim().min(1).max(1_000),
    source: z.string().trim().min(1).max(500),
    sourceType: z.enum(['REGULATOR', 'MANUFACTURER', 'SCRAPED', 'USER', 'IMPORT']),
    retrievedAt: z.string().datetime(),
    confidence: z.number().min(0).max(1).optional(),
    batchId: z.string().trim().min(1).max(200),
    rowSourceKey: z.string().trim().min(1).max(300),
    rights: connectorRights,
  })
  .strict();

const assertedEnvelope = z
  .object({
    value: z.string().trim().min(1).max(1_000),
    connectorId: z.string().trim().min(1).max(200),
    sourceLabel: z.string().trim().min(1).max(500),
    batchId: z.string().trim().min(1).max(200),
    rowSourceKey: z.string().trim().min(1).max(300),
    rights: connectorRights,
    blockingIssues: z.array(z.string().min(1).max(100)).max(4),
  })
  .strict();

const connectorProposalPayload = z
  .object({
    values: z.partialRecord(referenceField, z.string().trim().min(1).max(1_000)),
    source: z
      .object({
        connectorId: z.enum(['manual-file', DRAP_REGISTRY_CONNECTOR_ID]),
        label: z.string().trim().min(1).max(200),
        fileName: z.string().trim().min(1).max(500),
        batchId: z.string().trim().min(1).max(200),
        rowSourceKey: z.string().trim().min(1).max(300),
        rights: connectorRights,
      })
      .strict(),
  })
  .strict();

const assertionIdsPayload = z
  .object({
    assertionIds: z.array(boundedId).min(1).max(20),
  })
  .strict();

function jsonConnectorRights(rights: ConnectorRights): Prisma.InputJsonObject {
  return {
    acquisition: rights.acquisition,
    cache: rights.cache,
    redistribution: rights.redistribution,
    deletion: rights.deletion,
  };
}

const reviewDecisionInput = z.discriminatedUnion('action', [
  z
    .object({
      duplicateKey: z.string().min(1).max(700),
      action: z.enum(['ACCEPT', 'REJECT', 'DEFER']),
      medicineIds: z.array(boundedId).min(1).max(50),
      payload: assertionIdsPayload,
      soloPin: soloPinInput,
    })
    .strict(),
  z
    .object({
      duplicateKey: z.string().min(1).max(700),
      action: z.literal('CORRECT'),
      soloPin: soloPinInput,
      medicineIds: z.array(boundedId).min(1).max(50),
      payload: assertionIdsPayload
        .extend({
          corrections: z
            .array(
              z
                .object({
                  assertionId: boundedId,
                  value: z.string().trim().min(1).max(1_000),
                })
                .strict()
            )
            .min(1)
            .max(20),
        })
        .strict(),
    })
    .strict(),
]);

type BarcodeDb = Pick<Prisma.TransactionClient, 'medicineBarcode'>;

/**
 * Puts a scan code on one pack size. Codes are unique per tenant and barcode
 * rows are append-only (the `pharmacy_barcodes_append_only` trigger rejects
 * UPDATE and DELETE), so a code is only ever inserted: one already on this pack
 * is reused, and one held anywhere else (another pack, an older unpacked
 * publication, or another medicine) conflicts instead of being moved.
 */
async function attachPackBarcode(
  db: BarcodeDb,
  input: {
    medicineId: string;
    presentationId: string;
    packLevelId: string;
    type: 'GTIN' | 'MANUFACTURER' | 'INTERNAL';
    code: string;
  }
) {
  const normalizedCode = normalizeMedicineText(input.code);
  if (!normalizedCode)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Enter a barcode with letters or digits.',
    });
  const existing = await db.medicineBarcode.findFirst({
    where: { normalizedCode },
    include: { presentation: { select: { medicineId: true } } },
  });
  if (!existing) {
    try {
      return await db.medicineBarcode.create({
        data: {
          presentationId: input.presentationId,
          packLevelId: input.packLevelId,
          type: input.type,
          code: input.code,
          normalizedCode,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This barcode was just added elsewhere. Reload and retry.',
        });
      throw error;
    }
  }
  if (existing.packLevelId === input.packLevelId) return existing;
  throw new TRPCError({
    code: 'CONFLICT',
    message:
      existing.presentation.medicineId === input.medicineId && existing.packLevelId === null
        ? 'This barcode is already recorded for an earlier presentation of this medicine and barcodes cannot be moved. Remove it from the reviewed values, or import opening stock by pack ID.'
        : 'This barcode is already assigned to another pack. Barcodes cannot be moved; use the code printed on this pack.',
  });
}

function domainError(error: unknown): never {
  if (error instanceof PharmacyProductClassError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  if (error instanceof PharmacyMedicineError) {
    throw new TRPCError({
      code:
        error.reason === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.reason === 'CROSS_TENANT_REFERENCE'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST',
      message: error.message,
    });
  }
  throw error;
}

// Only this module can attach the replay token; client input is always parsed
// by the original procedure again when a reviewer approves a queued command.
// Its value is the approver's authority, which the replayed procedure re-checks.
const catalogueReplay = Symbol('catalogueApproval');
const replayAuthority = (ctx: TRPCContext) =>
  (ctx as TRPCContext & { [catalogueReplay]?: readonly Action[] })[catalogueReplay];
const isCatalogueReplay = (ctx: TRPCContext) => Array.isArray(replayAuthority(ctx));
// DEV-19: submitting any catalogue edit needs the catalogue-edit capability (deny
// by default) on top of tenant administration; an explicit DENY refuses an admin.
const CATALOGUE_EDIT_ACTIONS = ['admin:access', 'pharmacy:catalogue-edit'] as const;
const REVIEWER_AUTHORITY = ['pharmacy:catalogue-review'] as const;
// An owner approving without the review grant (no other reviewer) is held to the editor's own
// capabilities; their fresh PIN was verified before the replay.
const SOLO_OWNER_AUTHORITY = CATALOGUE_EDIT_ACTIONS;
const catalogueEditProcedure = contextualCapabilityProcedure(() => CATALOGUE_EDIT_ACTIONS);
// A catalogue command is submitted by a catalogue editor. When an approved edit
// replays it, the approver's own authority authorizes the write, so a pharmacist
// reviewer who is not a tenant administrator can apply what they approve.
const catalogueCommandProcedure = contextualCapabilityProcedure(
  (ctx) => replayAuthority(ctx) ?? CATALOGUE_EDIT_ACTIONS
);

/**
 * Who may see and decide the catalogue queue. A reviewer holds the exact
 * pharmacy:catalogue-review grant. A pharmacy owner (live owner authority, no
 * DENY) may decide without it while no other active member holds it, but approves
 * only with a fresh PIN. An editor may see the queue they submit to.
 */
async function catalogueAccess(ctx: TRPCContext) {
  const user = ctx.session!.user;
  const subject = subjectFromSession(user);
  const opts = { db: ctx.db, source: 'TRPC' as const, ip: ctx.requestMeta.ip };
  const allowed = async (actions: readonly Action[]) => {
    for (const action of actions) if (!(await can(subject, action, undefined, opts))) return false;
    return true;
  };
  const reviewer = await allowed(REVIEWER_AUTHORITY);
  const editor = await allowed(CATALOGUE_EDIT_ACTIONS);
  const scope = {
    organizationId: ctx.entitlements.organizationId,
    actorId: user.id,
    actorOrganizationId: user.organizationId,
  };
  const ownerFallback = !reviewer && editor && (await isOwnerWithoutOtherReviewer(ctx.db, scope));
  const owner =
    ownerFallback || (await actorIsPharmacyOwner(ctx.db, scope.organizationId, user.id));
  return { reviewer, editor, ownerFallback, owner };
}
const catalogueCommands = [
  'setPackPrice',
  'createIngredient',
  'createPackLevel',
  'revisePackLevel',
  'recordPrintedMrp',
  'addBarcode',
  'setPackBarcode',
  'addAlias',
  STAGED_CREATION_OPERATION,
] as const;
type CatalogueCommand = (typeof catalogueCommands)[number];
async function queueCatalogueCommand(
  ctx: TRPCContext,
  medicineId: string,
  operation: CatalogueCommand,
  input: unknown
) {
  if (isCatalogueReplay(ctx)) return;
  const medicine = await ctx.db.medicine.findFirst({
    where: { id: medicineId },
  });
  if (!medicine)
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Catalogue item not found.',
    });
  return ctx.db.pharmacyCatalogueEdit.create({
    data: {
      medicineId,
      editorId: ctx.session!.user.id,
      operation,
      changes: superjson.serialize(input) as unknown as Prisma.InputJsonObject,
      expectedUpdatedAt: medicine.updatedAt,
    },
  });
}
async function applyCatalogueCommand(
  ctx: TRPCContext,
  tx: typeof ctx.db,
  operation: string,
  payload: Prisma.JsonValue,
  authority: readonly Action[]
): Promise<unknown> {
  if (!catalogueCommands.includes(operation as CatalogueCommand))
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Unsupported catalogue edit.',
    });
  const replayContext = { ...ctx, db: tx, [catalogueReplay]: authority };
  const caller = pharmacyMedicineRouter.createCaller(replayContext) as unknown as Record<
    CatalogueCommand,
    (input: unknown) => Promise<unknown>
  >;
  return caller[operation as CatalogueCommand](
    superjson.deserialize(payload as unknown as Parameters<typeof superjson.deserialize>[0])
  );
}

/**
 * DEV-923: recording a review decision, publishing reviewed assertions and reversing a
 * publication are reviewer work. They need the exact pharmacy:catalogue-review grant,
 * resolved by the ABAC engine (an explicit DENY refuses anyone), with no tenant-admin
 * requirement, so a Pharmacist reviews. The one exception is DEV-19's owner fallback: an
 * owner (live owner authority, no DENY) while no other active member can review; their
 * acceptances then need a fresh PIN.
 */
const reviewerProcedure = auditedProtectedProcedure.use(async ({ ctx, next }) => {
  const access = await catalogueAccess(ctx);
  if (!access.reviewer && !access.ownerFallback)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Reviewing and publishing catalogue changes needs the catalogue review permission.',
    });
  return next({ ctx: { catalogueOwnerFallback: !access.reviewer } });
});

const DUPLICATE_INGREDIENT_MESSAGE = 'This ingredient already exists. Use the existing one.';
const DUPLICATE_PACK_MESSAGE =
  'This pack already exists for this medicine. Use the existing pack instead of adding it again.';

export const pharmacyMedicineRouter = router({
  // DEV-19: reviewers and the owner with no other reviewer read the queue they decide; editors read
  // the queue they submit to. Everyone else is refused.
  catalogueEdits: auditedProtectedProcedure.query(async ({ ctx }) => {
    const access = await catalogueAccess(ctx);
    if (!access.reviewer && !access.editor)
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'You do not have permission for this action.',
      });
    return listPendingCatalogueEdits(ctx.db);
  }),
  /** What the signed-in member may do in the catalogue queue, for the UI only. */
  catalogueQueueAccess: auditedProtectedProcedure.query(async ({ ctx }) => {
    const access = await catalogueAccess(ctx);
    return {
      canEdit: access.editor,
      canDecide: access.reviewer || access.ownerFallback,
      // The owner approves with their own fresh PIN because nobody else can review.
      ownerPinApproval: access.ownerFallback,
      isOwner: access.owner,
    };
  }),
  proposeCatalogueEdit: catalogueEditProcedure
    .input(z.object({ medicineId: boundedId, changes: catalogueChanges }).strict())
    .mutation(({ ctx, input }) =>
      submitCatalogueEdit(
        ctx.db,
        {
          organizationId: ctx.entitlements.organizationId,
          actorId: ctx.session.user.id,
        },
        input.medicineId,
        input.changes
      )
    ),
  // DEV-19: a decision needs the pharmacist review capability, decided by the ABAC
  // engine like connector proposals: an explicit DENY refuses even an administrator.
  // The one exception is an owner while no other active member can review: they
  // approve with a fresh PIN.
  decideCatalogueEdit: auditedProtectedProcedure
    .input(
      z
        .object({
          editId: boundedId,
          decision: z.enum(['APPROVE', 'REJECT']),
          soloPin: soloPinInput,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const access = await catalogueAccess(ctx);
      if (!access.reviewer && !access.ownerFallback)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Approving catalogue edits needs the catalogue review permission.',
        });
      const authority = access.reviewer ? REVIEWER_AUTHORITY : SOLO_OWNER_AUTHORITY;
      return decideCatalogueEdit(
        ctx.db,
        {
          organizationId: ctx.entitlements.organizationId,
          actorId: ctx.session.user.id,
          actorOrganizationId: ctx.session.user.organizationId,
        },
        input,
        (tx, operation, payload) => applyCatalogueCommand(ctx, tx, operation, payload, authority),
        { soloOwnerAuthority: !access.reviewer, ownerWithoutOtherReviewer: true }
      );
    }),
  priceNotices: capabilityProcedure('pharmacy:safety').query(({ ctx }) =>
    priceIntelligence(ctx.db, {
      organizationId: ctx.entitlements.organizationId,
      actorId: ctx.session.user.id,
    })
  ),
  confirmPrices: capabilityProcedure('pharmacy:safety')
    .input(z.object({ proposalIds: z.array(z.string().min(1).max(200)).min(1).max(100) }).strict())
    .mutation(({ ctx, input }) =>
      confirmPriceChanges(
        ctx.db,
        { organizationId: ctx.entitlements.organizationId, actorId: ctx.session.user.id },
        input.proposalIds
      )
    ),
  ingestPriceNotices: capabilityProcedure('pharmacy:safety')
    .input(
      z
        .object({
          contents: z.string().min(2).max(1000000),
          // DEV-693: an SRO price schedule may be uploaded as CSV as well as JSON.
          format: z.enum(['json', 'csv']).default('json'),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const source =
        input.format === 'csv'
          ? new CsvDrapNoticeSource(input.contents)
          : new FileDrapNoticeSource(input.contents);
      let notices;
      try {
        notices = await source.read();
      } catch (error) {
        if (error instanceof DrapSroCsvError)
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
        throw error;
      }
      if (!notices.length || notices.length > 100 || notices.some((n) => n.kind !== 'PRICE'))
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Supply 1–100 PRICE notices' });
      return ctx.db.$transaction((tx) =>
        ingestDrapSource(
          tx as typeof ctx.db,
          { organizationId: ctx.entitlements.organizationId, actorId: ctx.session.user.id },
          source
        )
      );
    }),
  /** DEV-693: official DRAP price changes, for information only. Never a price write. */
  drapPriceAlerts: capabilityProcedure('pharmacy:safety')
    .input(
      z
        .object({ medicineIds: z.array(z.string().min(1).max(200)).min(1).max(500).optional() })
        .strict()
        .optional()
    )
    .query(({ ctx, input }) =>
      listDrapPriceAlerts(
        ctx.db,
        { organizationId: ctx.entitlements.organizationId, actorId: ctx.session.user.id },
        input?.medicineIds
      )
    ),
  dismissDrapPriceAlert: capabilityProcedure('pharmacy:safety')
    .input(z.object({ alertId: z.string().min(1).max(200) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await dismissDrapPriceAlert(
          ctx.db,
          { organizationId: ctx.entitlements.organizationId, actorId: ctx.session.user.id },
          input.alertId
        );
      } catch (error) {
        if (error instanceof PharmacyInventoryError && error.reason === 'NOT_FOUND')
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'This alert was already dismissed or does not exist.',
          });
        throw error;
      }
    }),
  setPackPrice: catalogueCommandProcedure
    .input(
      z
        .object({
          packLevelId: z.string().min(1).max(200),
          branchId: z.string().min(1).max(200).optional(),
          mrpMinor: z.number().int().min(0).max(2147483647),
          sellingPriceMinor: z.number().int().min(0).max(2147483647).nullable(),
          effectiveFrom: z.date(),
        })
        .strict()
    )
    // DEV-923: a pack price is what the counter charges, so it is a reviewed catalogue
    // edit. It is queued and written only when another reviewer approves it (or a solo
    // owner with their fresh PIN), with the same approval audit as every catalogue edit.
    .mutation(async ({ ctx, input }) => {
      if (input.sellingPriceMinor !== null && input.sellingPriceMinor > input.mrpMinor)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Selling price cannot exceed MRP' });
      const pack = await ctx.db.packLevel.findFirst({
        where: { id: input.packLevelId },
        include: { presentation: true },
      });
      if (!pack) throw new TRPCError({ code: 'NOT_FOUND', message: 'Pack not found.' });
      const queued = await queueCatalogueCommand(
        ctx,
        pack.presentation.medicineId,
        'setPackPrice',
        input
      );
      if (queued) return queued;
      return setManualPackPrice(
        ctx.db,
        { organizationId: ctx.entitlements.organizationId, actorId: ctx.session.user.id },
        input
      );
    }),
  priceOverrides: adminProcedure
    .input(z.object({ branchId: z.string().min(1).max(200).optional() }).strict())
    .query(({ ctx, input }) =>
      priceOverrides(
        ctx.db,
        { organizationId: ctx.entitlements.organizationId, actorId: ctx.session.user.id },
        input.branchId
      )
    ),

  configureReferenceConnector: adminProcedure
    .input(
      z
        .object({
          label: z.string().trim().min(1).max(200).default('Manual CSV / Excel'),
          enabled: z.boolean().default(true),
          schedule: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('MANUAL') }).strict(),
            z
              .object({
                kind: z.literal('EXPLICIT_CALL'),
                expression: z.string().trim().min(1).max(120),
                timezone: z.string().trim().min(1).max(100),
              })
              .strict(),
          ]),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      configureManualReferenceConnector(ctx.db, {
        organizationId: ctx.entitlements.organizationId,
        actorId: ctx.session.user.id,
        ...input,
      })
    ),

  referenceConnectorState: adminProcedure.query(({ ctx }) =>
    ctx.db.pharmacyReferenceConnector.findMany({
      include: { runs: { orderBy: { startedAt: 'desc' }, take: 20 } },
      orderBy: { createdAt: 'asc' },
    })
  ),

  runReferenceConnectorNow: adminProcedure
    .input(
      z
        .object({
          connectorId: z.enum(['manual-file', DRAP_REGISTRY_CONNECTOR_ID]),
          batchId: z.string().trim().min(1).max(200),
          fileName: z.string().trim().min(1).max(500),
          triggerKind: z.enum(['MANUAL', 'SCHEDULED_CALL']).default('MANUAL'),
          rows: z
            .array(
              z
                .object({
                  batchId: z.string().trim().min(1).max(200),
                  rowSourceKey: z.string().trim().min(1).max(300),
                  targetMedicineId: z.string().trim().min(1).max(200).optional(),
                  values: z
                    .record(z.string().min(1).max(100), z.string().trim().min(1).max(1_000))
                    .refine(
                      (value) => Object.keys(value).length <= 50,
                      'Must contain at most 50 fields'
                    ),
                  assertions: z.array(referenceAssertion).min(1).max(20),
                  blockingIssues: z
                    .array(
                      z.enum([
                        'MISSING_PRODUCT_NAME',
                        'MISSING_STRENGTH',
                        'MISSING_DOSAGE_FORM',
                        'MISSING_PACK',
                        'INVALID_SCHEDULE_CLASSIFICATION',
                      ])
                    )
                    .max(5),
                })
                .strict()
            )
            .min(1)
            .max(REFERENCE_BATCH_MAX_ROWS),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const descriptor = REFERENCE_CONNECTORS[input.connectorId];
      if (input.rows.some((row) => row.batchId !== input.batchId)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Every row must belong to this batch.',
        });
      }
      if (
        input.rows.some((row) => {
          const valueFields = Object.keys(row.values);
          const assertionFields = row.assertions.map((assertion) => assertion.field);
          return (
            valueFields.some(
              (field) =>
                !referenceField.options.includes(field as (typeof referenceField.options)[number])
            ) ||
            new Set(assertionFields).size !== assertionFields.length ||
            assertionFields.length !== valueFields.length ||
            row.assertions.some(
              (assertion) =>
                assertion.batchId !== input.batchId ||
                assertion.rowSourceKey !== row.rowSourceKey ||
                assertion.sourceType !== descriptor.sourceType ||
                row.values[assertion.field] !== assertion.value ||
                assertion.source !== input.fileName ||
                JSON.stringify(assertion.rights) !== JSON.stringify(descriptor.rights)
            )
          );
        })
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Manual provenance must match its batch, source row, and mapped value.',
        });
      }
      // Rx, restricted and controlled flags from the official registry must be explicit
      // true/false values; a row that could not be read is blocked, never guessed.
      if (
        descriptor.official &&
        input.rows.some(
          (row) =>
            !row.blockingIssues.includes('INVALID_SCHEDULE_CLASSIFICATION') &&
            (['rx', 'restricted', 'controlled'] as const).some(
              (field) =>
                row.values[field] !== undefined && !['true', 'false'].includes(row.values[field]!)
            )
        )
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'DRAP schedule flags must be true or false.',
        });
      }

      return ctx.db.$transaction((tx) =>
        runManualReferenceConnector(tx, {
          organizationId: ctx.entitlements.organizationId,
          actorId: ctx.session.user.id,
          connectorKey: input.connectorId,
          triggerKind: input.triggerKind,
          batchId: input.batchId,
          fileName: input.fileName,
          rows: input.rows,
        })
      );
    }),

  referenceConnectorProposals: capabilityProcedure('pharmacy:catalogue-review').query(({ ctx }) =>
    ctx.db.pharmacyReferenceConnectorProposal.findMany({
      where: { status: 'PENDING' },
      include: { run: true, targetMedicine: true },
      orderBy: { createdAt: 'asc' },
      take: 250,
    })
  ),

  decideReferenceConnectorProposal: capabilityProcedure('pharmacy:catalogue-review')
    .input(
      z
        .object({
          proposalId: z.string().trim().min(1).max(200),
          decision: z.enum(['CONFIRM', 'REJECT']),
          soloPin: soloPinInput,
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const proposal = await tx.pharmacyReferenceConnectorProposal.findFirst({
          where: { id: input.proposalId },
          include: { run: { select: { triggeredBy: true } } },
        });
        if (!proposal) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Connector proposal not found.' });
        }
        if (proposal.status !== 'PENDING') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Connector proposal already has a pharmacist decision.',
          });
        }
        const decidedAt = new Date();
        if (input.decision === 'REJECT') {
          // Guard on status so a concurrent CONFIRM and REJECT cannot both apply.
          const data = { status: 'REJECTED', decidedBy: ctx.session.user.id, decidedAt } as const;
          const rejected = await tx.pharmacyReferenceConnectorProposal.updateMany({
            where: { id: proposal.id, status: 'PENDING' },
            data,
          });
          if (rejected.count !== 1)
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Connector proposal already has a pharmacist decision.',
            });
          return { id: proposal.id, ...data };
        }

        const scope = {
          organizationId: ctx.entitlements.organizationId,
          actorId: ctx.session.user.id,
          actorOrganizationId: ctx.session.user.organizationId,
        };
        if (!proposal.run.triggeredBy)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Resubmit this source with editor evidence before approval.',
          });
        const solo = await requireIndependentCatalogueReviewer(
          tx as typeof ctx.db,
          scope,
          [proposal.run.triggeredBy],
          input.soloPin
        );
        if (solo)
          await recordCatalogueApproval(
            tx as typeof ctx.db,
            scope,
            proposal.id,
            true,
            'PharmacyReferenceConnectorProposal'
          );

        const payload = connectorProposalPayload.parse(proposal.payload);
        const values = payload.values;
        const source = REFERENCE_CONNECTORS[payload.source.connectorId];
        let medicine = proposal.targetMedicineId
          ? await tx.medicine.findFirst({ where: { id: proposal.targetMedicineId } })
          : null;
        let keptCorrection = false;
        if (proposal.targetMedicineId && !medicine) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Target medicine not found.' });
        }
        if (!medicine) {
          if (!values.productName) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'A new medicine proposal requires productName.',
            });
          }
          medicine = await tx.medicine.create({
            data: {
              productName: values.productName,
              brandName: values.brandName,
              manufacturer: values.manufacturer,
              drapRegistrationNumber: values.drapRegistrationNumber,
              rx: proposedBoolean(values.rx),
              restricted: proposedBoolean(values.restricted),
              controlled: proposedBoolean(values.controlled),
              productFamily: 'PHARMACEUTICAL',
              saleable: false,
            },
          });
        } else {
          // DEV-925: an import never sets back a person's correction to "not controlled".
          keptCorrection =
            source.sourceType === 'IMPORT' &&
            !medicine.controlled &&
            proposedBoolean(values.controlled) === true &&
            (await hasControlledCorrection(
              tx as typeof ctx.db,
              ctx.entitlements.organizationId,
              medicine.id
            ));
          medicine = await tx.medicine.update({
            where: { id: medicine.id },
            data: {
              productName: values.productName,
              brandName: values.brandName,
              manufacturer: values.manufacturer,
              drapRegistrationNumber: values.drapRegistrationNumber,
              rx: proposedBoolean(values.rx),
              restricted: proposedBoolean(values.restricted),
              controlled: keptCorrection ? undefined : proposedBoolean(values.controlled),
            },
          });
        }

        // DEV-854: a staged NARCOTICS-class legacy row makes this medicine controlled, no hold.
        await applyLegacyControlledToMedicine(
          tx as typeof ctx.db,
          ctx.entitlements.organizationId,
          medicine
        );

        const assertions = [];
        for (const [field, value] of Object.entries(values)) {
          // The import's controlled value was not applied, so it is not recorded as accepted.
          if (keptCorrection && field === 'controlled') continue;
          assertions.push(
            await tx.medicineProvenance.create({
              data: {
                medicineId: medicine.id,
                editorId: proposal.run.triggeredBy,
                field,
                source: `${source.key}:${proposal.inputDigest}:${proposal.rowSourceKey}`,
                sourceType: source.sourceType,
                retrievedAt: decidedAt,
                reviewer: ctx.session.user.id,
                status: 'ACCEPTED',
                assertedValue: {
                  value,
                  connectorId: payload.source.connectorId,
                  sourceLabel: payload.source.fileName,
                  batchId: payload.source.batchId,
                  rowSourceKey: payload.source.rowSourceKey,
                  rights: jsonConnectorRights(source.rights),
                  blockingIssues: [],
                },
              },
            })
          );
        }
        await tx.medicineReviewDecision.create({
          data: {
            duplicateKey: `connector:${proposal.id}`,
            action: 'ACCEPT',
            medicineIds: [medicine.id],
            payload: { assertionIds: assertions.map((assertion) => assertion.id) },
            reviewerId: ctx.session.user.id,
          },
        });
        const data = {
          status: 'CONFIRMED',
          targetMedicineId: medicine.id,
          decidedBy: ctx.session.user.id,
          decidedAt,
        } as const;
        // A concurrent decision may have claimed the row since it was read; refuse
        // with the same conflict as REJECT, rolling back everything written above.
        const confirmed = await tx.pharmacyReferenceConnectorProposal.updateMany({
          where: { id: proposal.id, status: 'PENDING' },
          data,
        });
        if (confirmed.count !== 1)
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Connector proposal already has a pharmacist decision.',
          });
        return { id: proposal.id, ...data };
      })
    ),

  referenceCandidates: adminProcedure.query(({ ctx }) =>
    ctx.db.medicine.findMany({
      where: {
        saleable: false,
        provenance: {
          some: {
            supersededBy: { none: {} },
            OR: [
              { status: 'UNREVIEWED' },
              {
                status: { in: ['ACCEPTED', 'CORRECTED'] },
                publicationEntries: { none: { batch: { status: 'PUBLISHED' } } },
              },
            ],
          },
        },
      },
      include: {
        provenance: {
          where: { supersededBy: { none: {} } },
          orderBy: { createdAt: 'asc' },
        },
        presentations: true,
        aliases: true,
        strengths: { include: { ingredient: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 250,
    })
  ),

  // DEV-19: a new ingredient is queued for review like every other catalogue edit.
  createIngredient: catalogueCommandProcedure
    .input(z.object({ name: z.string().trim().min(1).max(200) }).strict())
    .mutation(async ({ ctx, input }) => {
      // Checked when the edit is submitted and again when an approval replays it.
      if (await ctx.db.ingredient.findFirst({ where: { name: input.name } }))
        throw new TRPCError({ code: 'CONFLICT', message: DUPLICATE_INGREDIENT_MESSAGE });
      if (!isCatalogueReplay(ctx))
        return ctx.db.pharmacyCatalogueEdit.create({
          data: {
            medicineId: null,
            editorId: ctx.session.user.id,
            operation: 'createIngredient',
            changes: superjson.serialize(input) as unknown as Prisma.InputJsonObject,
            // A new ingredient has no prior version for this edit to go stale against.
            expectedUpdatedAt: new Date(),
          },
        });
      try {
        return await ctx.db.ingredient.create({ data: input });
      } catch (error) {
        if ((error as { code?: string })?.code === 'P2002')
          throw new TRPCError({ code: 'CONFLICT', message: DUPLICATE_INGREDIENT_MESSAGE });
        throw error;
      }
    }),

  /**
   * DEV-912: ask for every named row of a staged legacy file to become a catalogue medicine. One
   * request covers the whole batch and waits in the catalogue review queue; it is approved once,
   * by a different reviewer, or by the owner with a fresh PIN when nobody else can review. The
   * approval replays this command, which checks the batch again; `runStagedMedicineCreation`
   * then creates the medicines in chunks.
   */
  createStagedMedicines: catalogueCommandProcedure
    .input(
      z
        .object({
          batchId: boundedId,
          // Filled in by the server when the request is made, so the reviewer sees what they approve.
          fileName: z.string().max(255).optional(),
          sourceSha256: z.string().max(64).optional(),
          medicines: z.number().int().min(1).max(STAGING_MAX_ROWS).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pharmacy-staged-medicine-request:${ctx.entitlements.organizationId}:${input.batchId}`}, 0))`;
        const batch = await tx.pharmacyMigrationBatch.findFirst({
          where: {
            id: input.batchId,
            organizationId: ctx.entitlements.organizationId,
            status: 'PROFILED',
          },
          select: {
            id: true,
            updatedAt: true,
            source: { select: { fileName: true, contentHash: true } },
          },
        });
        if (!batch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Staged file not found.' });
        const progress = await stagedCreationProgress(
          tx,
          ctx.entitlements.organizationId,
          batch.id
        );
        const request = {
          batchId: batch.id,
          fileName: batch.source.fileName.slice(0, 255),
          sourceSha256: batch.source.contentHash,
          medicines: progress.candidates,
        };
        if (isCatalogueReplay(ctx)) {
          // The approval names exactly the batch and file the editor asked for.
          if (
            input.fileName !== request.fileName ||
            input.sourceSha256 !== request.sourceSha256 ||
            input.medicines !== request.medicines
          )
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'This request no longer matches its staged file. Reject it and ask again.',
            });
          return request;
        }
        if (!progress.candidates)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'This file has no medicine names to create.',
          });
        // Asking again returns the open or approved request instead of a second one.
        const existing = await tx.pharmacyCatalogueEdit.findFirst({
          where: {
            operation: STAGED_CREATION_OPERATION,
            status: { in: ['PENDING', 'APPROVED'] },
            changes: { path: ['json', 'batchId'], equals: batch.id },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        if (existing) return existing;
        return tx.pharmacyCatalogueEdit.create({
          data: {
            medicineId: null,
            editorId: ctx.session.user.id,
            operation: STAGED_CREATION_OPERATION,
            changes: superjson.serialize(request) as unknown as Prisma.InputJsonObject,
            expectedUpdatedAt: batch.updatedAt,
          },
        });
      })
    ),

  /** DEV-912: where a staged file's bulk creation stands, for an editor or a reviewer. */
  stagedMedicineCreation: auditedProtectedProcedure
    .input(z.object({ batchId: boundedId }).strict())
    .query(async ({ ctx, input }) => {
      const access = await catalogueAccess(ctx);
      if (!access.editor && !access.reviewer)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have permission for this action.',
        });
      const [request] = await ctx.db.pharmacyCatalogueEdit.findMany({
        where: {
          operation: STAGED_CREATION_OPERATION,
          changes: { path: ['json', 'batchId'], equals: input.batchId },
        },
        // An approved request outranks a pending or rejected one.
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        select: { id: true, status: true, editorId: true, reviewerId: true },
        take: 1,
      });
      return {
        request: request ?? null,
        canRequest: access.editor,
        ...(await stagedCreationProgress(ctx.db, ctx.entitlements.organizationId, input.batchId)),
      };
    }),

  /**
   * DEV-912: create the next chunk of medicines from an approved staged file. Running it again,
   * or for a second batch of the same file, creates nothing twice.
   */
  runStagedMedicineCreation: auditedProtectedProcedure
    .input(z.object({ batchId: boundedId }).strict())
    .mutation(async ({ ctx, input }) => {
      const access = await catalogueAccess(ctx);
      if (!access.editor && !access.reviewer)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have permission for this action.',
        });
      const result = await ctx.db.$transaction(
        async (tx) => {
          const approved = await tx.pharmacyCatalogueEdit.findFirst({
            where: {
              operation: STAGED_CREATION_OPERATION,
              status: 'APPROVED',
              changes: { path: ['json', 'batchId'], equals: input.batchId },
            },
            orderBy: [{ reviewedAt: 'asc' }, { id: 'asc' }],
            select: { id: true, editorId: true, reviewerId: true },
          });
          if (!approved?.reviewerId)
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Creating these medicines needs an approved request first.',
            });
          return {
            editId: approved.id,
            ...(await createStagedMedicinesChunk(
              tx as typeof ctx.db,
              { organizationId: ctx.entitlements.organizationId, actorId: ctx.session.user.id },
              {
                editId: approved.id,
                editorId: approved.editorId,
                reviewerId: approved.reviewerId,
                batchId: input.batchId,
              }
            )),
          };
        },
        { maxWait: 10_000, timeout: 120_000 }
      );
      const { medicineIds, ...summary } = result;
      annotateAudit(ctx, {
        targetType: 'PharmacyMigrationBatch',
        targetId: input.batchId,
        metadata: { ...summary, firstMedicineId: medicineIds[0] ?? null },
      });
      return summary;
    }),

  createMedicine: catalogueEditProcedure
    .input(
      z
        .object({
          productName: z.string().trim().min(1).max(300),
          brandName: z.string().trim().max(300).optional(),
          manufacturer: z.string().trim().max(300).optional(),
          marketingAuthorizationHolder: z.string().trim().max(300).optional(),
          drapRegistrationNumber: z.string().trim().max(100).optional(),
          drapRegistrationStatus: z.string().trim().max(100).optional(),
          drapRegisteredAt: z.date().optional(),
          productFamily: family,
          rx: z.boolean().optional(),
          otc: z.boolean().optional(),
          restricted: z.boolean().optional(),
          controlled: z.boolean().optional(),
          highAlert: z.boolean().optional(),
          lasa: z.boolean().optional(),
          coldChain: z.boolean().optional(),
          presentation: z
            .object({
              dosageForm: z.string().max(100).optional(),
              route: z.string().max(100).optional(),
              presentation: z.string().min(1).max(300),
            })
            .optional(),
          strengths: z
            .array(
              z
                .object({
                  ingredientId: z.string().min(1).max(200),
                  value: z.number().positive(),
                  unit: z.string().trim().min(1).max(50),
                })
                .strict()
            )
            .max(20)
            .default([]),
          provenance: z.array(provenance).max(20).default([]),
          // Never saleable on creation: publication follows a recorded review.
          saleable: z.literal(false).default(false),
          // #718: NON_DRUG_RETAIL (FRONT_SHOP) only — shop-set price, EAN-13 and category.
          retailPriceMinor: z.number().int().positive().safe().optional(),
          retailCategory: z.string().max(200).optional(),
          ean13: z.string().trim().max(13).optional(),
        })
        .strict()
        .refine((value) => !value.ean13 || Boolean(value.presentation), {
          message: 'An EAN-13 is printed on a presentation; add the presentation first.',
          path: ['ean13'],
        })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const retail = validateRetailFields({
          productFamily: input.productFamily,
          retailPriceMinor: input.retailPriceMinor,
          retailCategory: input.retailCategory,
          ean13: input.ean13,
        });
        for (const component of input.strengths) {
          if (!(await ctx.db.ingredient.findFirst({ where: { id: component.ingredientId } }))) {
            throw new PharmacyMedicineError('CROSS_TENANT_REFERENCE');
          }
        }
        const { presentation, strengths, provenance: assertions, ...rest } = input;
        // The validated retail values below replace the raw ones; the EAN-13 lives on a barcode.
        const medicine = { ...rest };
        delete medicine.retailPriceMinor;
        delete medicine.retailCategory;
        delete medicine.ean13;
        return await ctx.db.medicine.create({
          data: {
            ...medicine,
            retailPriceMinor: retail.retailPriceMinor,
            retailCategory: retail.retailCategory,
            presentations: presentation
              ? {
                  create: {
                    ...presentation,
                    barcodes: retail.ean13
                      ? {
                          create: {
                            type: 'GTIN',
                            code: retail.ean13,
                            normalizedCode: normalizeMedicineText(retail.ean13),
                          },
                        }
                      : undefined,
                  },
                }
              : undefined,
            strengths: { create: strengths },
            provenance: {
              create: assertions.map((item) => ({
                ...item,
                editorId: ctx.session.user.id,
                assertedValue: item.assertedValue ?? undefined,
              })),
            },
          },
          include: { strengths: true, presentations: true, provenance: true },
        });
      } catch (error) {
        domainError(error);
      }
    }),

  /**
   * #718: shop-set retail price and category for a NON_DRUG_RETAIL (FRONT_SHOP) item. A medicine
   * keeps its DRAP printed MRP and is refused; `null` clears a field.
   */
  setRetailDetails: catalogueEditProcedure
    .input(
      z
        .object({
          medicineId: z.string().min(1).max(200),
          retailPriceMinor: z.number().int().positive().safe().nullable(),
          retailCategory: z.string().max(200).nullable(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await submitCatalogueEdit(
          ctx.db,
          {
            organizationId: ctx.entitlements.organizationId,
            actorId: ctx.session.user.id,
          },
          input.medicineId,
          {
            retailPriceMinor: input.retailPriceMinor,
            retailCategory: input.retailCategory,
          }
        );
      } catch (error) {
        domainError(error);
      }
    }),

  get: auditedProtectedProcedure
    .input(z.object({ id: z.string().min(1).max(200) }).strict())
    .query(async ({ ctx, input }) => {
      const medicine = await ctx.db.medicine.findFirst({
        where: { id: input.id, saleable: true },
        include: {
          strengths: { include: { ingredient: true } },
          presentations: { include: { packLevels: { include: { barcodes: true } } } },
          provenance: true,
        },
      });
      if (!medicine) throw new TRPCError({ code: 'NOT_FOUND', message: 'Medicine not found.' });
      return medicine;
    }),

  createPackLevel: catalogueCommandProcedure
    .input(
      z
        .object({
          presentationId: z.string().min(1).max(200),
          parentPackLevelId: z.string().min(1).max(200).optional(),
          versionGroupId: z.string().min(1).max(200),
          level: z.enum(['CARTON', 'BOX', 'STRIP', 'UNIT']),
          unitsPerParent: z.number().int().positive(),
          effectiveFrom: z.date(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const presentation = await ctx.db.presentation.findFirst({
        where: { id: input.presentationId },
      });
      if (!presentation)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Presentation is outside this workspace.',
        });
      if (
        input.parentPackLevelId &&
        !(await ctx.db.packLevel.findFirst({
          where: { id: input.parentPackLevelId, presentationId: input.presentationId },
        }))
      )
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Parent pack is outside this presentation.',
        });
      const duplicate = {
        presentationId: input.presentationId,
        parentPackLevelId: input.parentPackLevelId ?? null,
        level: input.level,
        unitsPerParent: input.unitsPerParent,
        effectiveTo: null,
      };
      // Checked when the edit is submitted and again when an approval replays it.
      if (await ctx.db.packLevel.findFirst({ where: duplicate }))
        throw new TRPCError({ code: 'CONFLICT', message: DUPLICATE_PACK_MESSAGE });
      const queued = await queueCatalogueCommand(
        ctx,
        presentation.medicineId,
        'createPackLevel',
        input
      );
      if (queued) return queued;
      try {
        return await ctx.db.packLevel.create({ data: { ...input, version: 1 } });
      } catch (error) {
        if ((error as { code?: string })?.code === 'P2002')
          throw new TRPCError({ code: 'CONFLICT', message: DUPLICATE_PACK_MESSAGE });
        throw error;
      }
    }),

  revisePackLevel: catalogueCommandProcedure
    .input(
      z
        .object({
          id: z.string().min(1).max(200),
          unitsPerParent: z.number().int().positive(),
          effectiveFrom: z.date(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const current = await tx.packLevel.findFirst({ where: { id: input.id } });
        if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Pack level not found.' });
        const presentation = await tx.presentation.findFirst({
          where: { id: current.presentationId },
        });
        if (!presentation)
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Presentation not found.',
          });
        const queued = await queueCatalogueCommand(
          ctx,
          presentation.medicineId,
          'revisePackLevel',
          input
        );
        if (queued) return queued;
        await tx.packLevel.update({
          where: { id: current.id },
          data: { effectiveTo: input.effectiveFrom },
        });
        return tx.packLevel.create({
          data: {
            presentationId: current.presentationId,
            parentPackLevelId: current.parentPackLevelId,
            versionGroupId: current.versionGroupId,
            version: current.version + 1,
            level: current.level,
            unitsPerParent: input.unitsPerParent,
            effectiveFrom: input.effectiveFrom,
            supersedesPackLevelId: current.id,
          },
        });
      })
    ),

  // A batch's rounding increment lowers the price posted at the counter
  // (MED-08), so recording one is a pricing write held to the same gate as
  // `setPackPrice`; otherwise any employee could cut a charge without the
  // discount approval path.
  recordPrintedMrp: catalogueCommandProcedure
    .input(
      z
        .object({
          packLevelId: z.string().min(1).max(200),
          batchReference: z.string().min(1).max(200),
          printedMrpMinor: z.number().int().nonnegative(),
          roundingIncrementMinor: z.number().int().positive().default(1),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const pack = await ctx.db.packLevel.findFirst({
        where: { id: input.packLevelId },
        include: { presentation: true },
      });
      if (!pack)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Pack level is outside this workspace.',
        });
      const queued = await queueCatalogueCommand(
        ctx,
        pack.presentation.medicineId,
        'recordPrintedMrp',
        input
      );
      if (queued) return queued;
      return ctx.db.medicinePackMrp.create({ data: input });
    }),

  deriveLooseUnitPrice: auditedProtectedProcedure
    .input(
      z
        .object({
          mrpId: z.string().min(1).max(200),
          canonicalUnitsInPack: z.number().int().positive(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const mrp = await ctx.db.medicinePackMrp.findFirst({ where: { id: input.mrpId } });
      if (!mrp) throw new TRPCError({ code: 'NOT_FOUND', message: 'Printed MRP not found.' });
      return deriveLooseUnitPrice({
        printedMrpMinor: mrp.printedMrpMinor,
        canonicalUnitsInPack: input.canonicalUnitsInPack,
        roundingIncrementMinor: mrp.roundingIncrementMinor,
      });
    }),

  addBarcode: catalogueCommandProcedure
    .input(
      z
        .object({
          presentationId: z.string().min(1).max(200),
          packLevelId: z.string().min(1).max(200).optional(),
          type: z.enum(['GTIN', 'MANUFACTURER', 'INTERNAL']),
          code: z.string().trim().min(1).max(200),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const presentation = await ctx.db.presentation.findFirst({
        where: { id: input.presentationId },
      });
      if (!presentation)
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Presentation not found.',
        });
      const queued = await queueCatalogueCommand(ctx, presentation.medicineId, 'addBarcode', input);
      if (queued) return queued;
      return ctx.db.medicineBarcode.create({
        data: { ...input, normalizedCode: normalizeMedicineText(input.code) },
      });
    }),

  /**
   * Attach a barcode to a pack size that has none, so stock can be imported and
   * received by scanning the pack. Barcode rows are append-only, so a pack's
   * code cannot be edited, replaced or moved here.
   */
  setPackBarcode: catalogueCommandProcedure
    .input(
      z
        .object({
          packLevelId: z.string().min(1).max(200),
          type: z.enum(['GTIN', 'MANUFACTURER', 'INTERNAL']).default('GTIN'),
          code: z.string().trim().min(1).max(200),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const pack = await tx.packLevel.findFirst({
          where: { id: input.packLevelId },
          include: { presentation: { select: { medicineId: true } }, barcodes: true },
        });
        if (!pack) throw new TRPCError({ code: 'NOT_FOUND', message: 'Pack size not found.' });
        if (!isEffective(pack, new Date()))
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'This pack is not in effect. Attach the barcode to its current version.',
          });
        const normalizedCode = normalizeMedicineText(input.code);
        const before = pack.barcodes.map((item) => item.code);
        const current = pack.barcodes.find((item) => item.normalizedCode === normalizedCode);
        if (current) {
          annotateAudit(ctx, {
            targetType: 'PackLevel',
            targetId: pack.id,
            changes: { barcode: { before, after: before } },
          });
          return current;
        }
        if (pack.barcodes.length > 0)
          throw new TRPCError({
            code: 'CONFLICT',
            message: `This pack already carries barcode ${before.join(', ')}. Pack barcodes are permanent and cannot be replaced.`,
          });
        const queued = await queueCatalogueCommand(
          ctx,
          pack.presentation.medicineId,
          'setPackBarcode',
          input
        );
        if (queued) return queued;
        const attached = await attachPackBarcode(tx, {
          medicineId: pack.presentation.medicineId,
          presentationId: pack.presentationId,
          packLevelId: pack.id,
          type: input.type,
          code: input.code,
        });
        annotateAudit(ctx, {
          targetType: 'PackLevel',
          targetId: pack.id,
          changes: { barcode: { before, after: [attached.code] } },
        });
        return attached;
      })
    ),

  addAlias: catalogueCommandProcedure
    .input(
      z
        .object({
          medicineId: z.string().min(1).max(200),
          type: z.enum(['BRAND', 'GENERIC', 'URDU', 'TRANSLITERATION', 'LEGACY_CODE']),
          value: z.string().trim().min(1).max(300),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const queued = await queueCatalogueCommand(ctx, input.medicineId, 'addAlias', input);
      if (queued) return queued;
      return ctx.db.medicineAlias.create({
        data: { ...input, normalizedValue: normalizeMedicineText(input.value) },
      });
    }),

  resolveScan: auditedProtectedProcedure
    .input(z.object({ code: z.string().trim().min(1).max(200) }).strict())
    .query(async ({ ctx, input }) => {
      const matches = await ctx.db.medicineBarcode.findMany({
        where: {
          normalizedCode: normalizeMedicineText(input.code),
          presentation: { medicine: { saleable: true } },
        },
        include: { presentation: true, packLevel: true },
      });
      const targets = matches.map(({ presentation, packLevel }) => ({ presentation, packLevel }));
      if (targets.length === 0) {
        const legacyMatches = await ctx.db.medicineAlias.findMany({
          where: {
            type: 'LEGACY_CODE',
            normalizedValue: normalizeMedicineText(input.code),
            medicine: { saleable: true },
          },
          include: { medicine: { include: { presentations: { include: { packLevels: true } } } } },
        });
        for (const alias of legacyMatches) {
          for (const presentation of alias.medicine.presentations) {
            const currentLevels = presentation.packLevels.filter(
              (level) => level.effectiveTo === null
            );
            if (currentLevels.length === 0) targets.push({ presentation, packLevel: null });
            else
              targets.push(
                ...currentLevels.map((packLevel) => ({
                  presentation,
                  packLevel,
                }))
              );
          }
        }
      }
      if (targets.length === 0)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Scan code not found.' });
      return targets.length === 1
        ? { kind: 'resolved' as const, target: targets[0] }
        : { kind: 'disambiguation' as const, targets };
    }),

  search: auditedProtectedProcedure
    .input(
      z
        .object({
          query: z.string().trim().min(1).max(200),
          limit: z.number().int().min(1).max(100).default(25),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const query = normalizeMedicineText(input.query);
      const ids = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
        `SELECT DISTINCT medicine.id
           FROM pharmacy_medicines medicine
           LEFT JOIN pharmacy_presentations presentation ON presentation."medicineId" = medicine.id
           LEFT JOIN pharmacy_medicine_strength_components strength ON strength."medicineId" = medicine.id
           LEFT JOIN pharmacy_ingredients ingredient ON ingredient.id = strength."ingredientId"
           LEFT JOIN pharmacy_medicine_aliases alias ON alias."medicineId" = medicine.id
          WHERE medicine.saleable = true AND (
                pharmacy_normalize_catalog_text(coalesce(medicine."productName",'')) % $1
             OR pharmacy_normalize_catalog_text(coalesce(medicine."brandName",'')) % $1
             OR pharmacy_normalize_catalog_text(coalesce(ingredient.name,'')) % $1
             OR pharmacy_normalize_catalog_text(coalesce(strength.value::text,'') || coalesce(strength.unit,'')) % $1
             OR pharmacy_normalize_catalog_text(coalesce(presentation."dosageForm",'')) % $1
             OR coalesce(alias."normalizedValue",'') % $1
             OR coalesce(alias."normalizedValue",'') = $1)
          ORDER BY medicine.id LIMIT $2`,
        query,
        input.limit
      );
      return ctx.db.medicine.findMany({
        where: { id: { in: ids.map(({ id }) => id) }, saleable: true },
        include: {
          aliases: true,
          strengths: { include: { ingredient: true } },
          presentations: true,
        },
      });
    }),

  duplicateGroups: adminProcedure.query(async ({ ctx }) => {
    const medicines = await ctx.db.medicine.findMany({
      include: { strengths: true, presentations: true, aliases: true, provenance: true },
    });
    const groups = new Map<string, typeof medicines>();
    for (const medicine of medicines) {
      const key = medicineDuplicateKey({
        productName: medicine.productName,
        strengths: medicine.strengths.map((strength) => ({
          value: String(strength.value),
          unit: strength.unit,
        })),
        dosageForm: medicine.presentations[0]?.dosageForm,
      });
      groups.set(key, [...(groups.get(key) ?? []), medicine]);
    }
    return [...groups.entries()]
      .filter(([, candidates]) => candidates.length > 1)
      .map(([duplicateKey, candidates]) => ({ duplicateKey, candidates }));
  }),

  // DEV-923: this is the review step itself: the reviewer must differ from each
  // assertion's editor (or be a solo owner with a fresh PIN), so it is not queued again.
  recordReviewDecision: reviewerProcedure.input(reviewDecisionInput).mutation(({ ctx, input }) =>
    ctx.db.$transaction(async (tx) => {
      const medicineIds = [...new Set(input.medicineIds)];
      const assertionIds = [...new Set(input.payload.assertionIds)];
      if (
        medicineIds.length !== input.medicineIds.length ||
        assertionIds.length !== input.payload.assertionIds.length
      ) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Review references must be unique.' });
      }
      // Provenance is append-only in PostgreSQL. Serialize on the original
      // assertions, then append the review evidence instead of updating history.
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM pharmacy_medicine_provenance WHERE id IN (${Prisma.join(assertionIds)}) ORDER BY id FOR UPDATE`
      );
      const [medicineCount, assertions] = await Promise.all([
        tx.medicine.count({ where: { id: { in: medicineIds } } }),
        tx.medicineProvenance.findMany({
          where: { id: { in: assertionIds } },
          include: { supersededBy: { select: { id: true } } },
        }),
      ]);
      if (medicineCount !== medicineIds.length || assertions.length !== assertionIds.length) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Review candidate or assertion not found.',
        });
      }
      if (
        assertions.some(
          (assertion) =>
            !medicineIds.includes(assertion.medicineId) ||
            assertion.status !== 'UNREVIEWED' ||
            assertion.supersededBy.length > 0
        )
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'Review assertions must be current, unreviewed and belong to the referenced candidates.',
        });
      }
      const scope = {
        organizationId: ctx.entitlements.organizationId,
        actorId: ctx.session.user.id,
        actorOrganizationId: ctx.session.user.organizationId,
      };
      if (
        (input.action === 'ACCEPT' || input.action === 'CORRECT') &&
        assertions.some((item) => !item.editorId)
      )
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Resubmit assertions with editor evidence before approval.',
        });
      const editorIds = assertions.map((assertion) => assertion.editorId);
      const solo =
        (input.action === 'ACCEPT' || input.action === 'CORRECT') &&
        (await requireIndependentCatalogueReviewer(
          tx as typeof ctx.db,
          scope,
          // DEV-923: an owner deciding without the review grant (DEV-19 owner fallback)
          // goes through the fresh-PIN check on every acceptance, whoever the editor was.
          ctx.catalogueOwnerFallback ? [scope.actorId] : editorIds,
          input.soloPin,
          { ownerWithoutOtherReviewer: true, selfApproval: editorIds.includes(scope.actorId) }
        ));
      // DEV-923: every acceptance carries the catalogue approval audit, not only a solo one.
      if (input.action === 'ACCEPT' || input.action === 'CORRECT')
        await recordCatalogueApproval(
          tx as typeof ctx.db,
          scope,
          assertions[0]!.id,
          solo,
          'MedicineProvenance',
          solo ? NO_OTHER_REVIEWER : undefined
        );
      let reviewedAssertionIds = assertionIds;
      if (input.action !== 'DEFER') {
        const corrections = new Map(
          input.action === 'CORRECT'
            ? input.payload.corrections.map((item) => [item.assertionId, item.value])
            : []
        );
        if (
          input.action === 'CORRECT' &&
          (corrections.size !== input.payload.corrections.length ||
            [...corrections.keys()].some((id) => !assertionIds.includes(id)))
        )
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Corrections must reference selected assertions once.',
          });
        const created = [];
        for (const assertion of assertions) {
          const correction = corrections.get(assertion.id);
          created.push(
            await tx.medicineProvenance.create({
              data: {
                medicineId: assertion.medicineId,
                field: assertion.field,
                source: correction ? 'Reviewer correction' : assertion.source,
                sourceType: correction ? 'USER' : assertion.sourceType,
                retrievedAt: correction ? new Date() : assertion.retrievedAt,
                confidence: correction ? null : assertion.confidence,
                editorId: correction ? ctx.session.user.id : assertion.editorId,
                // A reviewer's correction is a new edit, requiring its own review.
                reviewer: correction ? null : ctx.session.user.id,
                status: correction
                  ? 'UNREVIEWED'
                  : input.action === 'REJECT'
                    ? 'REJECTED'
                    : 'ACCEPTED',
                supersedesId: assertion.id,
                assertedValue: correction
                  ? {
                      ...assertedEnvelope.parse(assertion.assertedValue),
                      value: correction,
                    }
                  : (assertion.assertedValue ?? undefined),
              },
            })
          );
        }
        reviewedAssertionIds = created.map((assertion) => assertion.id);
      }

      return tx.medicineReviewDecision.create({
        data: {
          duplicateKey: input.duplicateKey,
          action: input.action,
          medicineIds,
          payload: { assertionIds: reviewedAssertionIds } as Prisma.InputJsonValue,
          reviewerId: ctx.session.user.id,
        },
      });
    })
  ),

  // DEV-923: publication applies only assertions another reviewer already accepted (checked
  // below against the review decision evidence), so it is not queued again; releasing them
  // for sale is reviewer work, gated on the catalogue review permission.
  publishAssertions: reviewerProcedure.input(assertionIdsPayload).mutation(async ({ ctx, input }) =>
    ctx.db.$transaction(async (tx) => {
      const assertionIds = [...new Set(input.assertionIds)];
      const assertions = await tx.medicineProvenance.findMany({
        where: { id: { in: assertionIds } },
      });
      if (assertions.length !== assertionIds.length)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Assertion not found.' });
      if (
        assertions.some(
          (assertion) =>
            !['ACCEPTED', 'CORRECTED'].includes(assertion.status) || !assertion.reviewer
        )
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only reviewed, accepted assertions can be published.',
        });
      }
      const existingEntry = await tx.medicinePublicationEntry.findFirst({
        where: { assertionId: { in: assertionIds }, batch: { status: 'PUBLISHED' } },
      });
      if (existingEntry)
        throw new TRPCError({ code: 'CONFLICT', message: 'Assertion was already published.' });

      const decisions = await tx.medicineReviewDecision.findMany({
        where: {
          action: { in: ['ACCEPT', 'CORRECT'] },
          medicineIds: { hasSome: [...new Set(assertions.map((item) => item.medicineId))] },
        },
        orderBy: { createdAt: 'desc' },
      });
      const evidenced = new Set(
        decisions.flatMap((decision) => {
          const parsed = assertionIdsPayload.safeParse(decision.payload);
          return parsed.success ? parsed.data.assertionIds : [];
        })
      );
      if (assertions.some((assertion) => !evidenced.has(assertion.id))) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Accepted assertion lacks matching review evidence.',
        });
      }

      const batch = await tx.medicinePublicationBatch.create({
        data: { status: 'DRAFT' },
      });
      const byMedicine = new Map<string, typeof assertions>();
      for (const assertion of assertions)
        byMedicine.set(assertion.medicineId, [
          ...(byMedicine.get(assertion.medicineId) ?? []),
          assertion,
        ]);
      for (const [medicineId, selected] of byMedicine) {
        const values = new Map(
          selected.map((assertion) => [
            assertion.field,
            assertedEnvelope.parse(assertion.assertedValue).value,
          ])
        );
        const medicine = await tx.medicine.findUniqueOrThrow({
          where: { id: medicineId },
        });
        // DEV-852: a medicine whose identity came from a legacy import may lack strength and
        // registration; both are then stored as not recorded. Every other check still applies.
        const imported = isImportedIdentity(selected);
        const required =
          medicine.productFamily === 'FRONT_SHOP' || imported
            ? ['productName', 'dosageForm', 'pack']
            : ['productName', 'strength', 'dosageForm', 'pack'];
        for (const field of required) {
          if (!values.get(field))
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Publication requires ${field}.`,
            });
        }
        const strengthValue = values.get('strength');
        const parsedStrength = strengthValue ? parseSimpleMedicineStrength(strengthValue) : null;
        if (strengthValue && !parsedStrength)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Strength cannot be safely structured; correct it before publication.',
          });
        // The importer and receiving resolve stock through a pack size, so a
        // published medicine must carry one with its unit count.
        const defaultPack = parseDefaultPackSize(values.get('pack')!);
        if (!defaultPack)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'Pack size cannot be safely structured; correct it to a unit count such as "10 tablets" or "3 x 10" before publication.',
          });
        const ingredientName = values.get('alias') ?? values.get('productName')!;
        const ingredient = parsedStrength
          ? await tx.ingredient.upsert({
              where: {
                organizationId_name: {
                  organizationId: medicine.organizationId,
                  name: ingredientName,
                },
              },
              create: {
                organizationId: medicine.organizationId,
                name: ingredientName,
              },
              update: {},
            })
          : null;
        const presentation = await tx.presentation.create({
          data: {
            medicineId,
            dosageForm: values.get('dosageForm')!,
            presentation: values.get('pack')!,
          },
        });
        if (ingredient && parsedStrength)
          await tx.medicineStrengthComponent.create({
            data: {
              medicineId,
              ingredientId: ingredient.id,
              ...parsedStrength,
            },
          });
        const packLevel = await tx.packLevel.create({
          data: {
            presentationId: presentation.id,
            versionGroupId: randomUUID(),
            version: 1,
            level: defaultPack.level,
            unitsPerParent: defaultPack.unitsPerParent,
            effectiveFrom: new Date(),
          },
        });
        const barcode = values.get('barcode');
        if (barcode)
          await attachPackBarcode(tx, {
            medicineId,
            presentationId: presentation.id,
            packLevelId: packLevel.id,
            type: 'GTIN',
            code: barcode,
          });
        const alias = values.get('alias');
        if (alias)
          await tx.medicineAlias.create({
            data: {
              medicineId,
              type: 'GENERIC',
              value: alias,
              normalizedValue: normalizeMedicineText(alias),
            },
          });
        assertSaleable({
          productFamily: medicine.productFamily,
          hasPresentation: true,
          hasStrength: Boolean(parsedStrength),
          hasRegistration: Boolean(
            values.get('drapRegistrationNumber') ?? medicine.drapRegistrationNumber
          ),
          provenanceFields: new Set(selected.map((assertion) => assertion.field)),
          imported,
        });
        for (const field of ['rx', 'restricted', 'controlled'] as const) {
          const value = values.get(field);
          if (value !== undefined && !['true', 'false'].includes(value.trim().toLowerCase()))
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Schedule flags must be true or false.',
            });
        }
        await tx.medicine.update({
          where: { id: medicineId },
          data: {
            productName: values.get('productName')!,
            rx: proposedBoolean(values.get('rx')),
            restricted: proposedBoolean(values.get('restricted')),
            controlled: proposedBoolean(values.get('controlled')),
            brandName: values.get('brandName'),
            manufacturer: values.get('manufacturer'),
            drapRegistrationNumber: values.get('drapRegistrationNumber'),
            saleable: true,
          },
        });
      }
      await tx.medicinePublicationEntry.createMany({
        data: assertions.map((assertion) => ({
          batchId: batch.id,
          assertionId: assertion.id,
          priorAssertionId: assertion.supersedesId,
        })),
      });
      return tx.medicinePublicationBatch.update({
        where: { id: batch.id },
        data: { status: 'PUBLISHED', publishedBy: ctx.session.user.id, publishedAt: new Date() },
      });
    })
  ),

  // DEV-923: a reversal writes no new value: it restores assertions a reviewer accepted
  // before and leaves the medicine, its prices and saleability unchanged. The restored
  // assertions carry no review decision, so they cannot be published again without a new
  // independent review. It stamps the actor as reviewer, so it needs the review permission.
  supersedePublication: reviewerProcedure
    .input(z.object({ batchId: z.string().min(1).max(200) }).strict())
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const published = await tx.medicinePublicationBatch.findFirst({
          where: { id: input.batchId, status: 'PUBLISHED' },
          include: { entries: true },
        });
        if (!published)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Published batch not found.' });
        const reversal = await tx.medicinePublicationBatch.create({
          data: {
            status: 'SUPERSEDED',
            supersedesId: published.id,
            publishedBy: ctx.session.user.id,
            publishedAt: new Date(),
          },
        });
        for (const entry of published.entries) {
          if (!entry.priorAssertionId) continue;
          const [current, prior] = await Promise.all([
            tx.medicineProvenance.findUniqueOrThrow({ where: { id: entry.assertionId } }),
            tx.medicineProvenance.findUniqueOrThrow({ where: { id: entry.priorAssertionId } }),
          ]);
          const restored = await tx.medicineProvenance.create({
            data: {
              medicineId: current.medicineId,
              field: current.field,
              source: prior.source,
              sourceType: prior.sourceType,
              retrievedAt: new Date(),
              confidence: prior.confidence,
              reviewer: ctx.session.user.id,
              status: 'CORRECTED',
              assertedValue: prior.assertedValue ?? undefined,
              supersedesId: current.id,
            },
          });
          await tx.medicinePublicationEntry.create({
            data: { batchId: reversal.id, assertionId: restored.id, priorAssertionId: current.id },
          });
        }
        return reversal;
      })
    ),
});
