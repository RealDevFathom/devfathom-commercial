import { hasModule } from '@/lib/entitlements';
import {
  executeSandboxPayment,
  sandboxPaymentInput,
  PharmacyPaymentSandboxError,
} from '@/lib/pharmacy/payment-sandbox';
import { paymentSandboxAdmitted } from '@/lib/pharmacy/payment-sandbox-admission';
import { readCounterEvidence, readDailyCloseEvidence } from '@/lib/pharmacy/counter-evidence';
import { can } from '@/lib/abac';
import { annotateAudit } from '@/server/audit';
import {
  isLockedOut,
  registerFailedAttempt,
  clearLockout,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  PharmacyCounterError,
  readCounterCart,
  readCounterReceipt,
  searchCounterCatalog,
} from '@/lib/pharmacy/counter';
import {
  PharmacyCounterKeymapError,
  resolveCounterKeymap,
  type CounterBinding,
} from '@/lib/pharmacy/counter-keymap';
import {
  linkCustomerToSale,
  PharmacyLoyaltyError,
  readCustomerSnapshot,
  redeemSalePoints,
} from '@/lib/pharmacy/customer-loyalty';
import { PharmacyInventoryError } from '@/lib/pharmacy/inventory';
import { onHand } from '@/lib/pharmacy/stock-ledger';
import {
  buildPharmacyReceiptEscPosJob,
  PharmacyReceiptPrintError,
  readPharmacyReceiptFormat,
  readPharmacyReceiptTaxIdentity,
  savePharmacyReceiptFormat,
} from '@/lib/pharmacy/receipt-print';
import { SaveReceiptLayoutSchema } from '@/lib/receipts/configuration';
import { RawPrintValidationError } from '@/lib/restaurant/printing/contract';
import {
  declineSubstitute,
  findSubstituteProposals,
  PharmacySubstituteError,
} from '@/lib/pharmacy/substitute-finder';
import {
  addSaleLine,
  addRestockInterest,
  captureSafeRestockArrival,
  captureDemand,
  changeSaleStatus,
  createSale,
  demandAggregate,
  optOutRestockInterest,
  PharmacySaleError,
  recoverDemandWithAlternate,
  recoverRestockInterest,
  restockRecoveryReport,
  returnSaleLine,
  readReturnHistory,
} from '@/lib/pharmacy/sales';
import type { LedgerScope } from '@/lib/pharmacy/stock-ledger';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { authenticatePharmacyPack } from '@/lib/pharmacy/pack-authentication-operations';
import {
  applyPharmacyTender,
  closePharmacyDrawer,
  cutPharmacyDailyClose,
  openPharmacyDrawer,
  PharmacySettlementError,
  readPharmacyTenderOutcome,
  recordPharmacyCashMovement,
  refundPharmacyTender,
} from '@/lib/pharmacy/settlement';

import { adminProcedure, auditedProtectedProcedure, protectedProcedure, router } from '../trpc';
import type { TRPCContext } from '../trpc';

const branchId = z.string().trim().min(1).max(128);
// Preserve field order and parsing: settlement hashes JSON.stringify(parsed input).
const tenderInput = z
  .object({
    branchId,
    saleId: z.string().min(1),
    deviceId: z.string().min(1),
    businessDate: z.date(),
    type: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'WALLET', 'CREDIT']),
    amountMinor: z.number().int().positive(),
    cashReceivedMinor: z.number().int().nonnegative().optional(),
    idempotencyKey: z.string().trim().min(1).max(160),
  })
  .strict();
const saleUnit = z.enum(['PACK', 'STRIP', 'UNIT']);
const demandReason = z.enum([
  'STOCKOUT',
  'NOT_CARRIED',
  'PACK_UNAVAILABLE',
  'QUARANTINED_OR_EXPIRED',
  'PRICE_REJECTED',
  'PRESCRIPTION_RESTRICTION',
  'LICENCE_RESTRICTION',
  'PHARMACIST_RESTRICTION',
  'SUBSTITUTE_DECLINED',
  'SEARCH_FAILURE',
  'SERVICE_FAILURE',
]);
const txDb = (tx: unknown) => tx as ScopedDb;

