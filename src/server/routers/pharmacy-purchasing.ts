import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import {
  listReceivingExceptions,
  postGoodsReceipt,
  resolveReceivingException,
  reverseGoodsReceipt,
  verifyControlledPurchaseWitness,
} from '@/lib/pharmacy/goods-receipt';
import { listControlledPinWitnesses } from '@/lib/pharmacy/controlled-register';
import { PharmacyInventoryError } from '@/lib/pharmacy/inventory';
import {
  allocateCentralReceipt,
  centralDemand,
  CentralPurchasingError,
  createCentralPurchaseOrder,
} from '@/lib/pharmacy/central-purchasing';
import {
  listGoodsReceipts,
  listPurchaseOrders,
  listPurchaseReturns,
  listReceivingExceptionQueue,
  listRequisitions,
  listReturnableLots,
  listSupplierCredits,
  listSuppliers,
  lotsFromReceipt,
  purchasingWorkspace,
  purchasingReadBoundsSchema,
  receivedAgainstOrder,
  resolveScan,
  type PurchasingReadBounds,
  type PurchasingReadPage,
  type PurchaseReturnDetail,
  type SupplierCreditDetail,
} from '@/lib/pharmacy/purchasing-console';
import {
  assertApprovalAllowed,
  assertPurchaseOrderTransition,
  assertRequisitionTransition,
  assertSupplierEligible,
  compareQuotes,
  landedCost,
  PharmacyPurchasingError,
  SEGREGATION_OF_DUTIES_POLICY,
  type QuoteCandidate,
} from '@/lib/pharmacy/purchasing';
import {
  GS1_WARNING_CODES,
  gtinCheckDigit,
  nearExpiryWarning,
  packIsExpired,
  parseGs1DataMatrix,
  type Gs1WarningCode,
} from '@/lib/pharmacy/gs1-datamatrix';
import { normalizeMedicineText } from '@/lib/pharmacy/medicine';
import { actorCanProcure } from '@/lib/pharmacy/procurement-access';
import {
  assertDirectPurchaseAuthorized,
  cumulativeAllocatedChargeMinor,
  PharmacyReceivingError,
  receiptLineQuantities,
  receiptLineUnitCostMinor,
} from '@/lib/pharmacy/receiving';
import { PharmacySupplierReturnError } from '@/lib/pharmacy/supplier-returns';
import {
  allocateSupplierCredit,
  createPurchaseReturn,
  debitNotePositions,
  dispatchPurchaseReturn,
  issueDebitNote,
  recordSupplierCredit,
  submitPurchaseReturn,
} from '@/lib/pharmacy/supplier-returns-operations';
import type { ReceivingScope } from '@/lib/pharmacy/goods-receipt';
import { authenticatePharmacyPack } from '@/lib/pharmacy/pack-authentication-operations';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { auditedProtectedProcedure, protectedProcedure, router } from '../trpc';
import type { TRPCContext } from '../trpc';

/**
 * PH-PUR — PRD §6.3 PUR-01, PUR-02 (requisition through approval and on into
 * receiving), PUR-03, PUR-04 and PUR-05.
 *
 * The arithmetic and the refusals live in `@/lib/pharmacy/purchasing` and
 * `@/lib/pharmacy/receiving`, and the ledger postings in
 * `@/lib/pharmacy/goods-receipt`; this router resolves rows through the
 * tenant-scoped client, pins the tenant, branch and actor to the SESSION rather
 * than the payload, and maps the domain errors onto tRPC codes.
 */

const bps = z.number().int().min(0).max(10_000);
const branchId = z.string().trim().min(1).max(128);

function domainError(error: unknown): never {
  if (error instanceof CentralPurchasingError) {
    throw new TRPCError({
      code:
        error.reason === 'FORBIDDEN'
          ? 'FORBIDDEN'
          : error.reason === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : 'BAD_REQUEST',
      message: error.reason,
    });
  }
  if (error instanceof PharmacyPurchasingError) {
    throw new TRPCError({
      code:
        error.reason === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.reason === 'CROSS_TENANT_REFERENCE'
            ? 'FORBIDDEN'
            : error.reason === 'SUPPLIER_NOT_AUTHORIZED' ||
                error.reason === 'SUPPLIER_LICENCE_EXPIRED' ||
                error.reason === 'SELF_APPROVAL'
              ? 'FORBIDDEN'
              : 'BAD_REQUEST',
      message: error.message,
    });
  }
  if (error instanceof PharmacyReceivingError) {
    throw new TRPCError({
      code:
        error.reason === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.reason === 'CROSS_TENANT_REFERENCE' ||
              error.reason === 'CROSS_BRANCH_REFERENCE' ||
              error.reason === 'SUPPLIER_NOT_AUTHORIZED' ||
              error.reason === 'SUPPLIER_LICENCE_EXPIRED' ||
              error.reason === 'SELF_APPROVAL'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST',
      message: error.reason,
    });
  }
  if (error instanceof PharmacyInventoryError) {
    throw new TRPCError({
      code:
        error.reason === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.reason === 'CROSS_TENANT_REFERENCE' ||
              error.reason === 'CROSS_BRANCH_REFERENCE' ||
              error.reason === 'BLOCKED_STOCK'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST',
      message: error.reason,
    });
  }
  if (error instanceof PharmacySupplierReturnError) {
    throw new TRPCError({
      code:
        error.reason === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.reason === 'CROSS_TENANT_REFERENCE' ||
              error.reason === 'CROSS_BRANCH_REFERENCE' ||
              error.reason === 'SELF_APPROVAL'
            ? 'FORBIDDEN'
            : // ALREADY_CLAIMED, RETURN_WINDOW_CLOSED, OVER_ALLOCATION and the
              // transition refusals are all "you asked for something the current
              // state does not allow", not authorization failures.
              'BAD_REQUEST',
      message: error.reason,
    });
  }
  if (serialUniqueViolation(error)) {
    throw new TRPCError({ code: 'CONFLICT', message: 'DUPLICATE_SERIAL' });
  }
  throw error;
}

function constraintTarget(error: unknown): string {
  const target = (error as { meta?: { target?: unknown } } | null)?.meta?.target;
  if (Array.isArray(target)) return target.join(' ');
  return typeof target === 'string' ? target : '';
}

/** A GTIN/serial collision is a conflict the operator can act on. Other unique failures stay untouched. */
function serialUniqueViolation(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code !== 'P2002') return false;
  const message = error instanceof Error ? error.message : '';
  return /serial|gtin/i.test(`${constraintTarget(error)} ${message}`);
}

async function assertProcurement(ctx: TRPCContext) {
  const actorId = ctx.session?.user?.id;
  if (!actorId || !(await actorCanProcure(ctx.db, actorId))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
  }
}

type ReceiptIdentityInput = {
  medicineId: string;
  batchNumber: string;
  printedExpiry: Date;
  expiryPrecision: 'DAY' | 'MONTH';
  gtin?: string;
  serialNumber?: string;
  gs1Warnings?: readonly Gs1WarningCode[];
  gs1Payload?: string;
  invoiceCorrection?: boolean;
  acceptedCanonicalUnits: number;
  receivedAt: Date;
};

/**
 * The scan is evidence. Re-parse it here and store those fields. An invoice
 * correction may replace batch and expiry; GTIN and serial stay on the scan.
 */
