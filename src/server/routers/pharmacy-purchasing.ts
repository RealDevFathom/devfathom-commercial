import { findDuplicateSupplierInvoice } from '@/lib/pharmacy/supplier-invoice-duplicate';
import {
  SOLO_OWNER_POLICY,
  APPROVAL_BLOCKED,
  recordPurchaseApprovalEvidence,
  hasPurchaseApprovalEvidence,
  soloOwnerApprovalAllowed,
  verifyPurchaseApprover,
} from '@/lib/pharmacy/purchase-approval';
import { TRPCError } from '@trpc/server';
import {
  ControlledRestorationDenied,
  isSolePharmacist,
} from '@/lib/pharmacy/controlled-restoration-authorization';
import {
  issueOperatorCredential,
  CredentialLifecycleError,
} from '@/lib/restaurant/credential-lifecycle';
import { z } from 'zod';
import { can, subjectFromSession } from '@/lib/abac';
import { actorIsPharmacyOwner, procurementBranchIds } from '@/lib/pharmacy/procurement-access';
import { hasModule } from '@/lib/entitlements';
import {
  listReceivingExceptions,
  lockReceivablePurchaseOrder,
  orderReceiptCostTerms,
  postGoodsReceipt,
  resolveReceivingException,
  reverseGoodsReceipt,
  verifyControlledPurchaseWitness,
} from '@/lib/pharmacy/goods-receipt';
import { listControlledPinWitnesses } from '@/lib/pharmacy/controlled-register';
import { PharmacyInventoryError } from '@/lib/pharmacy/inventory';
import { listDrapPriceAlerts } from '@/lib/pharmacy/drap-monitoring';
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
  compareQuotes,
  effectiveCostPerSellableUnit,
  landedCost,
  licenceEvidence,
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
import {
  isNonDrugRetail,
  resolveReceiptBatchIdentity,
  resolveReceiptRetailPrice,
} from '@/lib/pharmacy/product-class';
import { assertProcurement } from '../pharmacy-procurement-access';
import {
  assertDirectPurchaseAuthorized,
  PharmacyReceivingError,
  receiptLandedCosts,
  receiptLineQuantities,
} from '@/lib/pharmacy/receiving';
import { PharmacySupplierReturnError } from '@/lib/pharmacy/supplier-returns';
import {
  enforceSupplierCompliance,
  readSupplierCompliancePolicy,
  recordSupplierComplianceSkip,
  supersededLicenceIds,
  type SupplierComplianceSubject,
} from '@/lib/pharmacy/supplier-compliance-policy';
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
import {
  planReorderDrafts,
  readReorderFacts,
  REORDER_DEFAULT_COVER_DAYS,
  REORDER_DEFAULT_WINDOW_DAYS,
} from '@/lib/pharmacy/reorder-drafts';
import { authenticatePharmacyPack } from '@/lib/pharmacy/pack-authentication-operations';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { denyByDefaultProcedure, router } from '../trpc';
import type { ProcedureMeta, TRPCContext } from '../trpc';
import {
  assertOrderBranches,
  assertProcurementBranch,
  isSoloOwner,
  procurementActor,
  reachableProcurementBranchIds,
} from '../pharmacy-procurement-scope';

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
// DEV-145: business-sized ceilings checked before any DB work. A requisition,
// quote, order or return is one supplier document; a receipt may split each
// ordered line across batches, and an allocation fans receipt lines out to branches.
const MAX_DOCUMENT_LINES = 100;
const MAX_RECEIPT_LINES = 200;
const MAX_RECEIPT_ALLOCATIONS = 500;

function domainError(error: unknown): never {
  if (error instanceof ControlledRestorationDenied) {
    throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
  }
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

type ReceiptIdentityInput = {
  medicineId: string;
  /** #718: a non-drug item may arrive without a printed batch or expiry. */
  productFamily: string;
  batchNumber?: string;
  printedExpiry?: Date;
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

  // #718: resolve the house batch only after the scan, so a generated non-drug batch names the
  // expiry actually received and two deliveries with different scanned expiries never collide.
  const resolved = resolveReceiptBatchIdentity({
    productFamily: line.productFamily,
    batchNumber,
    printedExpiry,
    expiryPrecision,
  });
  if (!resolved.ok) throw new PharmacyReceivingError(resolved.reason);
  batchNumber = resolved.batchNumber;
  printedExpiry = resolved.printedExpiry;
  expiryPrecision = resolved.expiryPrecision;

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

  if (line.acceptedCanonicalUnits > 0 && packIsExpired(resolved.printedExpiry, line.receivedAt)) {
    throw new PharmacyReceivingError('EXPIRED_PACK');
  }

  const near = nearExpiryWarning(
    resolved.printedExpiry.toISOString().slice(0, 10),
    line.receivedAt
  );
  warnings = warnings.filter((code) => code !== 'NEAR_EXPIRY');
  if (near && line.acceptedCanonicalUnits > 0) warnings.push(near.code);

  return {
    batchNumber: resolved.batchNumber,
    printedExpiry: resolved.printedExpiry,
    expiryPrecision: resolved.expiryPrecision,
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
 * somebody else is not evidence. The branch is a claim until
 * `assertProcurementBranch` confirms the caller is assigned to it (#979, PR J).
 */
function receivingScope(ctx: TRPCContext, branch: string): Promise<ReceivingScope> {
  return assertProcurementBranch(ctx, branch);
}

/**
 * Organization scope for records shared by all branches, such as suppliers.
 */
function tenantScope(ctx: TRPCContext): { organizationId: string } {
  const organizationId = ctx.entitlements?.organizationId;
  if (!organizationId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'No tenant actor on this request.' });
  }
  return { organizationId };
}

async function purchasingOrderScope(ctx: TRPCContext) {
  const { organizationId } = tenantScope(ctx);
  const userId = ctx.session!.user.id;
  const assigned = await procurementBranchIds(ctx.db, organizationId, userId);
  const central = await ctx.db.pharmacyCentralPurchasingAccess.findMany({
    where: { organizationId, userId },
    select: { branchId: true },
  });
  const includeUnscoped =
    central.some((grant) => grant.branchId === null) ||
    (await actorIsPharmacyOwner(ctx.db, organizationId, userId));
  const allowed = new Set([
    ...assigned,
    ...central.flatMap((grant) => (grant.branchId ? [grant.branchId] : [])),
  ]);
  const branches = await ctx.db.pharmacyBranch.findMany({
    where: { organizationId, active: true },
    select: { id: true },
  });
  const branchIds = branches
    .filter((branch) => includeUnscoped || allowed.has(branch.id))
    .map((branch) => branch.id);
  return {
    organizationId,
    branchIds,
    includeUnscoped,
  };
}

/**
 * Requisitions and orders without a branch are organization-wide records. The
 * list endpoints only show them to an installed owner or an organization-wide
 * central purchaser, so writes and by-ID reads must apply the same boundary;
 * a branch-scoped buyer must not reach them by guessing an ID.
 */
async function purchasingRecordScope(ctx: TRPCContext, branch: string | null | undefined) {
  if (branch) {
    await receivingScope(ctx, branch);
    return;
  }
  const { organizationId } = tenantScope(ctx);
  const userId = ctx.session!.user.id;
  const central = await ctx.db.pharmacyCentralPurchasingAccess.findMany({
    where: { organizationId, userId, branchId: null },
    select: { branchId: true },
  });
  if (
    central.some((grant) => grant.branchId === null) ||
    (await actorIsPharmacyOwner(ctx.db, organizationId, userId))
  )
    return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'Organization-wide purchasing is outside your pharmacy scope.',
  });
}

/**
 * PUR-01: refuse a supplier that may not be ordered from right now. `supplier`
 * is whatever the tenant-scoped client returned, so a row belonging to another
 * tenant arrives here as `null` and is refused on tenancy rather than licensing.
 *
 * DEV-753: the tenant owner's supplier-compliance policy, read on `db` (the same
 * transaction as the write, where there is one), decides whether licence evidence
 * and trade authorization are refusal reasons. With the checks on, supersession is
 * read strictly (DEV-466). With them off, the write goes ahead and leaves an
 * immutable evidence row. Tenancy is refused either way.
 */
async function assertOrderableSupplier(
  db: ScopedDb,
  ctx: TRPCContext,
  supplier: {
    id: string;
    authorized: boolean;
    licences: { id: string; expiresAt: Date; verifiedAt: Date | null }[];
  } | null,
  at: Date,
  subject: SupplierComplianceSubject,
  options: { record?: boolean } = {}
) {
  if (!supplier) throw new PharmacyPurchasingError('CROSS_TENANT_REFERENCE');
  const actorId = ctx.session?.user?.id;
  if (!actorId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'No tenant actor on this request.' });
  }
  return enforceSupplierCompliance(
    db,
    { organizationId: tenantScope(ctx).organizationId, actorId },
    supplier,
    at,
    subject,
    options
  );
}