function scopeFor(ctx: TRPCContext, branch: string): LedgerScope {
  const organizationId = ctx.entitlements?.organizationId;
  const actorId = ctx.session?.user?.id;
  if (!organizationId || !actorId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return { organizationId, branchId: branch, actorId };
}

function fail(error: unknown): never {
  if (error instanceof PharmacyPaymentSandboxError)
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  if (error instanceof PharmacyInventoryError && error.reason === 'BLOCKED_STOCK') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This lot is quarantined or recalled and cannot be dispensed or sold.',
    });
  }
  if (error instanceof PharmacyInventoryError) {
    // A refused batch override (unknown lot, missing evidence) or an allocation
    // the branch cannot cover is the operator's to correct, never a 500.
    throw new TRPCError({
      code: error.reason === 'NOT_FOUND' ? 'NOT_FOUND' : 'BAD_REQUEST',
      message: error.reason,
    });
  }
  if (error instanceof PharmacyLoyaltyError) {
    throw new TRPCError({
      code:
        error.reason === 'CUSTOMER_NOT_FOUND'
          ? 'NOT_FOUND'
          : error.reason === 'CONSENT_REQUIRED' || error.reason === 'SALE_NOT_LINKED'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST',
      message: error.reason,
    });
  }
  if (error instanceof PharmacySettlementError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.reason });
  }
  if (error instanceof PharmacyCounterError) {
    throw new TRPCError({
      code:
        error.reason === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.reason === 'CROSS_BRANCH_REFERENCE'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST',
      message: error.reason,
    });
  }
  if (error instanceof PharmacyCounterKeymapError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.reason });
  }
  if (error instanceof PharmacySaleError) {
    throw new TRPCError({
      code:
        error.reason === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.reason === 'CROSS_BRANCH_REFERENCE'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST',
      message: error.reason,
    });
  }
  throw error;
}

async function loadCounterReceipt(ctx: TRPCContext, scope: LedgerScope, saleId: string) {
  const [branch, organization] = await Promise.all([
    ctx.db.pharmacyBranch.findFirst({
      where: { id: scope.branchId, organizationId: scope.organizationId },
      select: { name: true },
    }),
    ctx.db.organization.findUnique({
      where: { id: scope.organizationId },
      select: { currency: true },
    }),
  ]);
  if (!branch) throw new PharmacyCounterError('CROSS_BRANCH_REFERENCE');
  return readCounterReceipt(ctx.db, scope, saleId, {
    name: branch.name,
    currency: organization?.currency ?? 'PKR',
  });
}