async function resolveReceiptLineIdentity(
  db: ScopedDb,
  organizationId: string,
  line: ReceiptIdentityInput
) {
  let batchNumber = line.batchNumber;
  let printedExpiry = line.printedExpiry;
  let expiryPrecision = line.expiryPrecision;
  let gtin = line.gtin ?? null;
  let serialNumber = line.serialNumber ?? null;
  let warnings: Gs1WarningCode[] = [...(line.gs1Warnings ?? [])];

  if (line.gs1Payload) {
    const parsed = parseGs1DataMatrix(line.gs1Payload, line.receivedAt);
    if (parsed.kind !== 'parsed') throw new PharmacyReceivingError('GS1_INVALID');
    gtin = parsed.fields.gtin;
    serialNumber = parsed.fields.serial;
    warnings = parsed.fields.warnings.map((warning) => warning.code);
    if (!line.invoiceCorrection) {
      if (parsed.fields.batch) batchNumber = parsed.fields.batch;
      if (parsed.fields.expiryDate) {
        printedExpiry = new Date(`${parsed.fields.expiryDate}T00:00:00.000Z`);
        expiryPrecision = parsed.fields.expiry?.endsWith('00') ? 'MONTH' : 'DAY';
      }
    }
  } else if (gtin && gtinCheckDigit(gtin.slice(0, 13)) !== Number(gtin[13])) {
    throw new PharmacyReceivingError('GS1_INVALID');
  }

  if (gtin) {
    const codes = [gtin, gtin.startsWith('0') ? gtin.slice(1) : null].filter(
      (code): code is string => Boolean(code)
    );
    const barcode = await db.medicineBarcode.findFirst({
      where: {
        organizationId,
        normalizedCode: { in: codes.map((code) => normalizeMedicineText(code)) },
      },
      select: { presentation: { select: { medicineId: true } } },
    });
    if (!barcode || barcode.presentation.medicineId !== line.medicineId) {
      throw new PharmacyReceivingError('GTIN_MEDICINE_MISMATCH');
    }
  }

  if (line.acceptedCanonicalUnits > 0 && packIsExpired(printedExpiry, line.receivedAt)) {
    throw new PharmacyReceivingError('EXPIRED_PACK');
  }

  const near = nearExpiryWarning(printedExpiry.toISOString().slice(0, 10), line.receivedAt);
  warnings = warnings.filter((code) => code !== 'NEAR_EXPIRY');
  if (near && line.acceptedCanonicalUnits > 0) warnings.push(near.code);

  return {
    batchNumber,
    printedExpiry,
    expiryPrecision,
    gtin,
    serialNumber,
    serialKey: serialNumber ? serialNumber.toUpperCase() : null,
    gs1Warnings: warnings,
  };
}

/**
 * Prisma's interactive-transaction client omits lifecycle methods from its
 * generated type even though the model delegates are identical, so a
 * transaction handle needs the widening the rest of the repository uses before
 * it reaches a service function.
 */
function txDb(tx: unknown): ScopedDb {
  return tx as ScopedDb;
}

/**
 * The tenant, branch and actor of a receiving posting. The organization and the
 * actor come from the SESSION and never from an input field: a payload-supplied
 * tenant is a substitution vector, and bypass or resolution evidence naming
 * somebody else is not evidence.
 */
function receivingScope(ctx: TRPCContext, branch: string): ReceivingScope {
  const organizationId = ctx.entitlements?.organizationId;
  const actorId = ctx.session?.user?.id;
  if (!organizationId || !actorId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'No tenant actor on this request.' });
  }
  return { organizationId, branchId: branch, actorId };
}

/**
 * The organization-only half of the same rule, for the reads that are not
 * branch-scoped. Suppliers, requisitions and orders are tenant-level records;
 * their `branchId`, where they carry one, is a filter and not a boundary.
 */
function tenantScope(ctx: TRPCContext): { organizationId: string } {
  const organizationId = ctx.entitlements?.organizationId;
  if (!organizationId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'No tenant actor on this request.' });
  }
  return { organizationId };
}

/**
 * PUR-01: refuse a supplier that may not be ordered from right now. `supplier`
 * is whatever the tenant-scoped client returned, so a row belonging to another
 * tenant arrives here as `null` and is refused on tenancy rather than licensing.
 */
function assertOrderableSupplier(
  supplier: {
    authorized: boolean;
    licences: { expiresAt: Date; verifiedAt: Date | null }[];
  } | null,
  at: Date
) {
  if (!supplier) throw new PharmacyPurchasingError('CROSS_TENANT_REFERENCE');
  assertSupplierEligible({
    authorized: supplier.authorized,
    licences: supplier.licences.map((licence) => ({
      expiresAt: licence.expiresAt,
      verified: licence.verifiedAt !== null,
    })),
    at,
  });
}

const WITH_LICENCES = { licences: true } as const;

const supplierFollowUpInput = purchasingReadBoundsSchema.safeExtend({ branchId });

/** Both bounded and legacy financial readers enforce access before reading their source rows. */
async function supplierFollowUpScope(ctx: TRPCContext, branch: string) {
  const scope = receivingScope(ctx, branch);
  // Direct subrouter callers have no pharmacyPurchasing path prefix for the shared module lookup.
  if (!hasModule(ctx.entitlements, 'pharmacy-procurement')) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Pharmacy procurement access required.' });
  }
  if (
    !(await can(subjectFromSession(ctx.session!.user), 'reports:financial', undefined, {
      db: ctx.db,
      source: 'TRPC',
      ip: ctx.requestMeta.ip,
    }))
  )
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Financial report access required.' });
  const available = await ctx.db.pharmacyBranch.findFirst({
    where: { organizationId: scope.organizationId, id: scope.branchId, active: true },
    select: { id: true },
  });
  if (!available)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
  return scope;
}