const WITH_LICENCES = { licences: true } as const;

const supplierFollowUpInput = purchasingReadBoundsSchema.safeExtend({ branchId });

/** Both bounded and legacy financial readers enforce access before reading their source rows. */
async function supplierFollowUpScope(ctx: TRPCContext, branch: string) {
  const actorId = ctx.session?.user?.id;
  if (!actorId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const active = await ctx.db.user.findUnique({
    where: { id: actorId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!active) throw new TRPCError({ code: 'FORBIDDEN' });
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
  // Active branch of this organization AND assigned to the caller (or live tenant owner).
  return receivingScope(ctx, branch);
}

/**
 * Deny by default (#979, PR J). Every purchasing procedure is built on
 * `denyByDefaultProcedure` and names its permission in `.meta(...)`; one that
 * forgets is refused for everybody, and the router test fails on it.
 *
 * - `PROCUREMENT`: supplier, requisition, quote and order work, Goods-in, the
 *   PUR-04 exception queue, pack authentication, central purchasing and every
 *   console read. A counter-only role (cashier: `pharmacy:counter` +
 *   `pharmacy:orders`) holds none of it.
 * - `APPROVAL`: approving and sending a purchase order. Manager and Owner
 *   templates hold it; so does the solo owner (tenant admin without a role).
 * - `PROCUREMENT_AND_APPROVAL`: authorizing or withdrawing a supplier, which
 *   is procurement work that also needs the approver capability.
 * - `PROCUREMENT_AND_FINANCE`: PUR-06 returns, debit notes and supplier credit,
 *   which move stock out and book money.
 * - `FINANCIAL_FOLLOW_UP`: the supplier-credit follow-up reads, which the
 *   Finance role's report also uses; unchanged from before.
 *
 * The branch boundary is separate: every branch-scoped call goes through
 * `assertProcurementBranch` (directly or via `receivingScope`), and every
 * order- or requisition-scoped call through `assertOrderBranches`.
 */
const purchasing = denyByDefaultProcedure;
const PROCUREMENT = { capabilities: ['pharmacy:procurement'] } as const satisfies ProcedureMeta;
const APPROVAL = {
  capabilities: ['pharmacy:procurement-approve'],
} as const satisfies ProcedureMeta;
const PROCUREMENT_AND_APPROVAL = {
  capabilities: ['pharmacy:procurement', 'pharmacy:procurement-approve'],
} as const satisfies ProcedureMeta;
const PROCUREMENT_AND_FINANCE = {
  capabilities: ['pharmacy:procurement', 'reports:financial'],
} as const satisfies ProcedureMeta;
const FINANCIAL_FOLLOW_UP = {
  capabilities: ['reports:financial'],
} as const satisfies ProcedureMeta;

/** Recorded on a purchase-order approval the solo owner gave their own order. */
export const SOLO_OWNER_APPROVAL_POLICY = SOLO_OWNER_POLICY;

const selfVerification = () => new TRPCError({ code: 'FORBIDDEN', message: 'SELF_VERIFICATION' });

const purchasingRouter = router({
  /** Pharmacy-only tenants can establish their own approval PIN without restaurant modules. */
  provisionMyPurchasePin: purchasing
    .meta(PROCUREMENT_AND_APPROVAL)
    .input(z.object({ pin: z.string().regex(/^\d{4,8}$/) }).strict())
    .mutation(async ({ ctx, input }) => {
      ctx.audit.detail.skipInput = true;
      if (!hasModule(ctx.entitlements, 'pharmacy-procurement')) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      const { organizationId } = tenantScope(ctx);
      const userId = ctx.session.user.id;
      return ctx.db.$transaction(async (tx) => {
        // Serialize initial profile/credential creation for this person.
        await tx.$queryRaw`SELECT id FROM users WHERE id=${userId} AND "organizationId"=${organizationId} FOR UPDATE`;
        const priorPin = await tx.restaurantOperatorCredential.findFirst({
          where: {
            organizationId,
            type: 'PIN',
            deviceId: null,
            staffProfile: { organizationId, userId },
          },
          select: { id: true },
        });
        if (priorPin) {
          throw new TRPCError({
            code: 'CONFLICT',
            message:
              'An approval PIN has already been issued. Ask your administrator to manage it.',
          });
        }
        let profile = await tx.restaurantStaffProfile.findFirst({
          where: { organizationId, userId },
          orderBy: { id: 'asc' },
        });
        if (profile && profile.status !== 'ACTIVE') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Ask your administrator to activate your staff profile.',
          });
        }
        if (!profile) {
          profile = await tx.restaurantStaffProfile.create({
            data: {
              organizationId,
              userId,
              displayName: ctx.session.user.name ?? ctx.session.user.email ?? 'Pharmacy buyer',
            },
          });
        }
        try {
          const credential = await issueOperatorCredential(txDb(tx), {
            staffProfileId: profile.id,
            type: 'PIN',
            secret: input.pin,
          });
          return { id: credential.id, staffProfileId: profile.id };
        } catch (error) {
          if (error instanceof CredentialLifecycleError && error.reason === 'ALREADY_EXISTS') {
            throw new TRPCError({ code: 'CONFLICT', message: 'You already have an approval PIN.' });
          }
          throw error;
        }
      });
    }),

  // ----- PUR-01 licensed suppliers -----

  createSupplier: purchasing
    .meta(PROCUREMENT)
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
    .mutation(async ({ ctx, input }) => {
      return ctx.db.pharmacySupplier.create({ data: input });
    }),

  /** Licence evidence is append-only; a correction supersedes the earlier filing. */
  recordSupplierLicence: purchasing
    .meta(PROCUREMENT)
    .input(
      z
        .object({
          supplierId: z.string().min(1).max(200),
          licenceType: z.string().trim().min(1).max(100),
          licenceNumber: z.string().trim().min(1).max(100),
          issuingAuthority: z.string().trim().min(1).max(200),
          issuedAt: z.date(),
          expiresAt: z.date(),
          evidenceUri: z.string().trim().max(1000).optional(),
          verified: z.boolean().default(false),
          supersedesId: z.string().min(1).max(200).optional(),
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
      // PUR-01 (#979, PR J): whoever files a licence cannot also verify it. A
      // colleague verifies it with `verifySupplierLicence`; only the solo owner,
      // who has no colleague, may file it already verified.
      if (verified && !(await isSoloOwner(ctx))) throw selfVerification();
      return ctx.db.pharmacySupplierLicence.create({
        data: {
          ...licence,
          recordedByUserId: ctx.session.user.id,
          verifiedAt: verified ? new Date() : null,
          verifiedByUserId: verified ? ctx.session.user.id : null,
        },
      });
    }),

  /**
   * PUR-01: a second person confirms a filed licence against the issuing
   * authority. Licence evidence is append-only, so verification is a new filing
   * that supersedes the unverified one and copies its details from the stored
   * row, never from the payload. Refused for the person who filed it (and for
   * a filing whose filer was never recorded), except under the solo rule.
   */
  verifySupplierLicence: purchasing
    .meta(PROCUREMENT)
    .input(z.object({ licenceId: z.string().min(1).max(200) }).strict())
    .mutation(async ({ ctx, input }) => {
      const { organizationId, actorId } = procurementActor(ctx);
      // One transaction holding the filing's row lock: two colleagues verifying
      // the same filing at once serialize here, and the second then sees the
      // first one's superseding row and is refused (#979).
      return ctx.db.$transaction(async (tx) => {
        const db = txDb(tx);
        await db.$queryRaw`SELECT id FROM pharmacy_supplier_licences WHERE id=${input.licenceId} AND "organizationId"=${organizationId} FOR UPDATE`;
        const filed = await db.pharmacySupplierLicence.findFirst({
          where: { id: input.licenceId },
        });
        if (!filed) throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND' });
        if (filed.verifiedAt)
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'INVALID_TRANSITION' });
        if (
          await db.pharmacySupplierLicence.findFirst({
            where: { supersedesId: filed.id },
            select: { id: true },
          })
        )
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'INVALID_TRANSITION' });
        const someoneElseFiled =
          filed.recordedByUserId !== null && filed.recordedByUserId !== actorId;
        if (!someoneElseFiled && !(await isSoloOwner(ctx, db))) throw selfVerification();
        return db.pharmacySupplierLicence.create({
          data: {
            supplierId: filed.supplierId,
            licenceType: filed.licenceType,
            licenceNumber: filed.licenceNumber,
            issuingAuthority: filed.issuingAuthority,
            issuedAt: filed.issuedAt,
            expiresAt: filed.expiresAt,
            evidenceUri: filed.evidenceUri,
            supersedesId: filed.id,
            recordedByUserId: actorId,
            verifiedAt: new Date(),
            verifiedByUserId: actorId,
          },
        });
      });
    }),

  /**
   * PUR-01: authorizing (or withdrawing) trade with a supplier is an approval,
   * like approving a purchase order: it needs the approver capability on top of
   * procurement. Manager and Owner templates hold it; so does the solo owner.
   */
  setSupplierAuthorization: purchasing
    .meta(PROCUREMENT_AND_APPROVAL)
    .input(z.object({ supplierId: z.string().min(1).max(200), authorized: z.boolean() }).strict())
    .mutation(async ({ ctx, input }) => {
      if (!(await ctx.db.pharmacySupplier.findFirst({ where: { id: input.supplierId } })))
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Supplier is outside this workspace.' });
      return ctx.db.pharmacySupplier.update({
        where: { id: input.supplierId },
        data: { authorized: input.authorized },
      });
    }),

  // ----- PUR-02 requisition -----

  createRequisition: purchasing
    .meta(PROCUREMENT)
    .input(
      z
        .object({
          reference: z.string().trim().min(1).max(100),
          branchId: z.string().min(1).max(200).optional(),
          neededBy: z.date().optional(),
          note: z.string().trim().max(2000).optional(),
          lines: z
            .array(
              z
                .object({
                  medicineId: z.string().min(1).max(200),
                  packLevelId: z.string().min(1).max(200),
                  quantityPacks: z.number().int().positive(),
                  canonicalUnitsPerPack: z.number().int().positive(),
                  note: z.string().trim().max(500).optional(),
                })
                .strict()
            )
            .min(1)
            .max(MAX_DOCUMENT_LINES),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await purchasingRecordScope(ctx, input.branchId);
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

  submitRequisition: purchasing
    .meta(PROCUREMENT)
    .input(z.object({ requisitionId: z.string().min(1).max(200) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const requisition = await ctx.db.pharmacyRequisition.findFirst({
          where: { id: input.requisitionId },
        });
        if (!requisition) throw new PharmacyPurchasingError('NOT_FOUND');
        await purchasingRecordScope(ctx, requisition.branchId);
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

  recordQuote: purchasing
    .meta(PROCUREMENT)
    .input(
      z
        .object({
          requisitionId: z.string().min(1).max(200),
          supplierId: z.string().min(1).max(200),
          reference: z.string().trim().max(100).optional(),
          quotedAt: z.date(),
          validUntil: z.date(),
          note: z.string().trim().max(2000).optional(),
          lines: z
            .array(
              z
                .object({
                  requisitionLineId: z.string().min(1).max(200),
                  pricePerPackMinor: z.number().int().nonnegative(),
                  schemeBuyPacks: z.number().int().nonnegative().default(0),
                  schemeFreePacks: z.number().int().nonnegative().default(0),
                  discountBps: bps.default(0),
                  moqPacks: z.number().int().positive().default(1),
                  leadTimeDays: z.number().int().nonnegative().default(0),
                  minimumExpiryDays: z.number().int().nonnegative().default(0),
                  forecastSellThroughPacks: z.number().int().positive(),
                  canonicalUnitsPerPack: z.number().int().positive(),
                })
                .strict()
                .refine((value) => (value.schemeBuyPacks === 0) === (value.schemeFreePacks === 0), {
                  message: 'A scheme needs both a buy quantity and a free quantity.',
                  path: ['schemeFreePacks'],
                })
            )
            .min(1)
            .max(MAX_DOCUMENT_LINES),
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
        await purchasingRecordScope(ctx, requisition.branchId);
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
  compareQuotes: purchasing
    .meta(PROCUREMENT)
    .input(
      z.object({ requisitionLineId: z.string().min(1).max(200), at: z.date().optional() }).strict()
    )
    .query(async ({ ctx, input }) => {
      try {
        const at = input.at ?? new Date();
        const requisitionLine = await ctx.db.pharmacyRequisitionLine.findFirst({
          where: { id: input.requisitionLineId },
          include: { requisition: { select: { branchId: true } } },
        });
        if (!requisitionLine) throw new PharmacyPurchasingError('NOT_FOUND');
        await purchasingRecordScope(ctx, requisitionLine.requisition?.branchId);
        const quoteLines = await ctx.db.pharmacyQuoteLine.findMany({
          where: { requisitionLineId: requisitionLine.id },
          include: { quote: { include: { supplier: { include: { licences: true } } } } },
        });
        // DEV-753 / DEV-466: the owner policy and strict supersession, read on the server.
        const { organizationId } = tenantScope(ctx);
        const superseded = await supersededLicenceIds(
          ctx.db,
          organizationId,
          quoteLines.flatMap((line) => line.quote.supplier.licences.map((licence) => licence.id))
        );
        const policy = await readSupplierCompliancePolicy(ctx.db, organizationId);
        const candidates: QuoteCandidate[] = quoteLines.map((line) => ({
          quoteId: line.quoteId,
          supplierId: line.quote.supplierId,
          supplierName: line.quote.supplier.name,
          supplierAuthorized: line.quote.supplier.authorized,
          supplierLicences: licenceEvidence(line.quote.supplier.licences, superseded),
          validUntil: line.quote.validUntil,
          pricePerPackMinor: line.pricePerPackMinor,
          canonicalUnitsPerPack: line.canonicalUnitsPerPack,
          schemeBuyPacks: line.schemeBuyPacks,
          schemeFreePacks: line.schemeFreePacks,
          discountBps: line.discountBps,
          moqPacks: line.moqPacks,
          leadTimeDays: line.leadTimeDays,
          minimumExpiryDays: line.minimumExpiryDays,
          // A legacy quote has no recorded forecast; the comparison assumes it
          // all sells and says so, rather than inventing one from the requisition.
          forecastSellThroughPacks: line.forecastSellThroughPacks,
        }));
        return {
          requisitionLineId: requisitionLine.id,
          requiredPacks: requisitionLine.quantityPacks,
          /** Ranked, explained, and deliberately not awarded. */
          ranking: compareQuotes({
            requiredPacks: requisitionLine.quantityPacks,
            candidates,
            at,
            policy,
          }),
          supplierChecksEnabled: policy.checksEnabled,
        };
      } catch (error) {
        domainError(error);
      }
    }),

  // ----- PUR-02 purchase order and approval -----

  createPurchaseOrder: purchasing
    .meta(PROCUREMENT)
    .input(
      z
        .object({
          reference: z.string().trim().min(1).max(100),
          supplierId: z.string().min(1).max(200),
          branchId: z.string().min(1).max(200).optional(),
          requisitionId: z.string().min(1).max(200).optional(),
          quoteId: z.string().min(1).max(200).optional(),
          expectedDeliveryAt: z.date().optional(),
          freightMinor: z.number().int().nonnegative().default(0),
          otherChargesMinor: z.number().int().nonnegative().default(0),
          note: z.string().trim().max(2000).optional(),
          lines: z
            .array(
              z
                .object({
                  medicineId: z.string().min(1).max(200),
                  packLevelId: z.string().min(1).max(200),
                  orderedPacks: z.number().int().positive(),
                  bonusPacks: z.number().int().nonnegative().default(0),
                  canonicalUnitsPerPack: z.number().int().positive(),
                  listPricePerPackMinor: z.number().int().nonnegative(),
                  discountBps: bps.default(0),
                  rebateBps: bps.default(0),
                  taxBps: bps.default(0),
                  taxCreditable: z.boolean().default(false),
                  forecastSellThroughPacks: z.number().int().positive().optional(),
                  minimumExpiryDays: z.number().int().nonnegative().optional(),
                  leadTimeDays: z.number().int().nonnegative().optional(),
                })
                .strict()
            )
            .min(1)
            .max(MAX_DOCUMENT_LINES),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await purchasingRecordScope(ctx, input.branchId);
      try {
        // PUR-01: refuse an unauthorized or licence-expired supplier before anything is written.
        // The gate is decided again below, in the transaction that writes the order.
        await assertOrderableSupplier(
          ctx.db,
          ctx,
          await ctx.db.pharmacySupplier.findFirst({
            where: { id: input.supplierId },
            include: WITH_LICENCES,
          }),
          new Date(),
          {
            operation: 'PURCHASE_ORDER_CREATE',
            reference: input.reference,
          },
          { record: false }
        );
        const requisition = input.requisitionId
          ? await ctx.db.pharmacyRequisition.findFirst({ where: { id: input.requisitionId } })
          : null;
        if (input.requisitionId && !requisition)
          throw new PharmacyPurchasingError('CROSS_TENANT_REFERENCE');
        const quote = input.quoteId
          ? await ctx.db.pharmacyQuote.findFirst({
              where: { id: input.quoteId, supplierId: input.supplierId },
              include: { requisition: { select: { branchId: true } } },
            })
          : null;
        if (input.quoteId && !quote) throw new PharmacyPurchasingError('CROSS_TENANT_REFERENCE');
        if (requisition) await purchasingRecordScope(ctx, requisition.branchId);
        if (quote) await purchasingRecordScope(ctx, quote.requisition?.branchId);
        // The order's own branch, its requisition's and its quote's: the caller
        // must be assigned to every one of them.
        await assertOrderBranches(ctx, {
          branchId: input.branchId,
          requisitionBranchId: requisition?.branchId ?? null,
        });
        await assertOrderBranches(ctx, {
          requisitionBranchId: quote?.requisition?.branchId ?? null,
        });
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

        // The comparison assumptions retained on each line are quote facts, so
        // they are copied from the stored quote lines and never trusted from the
        // client. A line with no matching stored quote line carries none.
        const quoteAssumptions = new Map<
          string,
          {
            forecastSellThroughPacks: number | null;
            minimumExpiryDays: number;
            leadTimeDays: number;
          }
        >();
        if (input.quoteId) {
          const storedQuoteLines = await ctx.db.pharmacyQuoteLine.findMany({
            where: {
              quoteId: input.quoteId,
              ...(input.requisitionId
                ? { requisitionLine: { requisitionId: input.requisitionId } }
                : {}),
            },
            include: { requisitionLine: { select: { medicineId: true } } },
          });
          for (const stored of storedQuoteLines) {
            quoteAssumptions.set(stored.requisitionLine.medicineId, {
              forecastSellThroughPacks: stored.forecastSellThroughPacks,
              minimumExpiryDays: stored.minimumExpiryDays,
              leadTimeDays: stored.leadTimeDays,
            });
          }
        }

        const { lines, ...purchaseOrder } = input;
        // DEV-753: one transaction. The owner policy is share-locked while the order is
        // written, and an order raised past the unchecked gate commits with its evidence,
        // named by its own id, or not at all.
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          const supplierGate = await assertOrderableSupplier(
            db,
            ctx,
            await db.pharmacySupplier.findFirst({
              where: { id: input.supplierId },
              include: WITH_LICENCES,
            }),
            new Date(),
            { operation: 'PURCHASE_ORDER_CREATE', reference: input.reference },
            { record: false }
          );
          const created = await db.pharmacyPurchaseOrder.create({
            data: {
              ...purchaseOrder,
              createdByUserId: ctx.session.user.id,
              lines: {
                create: lines.map((line, index) => ({
                  ...line,
                  forecastSellThroughPacks: undefined,
                  minimumExpiryDays: undefined,
                  leadTimeDays: undefined,
                  ...quoteAssumptions.get(line.medicineId),
                  lineNumber: index + 1,
                  orderedCanonicalUnits: line.orderedPacks * line.canonicalUnitsPerPack,
                  bonusCanonicalUnits: line.bonusPacks * line.canonicalUnitsPerPack,
                })),
              },
            },
            include: { lines: true },
          });
          if (!supplierGate.checked) {
            await recordSupplierComplianceSkip(
              db,
              { organizationId: tenantScope(ctx).organizationId, actorId: ctx.session.user.id },
              {
                operation: 'PURCHASE_ORDER_CREATE',
                supplierId: input.supplierId,
                purchaseOrderId: created.id,
                reference: input.reference,
                outcome: supplierGate,
              }
            );
          }
          return created;
        });
      } catch (error) {
        domainError(error);
      }
    }),

  submitPurchaseOrder: purchasing
    .meta(PROCUREMENT)
    .input(z.object({ purchaseOrderId: z.string().min(1).max(200) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const order = await ctx.db.pharmacyPurchaseOrder.findFirst({
          where: { id: input.purchaseOrderId },
          include: { requisition: { select: { branchId: true } } },
        });
        if (!order) throw new PharmacyPurchasingError('NOT_FOUND');
        await assertOrderBranches(ctx, {
          branchId: order.branchId,
          requisitionBranchId: order.requisition?.branchId ?? null,
        });
        await purchasingRecordScope(ctx, order.branchId);
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
   * it requires a second person unless a sole active owner reauthenticates
   * with their PIN. A rejection is recorded too, and returns the order to DRAFT.
   */
  approvePurchaseOrder: purchasing
    .meta(APPROVAL)
    .input(
      z
        .object({
          purchaseOrderId: z.string().min(1).max(200),
          decision: z.enum(['APPROVED', 'REJECTED']),
          pin: z
            .string()
            .regex(/^\d{4,8}$/)
            .optional(),
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
          // #683 rule, implemented here: the approver must be assigned to the
          // order's branch (and its requisition's), not merely hold the capability.
          await assertOrderBranches(
            ctx,
            {
              branchId: order.branchId,
              requisitionBranchId: order.requisition?.branchId ?? null,
            },
            txDb(tx)
          );

          await purchasingRecordScope(ctx, order.branchId);

          const toStatus = input.decision === 'APPROVED' ? 'APPROVED' : 'DRAFT';
          assertPurchaseOrderTransition(order.status, toStatus);
          const selfApproval =
            order.createdByUserId === ctx.session.user.id ||
            order.requisition?.requestedByUserId === ctx.session.user.id;
          if (selfApproval) {
            if (
              !(await isSoloOwner(ctx, txDb(tx))) ||
              !(await soloOwnerApprovalAllowed(
                txDb(tx),
                tenantScope(ctx).organizationId,
                ctx.session.user.id,
                order.branchId
              ))
            ) {
              assertApprovalAllowed({
                approverId: ctx.session.user.id,
                requestedById: order.requisition?.requestedByUserId ?? null,
                createdById: order.createdByUserId,
              });
            }
            const attempt = await verifyPurchaseApprover(txDb(tx), {
              organizationId: tenantScope(ctx).organizationId,
              branchId: order.branchId,
              approverId: ctx.session.user.id,
              actorId: ctx.session.user.id,
              pin: input.pin,
            });
            ctx.audit.detail = {
              skipInput: true,
              metadata: {
                ...ctx.audit.detail.metadata,
                policy: SOLO_OWNER_POLICY,
                approverId: ctx.session.user.id,
                pinVerified: !('blocked' in attempt),
              },
            };
            if ('blocked' in attempt) return attempt;
          }
          if (input.decision === 'APPROVED') {
            // Authorization can lapse between drafting and approval.
            await assertOrderableSupplier(
              txDb(tx),
              ctx,
              await tx.pharmacySupplier.findFirst({
                where: { id: order.supplierId },
                include: WITH_LICENCES,
              }),
              new Date(),
              { operation: 'PURCHASE_ORDER_APPROVE', purchaseOrderId: order.id }
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
              policy: selfApproval ? SOLO_OWNER_POLICY : SEGREGATION_OF_DUTIES_POLICY,
              decision: input.decision,
              fromStatus: order.status,
              toStatus,
              reason: input.reason,
            },
          });
          if (selfApproval) {
            await tx.auditLog.create({
              data: {
                organizationId: tenantScope(ctx).organizationId,
                actorId: ctx.session.user.id,
                actorType: 'USER',
                source: 'TRPC',
                category: 'PHARMACY_PURCHASING',
                operation: 'OTHER',
                action: 'pharmacy.purchaseOrderApproval',
                targetType: 'PharmacyPurchaseOrder',
                targetId: order.id,
                metadata: {
                  policy: SOLO_OWNER_POLICY,
                  pinVerified: true,
                  decision: input.decision,
                },
              },
            });
          }
          return updatedOrder;
        });
      } catch (error) {
        domainError(error);
      }
    }),

  sendPurchaseOrder: purchasing
    .meta(APPROVAL)
    .input(z.object({ purchaseOrderId: z.string().min(1).max(200) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const order = await ctx.db.pharmacyPurchaseOrder.findFirst({
          where: { id: input.purchaseOrderId },
          include: { requisition: { select: { branchId: true } } },
        });
        if (!order) throw new PharmacyPurchasingError('NOT_FOUND');
        await assertOrderBranches(ctx, {
          branchId: order.branchId,
          requisitionBranchId: order.requisition?.branchId ?? null,
        });
        await purchasingRecordScope(ctx, order.branchId);
        assertPurchaseOrderTransition(order.status, 'SENT');
        // PUR-01 again: the supplier must still be orderable at the moment it is sent.
        // One transaction (DEV-753): the owner policy is share-locked for the send, and
        // any unchecked-gate evidence commits with it.
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          await assertOrderableSupplier(
            db,
            ctx,
            await db.pharmacySupplier.findFirst({
              where: { id: order.supplierId },
              include: WITH_LICENCES,
            }),
            new Date(),
            { operation: 'PURCHASE_ORDER_SEND', purchaseOrderId: order.id }
          );
          return db.pharmacyPurchaseOrder.update({
            where: { id: order.id },
            data: { status: 'SENT', sentAt: new Date() },
          });
        });
      } catch (error) {
        domainError(error);
      }
    }),

  /** PUR-03: the stored order, costed. Bonus packs only ever divide the money over more units. */
  landedCost: purchasing
    .meta(PROCUREMENT)
    .input(z.object({ purchaseOrderId: z.string().min(1).max(200) }).strict())
    .query(async ({ ctx, input }) => {
      try {
        const order = await ctx.db.pharmacyPurchaseOrder.findFirst({
          where: { id: input.purchaseOrderId },
          include: {
            lines: { orderBy: { lineNumber: 'asc' } },
            requisition: { select: { branchId: true } },
          },
        });
        if (!order) throw new PharmacyPurchasingError('NOT_FOUND');
        await assertOrderBranches(ctx, {
          branchId: order.branchId,
          requisitionBranchId: order.requisition?.branchId ?? null,
        });
        await purchasingRecordScope(ctx, order.branchId);
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
            ...(order.lines[index]!.forecastSellThroughPacks
              ? effectiveCostPerSellableUnit({
                  costMinor: line.landedCostMinor,
                  paidPacks: order.lines[index]!.orderedPacks,
                  bonusPacks: order.lines[index]!.bonusPacks,
                  canonicalUnitsPerPack: order.lines[index]!.canonicalUnitsPerPack,
                  forecastSellThroughPacks: order.lines[index]!.forecastSellThroughPacks!,
                })
              : {}),
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
  createGoodsReceipt: purchasing
    .meta(PROCUREMENT)
    .input(
      z
        .object({
          reference: z.string().trim().min(1).max(100),
          branchId,
          supplierId: z.string().min(1).max(200),
          purchaseOrderId: z.string().min(1).max(200).optional(),
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
              pin: z.string().regex(/^\d{4,8}$/),
            })
            .strict()
            .optional(),
          note: z.string().trim().max(2000).optional(),
          qualifiedPersonUserId: z.string().trim().min(1).max(200).optional(),
          /** DEV-77: freight the supplier billed on this invoice, spread into lot landed cost. */
          freightMinor: z.number().int().nonnegative().max(999_999_999).default(0),
          lines: z
            .array(
              z
                .object({
                  purchaseOrderLineId: z.string().min(1).max(200).optional(),
                  medicineId: z.string().min(1).max(200),
                  packLevelId: z.string().min(1).max(200),
                  // #718: optional only for NON_DRUG_RETAIL (FRONT_SHOP) items; the server
                  // still refuses a medicine line without its printed batch, expiry and MRP.
                  batchNumber: z.string().trim().min(1).max(120).optional(),
                  printedExpiry: z.date().optional(),
                  expiryPrecision: z.enum(['DAY', 'MONTH']),
                  printedMrpMinor: z.number().int().positive().optional(),
                  canonicalUnitsPerPack: z.number().int().positive(),
                  receivedPacks: z.number().int().nonnegative(),
                  bonusPacks: z.number().int().nonnegative().default(0),
                  rejectedCanonicalUnits: z.number().int().nonnegative().default(0),
                  rejectionReason: z.string().trim().min(1).max(500).optional(),
                  invoicedPricePerPackMinor: z.number().int().nonnegative(),
                  discountBps: bps.default(0),
                  taxBps: bps.default(0),
                  taxCreditable: z.boolean().default(false),
                  stockLocationId: z.string().min(1).max(200),
                  quarantineLocationId: z.string().min(1).max(200).optional(),
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
            .min(1)
            .max(MAX_RECEIPT_LINES),
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
      const scope = await receivingScope(ctx, input.branchId);
      try {
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          // DEV-679: one supplier bill, one receipt. Checked before any PIN is
          // spent, and case-insensitively, so a re-typed or photo-read invoice
          // number cannot file the same bill twice.
          const duplicate = await findDuplicateSupplierInvoice(db, {
            organizationId: scope.organizationId,
            supplierId: input.supplierId,
            supplierInvoiceRef: input.supplierInvoiceRef,
          });
          if (duplicate) {
            throw new TRPCError({ code: 'CONFLICT', message: 'DUPLICATE_SUPPLIER_INVOICE' });
          }
          let costedOrder: { id: string; freightMinor: number; otherChargesMinor: number } | null =
            null;
          if (input.purchaseOrderId) {
            // Lock the referenced order before validating any mutable data so
            // cancellation cannot commit while the receipt is being checked.
            const order = await lockReceivablePurchaseOrder(db, scope, {
              purchaseOrderId: input.purchaseOrderId,
              supplierId: input.supplierId,
            });
            costedOrder = {
              id: input.purchaseOrderId,
              freightMinor: order.freightMinor,
              otherChargesMinor: order.otherChargesMinor,
            };
            // An organization-wide order raised from a branch requisition is
            // still that branch's demand: receiving against it needs reach
            // there too, as every other order-scoped procedure does (#979).
            await assertOrderBranches(
              ctx,
              { branchId: order.branchId, requisitionId: order.requisitionId },
              db
            );
          }
          // PUR-01: an unauthorized or licence-expired supplier cannot be
          // received from, checked here and again when the receipt posts. With
          // supplier checks off, the evidence row is written once the receipt
          // exists: a direct purchase refused at the approver PIN below returns
          // `{ blocked }` and commits, and must not leave evidence of a receipt
          // that was never drafted.
          const supplierGate = await assertOrderableSupplier(
            db,
            ctx,
            await db.pharmacySupplier.findFirst({
              where: { id: input.supplierId },
              include: WITH_LICENCES,
            }),
            input.receivedAt,
            {
              operation: 'GOODS_RECEIPT_CREATE',
              purchaseOrderId: input.purchaseOrderId ?? null,
              reference: input.reference,
            },
            { record: false }
          );
          if (input.directPurchase) {
            const selfApproval = input.directPurchase.approvedByUserId === scope.actorId;
            const soloOwner =
              selfApproval &&
              (await soloOwnerApprovalAllowed(
                db,
                scope.organizationId,
                scope.actorId,
                scope.branchId
              ));
            assertDirectPurchaseAuthorized({
              bypassReason: input.directPurchase.reason,
              bypassApprovedByUserId: input.directPurchase.approvedByUserId,
              receivedByUserId: scope.actorId,
              soloOwnerReauthenticated: soloOwner,
            });
            const attempt = await verifyPurchaseApprover(db, {
              organizationId: scope.organizationId,
              branchId: scope.branchId,
              approverId: input.directPurchase!.approvedByUserId,
              actorId: scope.actorId,
              pin: input.directPurchase!.pin,
            });
            ctx.audit.detail = {
              skipInput: true,
              metadata: {
                policy: soloOwner ? SOLO_OWNER_POLICY : SEGREGATION_OF_DUTIES_POLICY,
                approverId: input.directPurchase.approvedByUserId,
                pinVerified: !('blocked' in attempt),
              },
            };
            if ('blocked' in attempt) return attempt;
          }

          // PUR-03: the lot carries the landed cost the order was approved at:
          // its line rebate and its share of the order's freight and charges.
          const orderTerms = costedOrder
            ? await orderReceiptCostTerms(db, scope.organizationId, costedOrder)
            : null;

          const lines = [];
          const orderCostTermsByLine: Array<{ rebateBps: number; allocatedChargeMinor: number }> =
            [];
          const seenSerials = new Set<string>();
          for (const [index, line] of input.lines.entries()) {
            const item = await db.medicine.findFirst({
              where: { id: line.medicineId, saleable: true },
              select: { id: true, productFamily: true, retailPriceMinor: true },
            });
            if (!item) throw new PharmacyReceivingError('CROSS_TENANT_REFERENCE');
            // #718: a medicine keeps PUR-02 exactly (typed printed batch, expiry and DRAP MRP). A
            // non-drug item may arrive without a batch or expiry and is priced at the shop-set
            // retail price, so the counter never has to ask for a batch.
            if (!isNonDrugRetail(item.productFamily)) {
              const typed = resolveReceiptBatchIdentity({
                productFamily: item.productFamily,
                batchNumber: line.batchNumber,
                printedExpiry: line.printedExpiry,
                expiryPrecision: line.expiryPrecision,
              });
              if (!typed.ok) throw new PharmacyReceivingError(typed.reason);
            }
            const printedMrpMinor = resolveReceiptRetailPrice({
              productFamily: item.productFamily,
              printedMrpMinor: line.printedMrpMinor,
              retailPriceMinor: item.retailPriceMinor,
            });
            if (printedMrpMinor === null) throw new PharmacyReceivingError('MISSING_MRP');
            if (!(await db.packLevel.findFirst({ where: { id: line.packLevelId } })))
              throw new PharmacyReceivingError('MISSING_PACK_CONVERSION');
            // An ordered line borrowed from another order — or from another
            // tenant — would make the three-way match compare the goods against
            // something they were never ordered on.
            const orderLine = line.purchaseOrderLineId
              ? orderTerms?.orderLines.get(line.purchaseOrderLineId)
              : undefined;
            if (line.purchaseOrderLineId) {
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

            const quantities = receiptLineQuantities({
              receivedPacks: line.receivedPacks,
              bonusPacks: line.bonusPacks,
              canonicalUnitsPerPack: line.canonicalUnitsPerPack,
              rejectedCanonicalUnits: line.rejectedCanonicalUnits,
            });
            // The order line's rebate always applies. Its share of the order's
            // freight and other charges applies only when this receipt bills no
            // freight of its own: the invoice is then the authority for what
            // this delivery's freight was, and the two never stack. Either way
            // the delivery's paid units count against the order line's share.
            const orderLineTerms = orderTerms?.termsFor(
              line.purchaseOrderLineId,
              quantities.receivedCanonicalUnits
            ) ?? { rebateBps: 0, allocatedChargeMinor: 0 };
            const orderCostTerms = {
              rebateBps: orderLineTerms.rebateBps,
              allocatedChargeMinor:
                input.freightMinor > 0 ? 0 : orderLineTerms.allocatedChargeMinor,
            };
            orderCostTermsByLine.push(orderCostTerms);
            const identity = await resolveReceiptLineIdentity(db, scope.organizationId, {
              medicineId: line.medicineId,
              productFamily: item.productFamily,
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
            // GS1 AI(21) names ONE pack. A shared batch/expiry may cover many
            // packs; a serial never does, so it cannot be cloned onto a count.
            if (identity.serialKey && line.receivedPacks + line.bonusPacks !== 1) {
              throw new PharmacyReceivingError('SERIALIZED_PACK_QUANTITY');
            }
            // Fail at draft time, not post time, when a shelf is not this branch's.
            for (const locationId of [line.stockLocationId, line.quarantineLocationId]) {
              if (!locationId) continue;
              const location = await db.pharmacyStockLocation.findFirst({
                where: { id: locationId, organizationId: scope.organizationId },
                select: { branchId: true },
              });
              if (!location) throw new PharmacyReceivingError('CROSS_TENANT_REFERENCE');
              if (location.branchId !== scope.branchId) {
                throw new PharmacyReceivingError('CROSS_BRANCH_REFERENCE');
              }
            }
            if (identity.gtin && identity.serialKey) {
              const token = `${identity.gtin}:${identity.serialKey}`;
              if (seenSerials.has(token)) throw new PharmacyReceivingError('DUPLICATE_SERIAL');
              seenSerials.add(token);
              const prior = await db.pharmacyGoodsReceiptLine.findFirst({
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
              printedMrpMinor,
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
              // PUR-03 / DEV-77 / DEV-161: bonus units divide the same money over
              // more units, so a scheme lowers the landed cost and never adds
              // revenue; the charge shares are added once every line is known.
              allocatedFreightMinor: 0,
              allocatedOrderChargeMinor: orderCostTerms.allocatedChargeMinor,
              unitCostMinor: 0,
              stockLocationId: line.stockLocationId,
              quarantineLocationId: line.quarantineLocationId ?? null,
              gtin: identity.gtin,
              serialNumber: identity.serialNumber,
              serialKey: identity.serialKey,
              gs1Warnings: identity.gs1Warnings,
            });
          }

          // DEV-77: one landed-cost pass over the whole receipt, so the freight
          // shares sum to the billed freight exactly and every lot carries
          // (net − rebate + non-creditable tax + charge share) / (received +
          // bonus). DEV-161: each line also brings its order-line rebate and,
          // when the invoice bills no freight, its share of the PO's charges.
          const landed = receiptLandedCosts({
            freightMinor: input.freightMinor,
            lines: input.lines.map((line, index) => ({
              receivedPacks: line.receivedPacks,
              bonusPacks: line.bonusPacks,
              canonicalUnitsPerPack: line.canonicalUnitsPerPack,
              invoicedPricePerPackMinor: line.invoicedPricePerPackMinor,
              discountBps: line.discountBps,
              rebateBps: orderCostTermsByLine[index]!.rebateBps,
              taxBps: line.taxBps,
              taxCreditable: line.taxCreditable,
              allocatedChargeMinor: orderCostTermsByLine[index]!.allocatedChargeMinor,
            })),
          });
          for (const [index, line] of lines.entries()) {
            line.allocatedFreightMinor = landed[index]!.allocatedFreightMinor;
            line.unitCostMinor = landed[index]!.unitCostMinor;
          }

          const receipt = await db.pharmacyGoodsReceipt.create({
            data: {
              organizationId: scope.organizationId,
              branchId: scope.branchId,
              reference: input.reference,
              freightMinor: input.freightMinor,
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
          if (input.directPurchase) {
            await recordPurchaseApprovalEvidence(db, {
              organizationId: scope.organizationId,
              receiptId: receipt.id,
              actorId: scope.actorId,
              approverId: input.directPurchase.approvedByUserId,
            });
          }
          if (!supplierGate.checked) {
            await recordSupplierComplianceSkip(
              db,
              { organizationId: scope.organizationId, actorId: scope.actorId },
              {
                operation: 'GOODS_RECEIPT_CREATE',
                supplierId: input.supplierId,
                purchaseOrderId: input.purchaseOrderId ?? null,
                reference: input.reference,
                outcome: supplierGate,
              }
            );
          }
          return receipt;
        });
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
  postGoodsReceipt: purchasing
    .meta(PROCUREMENT)
    .input(
      z
        .object({
          branchId,
          goodsReceiptId: z.string().min(1).max(200),
          staffProfileId: z.string().trim().min(1).max(200).optional(),
          approvalPin: z
            .string()
            .regex(/^\d{4,8}$/)
            .optional(),
          pin: z
            .string()
            .regex(/^\d{4,8}$/)
            .optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await assertProcurement(ctx);
      const scope = await receivingScope(ctx, input.branchId);
      // One read of the receipt, scoped to the tenant and the posting branch. A
      // receipt held by another branch is not found here, and the posting below
      // refuses it before any stock moves.
      const receipt = await ctx.db.pharmacyGoodsReceipt.findFirst({
        where: {
          id: input.goodsReceiptId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
        },
        select: {
          id: true,
          directPurchase: true,
          status: true,
          bypassApprovedByUserId: true,
          receivedByUserId: true,
          purchaseOrder: {
            select: { branchId: true, requisition: { select: { branchId: true } } },
          },
        },
      });
      // The receipt's order carries its own branch and the branch of the
      // requisition it came from. Posting moves that order to RECEIVING, so it
      // needs reach at both (#979) before any PIN transaction or posting runs.
      // The links from receipt to order and from order to requisition do not
      // change once the receipt exists.
      if (receipt?.purchaseOrder) {
        await assertOrderBranches(ctx, {
          branchId: receipt.purchaseOrder.branchId,
          requisitionBranchId: receipt.purchaseOrder.requisition?.branchId ?? null,
        });
      }
      // Lockout counters commit even when the PIN is refused. Stock posting is
      // a second transaction, so a refused PIN never leaves a half-posted receipt.
      if (receipt?.directPurchase && receipt.status === 'DRAFT') {
        const approverId = receipt.bypassApprovedByUserId;
        if (!approverId) return { blocked: APPROVAL_BLOCKED };
        if (
          !(await hasPurchaseApprovalEvidence(ctx.db, scope.organizationId, receipt.id, approverId))
        ) {
          // Old drafts have no verified evidence. Reauthenticate their recorded
          // approver rather than treating a historical ID as a signature.
          if (
            approverId === receipt.receivedByUserId &&
            !(await soloOwnerApprovalAllowed(
              ctx.db,
              scope.organizationId,
              approverId,
              scope.branchId
            ))
          )
            return { blocked: APPROVAL_BLOCKED };
          const approval = await ctx.db.$transaction(async (inner) => {
            const db = txDb(inner);
            const result = await verifyPurchaseApprover(db, {
              organizationId: scope.organizationId,
              branchId: scope.branchId,
              approverId,
              actorId: scope.actorId,
              pin: input.approvalPin,
            });
            if ('blocked' in result) return result;
            await recordPurchaseApprovalEvidence(db, {
              organizationId: scope.organizationId,
              receiptId: receipt.id,
              actorId: scope.actorId,
              receiverId: receipt.receivedByUserId,
              approverId,
            });
            return result;
          });
          ctx.audit.detail.skipInput = true;
          if ('blocked' in approval) return approval;
        }
      }
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
  controlledWitnesses: purchasing
    .meta(PROCUREMENT)
    .input(
      z
        .object({
          branchId,
          goodsReceiptId: z.string().min(1).max(200),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      // The list names PIN holders. Without the procurement module it is
      // refused here too (#246): server pages call this router directly, where
      // the path-based module gate cannot name the module.
      if (!hasModule(ctx.entitlements, 'pharmacy-procurement')) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Pharmacy procurement access required.',
        });
      }
      const actorId = ctx.session.user.id;
      const actor = subjectFromSession(ctx.session.user);
      if (
        !(await can(actor, 'pharmacy:safety', undefined, { db: ctx.db })) &&
        !(await can(actor, 'pharmacy:dispense', undefined, { db: ctx.db }))
      ) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      const { organizationId } = await receivingScope(ctx, input.branchId);
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
   * Fresh independent witnesses for reversing a posted controlled receipt: any
   * active PIN-holding pharmacist other than the person reversing. Unlike
   * posting, this is not limited to the receipt's original qualified person.
   * A sole pharmacist gets only their own profile, marked `self`.
   */
  controlledReversalWitnesses: purchasing
    .meta(PROCUREMENT)
    .input(
      z
        .object({
          branchId,
          goodsReceiptId: z.string().min(1).max(200),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      if (!hasModule(ctx.entitlements, 'pharmacy-procurement')) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Pharmacy procurement access required.',
        });
      }
      const actorId = ctx.session.user.id;
      const actor = subjectFromSession(ctx.session.user);
      // Reversing controlled stock requires pharmacy:safety; do not enumerate otherwise.
      if (!(await can(actor, 'pharmacy:safety', undefined, { db: ctx.db }))) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      const { organizationId } = await receivingScope(ctx, input.branchId);
      const receipt = await ctx.db.pharmacyGoodsReceipt.findFirst({
        where: {
          id: input.goodsReceiptId,
          organizationId,
          branchId: input.branchId,
          status: 'POSTED',
        },
        select: { id: true },
      });
      if (!receipt) return [];
      const others = await listControlledPinWitnesses(ctx.db, organizationId, actorId);
      if (others.length > 0) return others;
      // Solo-pharmacy rule: with no other pharmacist, the user witnesses with
      // their own fresh PIN; the reversal itself rechecks this and audits it.
      if (!(await isSolePharmacist(ctx.db, organizationId, actorId))) return [];
      const self = await listControlledPinWitnesses(ctx.db, organizationId, actorId, actorId);
      return self.map((witness) => ({ ...witness, self: true }));
    }),

  /**
   * PUR-04: undo a posting with linked compensating movements. Nothing that was
   * posted is edited or deleted; if the stock has already moved on, the ledger
   * refuses rather than driving a balance negative.
   */
  reverseGoodsReceipt: purchasing
    .meta(PROCUREMENT)
    .input(
      z
        .object({
          branchId,
          goodsReceiptId: z.string().min(1).max(200),
          reason: z.string().trim().min(1).max(1000),
          controlledWitness: z
            .object({
              staffProfileId: z.string().min(1).max(200),
              pin: z.string().regex(/^\d{4,8}$/),
            })
            .strict()
            .optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await assertProcurement(ctx);
      const scope = await receivingScope(ctx, input.branchId);
      try {
        return await ctx.db.$transaction((tx) =>
          reverseGoodsReceipt(txDb(tx), scope, {
            goodsReceiptId: input.goodsReceiptId,
            reason: input.reason,
            at: new Date(),
            controlledWitness: input.controlledWitness,
          })
        );
      } catch (error) {
        domainError(error);
      }
    }),

  /** PUR-04: the queue that stays visible until somebody resolves it. */
  receivingExceptions: purchasing
    .meta(PROCUREMENT)
    .input(
      z
        .object({
          branchId,
          status: z.enum(['OPEN', 'RESOLVED']).default('OPEN'),
          goodsReceiptId: z.string().min(1).max(200).optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const scope = await receivingScope(ctx, input.branchId);
      return listReceivingExceptions(
        ctx.db,
        { organizationId: scope.organizationId, branchId: scope.branchId },
        { status: input.status, goodsReceiptId: input.goodsReceiptId }
      );
    }),

  /** PUR-04: close one, with the actor from the session and a mandatory note. */
  resolveReceivingException: purchasing
    .meta(PROCUREMENT)
    .input(
      z
        .object({
          branchId,
          receivingExceptionId: z.string().min(1).max(200),
          resolutionNote: z.string().trim().min(1).max(1000),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await resolveReceivingException(ctx.db, await receivingScope(ctx, input.branchId), {
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
  createPurchaseReturn: purchasing
    .meta(PROCUREMENT_AND_FINANCE)
    .input(
      z
        .object({
          branchId,
          supplierId: z.string().min(1).max(200),
          kind: z.enum(['PURCHASE_RETURN', 'EXPIRY_CLAIM']),
          reference: z.string().trim().min(1).max(120),
          note: z.string().trim().max(1000).optional(),
          lines: z
            .array(
              z
                .object({
                  inventoryLotId: z.string().min(1).max(200),
                  stockLocationId: z.string().min(1).max(200),
                  quantityUnits: z.number().int().positive(),
                  reason: z.string().trim().min(1).max(500),
                  returnWindowEndsAt: z.date(),
                  expectedCreditMinor: z.number().int().min(0),
                })
                .strict()
            )
            .min(1)
            .max(MAX_DOCUMENT_LINES),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await receivingScope(ctx, input.branchId);
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
  submitPurchaseReturn: purchasing
    .meta(PROCUREMENT_AND_FINANCE)
    .input(z.object({ branchId, purchaseReturnId: z.string().min(1).max(200) }).strict())
    .mutation(async ({ ctx, input }) => {
      const scope = await receivingScope(ctx, input.branchId);
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
  dispatchPurchaseReturn: purchasing
    .meta(PROCUREMENT_AND_FINANCE)
    .input(
      z
        .object({
          branchId,
          purchaseReturnId: z.string().min(1).max(200),
          idempotencyKey: z.string().trim().min(1).max(200),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await receivingScope(ctx, input.branchId);
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

  issueDebitNote: purchasing
    .meta(PROCUREMENT_AND_FINANCE)
    .input(
      z
        .object({
          branchId,
          purchaseReturnId: z.string().min(1).max(200),
          reference: z.string().trim().min(1).max(120),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await receivingScope(ctx, input.branchId);
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

  recordSupplierCredit: purchasing
    .meta(PROCUREMENT_AND_FINANCE)
    .input(
      z
        .object({
          branchId,
          supplierId: z.string().min(1).max(200),
          reference: z.string().trim().min(1).max(120),
          amountMinor: z.number().int().positive(),
          receivedAt: z.date(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await receivingScope(ctx, input.branchId);
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

  allocateSupplierCredit: purchasing
    .meta(PROCUREMENT_AND_FINANCE)
    .input(
      z
        .object({
          branchId,
          supplierCreditId: z.string().min(1).max(200),
          debitNoteId: z.string().min(1).max(200),
          amountMinor: z.number().int().positive(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await receivingScope(ctx, input.branchId);
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
  debitNotePositions: purchasing
    .meta(PROCUREMENT)
    .input(z.object({ branchId, supplierId: z.string().min(1).max(200).optional() }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await receivingScope(ctx, input.branchId);
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
  /**
   * The pickers. `branches` is every active branch of the organization;
   * `reachableBranchIds` names the ones the caller may act at (assigned, or
   * live tenant owner), so a branch-owned board never offers a branch whose
   * reads `assertProcurementBranch` would refuse.
   */
  workspace: purchasing.meta(PROCUREMENT).query(async ({ ctx }) => {
    const workspace = await purchasingWorkspace(ctx.db, {
      organizationId: tenantScope(ctx).organizationId,
      actorId: ctx.session.user.id,
    });
    const reachableBranchIds = await reachableProcurementBranchIds(
      ctx,
      workspace.branches.map((branch) => branch.id)
    );
    return { ...workspace, reachableBranchIds };
  }),

  /** PUR-01 — suppliers with licence evidence and the current trade decision. */
  suppliers: purchasing
    .meta(PROCUREMENT)
    .input(
      z
        .object({ includeInactive: z.boolean().default(false) })
        .strict()
        .optional()
    )
    .query(async ({ ctx, input }) =>
      listSuppliers(ctx.db, tenantScope(ctx), { includeInactive: input?.includeInactive })
    ),

  /** PUR-02 — requisitions with their lines, quotes and resulting orders. */
  requisitions: purchasing
    .meta(PROCUREMENT)
    .query(async ({ ctx }) => listRequisitions(ctx.db, await purchasingOrderScope(ctx))),

  /** PUR-02/PUR-03 — orders with lines, approval history and posted receipts. */
  purchaseOrders: purchasing
    .meta(PROCUREMENT)
    .query(async ({ ctx }) => listPurchaseOrders(ctx.db, await purchasingOrderScope(ctx))),

  /**
   * PUR-02 — canonical units already received against each ordered line, from
   * POSTED receipts only. The receiving bench pre-fills the outstanding balance
   * from this, so it never asks the operator to work out what is still owed.
   */
  /**
   * DEV-693: read-only official-price hints for the medicines being received.
   * An official DRAP price is price data, so only a receiver who also holds the
   * price-page grant (pharmacy:safety) gets any; everyone else gets no hints.
   */
  officialPriceAlerts: purchasing
    .meta(PROCUREMENT)
    .input(z.object({ medicineIds: z.array(z.string().min(1).max(200)).min(1).max(500) }).strict())
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.entitlements?.organizationId;
      if (!organizationId || !ctx.session || !hasModule(ctx.entitlements, 'pharmacy-procurement'))
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Pharmacy procurement access required.',
        });
      const actor = subjectFromSession(ctx.session.user);
      if (!(await can(actor, 'pharmacy:safety', undefined, { db: ctx.db }))) return [];
      return listDrapPriceAlerts(
        ctx.db,
        { organizationId, actorId: ctx.session.user.id },
        input.medicineIds
      );
    }),

  receivedAgainstOrder: purchasing
    .meta(PROCUREMENT)
    .input(z.object({ purchaseOrderId: z.string().min(1).max(200) }).strict())
    .query(async ({ ctx, input }) => {
      const order = await ctx.db.pharmacyPurchaseOrder.findFirst({
        where: { id: input.purchaseOrderId },
        select: { branchId: true, requisition: { select: { branchId: true } } },
      });
      if (!order) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Order is outside your pharmacy scope.',
        });
      }
      await purchasingRecordScope(ctx, order.branchId);
      await assertOrderBranches(ctx, {
        branchId: order.branchId,
        requisitionBranchId: order.requisition?.branchId ?? null,
      });
      return Object.fromEntries(
        await receivedAgainstOrder(ctx.db, tenantScope(ctx), input.purchaseOrderId)
      );
    }),

  /** PUR-02 receiving / PUR-05 — the receipts filed at one branch. */
  goodsReceipts: purchasing
    .meta(PROCUREMENT)
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) =>
      listGoodsReceipts(ctx.db, await receivingScope(ctx, input.branchId))
    ),

  /** PUR-04 — the review queue, joined to the medicine and receipt it concerns. */
  receivingExceptionQueue: purchasing
    .meta(PROCUREMENT)
    .input(z.object({ branchId, status: z.enum(['OPEN', 'RESOLVED']).default('OPEN') }).strict())
    .query(async ({ ctx, input }) =>
      listReceivingExceptionQueue(ctx.db, await receivingScope(ctx, input.branchId), {
        status: input.status,
      })
    ),

  /**
   * PUR-02 acceptance — the stock a posted receipt produced, read back from the
   * PH-INV ledger rather than from the receipt document.
   */
  lotsFromReceipt: purchasing
    .meta(PROCUREMENT)
    .input(z.object({ branchId, goodsReceiptId: z.string().min(1).max(200) }).strict())
    .query(async ({ ctx, input }) =>
      lotsFromReceipt(ctx.db, await receivingScope(ctx, input.branchId), input.goodsReceiptId)
    ),

  /** PUR-06 — returns and claims with their window state and credit position. */
  purchaseReturns: purchasing
    .meta(FINANCIAL_FOLLOW_UP)
    .input(supplierFollowUpInput)
    .query(async ({ ctx, input: { branchId: branch, ...bounds } }) =>
      listPurchaseReturns(ctx.db, await supplierFollowUpScope(ctx, branch), bounds)
    ),

  /** PUR-06 — the available lots a return may be raised against. */
  returnableLots: purchasing
    .meta(PROCUREMENT)
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) =>
      listReturnableLots(ctx.db, await receivingScope(ctx, input.branchId))
    ),

  /**
   * PUR-02 receiving — resolve a scanned barcode, or a typed fragment of a
   * product name, to the medicine the carton in the operator's hand contains.
   */
  resolveScan: purchasing
    .meta(PROCUREMENT)
    .input(z.object({ term: z.string().trim().min(1).max(512) }).strict())
    .query(async ({ ctx, input }) => resolveScan(ctx.db, tenantScope(ctx), input.term)),

  /** SAFE-05: audited, advisory pack authentication at the goods-in bench. */
  authenticatePack: purchasing
    .meta(PROCUREMENT)
    .input(z.object({ branchId, payload: z.string().max(512) }).strict())
    .mutation(async ({ ctx, input }) => {
      const scope = await receivingScope(ctx, input.branchId);
      ctx.audit.detail = { category: 'PHARMACY_SAFETY', action: 'receiving_pack_scan' };
      return authenticatePharmacyPack(ctx.db, {
        ...scope,
        actorId: ctx.session.user.id,
        source: 'RECEIVING',
        payload: input.payload,
      });
    }),

  /** PUR-06 — supplier credits recorded at this branch and what they cover. */
  supplierCredits: purchasing
    .meta(FINANCIAL_FOLLOW_UP)
    .input(supplierFollowUpInput)
    .query(async ({ ctx, input: { branchId: branch, ...bounds } }) =>
      listSupplierCredits(ctx.db, await supplierFollowUpScope(ctx, branch), bounds)
    ),

  /**
   * DEV-678 — velocity-based reorder, one draft per distributor. Read only: SQL
   * reads the branch's sales, available stock and open orders, and the planner
   * turns them into suggested packs. A person confirms a draft through
   * `createPurchaseOrder`; nothing is written or sent here.
   */
  reorderDrafts: purchasing
    .meta(PROCUREMENT)
    .input(
      z
        .object({
          branchId,
          windowDays: z.number().int().min(1).max(90).default(REORDER_DEFAULT_WINDOW_DAYS),
          coverDays: z.number().int().min(0).max(90).default(REORDER_DEFAULT_COVER_DAYS),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const scope = await receivingScope(ctx, input.branchId);
      const policy = { windowDays: input.windowDays, coverDays: input.coverDays };
      const facts = await readReorderFacts(
        ctx.db,
        { organizationId: scope.organizationId, branchId: scope.branchId },
        policy
      );
      return { branchId: scope.branchId, ...planReorderDrafts(facts, policy) };
    }),

  /** INV-10 — exact PUR-07 demand. Branch grants see only their own rows. */
  centralDemand: purchasing
    .meta(PROCUREMENT)
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
  createCentralPurchaseOrder: purchasing
    .meta(PROCUREMENT)
    .input(
      z
        .object({
          reference: z.string().trim().min(1).max(100),
          supplierId: z.string().min(1).max(200),
          receivingBranchId: branchId,
          lines: z
            .array(
              z
                .object({
                  medicineId: z.string().min(1).max(200),
                  packLevelId: z.string().min(1).max(200),
                  orderedPacks: z.number().int().positive(),
                  canonicalUnitsPerPack: z.number().int().positive(),
                  listPricePerPackMinor: z.number().int().nonnegative(),
                })
                .strict()
            )
            .min(1)
            .max(MAX_DOCUMENT_LINES),
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
  allocateCentralReceipt: purchasing
    .meta(PROCUREMENT)
    .input(
      z
        .object({
          goodsReceiptId: z.string().min(1).max(200),
          allocations: z
            .array(
              z
                .object({
                  goodsReceiptLineId: z.string().min(1).max(200),
                  destinationBranchId: branchId,
                  destinationStockLocationId: z.string().min(1).max(200),
                  quantityUnits: z.number().int().positive(),
                })
                .strict()
            )
            .min(1)
            .max(MAX_RECEIPT_ALLOCATIONS),
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
