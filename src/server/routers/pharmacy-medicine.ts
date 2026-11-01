import {
  confirmPriceChanges,
  priceIntelligence,
  priceOverrides,
  setManualPackPrice,
} from '@/lib/pharmacy/pricing';
import { FileDrapNoticeSource, ingestDrapSource } from '@/lib/pharmacy/drap-monitoring';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import {
  assertSaleable,
  deriveLooseUnitPrice,
  medicineDuplicateKey,
  normalizeMedicineText,
  parseSimpleMedicineStrength,
  PharmacyMedicineError,
} from '@/lib/pharmacy/medicine';
import {
  configureManualReferenceConnector,
  proposedBoolean,
  runManualReferenceConnector,
} from '@/lib/pharmacy/reference-connector-automation';
import {
  MANUAL_FILE_RIGHTS,
  REFERENCE_BATCH_MAX_ROWS,
  type ConnectorRights,
} from '@/lib/pharmacy/reference-connectors';
import {
  adminProcedure,
  auditedProtectedProcedure,
  capabilityProcedure,
  protectedProcedure,
  router,
} from '../trpc';
import type { AuditDetail } from '../audit';
import {
  assertCanProposeCatalogueChange,
  assertCatalogueReviewer,
  canProposeCatalogueChange,
  catalogueReviewAuthority,
  catalogueReviewModeFor,
  type CatalogueDb,
} from '@/lib/pharmacy/catalogue-review';

const family = z.enum(['PHARMACEUTICAL', 'BIOLOGICAL', 'DEVICE', 'ALTERNATIVE', 'FRONT_SHOP']);
const boundedId = z.string().min(1).max(200);

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