const purchasingRouter = router({
  // ----- PUR-01 licensed suppliers -----

  createSupplier: protectedProcedure
    .input(
      z
        .object({
          name: z.string().trim().min(1).max(300),
          legalName: z.string().trim().max(300).optional(),
          serviceArea: z.string().trim().max(500).optional(),
          contactName: z.string().trim().max(200).optional(),
          contactPhone: z.string().trim().max(50).optional(),
          paymentTermsDays: z.number().int().min(0).max(365).default(0),
          creditLimitMinor: z.number().int().nonnegative().default(0),
        })
        .strict()
    )
    .mutation(({ ctx, input }) => ctx.db.pharmacySupplier.create({ data: input })),

  /** Licence evidence is append-only; a correction supersedes the earlier filing. */
  recordSupplierLicence: protectedProcedure
    .input(
      z
        .object({
          supplierId: z.string().min(1),
          licenceType: z.string().trim().min(1).max(100),
          licenceNumber: z.string().trim().min(1).max(100),
          issuingAuthority: z.string().trim().min(1).max(200),
          issuedAt: z.date(),
          expiresAt: z.date(),
          evidenceUri: z.string().trim().max(1000).optional(),
          verified: z.boolean().default(false),
          supersedesId: z.string().min(1).optional(),
        })
        .strict()
        .refine((value) => value.expiresAt > value.issuedAt, {
          message: 'A licence must expire after it was issued.',
          path: ['expiresAt'],
        })
    )
    .mutation(async ({ ctx, input }) => {
      if (!(await ctx.db.pharmacySupplier.findFirst({ where: { id: input.supplierId } })))
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Supplier is outside this workspace.' });
      const { verified, ...licence } = input;
      return ctx.db.pharmacySupplierLicence.create({
        data: {
          ...licence,
          verifiedAt: verified ? new Date() : null,
          verifiedByUserId: verified ? ctx.session.user.id : null,
        },
      });
    }),

  setSupplierAuthorization: protectedProcedure
    .input(z.object({ supplierId: z.string().min(1), authorized: z.boolean() }).strict())
    .mutation(async ({ ctx, input }) => {
      if (!(await ctx.db.pharmacySupplier.findFirst({ where: { id: input.supplierId } })))
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Supplier is outside this workspace.' });
      return ctx.db.pharmacySupplier.update({
        where: { id: input.supplierId },
        data: { authorized: input.authorized },
      });
    }),

  // ----- PUR-02 requisition -----

  createRequisition: protectedProcedure
    .input(
      z
        .object({
          reference: z.string().trim().min(1).max(100),
          branchId: z.string().min(1).optional(),
          neededBy: z.date().optional(),
          note: z.string().trim().max(2000).optional(),
          lines: z
            .array(
              z
                .object({
                  medicineId: z.string().min(1),
                  packLevelId: z.string().min(1),
                  quantityPacks: z.number().int().positive(),
                  canonicalUnitsPerPack: z.number().int().positive(),
                  note: z.string().trim().max(500).optional(),
                })
                .strict()
            )
            .min(1),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        for (const line of input.lines) {
          if (
            !(await ctx.db.medicine.findFirst({ where: { id: line.medicineId, saleable: true } }))
          )
            throw new PharmacyPurchasingError('CROSS_TENANT_REFERENCE');
          if (!(await ctx.db.packLevel.findFirst({ where: { id: line.packLevelId } })))
            throw new PharmacyPurchasingError('CROSS_TENANT_REFERENCE');
        }
        const { lines, ...requisition } = input;
        return await ctx.db.pharmacyRequisition.create({
          data: {
            ...requisition,
            requestedByUserId: ctx.session.user.id,
            lines: {
              create: lines.map((line, index) => ({
                ...line,
                lineNumber: index + 1,
                canonicalUnits: line.quantityPacks * line.canonicalUnitsPerPack,
              })),
            },
          },
          include: { lines: true },
        });
      } catch (error) {
        domainError(error);
      }
    }),

  submitRequisition: protectedProcedure
    .input(z.object({ requisitionId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const requisition = await ctx.db.pharmacyRequisition.findFirst({
          where: { id: input.requisitionId },
        });
        if (!requisition) throw new PharmacyPurchasingError('NOT_FOUND');
        assertRequisitionTransition(requisition.status, 'SUBMITTED');
        return await ctx.db.pharmacyRequisition.update({
          where: { id: requisition.id },
          data: { status: 'SUBMITTED', submittedAt: new Date() },
        });
      } catch (error) {
        domainError(error);
      }
    }),

  // ----- PUR-02 quotes and comparison -----

  recordQuote: protectedProcedure
    .input(
      z
        .object({
          requisitionId: z.string().min(1),
          supplierId: z.string().min(1),
          reference: z.string().trim().max(100).optional(),
          quotedAt: z.date(),
          validUntil: z.date(),
          note: z.string().trim().max(2000).optional(),
          lines: z
            .array(
              z
                .object({
                  requisitionLineId: z.string().min(1),
                  pricePerPackMinor: z.number().int().nonnegative(),
                  schemeBuyPacks: z.number().int().nonnegative().default(0),
                  schemeFreePacks: z.number().int().nonnegative().default(0),
                  discountBps: bps.default(0),
                  moqPacks: z.number().int().positive().default(1),
                  leadTimeDays: z.number().int().nonnegative().default(0),
                  minimumExpiryDays: z.number().int().nonnegative().default(0),
                  canonicalUnitsPerPack: z.number().int().positive(),
                })
                .strict()
                .refine((value) => (value.schemeBuyPacks === 0) === (value.schemeFreePacks === 0), {
                  message: 'A scheme needs both a buy quantity and a free quantity.',
                  path: ['schemeFreePacks'],
                })
            )
            .min(1),
        })
        .strict()
        .refine((value) => value.validUntil >= value.quotedAt, {
          message: 'A quote cannot expire before it was given.',
          path: ['validUntil'],
        })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        if (!(await ctx.db.pharmacySupplier.findFirst({ where: { id: input.supplierId } })))
          throw new PharmacyPurchasingError('CROSS_TENANT_REFERENCE');
        const requisition = await ctx.db.pharmacyRequisition.findFirst({
          where: { id: input.requisitionId },
          include: { lines: true },
        });
        if (!requisition) throw new PharmacyPurchasingError('CROSS_TENANT_REFERENCE');
        const ownLines = new Set(requisition.lines.map((line) => line.id));
        for (const line of input.lines) {
          if (!ownLines.has(line.requisitionLineId))
            throw new PharmacyPurchasingError('CROSS_TENANT_REFERENCE');
        }
        const { lines, ...quote } = input;
        return await ctx.db.pharmacyQuote.create({
          data: { ...quote, lines: { create: lines } },
          include: { lines: true },
        });
      } catch (error) {
        domainError(error);
      }
    }),

  /**
   * PUR-02: a ranked and explained comparison for one requisition line. It never
   * awards — the caller gets a list with reasons and decides.
   */
  compareQuotes: auditedProtectedProcedure
    .input(z.object({ requisitionLineId: z.string().min(1), at: z.date().optional() }).strict())
    .query(async ({ ctx, input }) => {
      try {
        const at = input.at ?? new Date();
        const requisitionLine = await ctx.db.pharmacyRequisitionLine.findFirst({
          where: { id: input.requisitionLineId },
        });
        if (!requisitionLine) throw new PharmacyPurchasingError('NOT_FOUND');
        const quoteLines = await ctx.db.pharmacyQuoteLine.findMany({
          where: { requisitionLineId: requisitionLine.id },
          include: { quote: { include: { supplier: { include: { licences: true } } } } },
        });
        const candidates: QuoteCandidate[] = quoteLines.map((line) => ({
          quoteId: line.quoteId,
          supplierId: line.quote.supplierId,
          supplierName: line.quote.supplier.name,
          supplierAuthorized: line.quote.supplier.authorized,
          supplierLicences: line.quote.supplier.licences.map((licence) => ({
            expiresAt: licence.expiresAt,
            verified: licence.verifiedAt !== null,
          })),
          validUntil: line.quote.validUntil,
          pricePerPackMinor: line.pricePerPackMinor,
          canonicalUnitsPerPack: line.canonicalUnitsPerPack,
          schemeBuyPacks: line.schemeBuyPacks,
          schemeFreePacks: line.schemeFreePacks,
          discountBps: line.discountBps,
          moqPacks: line.moqPacks,
          leadTimeDays: line.leadTimeDays,
          minimumExpiryDays: line.minimumExpiryDays,
        }));
        return {
          requisitionLineId: requisitionLine.id,
          requiredPacks: requisitionLine.quantityPacks,
          /** Ranked, explained, and deliberately not awarded. */
          ranking: compareQuotes({
            requiredPacks: requisitionLine.quantityPacks,
            candidates,
            at,
          }),
        };
      } catch (error) {
        domainError(error);
      }
    }),

  // ----- PUR-02 purchase order and approval -----

  createPurchaseOrder: protectedProcedure
    .input(
      z
        .object({
          reference: z.string().trim().min(1).max(100),
          supplierId: z.string().min(1),
          branchId: z.string().min(1).optional(),
          requisitionId: z.string().min(1).optional(),
          quoteId: z.string().min(1).optional(),
          expectedDeliveryAt: z.date().optional(),
          freightMinor: z.number().int().nonnegative().default(0),
          otherChargesMinor: z.number().int().nonnegative().default(0),
          note: z.string().trim().max(2000).optional(),
          lines: z
            .array(
              z
                .object({
                  medicineId: z.string().min(1),
                  packLevelId: z.string().min(1),
                  orderedPacks: z.number().int().positive(),
                  bonusPacks: z.number().int().nonnegative().default(0),
                  canonicalUnitsPerPack: z.number().int().positive(),
                  listPricePerPackMinor: z.number().int().nonnegative(),
                  discountBps: bps.default(0),
                  rebateBps: bps.default(0),
                  taxBps: bps.default(0),
                  taxCreditable: z.boolean().default(false),
                })
                .strict()
            )
            .min(1),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        // PUR-01: refuse an unauthorized or licence-expired supplier before anything is written.
        assertOrderableSupplier(
          await ctx.db.pharmacySupplier.findFirst({
            where: { id: input.supplierId },
            include: WITH_LICENCES,
          }),
          new Date()
        );
        if (
          input.requisitionId &&
          !(await ctx.db.pharmacyRequisition.findFirst({ where: { id: input.requisitionId } }))
        )
          throw new PharmacyPurchasingError('CROSS_TENANT_REFERENCE');
        if (
          input.quoteId &&
          !(await ctx.db.pharmacyQuote.findFirst({
            where: { id: input.quoteId, supplierId: input.supplierId },
          }))
        )
          throw new PharmacyPurchasingError('CROSS_TENANT_REFERENCE');
        for (const line of input.lines) {
          if (
            !(await ctx.db.medicine.findFirst({ where: { id: line.medicineId, saleable: true } }))
          )
            throw new PharmacyPurchasingError('CROSS_TENANT_REFERENCE');
          if (!(await ctx.db.packLevel.findFirst({ where: { id: line.packLevelId } })))
            throw new PharmacyPurchasingError('CROSS_TENANT_REFERENCE');
        }
        // Reject impossible money or quantity terms before they reach the table.
        landedCost({
          lines: input.lines,
          freightMinor: input.freightMinor,
          otherChargesMinor: input.otherChargesMinor,
        });

        const { lines, ...purchaseOrder } = input;
        return await ctx.db.pharmacyPurchaseOrder.create({
          data: {
            ...purchaseOrder,
            createdByUserId: ctx.session.user.id,
            lines: {
              create: lines.map((line, index) => ({
                ...line,
                lineNumber: index + 1,
                orderedCanonicalUnits: line.orderedPacks * line.canonicalUnitsPerPack,
                bonusCanonicalUnits: line.bonusPacks * line.canonicalUnitsPerPack,
              })),
            },
          },
          include: { lines: true },
        });
      } catch (error) {
        domainError(error);
      }
    }),

  submitPurchaseOrder: protectedProcedure
    .input(z.object({ purchaseOrderId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const order = await ctx.db.pharmacyPurchaseOrder.findFirst({
          where: { id: input.purchaseOrderId },
        });
        if (!order) throw new PharmacyPurchasingError('NOT_FOUND');
        assertPurchaseOrderTransition(order.status, 'SUBMITTED');
        return await ctx.db.pharmacyPurchaseOrder.update({
          where: { id: order.id },
          data: { status: 'SUBMITTED', submittedAt: new Date() },
        });
      } catch (error) {
        domainError(error);
      }
    }),

  /**
   * PUR-02: approval is a recorded event with an actor and a named policy, and
   * it is refused for whoever raised the order or the underlying requisition.
   * A rejection is recorded too, and returns the order to DRAFT.
   */
  approvePurchaseOrder: protectedProcedure
    .input(
      z
        .object({
          purchaseOrderId: z.string().min(1),
          decision: z.enum(['APPROVED', 'REJECTED']),
          reason: z.string().trim().max(1000).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) => {
          const order = await tx.pharmacyPurchaseOrder.findFirst({
            where: { id: input.purchaseOrderId },
            include: { requisition: true },
          });
          if (!order) throw new PharmacyPurchasingError('NOT_FOUND');

          const toStatus = input.decision === 'APPROVED' ? 'APPROVED' : 'DRAFT';
          assertPurchaseOrderTransition(order.status, toStatus);
          assertApprovalAllowed({
            approverId: ctx.session.user.id,
            requestedById: order.requisition?.requestedByUserId ?? null,
            createdById: order.createdByUserId,
          });
          if (input.decision === 'APPROVED') {
            // Authorization can lapse between drafting and approval.
            assertOrderableSupplier(
              await tx.pharmacySupplier.findFirst({
                where: { id: order.supplierId },
                include: WITH_LICENCES,
              }),
              new Date()
            );
          }

          let updatedOrder;
          try {
            updatedOrder = await tx.pharmacyPurchaseOrder.update({
              where: { id: order.id, status: 'SUBMITTED' },
              data:
                input.decision === 'APPROVED'
                  ? {
                      status: 'APPROVED',
                      approvedAt: new Date(),
                      approvedByUserId: ctx.session.user.id,
                    }
                  : { status: 'DRAFT' },
            });
          } catch (error) {
            if ((error as { code?: unknown } | null)?.code === 'P2025') {
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'Purchase order has already been reviewed.',
              });
            }
            throw error;
          }

          await tx.pharmacyPurchaseOrderApproval.create({
            data: {
              purchaseOrderId: order.id,
              actorUserId: ctx.session.user.id,
              policy: SEGREGATION_OF_DUTIES_POLICY,
              decision: input.decision,
              fromStatus: order.status,
              toStatus,
              reason: input.reason,
            },
          });
          return updatedOrder;
        });
      } catch (error) {
        domainError(error);
      }
    }),

  sendPurchaseOrder: protectedProcedure
    .input(z.object({ purchaseOrderId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const order = await ctx.db.pharmacyPurchaseOrder.findFirst({
          where: { id: input.purchaseOrderId },
        });
        if (!order) throw new PharmacyPurchasingError('NOT_FOUND');
        assertPurchaseOrderTransition(order.status, 'SENT');
        // PUR-01 again: the supplier must still be orderable at the moment it is sent.
        assertOrderableSupplier(
          await ctx.db.pharmacySupplier.findFirst({
            where: { id: order.supplierId },
            include: WITH_LICENCES,
          }),
          new Date()
        );
        return await ctx.db.pharmacyPurchaseOrder.update({
          where: { id: order.id },
          data: { status: 'SENT', sentAt: new Date() },
        });
      } catch (error) {
        domainError(error);
      }
    }),

  /** PUR-03: the stored order, costed. Bonus packs only ever divide the money over more units. */
  landedCost: auditedProtectedProcedure
    .input(z.object({ purchaseOrderId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      try {
        const order = await ctx.db.pharmacyPurchaseOrder.findFirst({
          where: { id: input.purchaseOrderId },
          include: { lines: { orderBy: { lineNumber: 'asc' } } },
        });
        if (!order) throw new PharmacyPurchasingError('NOT_FOUND');
        const costed = landedCost({
          lines: order.lines.map((line) => ({
            orderedPacks: line.orderedPacks,
            bonusPacks: line.bonusPacks,
            canonicalUnitsPerPack: line.canonicalUnitsPerPack,
            listPricePerPackMinor: line.listPricePerPackMinor,
            discountBps: line.discountBps,
            rebateBps: line.rebateBps,
            taxBps: line.taxBps,
            taxCreditable: line.taxCreditable,
          })),
          freightMinor: order.freightMinor,
          otherChargesMinor: order.otherChargesMinor,
        });
        return {
          purchaseOrderId: order.id,
          ...costed,
          lines: costed.lines.map((line, index) => ({
            ...line,
            purchaseOrderLineId: order.lines[index]!.id,
            medicineId: order.lines[index]!.medicineId,
          })),
        };
      } catch (error) {
        domainError(error);
      }
    }),

  // ----- PUR-02 receiving / PUR-05 direct purchase -----

  /**
   * PUR-02 receiving and PUR-05: draft what arrived. Nothing here touches
   * stock — a draft receipt is a document, and the ledger only learns about it
   * when `postGoodsReceipt` runs.
   *
   * `directPurchase` is the PUR-05 path: no purchase order, and a bypass reason
   * and approver in its place. Everything else about the two paths is identical
   * by construction, because they are the same procedure.
   */
  createGoodsReceipt: protectedProcedure
    .input(
      z
        .object({
          reference: z.string().trim().min(1).max(100),
          branchId,
          supplierId: z.string().min(1),
          purchaseOrderId: z.string().min(1).optional(),
          supplierInvoiceRef: z.string().trim().min(1).max(200),
          supplierInvoiceDate: z.date(),
          distributorNtn: z.string().trim().min(1).max(60).optional(),
          distributorStrn: z.string().trim().min(1).max(60).optional(),
          warrantyEvidenceRef: z.string().trim().min(1).max(500),
          receivedAt: z.date(),
          directPurchase: z
            .object({
              reason: z.string().trim().min(1).max(1000),
              approvedByUserId: z.string().trim().min(1).max(200),
            })
            .strict()
            .optional(),
          note: z.string().trim().max(2000).optional(),
          qualifiedPersonUserId: z.string().trim().min(1).optional(),
          lines: z
            .array(
              z
                .object({
                  purchaseOrderLineId: z.string().min(1).optional(),
                  medicineId: z.string().min(1),
                  packLevelId: z.string().min(1),
                  batchNumber: z.string().trim().min(1).max(120),
                  printedExpiry: z.date(),
                  expiryPrecision: z.enum(['DAY', 'MONTH']),
                  printedMrpMinor: z.number().int().positive(),
                  canonicalUnitsPerPack: z.number().int().positive(),
                  receivedPacks: z.number().int().nonnegative(),
                  bonusPacks: z.number().int().nonnegative().default(0),
                  rejectedCanonicalUnits: z.number().int().nonnegative().default(0),
                  rejectionReason: z.string().trim().min(1).max(500).optional(),
                  invoicedPricePerPackMinor: z.number().int().nonnegative(),
                  discountBps: bps.default(0),
                  taxBps: bps.default(0),
                  taxCreditable: z.boolean().default(false),
                  stockLocationId: z.string().min(1),
                  quarantineLocationId: z.string().min(1).optional(),
                  gtin: z
                    .string()
                    .regex(/^\d{14}$/)
                    .optional(),
                  serialNumber: z.string().trim().min(1).max(20).optional(),
                  gs1Payload: z.string().trim().min(1).max(400).optional(),
                  invoiceCorrection: z.boolean().optional(),
                  gs1Warnings: z.array(z.enum(GS1_WARNING_CODES)).max(6).optional(),
                })
                .strict()
                // PUR-04: rejected goods need somewhere that is not the shelf,
                // and a reason, before the row can even be drafted.
                .refine(
                  (line) =>
                    line.rejectedCanonicalUnits === 0
                      ? !line.quarantineLocationId && !line.rejectionReason
                      : Boolean(line.quarantineLocationId) && Boolean(line.rejectionReason),
                  {
                    message:
                      'Rejected units need a quarantine location and a reason; accepted-only lines need neither.',
                    path: ['rejectedCanonicalUnits'],
                  }
                )
                .refine(
                  (line) => !line.serialNumber || Boolean(line.gtin) || Boolean(line.gs1Payload),
                  {
                    message: 'A serial needs the GTIN it was scanned with.',
                    path: ['serialNumber'],
                  }
                )
            )
            .min(1),
        })
        .strict()
        .refine((value) => Boolean(value.directPurchase) !== Boolean(value.purchaseOrderId), {
          message:
            'A goods receipt is either against a purchase order or a direct purchase with a bypass, never both or neither.',
          path: ['purchaseOrderId'],
        })
    )
    .mutation(async ({ ctx, input }) => {
      await assertProcurement(ctx);
      const scope = receivingScope(ctx, input.branchId);
      try {
        // PUR-01: an unauthorized or licence-expired supplier cannot be
        // received from, checked here and again when the receipt posts.
        assertOrderableSupplier(
          await ctx.db.pharmacySupplier.findFirst({
            where: { id: input.supplierId },
            include: WITH_LICENCES,
          }),
          input.receivedAt
        );
        if (input.directPurchase) {
          assertDirectPurchaseAuthorized({
            bypassReason: input.directPurchase.reason,
            bypassApprovedByUserId: input.directPurchase.approvedByUserId,
            receivedByUserId: scope.actorId,
          });
        }
        const purchaseOrder = input.purchaseOrderId
          ? await ctx.db.pharmacyPurchaseOrder.findFirst({
              where: { id: input.purchaseOrderId, supplierId: input.supplierId, branchId: input.branchId },
              include: { lines: { orderBy: { lineNumber: 'asc' } } },
            })
          : null;
        if (input.purchaseOrderId && !purchaseOrder) {
          throw new PharmacyReceivingError('CROSS_TENANT_REFERENCE');
        }

        const orderLines = purchaseOrder?.lines ?? [];
        const ownOrderLines = new Map(orderLines.map((line) => [line.id, line]));
        const orderLandedCosts = purchaseOrder
          ? landedCost({
              lines: orderLines.map((line) => ({
                orderedPacks: line.orderedPacks,
                bonusPacks: line.bonusPacks ?? 0,
                canonicalUnitsPerPack: line.canonicalUnitsPerPack,
                listPricePerPackMinor: line.listPricePerPackMinor,
                discountBps: line.discountBps ?? 0,
                rebateBps: line.rebateBps,
                taxBps: line.taxBps ?? 0,
                taxCreditable: line.taxCreditable ?? false,
              })),
              freightMinor: purchaseOrder.freightMinor,
              otherChargesMinor: purchaseOrder.otherChargesMinor,
            }).lines
          : [];
        const landedCostByOrderLine = new Map(
          orderLines.map((line, index) => [line.id, orderLandedCosts[index]!])
        );

        const lines: Prisma.PharmacyGoodsReceiptLineUncheckedCreateWithoutGoodsReceiptInput[] = [];
        const seenSerials = new Set<string>();
        for (const [index, line] of input.lines.entries()) {
          if (
            !(await ctx.db.medicine.findFirst({ where: { id: line.medicineId, saleable: true } }))
          )
            throw new PharmacyReceivingError('CROSS_TENANT_REFERENCE');
          if (!(await ctx.db.packLevel.findFirst({ where: { id: line.packLevelId } })))
            throw new PharmacyReceivingError('MISSING_PACK_CONVERSION');
          // An ordered line borrowed from another order — or from another
          // tenant — would make the three-way match compare the goods against
          // something they were never ordered on.
          if (line.purchaseOrderLineId) {
            const orderLine = ownOrderLines.get(line.purchaseOrderLineId);
            if (!orderLine) throw new PharmacyReceivingError('CROSS_TENANT_REFERENCE');
            // The referenced order line is the authority for item identity. Without
            // this check, unrelated goods could inherit its price and quantity terms,
            // pass three-way matching, and close the wrong ordered line.
            if (
              orderLine.medicineId !== line.medicineId ||
              orderLine.packLevelId !== line.packLevelId
            ) {
              throw new PharmacyReceivingError('PURCHASE_ORDER_LINE_ITEM_MISMATCH');
            }
          }

          const orderLine = line.purchaseOrderLineId
            ? ownOrderLines.get(line.purchaseOrderLineId)
            : undefined;
          const quantities = receiptLineQuantities({
            receivedPacks: line.receivedPacks,
            bonusPacks: line.bonusPacks,
            canonicalUnitsPerPack: line.canonicalUnitsPerPack,
            rejectedCanonicalUnits: line.rejectedCanonicalUnits,
          });
          const identity = await resolveReceiptLineIdentity(ctx.db, scope.organizationId, {
            medicineId: line.medicineId,
            batchNumber: line.batchNumber,
            printedExpiry: line.printedExpiry,
            expiryPrecision: line.expiryPrecision,
            gtin: line.gtin,
            serialNumber: line.serialNumber,
            gs1Warnings: line.gs1Warnings,
            gs1Payload: line.gs1Payload,
            invoiceCorrection: line.invoiceCorrection,
            acceptedCanonicalUnits: quantities.acceptedCanonicalUnits,
            receivedAt: input.receivedAt,
          });
          if (identity.gtin && identity.serialKey) {
            const token = `${identity.gtin}:${identity.serialKey}`;
            if (seenSerials.has(token)) throw new PharmacyReceivingError('DUPLICATE_SERIAL');
            seenSerials.add(token);
            const prior = await ctx.db.pharmacyGoodsReceiptLine.findFirst({
              where: {
                organizationId: scope.organizationId,
                gtin: identity.gtin,
                serialKey: identity.serialKey,
              },
              select: { id: true },
            });
            if (prior) throw new PharmacyReceivingError('DUPLICATE_SERIAL');
          }
          // The tenant and branch are not repeated here: they travel in the
          // composite key of the receipt this line is nested under, so Prisma
          // supplies them and a payload could never disagree with the header.
          lines.push({
            lineNumber: index + 1,
            purchaseOrderLineId: line.purchaseOrderLineId ?? null,
            medicineId: line.medicineId,
            packLevelId: line.packLevelId,
            batchNumber: identity.batchNumber,
            printedExpiry: identity.printedExpiry,
            expiryPrecision: identity.expiryPrecision,
            printedMrpMinor: line.printedMrpMinor,
            canonicalUnitsPerPack: line.canonicalUnitsPerPack,
            receivedPacks: line.receivedPacks,
            bonusPacks: line.bonusPacks,
            receivedCanonicalUnits: quantities.receivedCanonicalUnits,
            bonusCanonicalUnits: quantities.bonusCanonicalUnits,
            acceptedCanonicalUnits: quantities.acceptedCanonicalUnits,
            rejectedCanonicalUnits: quantities.rejectedCanonicalUnits,
            rejectionReason: line.rejectionReason ?? null,
            invoicedPricePerPackMinor: line.invoicedPricePerPackMinor,
            discountBps: line.discountBps,
            taxBps: line.taxBps,
            taxCreditable: line.taxCreditable,
            // PUR-03: bonus units divide the same money over more units, so a
            // scheme lowers the landed cost and never adds revenue.
            unitCostMinor: receiptLineUnitCostMinor({
              receivedPacks: line.receivedPacks,
              bonusPacks: line.bonusPacks,
              canonicalUnitsPerPack: line.canonicalUnitsPerPack,
              invoicedPricePerPackMinor: line.invoicedPricePerPackMinor,
              discountBps: line.discountBps,
              rebateBps: orderLine?.rebateBps ?? 0,
              taxBps: line.taxBps,
              taxCreditable: line.taxCreditable,
              // Replaced with the cumulative residual inside the serializable
              // write transaction below, after prior receipts are known.
              allocatedChargeMinor: 0,
            }),
            stockLocationId: line.stockLocationId,
            quarantineLocationId: line.quarantineLocationId ?? null,
            gtin: identity.gtin,
            serialNumber: identity.serialNumber,
            serialKey: identity.serialKey,
            gs1Warnings: identity.gs1Warnings,
          });
        }

        return await ctx.db.$transaction(
          async (tx) => {
            const orderLineIds = [
              ...new Set(
                lines.flatMap((line) =>
                  line.purchaseOrderLineId ? [line.purchaseOrderLineId] : []
                )
              ),
            ];
            const priorLines = orderLineIds.length
              ? await tx.pharmacyGoodsReceiptLine.findMany({
                  where: { purchaseOrderLineId: { in: orderLineIds } },
                  select: { purchaseOrderLineId: true, receivedPacks: true },
                })
              : [];
            const cumulativePacks = new Map<string, number>();
            for (const prior of priorLines) {
              if (!prior.purchaseOrderLineId) continue;
              const total =
                (cumulativePacks.get(prior.purchaseOrderLineId) ?? 0) + prior.receivedPacks;
              if (!Number.isSafeInteger(total))
                throw new PharmacyReceivingError('INVALID_QUANTITY');
              cumulativePacks.set(prior.purchaseOrderLineId, total);
            }
            for (const line of lines) {
              if (!line.purchaseOrderLineId) continue;
              const orderLine = ownOrderLines.get(line.purchaseOrderLineId);
              const orderLineCost = landedCostByOrderLine.get(line.purchaseOrderLineId);
              if (!orderLine || !orderLineCost) continue;
              const previouslyReceivedPacks = cumulativePacks.get(line.purchaseOrderLineId) ?? 0;
              const allocatedChargeMinor = cumulativeAllocatedChargeMinor({
                allocatedChargeMinor: orderLineCost.allocatedChargeMinor,
                orderedPacks: orderLine.orderedPacks,
                previouslyReceivedPacks,
                receivedPacks: line.receivedPacks,
              });
              line.unitCostMinor = receiptLineUnitCostMinor({
                receivedPacks: line.receivedPacks,
                bonusPacks: line.bonusPacks ?? 0,
                canonicalUnitsPerPack: line.canonicalUnitsPerPack,
                invoicedPricePerPackMinor: line.invoicedPricePerPackMinor,
                discountBps: line.discountBps ?? 0,
                rebateBps: orderLine.rebateBps,
                taxBps: line.taxBps ?? 0,
                taxCreditable: line.taxCreditable ?? false,
                allocatedChargeMinor,
              });
              const totalReceivedPacks = previouslyReceivedPacks + line.receivedPacks;
              if (!Number.isSafeInteger(totalReceivedPacks))
                throw new PharmacyReceivingError('INVALID_QUANTITY');
              cumulativePacks.set(line.purchaseOrderLineId, totalReceivedPacks);
            }

            return tx.pharmacyGoodsReceipt.create({
              data: {
                organizationId: scope.organizationId,
                branchId: scope.branchId,
                reference: input.reference,
                supplierId: input.supplierId,
                purchaseOrderId: input.purchaseOrderId ?? null,
                supplierInvoiceRef: input.supplierInvoiceRef,
                supplierInvoiceDate: input.supplierInvoiceDate,
                distributorNtn: input.distributorNtn ?? null,
                distributorStrn: input.distributorStrn ?? null,
                warrantyEvidenceRef: input.warrantyEvidenceRef,
                receivedByUserId: scope.actorId,
                receivedAt: input.receivedAt,
                directPurchase: Boolean(input.directPurchase),
                bypassReason: input.directPurchase?.reason ?? null,
                bypassApprovedByUserId: input.directPurchase?.approvedByUserId ?? null,
                bypassApprovedAt: input.directPurchase ? new Date() : null,
                note: input.note,
                qualifiedPersonUserId: input.qualifiedPersonUserId ?? null,
                lines: { create: lines },
              },
              include: { lines: { orderBy: { lineNumber: 'asc' } } },
            });
          },
          { isolationLevel: 'Serializable' }
        );
      } catch (error) {
        domainError(error);
      }
    }),

  /**
   * PUR-02 receiving: post the receipt into the PH-INV batch ledger, and raise
   * the PUR-04 match exceptions the delivery earned.
   *
   * One transaction: the lot, both dispositions, every exception, the receipt
   * status and the order's move to RECEIVING commit together or not at all.
   */
  postGoodsReceipt: protectedProcedure
    .input(
      z
        .object({
          branchId,
          goodsReceiptId: z.string().min(1),
          staffProfileId: z.string().trim().min(1).optional(),
          pin: z
            .string()
            .regex(/^\d{4,8}$/)
            .optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await assertProcurement(ctx);
      const scope = receivingScope(ctx, input.branchId);
      // Lockout counters commit even when the PIN is refused. Stock posting is
      // a second transaction, so a refused PIN never leaves a half-posted receipt.
      const attempt = await ctx.db.$transaction((tx) =>
        verifyControlledPurchaseWitness(txDb(tx), scope, {
          goodsReceiptId: input.goodsReceiptId,
          staffProfileId: input.staffProfileId,
          pin: input.pin,
        })
      );
      if ('blocked' in attempt) return attempt;
      try {
        return await ctx.db.$transaction((tx) =>
          postGoodsReceipt(txDb(tx), scope, {
            goodsReceiptId: input.goodsReceiptId,
            at: new Date(),
            staffProfileId: input.staffProfileId,
            pin: input.pin,
          })
        );
      } catch (error) {
        domainError(error);
      }
    }),

  /** The receipt's qualified person, when they can enter a PIN to witness posting. */
  controlledWitnesses: protectedProcedure
    .input(
      z
        .object({
          branchId,
          goodsReceiptId: z.string().min(1),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const actorId = ctx.session?.user?.id;
      if (!actorId) throw new TRPCError({ code: 'UNAUTHORIZED' });
      const actor = subjectFromSession(ctx.session!.user);
      if (
        !(await can(actor, 'pharmacy:safety', undefined, { db: ctx.db })) &&
        !(await can(actor, 'pharmacy:dispense', undefined, { db: ctx.db }))
      ) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      const organizationId = ctx.entitlements?.organizationId;
      if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
      const receipt = await ctx.db.pharmacyGoodsReceipt.findFirst({
        where: {
          id: input.goodsReceiptId,
          organizationId,
          branchId: input.branchId,
        },
        select: { qualifiedPersonUserId: true },
      });
      if (!receipt?.qualifiedPersonUserId || receipt.qualifiedPersonUserId === actorId) return [];
      return listControlledPinWitnesses(
        ctx.db,
        organizationId,
        actorId,
        receipt.qualifiedPersonUserId
      );
    }),

  /**
   * PUR-04: undo a posting with linked compensating movements. Nothing that was
   * posted is edited or deleted; if the stock has already moved on, the ledger
   * refuses rather than driving a balance negative.
   */
  reverseGoodsReceipt: protectedProcedure
    .input(
      z
        .object({
          branchId,
          goodsReceiptId: z.string().min(1),
          reason: z.string().trim().min(1).max(1000),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await assertProcurement(ctx);
      const scope = receivingScope(ctx, input.branchId);
      try {
        return await ctx.db.$transaction((tx) =>
          reverseGoodsReceipt(txDb(tx), scope, {
            goodsReceiptId: input.goodsReceiptId,
            reason: input.reason,
            at: new Date(),
          })
        );
      } catch (error) {
        domainError(error);
      }
    }),

  /** PUR-04: the queue that stays visible until somebody resolves it. */
  receivingExceptions: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId,
          status: z.enum(['OPEN', 'RESOLVED']).default('OPEN'),
          goodsReceiptId: z.string().min(1).optional(),
        })
        .strict()
    )
    .query(({ ctx, input }) => {
      const scope = receivingScope(ctx, input.branchId);
      return listReceivingExceptions(
        ctx.db,
        { organizationId: scope.organizationId, branchId: scope.branchId },
        { status: input.status, goodsReceiptId: input.goodsReceiptId }
      );
    }),

  /** PUR-04: close one, with the actor from the session and a mandatory note. */
  resolveReceivingException: protectedProcedure
    .input(
      z
        .object({
          branchId,
          receivingExceptionId: z.string().min(1),
          resolutionNote: z.string().trim().min(1).max(1000),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await resolveReceivingException(ctx.db, receivingScope(ctx, input.branchId), {
          receivingExceptionId: input.receivingExceptionId,
          resolutionNote: input.resolutionNote,
          at: new Date(),
        });
      } catch (error) {
        domainError(error);
      }
    }),

  // ── PUR-06 — returns, expiry claims, debit notes and supplier credit ──────

  /**
   * Open a DRAFT return or expiry claim. Reserves nothing: the INV-09 hold is
   * taken at submission, so a draft never removes stock from sale.
   */
  createPurchaseReturn: protectedProcedure
    .input(
      z
        .object({
          branchId,
          supplierId: z.string().min(1),
          kind: z.enum(['PURCHASE_RETURN', 'EXPIRY_CLAIM']),
          reference: z.string().trim().min(1).max(120),
          note: z.string().trim().max(1000).optional(),
          lines: z
            .array(
              z
                .object({
                  inventoryLotId: z.string().min(1),
                  stockLocationId: z.string().min(1),
                  quantityUnits: z.number().int().positive(),
                  reason: z.string().trim().min(1).max(500),
                  returnWindowEndsAt: z.date(),
                  expectedCreditMinor: z.number().int().min(0),
                })
                .strict()
            )
            .min(1),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = receivingScope(ctx, input.branchId);
      try {
        return await ctx.db.$transaction((tx) =>
          createPurchaseReturn(txDb(tx), scope, {
            supplierId: input.supplierId,
            kind: input.kind,
            reference: input.reference,
            note: input.note,
            lines: input.lines,
          })
        );
      } catch (error) {
        domainError(error);
      }
    }),

  /** Take the INV-09 reservation. From here the quantity cannot be sold. */
  submitPurchaseReturn: auditedProtectedProcedure
    .input(z.object({ branchId, purchaseReturnId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      const scope = receivingScope(ctx, input.branchId);
      try {
        return await ctx.db.$transaction((tx) =>
          submitPurchaseReturn(txDb(tx), scope, {
            purchaseReturnId: input.purchaseReturnId,
            at: new Date(),
          })
        );
      } catch (error) {
        domainError(error);
      }
    }),

  /** Post the RETURN_TO_SUPPLIER movements and release the reservation. */
  dispatchPurchaseReturn: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId,
          purchaseReturnId: z.string().min(1),
          idempotencyKey: z.string().trim().min(1).max(200),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = receivingScope(ctx, input.branchId);
      try {
        return await ctx.db.$transaction((tx) =>
          dispatchPurchaseReturn(txDb(tx), scope, {
            purchaseReturnId: input.purchaseReturnId,
            at: new Date(),
            idempotencyKeyPrefix: input.idempotencyKey,
          })
        );
      } catch (error) {
        domainError(error);
      }
    }),

  issueDebitNote: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId,
          purchaseReturnId: z.string().min(1),
          reference: z.string().trim().min(1).max(120),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = receivingScope(ctx, input.branchId);
      try {
        return await issueDebitNote(ctx.db, scope, {
          purchaseReturnId: input.purchaseReturnId,
          reference: input.reference,
          at: new Date(),
        });
      } catch (error) {
        domainError(error);
      }
    }),

  recordSupplierCredit: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId,
          supplierId: z.string().min(1),
          reference: z.string().trim().min(1).max(120),
          amountMinor: z.number().int().positive(),
          receivedAt: z.date(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = receivingScope(ctx, input.branchId);
      try {
        return await recordSupplierCredit(ctx.db, scope, {
          supplierId: input.supplierId,
          reference: input.reference,
          amountMinor: input.amountMinor,
          receivedAt: input.receivedAt,
        });
      } catch (error) {
        domainError(error);
      }
    }),

  allocateSupplierCredit: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId,
          supplierCreditId: z.string().min(1),
          debitNoteId: z.string().min(1),
          amountMinor: z.number().int().positive(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = receivingScope(ctx, input.branchId);
      try {
        return await ctx.db.$transaction((tx) =>
          allocateSupplierCredit(txDb(tx), scope, {
            supplierCreditId: input.supplierCreditId,
            debitNoteId: input.debitNoteId,
            amountMinor: input.amountMinor,
            at: new Date(),
          })
        );
      } catch (error) {
        domainError(error);
      }
    }),

  /** PUR-06 acceptance: expected and received credit, side by side. */
  debitNotePositions: protectedProcedure
    .input(z.object({ branchId, supplierId: z.string().min(1).optional() }).strict())
    .query(({ ctx, input }) => {
      const scope = receivingScope(ctx, input.branchId);
      return debitNotePositions(
        ctx.db,
        { organizationId: scope.organizationId, branchId: scope.branchId },
        { supplierId: input.supplierId }
      );
    }),

  // ── PUR-01..06 console reads ────────────────────────────────────────────────
  //
  // The lane composed its writes and its refusals first, so nothing above reads
  // a list back. These add the projections the four purchasing surfaces render
  // and change no state. They live on this router rather than a new one so the
  // `pharmacyPurchasing` → `pharmacy-procurement` module gate in module-catalog
  // covers a read exactly as it covers a write; a separate router key would be
  // ungated until somebody remembered to add it.

  /**
   * Every option the purchasing surfaces offer, in one round trip: branches,
   * stock locations, medicines with their derived pack conversions, suppliers
   * with their PUR-01 eligibility, and the users who may approve a PUR-05
   * bypass. UX rules 1 and 16: resolved server-side, this organization only.
   */
  workspace: protectedProcedure.query(({ ctx }) =>
    purchasingWorkspace(ctx.db, {
      organizationId: tenantScope(ctx).organizationId,
      actorId: ctx.session.user.id,
    })
  ),

  /** PUR-01 — suppliers with licence evidence and the current trade decision. */
  suppliers: protectedProcedure
    .input(
      z
        .object({ includeInactive: z.boolean().default(false) })
        .strict()
        .optional()
    )
    .query(({ ctx, input }) =>
      listSuppliers(ctx.db, tenantScope(ctx), { includeInactive: input?.includeInactive })
    ),

  /** PUR-02 — requisitions with their lines, quotes and resulting orders. */
  requisitions: protectedProcedure.query(({ ctx }) => listRequisitions(ctx.db, tenantScope(ctx))),

  /** PUR-02/PUR-03 — orders with lines, approval history and posted receipts. */
  purchaseOrders: protectedProcedure.query(({ ctx }) =>
    listPurchaseOrders(ctx.db, tenantScope(ctx))
  ),

  /**
   * PUR-02 — canonical units already received against each ordered line, from
   * POSTED receipts only. The receiving bench pre-fills the outstanding balance
   * from this, so it never asks the operator to work out what is still owed.
   */
  receivedAgainstOrder: protectedProcedure
    .input(z.object({ purchaseOrderId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) =>
      Object.fromEntries(
        await receivedAgainstOrder(ctx.db, tenantScope(ctx), input.purchaseOrderId)
      )
    ),

  /** PUR-02 receiving / PUR-05 — the receipts filed at one branch. */
  goodsReceipts: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(({ ctx, input }) => listGoodsReceipts(ctx.db, receivingScope(ctx, input.branchId))),

  /** PUR-04 — the review queue, joined to the medicine and receipt it concerns. */
  receivingExceptionQueue: protectedProcedure
    .input(z.object({ branchId, status: z.enum(['OPEN', 'RESOLVED']).default('OPEN') }).strict())
    .query(({ ctx, input }) =>
      listReceivingExceptionQueue(ctx.db, receivingScope(ctx, input.branchId), {
        status: input.status,
      })
    ),

  /**
   * PUR-02 acceptance — the stock a posted receipt produced, read back from the
   * PH-INV ledger rather than from the receipt document.
   */
  lotsFromReceipt: protectedProcedure
    .input(z.object({ branchId, goodsReceiptId: z.string().min(1) }).strict())
    .query(({ ctx, input }) =>
      lotsFromReceipt(ctx.db, receivingScope(ctx, input.branchId), input.goodsReceiptId)
    ),

  /** PUR-06 — returns and claims with their window state and credit position. */
  purchaseReturns: protectedProcedure
    .input(supplierFollowUpInput)
    .query(async ({ ctx, input: { branchId: branch, ...bounds } }) =>
      listPurchaseReturns(ctx.db, await supplierFollowUpScope(ctx, branch), bounds)
    ),

  /** PUR-06 — the available lots a return may be raised against. */
  returnableLots: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(({ ctx, input }) => listReturnableLots(ctx.db, receivingScope(ctx, input.branchId))),

  /**
   * PUR-02 receiving — resolve a scanned barcode, or a typed fragment of a
   * product name, to the medicine the carton in the operator's hand contains.
   */
  resolveScan: protectedProcedure
    .input(z.object({ term: z.string().trim().min(1).max(512) }).strict())
    .query(({ ctx, input }) => resolveScan(ctx.db, tenantScope(ctx), input.term)),

  /** SAFE-05: audited, advisory pack authentication at the goods-in bench. */
  authenticatePack: auditedProtectedProcedure
    .input(z.object({ branchId, payload: z.string().max(512) }).strict())
    .mutation(async ({ ctx, input }) => {
      const scope = receivingScope(ctx, input.branchId);
      ctx.audit.detail = { category: 'PHARMACY_SAFETY', action: 'receiving_pack_scan' };
      return authenticatePharmacyPack(ctx.db, {
        ...scope,
        actorId: ctx.session.user.id,
        source: 'RECEIVING',
        payload: input.payload,
      });
    }),

  /** PUR-06 — supplier credits recorded at this branch and what they cover. */
  supplierCredits: protectedProcedure
    .input(supplierFollowUpInput)
    .query(async ({ ctx, input: { branchId: branch, ...bounds } }) =>
      listSupplierCredits(ctx.db, await supplierFollowUpScope(ctx, branch), bounds)
    ),

  /** INV-10 — exact PUR-07 demand. Branch grants see only their own rows. */
  centralDemand: auditedProtectedProcedure
    .input(z.object({ branchId: branchId.optional() }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return await centralDemand(
          ctx.db,
          {
            organizationId: tenantScope(ctx).organizationId,
            actorId: ctx.session.user.id,
          },
          input.branchId
        );
      } catch (error) {
        domainError(error);
      }
    }),

  /** INV-10 — one human-created central draft PO; never auto-orders. */
  createCentralPurchaseOrder: auditedProtectedProcedure
    .input(
      z
        .object({
          reference: z.string().trim().min(1).max(100),
          supplierId: z.string().min(1),
          receivingBranchId: branchId,
          lines: z
            .array(
              z
                .object({
                  medicineId: z.string().min(1),
                  packLevelId: z.string().min(1),
                  orderedPacks: z.number().int().positive(),
                  canonicalUnitsPerPack: z.number().int().positive(),
                  listPricePerPackMinor: z.number().int().nonnegative(),
                })
                .strict()
            )
            .min(1),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await createCentralPurchaseOrder(
          ctx.db,
          {
            organizationId: tenantScope(ctx).organizationId,
            actorId: ctx.session.user.id,
          },
          input
        );
      } catch (error) {
        domainError(error);
      }
    }),

  /** INV-10 — records allocation evidence while INV-07 creates the movement. */
  allocateCentralReceipt: auditedProtectedProcedure
    .input(
      z
        .object({
          goodsReceiptId: z.string().min(1),
          allocations: z
            .array(
              z
                .object({
                  goodsReceiptLineId: z.string().min(1),
                  destinationBranchId: branchId,
                  destinationStockLocationId: z.string().min(1),
                  quantityUnits: z.number().int().positive(),
                })
                .strict()
            )
            .min(1),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          allocateCentralReceipt(
            txDb(tx),
            {
              organizationId: tenantScope(ctx).organizationId,
              actorId: ctx.session.user.id,
            },
            input
          )
        );
      } catch (error) {
        domainError(error);
      }
    }),
});