export const pharmacySalesRouter = router({
  sandboxPayment: adminProcedure.input(sandboxPaymentInput).mutation(async ({ ctx, input }) => {
    annotateAudit(ctx, { skipInput: true });
    try {
      return await ctx.db.$transaction((tx) =>
        executeSandboxPayment(txDb(tx), scopeFor(ctx, input.branchId), input)
      );
    } catch (error) {
      fail(error);
    }
  }),
  customerDirectory: adminProcedure
    .input(z.object({ branchId, query: z.string().trim().max(100).default('') }).strict())
    .query(async ({ ctx, input }) => {
      if (!hasModule(ctx.entitlements, 'pharmacy-crm')) throw new TRPCError({ code: 'FORBIDDEN' });
      const scope = scopeFor(ctx, input.branchId);
      if (
        !(await ctx.db.pharmacyBranch.findFirst({
          where: { id: input.branchId, organizationId: scope.organizationId, active: true },
        }))
      )
        throw new TRPCError({ code: 'FORBIDDEN' });
      return ctx.db.pharmacyCustomer.findMany({
        where: {
          organizationId: scope.organizationId,
          active: true,
          displayName: { contains: input.query, mode: 'insensitive' },
        },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        take: 50,
        select: { id: true, displayName: true, phoneLast4: true },
      });
    }),
  // Evidence contains staff/customer imagery; keep owner-only access separate
  // from cashier receipt access. Tenant and branch filters apply before storage.
  counterEvidence: adminProcedure
    .input(z.object({ branchId, saleId: z.string().min(1) }).strict())
    .query(({ ctx, input }) => {
      if (!hasModule(ctx.entitlements, 'pharmacy-core')) throw new TRPCError({ code: 'FORBIDDEN' });
      return readCounterEvidence(ctx.db, scopeFor(ctx, input.branchId), input.saleId);
    }),
  dailyCloseEvidence: adminProcedure
    .input(z.object({ branchId, closeId: z.string().min(1) }).strict())
    .query(({ ctx, input }) => {
      if (!hasModule(ctx.entitlements, 'pharmacy-core')) throw new TRPCError({ code: 'FORBIDDEN' });
      return readDailyCloseEvidence(ctx.db, scopeFor(ctx, input.branchId), input.closeId);
    }),
  customerSnapshot: protectedProcedure
    .input(
      z
        .object({
          branchId,
          customerId: z.string().min(1),
          page: z.number().int().min(1).max(10000).default(1),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      try {
        return await readCustomerSnapshot(
          ctx.db,
          scopeFor(ctx, input.branchId),
          input.customerId,
          input.page
        );
      } catch (error) {
        fail(error);
      }
    }),
  linkCustomer: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1),
          patientId: z.string().min(1),
          displayName: z.string().trim().min(1).max(200),
          phoneLast4: z
            .string()
            .regex(/^\d{4}$/)
            .optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          linkCustomerToSale(txDb(tx), scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  redeemPoints: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1),
          points: z.number().int().positive(),
          deviceId: z.string().min(1),
          businessDate: z.date(),
          idempotencyKey: z.string().trim().min(1).max(160),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          redeemSalePoints(txDb(tx), scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  openDrawer: protectedProcedure
    .input(
      z
        .object({
          branchId,
          deviceId: z.string().min(1),
          businessDate: z.date(),
          openingFloatMinor: z.number().int().nonnegative(),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        openPharmacyDrawer(txDb(tx), scopeFor(ctx, input.branchId), input)
      )
    ),
  drawerMovement: protectedProcedure
    .input(
      z
        .object({
          branchId,
          drawerSessionId: z.string().min(1),
          kind: z.enum(['PAID_IN', 'PAID_OUT']),
          amountMinor: z.number().int().positive(),
          reason: z.string().trim().min(1),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        recordPharmacyCashMovement(txDb(tx), scopeFor(ctx, input.branchId), input)
      )
    ),
  closeDrawer: protectedProcedure
    .input(
      z
        .object({
          branchId,
          drawerSessionId: z.string().min(1),
          countedCashMinor: z.number().int().nonnegative(),
          controlledCountHook: z.record(z.string(), z.unknown()).optional(),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        closePharmacyDrawer(txDb(tx), scopeFor(ctx, input.branchId), input)
      )
    ),
  dailyClose: protectedProcedure
    .input(
      z
        .object({
          branchId,
          businessDate: z.date(),
          reopenReason: z.string().trim().min(1).optional(),
          controlledCountHook: z.record(z.string(), z.unknown()).optional(),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        cutPharmacyDailyClose(txDb(tx), scopeFor(ctx, input.branchId), input)
      )
    ),
  tenderOutcome: protectedProcedure
    .input(tenderInput)
    .query(({ ctx, input }) =>
      readPharmacyTenderOutcome(ctx.db, scopeFor(ctx, input.branchId), input)
    ),
  tender: protectedProcedure.input(tenderInput).mutation(async ({ ctx, input }) => {
    try {
      return await ctx.db.$transaction((tx) =>
        applyPharmacyTender(txDb(tx), scopeFor(ctx, input.branchId), input)
      );
    } catch (error) {
      fail(error);
    }
  }),
  refundTender: protectedProcedure
    .input(
      z
        .object({
          branchId,
          originalTenderId: z.string().min(1),
          deviceId: z.string().min(1),
          businessDate: z.date(),
          amountMinor: z.number().int().positive(),
          reason: z.string().trim().min(1),
          manualCashFallback: z.boolean().optional(),
          requireReturnedValue: z.boolean().optional(),
          idempotencyKey: z.string().trim().min(1).max(160),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          refundPharmacyTender(txDb(tx), scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  create: protectedProcedure
    .input(z.object({ branchId, quotation: z.boolean().default(false) }).strict())
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        createSale(txDb(tx), scopeFor(ctx, input.branchId), input.quotation)
      )
    ),
  addLine: protectedProcedure
    .input(
      z
        .object({
          controlledAuthorization: z
            .object({
              prescriptionLineId: z.string().min(1),
              patientId: z.string().min(1),
              staffProfileId: z.string().min(1),
              pin: z.string().regex(/^\d{4,8}$/),
            })
            .strict()
            .optional(),
          branchId,
          saleId: z.string().min(1),
          medicineId: z.string().min(1),
          presentationId: z.string().min(1),
          packLevelId: z.string().min(1),
          saleUnit,
          quantity: z.number().int().positive(),
          canonicalUnitsPerSaleUnit: z.number().int().positive(),
          discountKind: z.enum(['DISCOUNT', 'PROMOTION', 'COMPLIMENTARY']).optional(),
          discountMinor: z.number().int().nonnegative().optional(),
          approvedByUserId: z.string().min(1).optional(),
          approvalPolicy: z.string().trim().min(1).optional(),
          override: z
            .object({
              inventoryLotId: z.string().min(1),
              reason: z.string().trim().min(1).max(500),
              approvalPolicy: z.string().trim().min(1).max(200),
            })
            .strict()
            .optional(),
          idempotencyKey: z.string().trim().min(1).max(160),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, { skipInput: true });
      // PH-A4 (F10): a batch taken out of FEFO order is a safety decision, so its
      // audit row is labelled as one — refused attempts included, since the
      // label is set before the domain runs. The override row itself is written
      // by `allocateForSale` inside the sale transaction. Merged through
      // annotateAudit so the controlled-medicine `skipInput` flag above is kept.
      if (input.override) {
        annotateAudit(ctx, {
          category: 'PHARMACY_SAFETY',
          action: 'fefo_override',
          targetType: 'PharmacySale',
          targetId: input.saleId,
          description: 'Counter sold a batch out of FEFO order.',
          metadata: {
            branchId: input.branchId,
            medicineId: input.medicineId,
            selectedLotId: input.override.inventoryLotId,
            reason: input.override.reason,
            approvalPolicy: input.override.approvalPolicy,
          },
        });
      }
      try {
        const outcome = await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          const scope = scopeFor(ctx, input.branchId);
          const medicine = await db.medicine.findFirst({
            where: { id: input.medicineId, organizationId: scope.organizationId },
          });
          if (!medicine?.controlled) return addSaleLine(db, scope, input);
          const authorization = input.controlledAuthorization;
          const blocked = {
            blocked:
              'Controlled medicine requires a valid prescription, patient ID and an independent pharmacist PIN.',
          } as const;
          if (!authorization) return blocked;
          // Serialize credential attempts; returning a denial commits durable lockout counters.
          await db.$queryRaw`SELECT id FROM restaurant_operator_credentials WHERE "organizationId"=${scope.organizationId} AND "staffProfileId"=${authorization.staffProfileId} AND type='PIN' AND "revokedAt" IS NULL AND "deviceId" IS NULL FOR UPDATE`;
          const credential = await db.restaurantOperatorCredential.findFirst({
            where: {
              organizationId: scope.organizationId,
              staffProfileId: authorization.staffProfileId,
              type: 'PIN',
              revokedAt: null,
              deviceId: null,
            },
            include: { staffProfile: { include: { user: true } } },
          });
          const pharmacist = credential?.staffProfile.user;
          const now = new Date();
          if (
            !credential ||
            credential.staffProfile.status !== 'ACTIVE' ||
            !pharmacist ||
            pharmacist.organizationId !== scope.organizationId ||
            pharmacist.status !== 'ACTIVE' ||
            pharmacist.id === scope.actorId ||
            isLockedOut(credential, now)
          )
            return blocked;
          if (!(await can(pharmacist, 'pharmacy:dispense', undefined, { db, now }))) return blocked;
          if (
            !(await verifyOperatorCredential('PIN', authorization.pin, credential.credentialHash))
          ) {
            await db.restaurantOperatorCredential.update({
              where: { id: credential.id },
              data: registerFailedAttempt(credential, now),
            });
            return blocked;
          }
          await db.restaurantOperatorCredential.update({
            where: { id: credential.id },
            data: clearLockout(),
          });
          // Lock prescription and branch before stock allocation, fill numbering and register numbering.
          await db.$queryRaw`SELECT id FROM pharmacy_prescription_lines WHERE "organizationId"=${scope.organizationId} AND id=${authorization.prescriptionLineId} FOR UPDATE`;
          await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope.organizationId + ':' + scope.branchId},0))`;
          const rx = await db.prescriptionLine.findFirst({
            where: {
              id: authorization.prescriptionLineId,
              organizationId: scope.organizationId,
              medicineId: input.medicineId,
              presentationId: input.presentationId,
            },
            include: {
              prescription: { include: { patient: true, prescriber: true } },
              fills: true,
            },
          });
          if (
            !rx ||
            rx.prescription.patientId !== authorization.patientId ||
            !rx.prescription.patient.cnic?.trim() ||
            !rx.prescription.prescriber.registrationNumber.trim() ||
            rx.prescription.validFrom > now ||
            rx.prescription.validUntil <= now
          )
            return blocked;
          const units = input.quantity * input.canonicalUnitsPerSaleUnit;
          const previous = await db.pharmacySaleLine.findFirst({
            where: {
              organizationId: scope.organizationId,
              branchId: scope.branchId,
              saleId: input.saleId,
              idempotencyKey: input.idempotencyKey,
            },
          });
          if (previous)
            return {
              blocked:
                'This request was already recorded. Refresh the cart before adding another line.',
            };
          if (
            !Number.isSafeInteger(units) ||
            rx.fills.reduce((sum, fill) => sum + fill.quantityCanonicalUnits, 0) + units >
              rx.authorizedCanonicalUnits ||
            rx.fills.length > rx.prescription.authorizedRepeats
          )
            return { blocked: 'Prescription quantity or repeat allowance is exhausted.' };
          const consent = await db.patientConsent.findFirst({
            where: {
              organizationId: scope.organizationId,
              patientId: authorization.patientId,
              purpose: 'DISPENSING',
            },
            orderBy: { version: 'desc' },
          });
          if (!consent?.granted || consent.revokedAt)
            return { blocked: 'Patient dispensing consent is required.' };
          const result = await addSaleLine(db, scope, input);
          await db.prescriptionFill.create({
            data: {
              organizationId: scope.organizationId,
              prescriptionLineId: rx.id,
              fillSequence: rx.fills.length + 1,
              quantityCanonicalUnits: units,
              dispensedByUserId: pharmacist.id,
              idempotencyKey: `controlled:${result.line.id}`,
            },
          });
          const review = await db.pharmacyPharmacistReviewItem.create({
            data: {
              organizationId: scope.organizationId,
              prescriptionLineId: rx.id,
              saleLineId: result.line.id,
              requestedByUserId: scope.actorId,
            },
          });
          await db.pharmacyPharmacistReviewDecision.create({
            data: {
              organizationId: scope.organizationId,
              reviewItemId: review.id,
              kind: 'SIGN',
              actorUserId: pharmacist.id,
              signedAt: now,
            },
          });
          const latest = await db.pharmacyControlledRegisterEntry.aggregate({
            where: { organizationId: scope.organizationId, branchId: scope.branchId },
            _max: { serial: true },
          });
          let serial = latest._max.serial ?? 0;
          for (const movementId of result.allocation.movementIds) {
            const movement = await db.pharmacyStockMovement.findFirstOrThrow({
              where: {
                id: movementId,
                organizationId: scope.organizationId,
                branchId: scope.branchId,
              },
            });
            const lot = await db.pharmacyInventoryLot.findFirstOrThrow({
              where: { id: movement.inventoryLotId, organizationId: scope.organizationId },
              include: { batch: true },
            });
            const balance = await db.pharmacyStockBalance.aggregate({
              where: {
                organizationId: scope.organizationId,
                branchId: scope.branchId,
                inventoryLotId: lot.id,
              },
              _sum: { onHandUnits: true },
            });
            await db.pharmacyControlledRegisterEntry.create({
              data: {
                organizationId: scope.organizationId,
                branchId: scope.branchId,
                serial: ++serial,
                prescriptionId: rx.prescriptionId,
                prescriptionLineId: rx.id,
                patientId: authorization.patientId,
                prescriberId: rx.prescription.prescriberId,
                inventoryLotId: lot.id,
                stockMovementId: movement.id,
                batchNumber: lot.batch.batchNumber,
                quantityCanonicalUnits: -movement.quantityUnits,
                runningBalance: balance._sum.onHandUnits ?? 0,
                recordedByUserId: scope.actorId,
                witnessedByUserId: pharmacist.id,
              },
            });
          }
          return result;
        });
        if (input.override && 'line' in outcome) {
          annotateAudit(ctx, {
            metadata: {
              saleLineId: outcome.line.id,
              overrideId: outcome.allocation.overrideId,
              recommendedLotId: outcome.allocation.recommendedLotId,
            },
          });
        }
        return outcome;
      } catch (error) {
        fail(error);
      }
    }),
  transition: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1),
          action: z.enum(['hold', 'resume', 'convertQuotation', 'complete', 'void']),
          reason: z.string().trim().min(1).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          changeSaleStatus(
            txDb(tx),
            scopeFor(ctx, input.branchId),
            input.saleId,
            input.action,
            input.reason
          )
        );
      } catch (error) {
        fail(error);
      }
    }),
  lookupReceiptByNumber: protectedProcedure
    .input(z.object({ branchId, receiptNumber: z.number().int().positive() }).strict())
    .query(async ({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      // Receipt sequences are per device/date: never pick an arbitrary matching sale.
      return ctx.db.pharmacySale.findMany({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          receiptNumber: input.receiptNumber,
          status: 'COMPLETED',
        },
        select: { id: true, receiptNumber: true, receiptDeviceId: true, businessDate: true },
        orderBy: { completedAt: 'desc' },
        take: 50,
      });
    }),
  returnHistory: protectedProcedure
    .input(z.object({ branchId, saleId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return await readReturnHistory(ctx.db, scopeFor(ctx, input.branchId), input.saleId);
      } catch (error) {
        fail(error);
      }
    }),
  returnLine: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleLineId: z.string().min(1),
          canonicalUnits: z.number().int().positive(),
          quarantineLocationId: z.string().min(1).optional(),
          disposition: z.enum(['RESTOCK', 'QUARANTINE']).default('QUARANTINE'),
          reason: z.string().trim().min(1),
          integrityDecision: z.string().trim().min(1),
          idempotencyKey: z.string().trim().min(1),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          returnSaleLine(txDb(tx), scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  captureDemand: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1).optional(),
          requestedMedicineId: z.string().min(1).optional(),
          requestedText: z.string().trim().min(1).optional(),
          strength: z.string().optional(),
          form: z.string().optional(),
          presentation: z.string().optional(),
          saleUnit,
          quantity: z.number().int().positive(),
          reason: demandReason,
          inventoryRuleSnapshot: z.record(z.string(), z.unknown()),
          estimatedValueMinor: z.number().int().nonnegative().optional(),
          estimatedMarginMinor: z.number().int().optional(),
          customerId: z.string().min(1).optional(),
          consentRecorded: z.boolean().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await captureDemand(ctx.db, scopeFor(ctx, input.branchId), input);
      } catch (error) {
        fail(error);
      }
    }),
  substituteProposals: protectedProcedure
    .input(
      z
        .object({
          branchId,
          medicineId: z.string().min(1),
          presentationId: z.string().min(1),
          quantityCanonicalUnits: z.number().int().positive(),
          referencePriceMinor: z.number().int().positive().optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      try {
        return await findSubstituteProposals(ctx.db, scopeFor(ctx, input.branchId), input);
      } catch (error) {
        if (error instanceof PharmacySubstituteError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: error.code });
        }
        throw error;
      }
    }),
  declineSubstitute: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1).optional(),
          requestedMedicineId: z.string().min(1),
          requestedText: z.string().trim().min(1),
          strength: z.string().optional(),
          form: z.string().optional(),
          presentation: z.string().optional(),
          saleUnit,
          quantity: z.number().int().positive(),
          inventoryRuleSnapshot: z.record(z.string(), z.unknown()),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const scope = scopeFor(ctx, input.branchId);
        return await ctx.db.$transaction(async (tx) => {
          const event = await captureDemand(txDb(tx), scope, {
            ...input,
            reason: 'SUBSTITUTE_DECLINED',
          });
          return declineSubstitute(txDb(tx), scope, event.id);
        });
      } catch (error) {
        if (error instanceof PharmacySubstituteError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: error.code });
        }
        throw error;
      }
    }),
  recoverDemand: protectedProcedure
    .input(
      z.object({ branchId, demandId: z.string().min(1), saleLineId: z.string().min(1) }).strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await recoverDemandWithAlternate(
          ctx.db,
          scopeFor(ctx, input.branchId),
          input.demandId,
          input.saleLineId
        );
      } catch (error) {
        fail(error);
      }
    }),
  demandAggregate: protectedProcedure
    .input(z.object({ branchId, from: z.date(), to: z.date() }).strict())
    .query(({ ctx, input }) =>
      demandAggregate(ctx.db, scopeFor(ctx, input.branchId), input.from, input.to)
    ),
  addRestockInterest: protectedProcedure
    .input(
      z
        .object({
          branchId,
          demandEventId: z.string().min(1),
          patientId: z.string().min(1).optional(),
          channel: z.enum(['SMS', 'WHATSAPP']).optional(),
          reserveOnArrival: z.boolean().optional(),
          quantityUnits: z.number().int().positive(),
          campaignKey: z.string().trim().min(1).max(160).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          addRestockInterest(txDb(tx), scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  captureSafeRestockArrival: protectedProcedure
    .input(z.object({ branchId, inventoryLotId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          captureSafeRestockArrival(txDb(tx), scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  optOutRestockInterest: protectedProcedure
    .input(z.object({ branchId, interestId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          optOutRestockInterest(txDb(tx), scopeFor(ctx, input.branchId), input.interestId)
        );
      } catch (error) {
        fail(error);
      }
    }),
  recoverRestockInterest: protectedProcedure
    .input(
      z.object({ branchId, interestId: z.string().min(1), saleLineId: z.string().min(1) }).strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          recoverRestockInterest(txDb(tx), scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  restockRecoveryReport: protectedProcedure
    .input(
      z.object({ branchId, campaignKey: z.string().trim().min(1).max(160).optional() }).strict()
    )
    .query(({ ctx, input }) =>
      restockRecoveryReport(ctx.db, scopeFor(ctx, input.branchId), input.campaignKey)
    ),

  // ── PH-POS counter reads (POS-01, POS-02, POS-08) ─────────────────────────

  /** The branches this counter may open a bill against, with the money format. */
  counterBranches: protectedProcedure.query(async ({ ctx }) => {
    const organizationId = ctx.entitlements?.organizationId;
    if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
    const [branches, organization] = await Promise.all([
      ctx.db.pharmacyBranch.findMany({
        where: { organizationId, active: true },
        select: { id: true, code: true, name: true, city: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      ctx.db.organization.findUnique({
        where: { id: organizationId },
        select: { currency: true },
      }),
    ]);
    return {
      branches,
      currency: organization?.currency ?? 'PKR',
      paymentSandboxAvailable: ctx.session.user.role === 'ADMIN' && paymentSandboxAdmitted(),
    };
  }),

  /** POS-02: one search across brand, generic, ingredient, form, barcode and alias. */
  counterSearch: protectedProcedure
    .input(
      z
        .object({
          branchId,
          query: z.string().trim().min(2).max(120),
          limit: z.number().int().min(1).max(50).optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      try {
        return await searchCounterCatalog(ctx.db, scopeFor(ctx, input.branchId), {
          query: input.query,
          limit: input.limit,
        });
      } catch (error) {
        fail(error);
      }
    }),

  /** SAFE-05: advisory pack authentication; only the existing recall path blocks. */
  authenticatePack: auditedProtectedProcedure
    .input(z.object({ branchId, payload: z.string().max(512) }).strict())
    .mutation(async ({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      ctx.audit.detail = { category: 'PHARMACY_SAFETY', action: 'dispensing_pack_scan' };
      return authenticatePharmacyPack(ctx.db, {
        ...scope,
        source: 'DISPENSING',
        payload: input.payload,
      });
    }),

  /**
   * PH-A4: the lots a counter batch override may choose from, in FEFO order.
   *
   * Read-only. Lots that cannot be sold stay listed with the reason, so the
   * operator sees why a batch on the shelf is refused rather than missing.
   */
  counterLotOptions: protectedProcedure
    .input(z.object({ branchId, medicineId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      // `onHand` returns balance buckets already in FEFO order (expiry, then
      // receipt), so first appearance is the order the allocator would use.
      const buckets = await onHand(ctx.db, scope, input.medicineId, new Date());
      const lotIds = [...new Set(buckets.map((bucket) => bucket.inventoryLotId))];
      if (lotIds.length === 0) return [];
      const lots = await ctx.db.pharmacyInventoryLot.findMany({
        where: {
          id: { in: lotIds },
          organizationId: scope.organizationId,
          branchId: scope.branchId,
        },
        select: { id: true, batch: { select: { batchNumber: true, expiresAt: true } } },
      });
      const lotById = new Map(lots.map((lot) => [lot.id, lot]));
      return lotIds.flatMap((inventoryLotId) => {
        const lot = lotById.get(inventoryLotId);
        if (!lot) return [];
        const mine = buckets.filter((bucket) => bucket.inventoryLotId === inventoryLotId);
        const sellableUnits = mine.reduce(
          (total, bucket) => (bucket.blockedBy === null ? total + bucket.onHandUnits : total),
          0
        );
        return [
          {
            inventoryLotId,
            batchNumber: lot.batch.batchNumber,
            expiresAt: lot.batch.expiresAt.toISOString(),
            sellableUnits,
            blockedBy:
              sellableUnits > 0
                ? null
                : (mine.find((bucket) => bucket.blockedBy !== null)?.blockedBy ?? null),
          },
        ];
      });
    }),

  /** The open bill with the FEFO allocation each line actually drew (POS-03). */
  counterCart: protectedProcedure
    .input(z.object({ branchId, saleId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return await readCounterCart(ctx.db, scopeFor(ctx, input.branchId), input.saleId);
      } catch (error) {
        fail(error);
      }
    }),

  /**
   * POS-08: the receipt model, for the thermal and A4 renders alike.
   *
   * A query, deliberately. Reprinting re-reads the same sale and therefore the
   * same receipt number; only `tender` can ever issue one.
   */
  counterReceipt: protectedProcedure
    .input(z.object({ branchId, saleId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      try {
        return await loadCounterReceipt(ctx, scope, input.saleId);
      } catch (error) {
        fail(error);
      }
    }),

  /**
   * PH-A7: the settled receipt as a validated ESC/POS `RECEIPT` job, using the
   * branch's saved format. A read: printing and reprinting from history
   * re-read the same sale, so neither can issue or change a receipt number.
   * Text the raw baseline cannot print returns the browser/OS fallback.
   */
  counterReceiptPrintJob: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1),
          locale: z.enum(['en', 'ur']),
          reprint: z.boolean(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      try {
        const receipt = await loadCounterReceipt(ctx, scope, input.saleId);
        if (receipt.receiptNumber === null || !receipt.completedAt) {
          throw new PharmacyReceiptPrintError('RECEIPT_NOT_ISSUED');
        }
        const [format, taxIdentity] = await Promise.all([
          readPharmacyReceiptFormat(ctx.db, scope),
          readPharmacyReceiptTaxIdentity(ctx.db, scope, new Date(receipt.completedAt)),
        ]);
        return {
          status: 'READY' as const,
          ...buildPharmacyReceiptEscPosJob(receipt, input.locale, {
            layout: format.layout,
            taxIdentity,
            reprint: input.reprint,
          }),
        };
      } catch (error) {
        if (error instanceof RawPrintValidationError) {
          return {
            status: 'FALLBACK' as const,
            code: error.code,
            fallback: error.fallback,
            message: error.message,
          };
        }
        if (error instanceof PharmacyReceiptPrintError) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This bill is not settled, so it has no receipt to print.',
          });
        }
        fail(error);
      }
    }),

  /** PH-A7: this branch's saved receipt format (shared layout), for the counter. */
  counterReceiptFormat: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(({ ctx, input }) => readPharmacyReceiptFormat(ctx.db, scopeFor(ctx, input.branchId))),

  /** PH-A7: save the branch receipt format. Optimistic revision; admins only. */
  counterSaveReceiptFormat: adminProcedure
    .input(SaveReceiptLayoutSchema)
    .mutation(({ ctx, input }) =>
      savePharmacyReceiptFormat(ctx.db, scopeFor(ctx, input.branchId).organizationId, input)
    ),

  // ── POS-01 configurable shortcuts ─────────────────────────────────────────

  /** This operator's resolved keymap, falling back to the shipped default. */
  counterKeymap: protectedProcedure.query(async ({ ctx }) => {
    const organizationId = ctx.entitlements?.organizationId;
    const userId = ctx.session?.user?.id;
    if (!organizationId || !userId) throw new TRPCError({ code: 'UNAUTHORIZED' });
    const stored = await ctx.db.pharmacyCounterKeymapPreference.findFirst({
      where: { organizationId, userId },
      select: { preset: true, overrides: true },
    });
    try {
      const resolved = resolveCounterKeymap({
        preset: (stored?.preset ?? 'devfathom') as 'devfathom' | 'legacySpeed',
        overrides: (stored?.overrides ?? {}) as Record<string, CounterBinding>,
      });
      return { ...resolved, stored: stored !== null };
    } catch {
      // A row that no longer resolves (a preset removed, a chord that now
      // collides) must not leave the counter with no shortcuts at all. Fall
      // back to the shipped default and say the stored map was not applied.
      return { ...resolveCounterKeymap({ preset: 'devfathom' }), stored: false };
    }
  }),

  /**
   * Save this operator's keymap.
   *
   * Validated before it is written, so a map that would shadow a workflow is
   * refused at the boundary rather than persisted and discovered mid-bill.
   */
  counterSaveKeymap: protectedProcedure
    .input(
      z
        .object({
          preset: z.enum(['devfathom', 'legacySpeed']),
          // Keys are validated by `resolveCounterKeymap` rather than by the
          // schema: it is the same check that rejects a duplicate chord, so an
          // unknown action and a shadowed workflow fail through one path.
          overrides: z
            .record(
              z.string().trim().min(1).max(64),
              z
                .object({
                  key: z.string().trim().min(1).max(16),
                  ctrl: z.boolean().optional(),
                  alt: z.boolean().optional(),
                  shift: z.boolean().optional(),
                })
                .strict()
            )
            .default({}),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.entitlements?.organizationId;
      const userId = ctx.session?.user?.id;
      if (!organizationId || !userId) throw new TRPCError({ code: 'UNAUTHORIZED' });
      try {
        const resolved = resolveCounterKeymap({
          preset: input.preset,
          overrides: input.overrides as Record<string, CounterBinding>,
        });
        await ctx.db.pharmacyCounterKeymapPreference.upsert({
          where: { organizationId_userId: { organizationId, userId } },
          update: { preset: input.preset, overrides: input.overrides },
          create: { organizationId, userId, preset: input.preset, overrides: input.overrides },
        });
        return { ...resolved, stored: true };
      } catch (error) {
        fail(error);
      }
    }),
});