const provenance = z
  .object({
    field: z.string().min(1).max(100),
    source: z.string().min(1).max(500),
    sourceType: z.enum(['REGULATOR', 'MANUFACTURER', 'SCRAPED', 'USER', 'IMPORT']),
    retrievedAt: z.date(),
    confidence: z.number().min(0).max(1).optional(),
    reviewer: z.string().max(200).optional(),
    status: z.enum(['UNREVIEWED', 'ACCEPTED', 'CORRECTED', 'REJECTED']),
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
        connectorId: z.literal('manual-file'),
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
    })
    .strict(),
  z
    .object({
      duplicateKey: z.string().min(1).max(700),
      action: z.literal('CORRECT'),
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

function domainError(error: unknown): never {
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

/*
 * Catalogue review. Each catalogue edit below is validated (tenant references,
 * saleability) when it is proposed, stored as a PENDING PharmacyCatalogueChange,
 * and written to the catalogue only by `decideCatalogueChange` APPROVE, which
 * validates it again inside the decision transaction.
 */
const ingredientInput = z.object({ name: z.string().trim().min(1).max(200) }).strict();

const medicineInput = z
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
    saleable: z.boolean().default(false),
  })
  .strict();

const packLevelInput = z
  .object({
    presentationId: z.string().min(1),
    parentPackLevelId: z.string().min(1).optional(),
    versionGroupId: z.string().min(1),
    level: z.enum(['CARTON', 'BOX', 'STRIP', 'UNIT']),
    unitsPerParent: z.number().int().positive(),
    effectiveFrom: z.date(),
  })
  .strict();

const packRevisionInput = z
  .object({
    id: z.string().min(1),
    unitsPerParent: z.number().int().positive(),
    effectiveFrom: z.date(),
  })
  .strict();

const printedMrpInput = z
  .object({
    packLevelId: z.string().min(1),
    batchReference: z.string().min(1).max(200),
    printedMrpMinor: z.number().int().nonnegative(),
    roundingIncrementMinor: z.number().int().positive().default(1),
  })
  .strict();

const barcodeInput = z
  .object({
    presentationId: z.string().min(1),
    packLevelId: z.string().min(1).optional(),
    type: z.enum(['GTIN', 'MANUFACTURER', 'INTERNAL']),
    code: z.string().trim().min(1).max(200),
  })
  .strict();

const aliasInput = z
  .object({
    medicineId: z.string().min(1),
    type: z.enum(['BRAND', 'GENERIC', 'URDU', 'TRANSLITERATION', 'LEGACY_CODE']),
    value: z.string().trim().min(1).max(300),
  })
  .strict();

type CatalogueChangeKind =
  | 'INGREDIENT'
  | 'MEDICINE'
  | 'PACK_LEVEL'
  | 'PACK_REVISION'
  | 'PRINTED_MRP'
  | 'BARCODE'
  | 'ALIAS';

function outsideWorkspace(message: string): never {
  throw new TRPCError({ code: 'FORBIDDEN', message });
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

async function checkMedicine(db: CatalogueDb, input: z.infer<typeof medicineInput>) {
  try {
    if (input.saleable)
      assertSaleable({
        productFamily: input.productFamily,
        hasPresentation: Boolean(input.presentation),
        hasStrength: input.strengths.length > 0,
        hasRegistration: Boolean(input.drapRegistrationNumber),
        provenanceFields: new Set(
          input.provenance
            .filter((p) => p.status === 'ACCEPTED' || p.status === 'CORRECTED')
            .map((p) => p.field)
        ),
      });
    for (const component of input.strengths) {
      if (!(await db.ingredient.findFirst({ where: { id: component.ingredientId } }))) {
        throw new PharmacyMedicineError('CROSS_TENANT_REFERENCE');
      }
    }
  } catch (error) {
    domainError(error);
  }
  return `New medicine: ${input.productName}${input.brandName ? ` (${input.brandName})` : ''}`;
}

async function checkPackLevel(db: CatalogueDb, input: z.infer<typeof packLevelInput>) {
  const presentation = await db.presentation.findFirst({ where: { id: input.presentationId } });
  if (!presentation) outsideWorkspace('Presentation is outside this workspace.');
  if (
    input.parentPackLevelId &&
    !(await db.packLevel.findFirst({
      where: { id: input.parentPackLevelId, presentationId: input.presentationId },
    }))
  )
    outsideWorkspace('Parent pack is outside this presentation.');
  return `New ${input.level} pack of ${input.unitsPerParent} units for ${presentation.presentation}, from ${isoDate(input.effectiveFrom)}`;
}

async function checkPackRevision(db: CatalogueDb, input: z.infer<typeof packRevisionInput>) {
  const current = await db.packLevel.findFirst({ where: { id: input.id } });
  if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Pack level not found.' });
  return {
    current,
    summary: `Revise ${current.level} pack from ${current.unitsPerParent} to ${input.unitsPerParent} units, from ${isoDate(input.effectiveFrom)}`,
  };
}

async function checkPrintedMrp(db: CatalogueDb, input: z.infer<typeof printedMrpInput>) {
  if (!(await db.packLevel.findFirst({ where: { id: input.packLevelId } })))
    outsideWorkspace('Pack level is outside this workspace.');
  return `Printed MRP ${input.printedMrpMinor} (minor units) for batch ${input.batchReference}`;
}

async function checkBarcode(db: CatalogueDb, input: z.infer<typeof barcodeInput>) {
  if (!(await db.presentation.findFirst({ where: { id: input.presentationId } })))
    outsideWorkspace('Presentation is outside this workspace.');
  if (
    input.packLevelId &&
    !(await db.packLevel.findFirst({
      where: { id: input.packLevelId, presentationId: input.presentationId },
    }))
  )
    outsideWorkspace('Pack is outside this presentation.');
  return `${input.type} barcode ${input.code}`;
}

async function checkAlias(db: CatalogueDb, input: z.infer<typeof aliasInput>) {
  if (!(await db.medicine.findFirst({ where: { id: input.medicineId } })))
    outsideWorkspace('Medicine is outside this workspace.');
  return `${input.type} alias: ${input.value}`;
}

/** Restores the Date fields a JSON payload stores as ISO strings. */
function reviveStoredDates(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const revived: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const field of ['drapRegisteredAt', 'effectiveFrom']) {
    if (typeof revived[field] === 'string') revived[field] = new Date(revived[field] as string);
  }
  if (Array.isArray(revived.provenance)) {
    revived.provenance = revived.provenance.map((item: unknown) => {
      if (!item || typeof item !== 'object') return item;
      const { retrievedAt } = item as { retrievedAt?: unknown };
      return typeof retrievedAt === 'string'
        ? { ...item, retrievedAt: new Date(retrievedAt) }
        : item;
    });
  }
  return revived;
}

/**
 * Writes one approved change to the catalogue, re-validating it first, and
 * returns the id of the record it created.
 */
async function publishCatalogueChange(
  db: CatalogueDb,
  kind: CatalogueChangeKind,
  payload: unknown
): Promise<string> {
  const stored = reviveStoredDates(payload);
  switch (kind) {
    case 'INGREDIENT': {
      const input = ingredientInput.parse(stored);
      return (await db.ingredient.create({ data: input })).id;
    }
    case 'MEDICINE': {
      const input = medicineInput.parse(stored);
      await checkMedicine(db, input);
      const { presentation, strengths, provenance: assertions, ...medicine } = input;
      const created = await db.medicine.create({
        data: {
          ...medicine,
          presentations: presentation ? { create: presentation } : undefined,
          strengths: { create: strengths },
          provenance: {
            create: assertions.map((item) => ({
              ...item,
              assertedValue: item.assertedValue ?? undefined,
            })),
          },
        },
      });
      return created.id;
    }
    case 'PACK_LEVEL': {
      const input = packLevelInput.parse(stored);
      await checkPackLevel(db, input);
      return (await db.packLevel.create({ data: { ...input, version: 1 } })).id;
    }
    case 'PACK_REVISION': {
      const input = packRevisionInput.parse(stored);
      const { current } = await checkPackRevision(db, input);
      await db.packLevel.update({
        where: { id: current.id },
        data: { effectiveTo: input.effectiveFrom },
      });
      const revised = await db.packLevel.create({
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
      return revised.id;
    }
    case 'PRINTED_MRP': {
      const input = printedMrpInput.parse(stored);
      await checkPrintedMrp(db, input);
      return (await db.medicinePackMrp.create({ data: input })).id;
    }
    case 'BARCODE': {
      const input = barcodeInput.parse(stored);
      await checkBarcode(db, input);
      const barcode = await db.medicineBarcode.create({
        data: { ...input, normalizedCode: normalizeMedicineText(input.code) },
      });
      return barcode.id;
    }
    case 'ALIAS': {
      const input = aliasInput.parse(stored);
      await checkAlias(db, input);
      const alias = await db.medicineAlias.create({
        data: { ...input, normalizedValue: normalizeMedicineText(input.value) },
      });
      return alias.id;
    }
  }
}

function recordCatalogueAudit(ctx: { audit?: { detail: AuditDetail } }, detail: AuditDetail) {
  if (!ctx.audit) return;
  const metadata = { ...(ctx.audit.detail.metadata ?? {}), ...(detail.metadata ?? {}) };
  Object.assign(ctx.audit.detail, detail, { metadata });
}

/** Stores a validated edit as a PENDING review item; nothing reaches the catalogue. */
async function proposeCatalogueChange(
  ctx: {
    db: CatalogueDb;
    session: { user: { id: string } };
    audit?: { detail: AuditDetail };
  },
  kind: CatalogueChangeKind,
  input: object,
  summary: string
) {
  const change = await ctx.db.pharmacyCatalogueChange.create({
    data: {
      kind,
      // JSON keeps Dates as ISO strings; publishCatalogueChange revives them.
      payload: JSON.parse(JSON.stringify(input)) as Prisma.InputJsonObject,
      summary: summary.slice(0, 500),
      proposedBy: ctx.session.user.id,
    },
  });
  recordCatalogueAudit(ctx, {
    action: 'pharmacy.catalogue-change.propose',
    targetType: 'PharmacyCatalogueChange',
    targetId: change.id,
    description: `Proposed catalogue change for review: ${change.summary}`,
    metadata: {
      catalogueChangeId: change.id,
      kind,
      status: 'PENDING',
      proposedBy: change.proposedBy,
    },
  });
  return change;
}

/** Catalogue edits need the catalogue-edit capability (or its stored equivalents). */
const catalogueEditProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  await assertCanProposeCatalogueChange(ctx.db, ctx.session.user, { ip: ctx.requestMeta.ip });
  return next();
});

export const pharmacyMedicineRouter = router({
  priceNotices: capabilityProcedure('pharmacy:safety').query(({ ctx }) =>
    priceIntelligence(ctx.db, {
      organizationId: ctx.entitlements.organizationId,
      actorId: ctx.session.user.id,
    })
  ),
  confirmPrices: capabilityProcedure('pharmacy:safety')
    .input(z.object({ proposalIds: z.array(z.string().min(1)).min(1).max(100) }).strict())
    .mutation(({ ctx, input }) =>
      confirmPriceChanges(
        ctx.db,
        { organizationId: ctx.entitlements.organizationId, actorId: ctx.session.user.id },
        input.proposalIds
      )
    ),
  ingestPriceNotices: capabilityProcedure('pharmacy:safety')
    .input(z.object({ contents: z.string().min(2).max(1000000) }).strict())
    .mutation(async ({ ctx, input }) => {
      const source = new FileDrapNoticeSource(input.contents);
      const notices = await source.read();
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
  setPackPrice: adminProcedure
    .input(
      z
        .object({
          packLevelId: z.string().min(1),
          branchId: z.string().min(1).optional(),
          mrpMinor: z.number().int().min(0).max(2147483647),
          sellingPriceMinor: z.number().int().min(0).max(2147483647).nullable(),
          effectiveFrom: z.date(),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      setManualPackPrice(
        ctx.db,
        { organizationId: ctx.entitlements.organizationId, actorId: ctx.session.user.id },
        input
      )
    ),
  priceOverrides: adminProcedure
    .input(z.object({ branchId: z.string().min(1).optional() }).strict())
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
          connectorId: z.literal('manual-file'),
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
                  values: z.record(z.string(), z.string().trim().min(1).max(1_000)),
                  assertions: z.array(referenceAssertion).min(1).max(20),
                  blockingIssues: z.array(
                    z.enum([
                      'MISSING_PRODUCT_NAME',
                      'MISSING_STRENGTH',
                      'MISSING_DOSAGE_FORM',
                      'MISSING_PACK',
                      'INVALID_SCHEDULE_CLASSIFICATION',
                    ])
                  ),
                })
                .strict()
            )
            .min(1)
            .max(REFERENCE_BATCH_MAX_ROWS),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
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
                assertion.sourceType !== 'IMPORT' ||
                row.values[assertion.field] !== assertion.value ||
                assertion.source !== input.fileName ||
                JSON.stringify(assertion.rights) !== JSON.stringify(MANUAL_FILE_RIGHTS)
            )
          );
        })
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Manual provenance must match its batch, source row, and mapped value.',
        });
      }

      return ctx.db.$transaction((tx) =>
        runManualReferenceConnector(tx, {
          organizationId: ctx.entitlements.organizationId,
          actorId: ctx.session.user.id,
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
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const proposal = await tx.pharmacyReferenceConnectorProposal.findFirst({
          where: { id: input.proposalId },
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
          return tx.pharmacyReferenceConnectorProposal.update({
            where: { id: proposal.id },
            data: { status: 'REJECTED', decidedBy: ctx.session.user.id, decidedAt },
          });
        }

        const payload = connectorProposalPayload.parse(proposal.payload);
        const values = payload.values;
        let medicine = proposal.targetMedicineId
          ? await tx.medicine.findFirst({ where: { id: proposal.targetMedicineId } })
          : null;
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
          medicine = await tx.medicine.update({
            where: { id: medicine.id },
            data: {
              productName: values.productName,
              drapRegistrationNumber: values.drapRegistrationNumber,
              rx: proposedBoolean(values.rx),
              restricted: proposedBoolean(values.restricted),
              controlled: proposedBoolean(values.controlled),
            },
          });
        }

        const assertions = [];
        for (const [field, value] of Object.entries(values)) {
          assertions.push(
            await tx.medicineProvenance.create({
              data: {
                medicineId: medicine.id,
                field,
                source: `manual-file:${proposal.inputDigest}:${proposal.rowSourceKey}`,
                sourceType: 'IMPORT',
                retrievedAt: decidedAt,
                reviewer: ctx.session.user.id,
                status: 'ACCEPTED',
                assertedValue: {
                  value,
                  connectorId: payload.source.connectorId,
                  sourceLabel: payload.source.fileName,
                  batchId: payload.source.batchId,
                  rowSourceKey: payload.source.rowSourceKey,
                  rights: jsonConnectorRights(MANUAL_FILE_RIGHTS),
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
        return tx.pharmacyReferenceConnectorProposal.update({
          where: { id: proposal.id },
          data: {
            status: 'CONFIRMED',
            targetMedicineId: medicine.id,
            decidedBy: ctx.session.user.id,
            decidedAt,
          },
        });
      })
    ),

  referenceCandidates: adminProcedure.query(({ ctx }) =>
    ctx.db.medicine.findMany({
      where: {
        saleable: false,
        provenance: {
          some: {
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
        provenance: { orderBy: { createdAt: 'asc' } },
        presentations: true,
        aliases: true,
        strengths: { include: { ingredient: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 250,
    })
  ),

  createIngredient: catalogueEditProcedure
    .input(ingredientInput)
    .mutation(({ ctx, input }) =>
      proposeCatalogueChange(ctx, 'INGREDIENT', input, `New ingredient: ${input.name}`)
    ),

  createMedicine: catalogueEditProcedure
    .input(medicineInput)
    .mutation(async ({ ctx, input }) =>
      proposeCatalogueChange(ctx, 'MEDICINE', input, await checkMedicine(ctx.db, input))
    ),

  get: auditedProtectedProcedure
    .input(z.object({ id: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const medicine = await ctx.db.medicine.findFirst({
        where: { id: input.id, saleable: true },
        include: {
          strengths: { include: { ingredient: true } },
          presentations: { include: { packLevels: true } },
          provenance: true,
        },
      });
      if (!medicine) throw new TRPCError({ code: 'NOT_FOUND', message: 'Medicine not found.' });
      return medicine;
    }),

  createPackLevel: catalogueEditProcedure
    .input(packLevelInput)
    .mutation(async ({ ctx, input }) =>
      proposeCatalogueChange(ctx, 'PACK_LEVEL', input, await checkPackLevel(ctx.db, input))
    ),

  revisePackLevel: catalogueEditProcedure
    .input(packRevisionInput)
    .mutation(async ({ ctx, input }) =>
      proposeCatalogueChange(
        ctx,
        'PACK_REVISION',
        input,
        (await checkPackRevision(ctx.db, input)).summary
      )
    ),

  recordPrintedMrp: catalogueEditProcedure
    .input(printedMrpInput)
    .mutation(async ({ ctx, input }) =>
      proposeCatalogueChange(ctx, 'PRINTED_MRP', input, await checkPrintedMrp(ctx.db, input))
    ),

  deriveLooseUnitPrice: auditedProtectedProcedure
    .input(
      z
        .object({ mrpId: z.string().min(1), canonicalUnitsInPack: z.number().int().positive() })
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

  addBarcode: catalogueEditProcedure
    .input(barcodeInput)
    .mutation(async ({ ctx, input }) =>
      proposeCatalogueChange(ctx, 'BARCODE', input, await checkBarcode(ctx.db, input))
    ),

  addAlias: catalogueEditProcedure
    .input(aliasInput)
    .mutation(async ({ ctx, input }) =>
      proposeCatalogueChange(ctx, 'ALIAS', input, await checkAlias(ctx.db, input))
    ),

  /** The catalogue review queue, for catalogue editors and reviewers. */
  catalogueChanges: protectedProcedure
    .input(
      z
        .object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING') })
        .strict()
        .default({ status: 'PENDING' })
    )
    .query(async ({ ctx, input }) => {
      const actor = ctx.session.user;
      const options = { ip: ctx.requestMeta.ip };
      const editor = await canProposeCatalogueChange(ctx.db, actor, options);
      const authority = await catalogueReviewAuthority(ctx.db, actor, options);
      if (!editor && !authority.reviewer && !authority.soloOwner)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Viewing catalogue changes needs catalogue edit or review permission.',
        });
      const changes = await ctx.db.pharmacyCatalogueChange.findMany({
        where: { status: input.status },
        orderBy: { proposedAt: input.status === 'PENDING' ? 'asc' : 'desc' },
        take: 250,
      });
      return {
        viewer: { id: actor.id, ...authority },
        changes: changes.map((change) => ({
          ...change,
          canDecide:
            change.status === 'PENDING' &&
            (change.proposedBy === actor.id
              ? authority.soloOwner
              : authority.reviewer || authority.soloOwner),
        })),
      };
    }),

  /**
   * Approve (publish) or reject one pending catalogue change. Approval needs a
   * different user with pharmacy:catalogue-review; a solo owner may decide
   * their own change. The proposer and reviewer are kept on the change and in
   * the audit log.
   */
  decideCatalogueChange: protectedProcedure
    .input(
      z
        .object({
          changeId: boundedId,
          decision: z.enum(['APPROVE', 'REJECT']),
          note: z.string().trim().min(1).max(500).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const actor = ctx.session.user;
      const options = { ip: ctx.requestMeta.ip };
      const authority = await assertCatalogueReviewer(ctx.db, actor, options);
      const decided = await ctx.db.$transaction(async (tx) => {
        const change = await tx.pharmacyCatalogueChange.findFirst({
          where: { id: input.changeId },
        });
        if (!change)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Catalogue change not found.' });
        if (change.status !== 'PENDING')
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This catalogue change has already been reviewed.',
          });
        const reviewMode = catalogueReviewModeFor(authority, actor.id, change.proposedBy);
        const status = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
        let publishedRecordId: string | null = null;
        if (input.decision === 'APPROVE') {
          try {
            publishedRecordId = await publishCatalogueChange(tx, change.kind, change.payload);
          } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'The catalogue already holds this entry. Reject this change instead.',
              });
            if (error instanceof z.ZodError)
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'This catalogue change can no longer be published. Reject it instead.',
              });
            throw error;
          }
        }
        const reviewedAt = new Date();
        const claimed = await tx.pharmacyCatalogueChange.updateMany({
          where: { id: change.id, status: 'PENDING' },
          data: {
            status,
            reviewedBy: actor.id,
            reviewedAt,
            reviewMode,
            reviewNote: input.note ?? null,
            publishedRecordId,
          },
        });
        if (claimed.count !== 1)
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This catalogue change has already been reviewed.',
          });
        return {
          ...change,
          status,
          reviewedBy: actor.id,
          reviewedAt,
          reviewMode,
          reviewNote: input.note ?? null,
          publishedRecordId,
        };
      });
      recordCatalogueAudit(ctx, {
        action:
          decided.status === 'APPROVED'
            ? 'pharmacy.catalogue-change.approve'
            : 'pharmacy.catalogue-change.reject',
        targetType: 'PharmacyCatalogueChange',
        targetId: decided.id,
        description: `${decided.status === 'APPROVED' ? 'Approved and published' : 'Rejected'} catalogue change: ${decided.summary}`,
        metadata: {
          catalogueChangeId: decided.id,
          kind: decided.kind,
          status: decided.status,
          proposedBy: decided.proposedBy,
          reviewedBy: decided.reviewedBy,
          reviewMode: decided.reviewMode,
          publishedRecordId: decided.publishedRecordId,
        },
      });
      return decided;
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

  recordReviewDecision: adminProcedure.input(reviewDecisionInput).mutation(({ ctx, input }) =>
    ctx.db.$transaction(async (tx) => {
      const medicineIds = [...new Set(input.medicineIds)];
      const assertionIds = [...new Set(input.payload.assertionIds)];
      if (
        medicineIds.length !== input.medicineIds.length ||
        assertionIds.length !== input.payload.assertionIds.length
      ) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Review references must be unique.' });
      }
      const [medicineCount, assertions] = await Promise.all([
        tx.medicine.count({ where: { id: { in: medicineIds } } }),
        tx.medicineProvenance.findMany({ where: { id: { in: assertionIds } } }),
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
            !medicineIds.includes(assertion.medicineId) || assertion.status !== 'UNREVIEWED'
        )
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Review assertions must be unreviewed and belong to the referenced candidates.',
        });
      }

      let reviewedAssertionIds = assertionIds;
      if (input.action === 'ACCEPT' || input.action === 'REJECT') {
        const transitioned = await tx.medicineProvenance.updateMany({
          where: { id: { in: assertionIds }, status: 'UNREVIEWED' },
          data: {
            status: input.action === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
            reviewer: ctx.session.user.id,
          },
        });
        if (transitioned.count !== assertionIds.length) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Review assertion state changed.' });
        }
      } else if (input.action === 'CORRECT') {
        const corrections = new Map(
          input.payload.corrections.map((item) => [item.assertionId, item.value])
        );
        if (
          corrections.size !== input.payload.corrections.length ||
          [...corrections.keys()].some((id) => !assertionIds.includes(id))
        ) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Corrections must reference selected assertions once.',
          });
        }
        const created = [];
        for (const assertion of assertions) {
          const value = corrections.get(assertion.id);
          if (!value) continue;
          const envelope = assertedEnvelope.parse(assertion.assertedValue);
          created.push(
            await tx.medicineProvenance.create({
              data: {
                medicineId: assertion.medicineId,
                field: assertion.field,
                source: assertion.source,
                sourceType: assertion.sourceType,
                retrievedAt: new Date(),
                confidence: assertion.confidence,
                reviewer: ctx.session.user.id,
                status: 'CORRECTED',
                supersedesId: assertion.id,
                assertedValue: { ...envelope, value },
              },
            })
          );
        }
        const corrected = await tx.medicineProvenance.updateMany({
          where: { id: { in: [...corrections.keys()] }, status: 'UNREVIEWED' },
          data: { status: 'SUPERSEDED', reviewer: ctx.session.user.id },
        });
        if (corrected.count !== corrections.size) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Review assertion state changed.' });
        }
        reviewedAssertionIds = [
          ...assertionIds.filter((id) => !corrections.has(id)),
          ...created.map((assertion) => assertion.id),
        ];
        const accepted = await tx.medicineProvenance.updateMany({
          where: {
            id: { in: assertionIds.filter((id) => !corrections.has(id)) },
            status: 'UNREVIEWED',
          },
          data: { status: 'ACCEPTED', reviewer: ctx.session.user.id },
        });
        if (accepted.count !== assertionIds.length - corrections.size) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Review assertion state changed.' });
        }
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

  publishAssertions: adminProcedure
    .input(assertionIdsPayload)
    .mutation(async ({ ctx, input }) =>
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
          for (const field of ['productName', 'strength', 'dosageForm', 'pack'] as const) {
            if (!values.get(field))
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `Publication requires ${field}.`,
              });
          }
          const parsedStrength = parseSimpleMedicineStrength(values.get('strength')!);
          if (!parsedStrength)
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Strength cannot be safely structured; correct it before publication.',
            });
          const medicine = await tx.medicine.findUniqueOrThrow({ where: { id: medicineId } });
          const ingredientName = values.get('alias') ?? values.get('productName')!;
          const ingredient = await tx.ingredient.upsert({
            where: {
              organizationId_name: {
                organizationId: medicine.organizationId,
                name: ingredientName,
              },
            },
            create: { organizationId: medicine.organizationId, name: ingredientName },
            update: {},
          });
          const presentation = await tx.presentation.create({
            data: {
              medicineId,
              dosageForm: values.get('dosageForm')!,
              presentation: values.get('pack')!,
            },
          });
          await tx.medicineStrengthComponent.create({
            data: { medicineId, ingredientId: ingredient.id, ...parsedStrength },
          });
          const barcode = values.get('barcode');
          if (barcode)
            await tx.medicineBarcode.create({
              data: {
                presentationId: presentation.id,
                type: 'GTIN',
                code: barcode,
                normalizedCode: normalizeMedicineText(barcode),
              },
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
            hasStrength: true,
            hasRegistration: Boolean(
              values.get('drapRegistrationNumber') ?? medicine.drapRegistrationNumber
            ),
            provenanceFields: new Set(selected.map((assertion) => assertion.field)),
          });
          await tx.medicine.update({
            where: { id: medicineId },
            data: {
              productName: values.get('productName')!,
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

  supersedePublication: adminProcedure
    .input(z.object({ batchId: z.string().min(1) }).strict())
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
