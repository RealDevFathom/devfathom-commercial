import { TRPCError } from '@trpc/server';
import { z } from 'zod';
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
import { auditedProtectedProcedure, protectedProcedure, router } from '../trpc';

/**
 * PH-PUR — PRD §6.3 PUR-01, PUR-02 (to approval) and PUR-03. Receiving is the
 * follow-up lane once the PH-INV ledger lands, so a purchase order stops at
 * SENT here and never invents a batch, an expiry or a printed MRP.
 *
 * The arithmetic and the refusals live in `@/lib/pharmacy/purchasing`; this
 * router resolves rows through the tenant-scoped client and maps the domain
 * errors onto tRPC codes.
 */

const bps = z.number().int().min(0).max(10_000);

function domainError(error: unknown): never {
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
  throw error;
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

export const pharmacyPurchasingRouter = router({
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
          if (!(await ctx.db.medicine.findFirst({ where: { id: line.medicineId } })))
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
          if (!(await ctx.db.medicine.findFirst({ where: { id: line.medicineId } })))
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
          return tx.pharmacyPurchaseOrder.update({
            where: { id: order.id },
            data:
              input.decision === 'APPROVED'
                ? {
                    status: 'APPROVED',
                    approvedAt: new Date(),
                    approvedByUserId: ctx.session.user.id,
                  }
                : { status: 'DRAFT' },
          });
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
});