type FollowUpReadInput = PurchasingReadBounds & { branchId: string };
type FollowUpReadCaller<T> = {
  (
    input: FollowUpReadInput & { page: NonNullable<PurchasingReadBounds['page']> }
  ): Promise<PurchasingReadPage<T>>;
  (
    input: FollowUpReadInput & { page: PurchasingReadBounds['page'] }
  ): Promise<T[] | PurchasingReadPage<T>>;
  (input: FollowUpReadInput & { page?: undefined }): Promise<T[]>;
};
type PurchasingCaller = Omit<
  ReturnType<typeof purchasingRouter.createCaller>,
  'purchaseReturns' | 'supplierCredits'
> & {
  purchaseReturns: FollowUpReadCaller<PurchaseReturnDetail>;
  supplierCredits: FollowUpReadCaller<SupplierCreditDetail>;
};
// tRPC 11 widens input-dependent output to a union. These server-caller overloads preserve
// existing array callers; transport output remains the honest union. The runtime procedures
// above choose the envelope only for `page`, covered by router + serialization tests.
export const pharmacyPurchasingRouter: Omit<typeof purchasingRouter, 'createCaller'> & {
  createCaller: (...args: Parameters<typeof purchasingRouter.createCaller>) => PurchasingCaller;
} = Object.assign(purchasingRouter, {
  createCaller: purchasingRouter.createCaller as (
    ...args: Parameters<typeof purchasingRouter.createCaller>
  ) => PurchasingCaller,
});
