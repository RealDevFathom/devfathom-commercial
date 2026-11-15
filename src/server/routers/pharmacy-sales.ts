import { ControlledRestorationDenied } from '@/lib/pharmacy/controlled-restoration-authorization';
import {
  authorizeCounterApproval,
  confirmCounterApproval,
  CounterApprovalDenied,
  fefoOverrideApprovalPolicy,
  type CounterApproval,
  type CounterApprovalKind,
  type CounterApprovalPin,
} from '@/lib/pharmacy/counter-line-approval';
import { assertRxSaleAllowed, PharmacyRxSaleDenied } from '@/lib/pharmacy/rx-sale-gate';
import {
  PharmacyRxReferenceError,
  attachPrescriptionReference,
  resolvePrescriptionReference,
} from '@/lib/pharmacy/rx-prescription-reference';
import { hasModule } from '@/lib/entitlements';
import {
  manualPaymentSettingsSchema,
  isManualTender,
  manualMerchantPolicies,
  MANUAL_CARD_APPROVAL_CODE,
  MANUAL_CARD_REFERENCE,
} from '@/lib/pharmacy/manual-payments';
import {
  readManualPaymentSettings,
  saveManualPaymentSettings,
} from '@/lib/pharmacy/manual-payment-settings';
import {
  executeSandboxPayment,
  sandboxPaymentInput,
  PharmacyPaymentSandboxError,
} from '@/lib/pharmacy/payment-sandbox';
import { paymentSandboxAdmitted } from '@/lib/pharmacy/payment-sandbox-admission';
import { readCounterEvidence, readDailyCloseEvidence } from '@/lib/pharmacy/counter-evidence';
import { can, subjectFromSession } from '@/lib/abac';
import { capabilityMatches } from '@/lib/abac/capabilities';
import {
  appendControlledSaleEntries,
  earlierRegisterEntry,
  emergencyNoRxDecision,
  resolveEmergencySupplyPolicy,
} from '@/lib/pharmacy/controlled-register';
import { ACTIVE_STATUSES } from '@/lib/auth/session-state';
import { annotateAudit } from '@/server/audit';
import {
  isLockedOut,
  registerFailedAttempt,
  clearLockout,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';
import { closePharmacyDay, readPharmacyClose } from '@/lib/pharmacy/day-close';
import { readPharmacyCashCloseCheck } from '@/lib/pharmacy/cash-close-check-operations';
import { workspaceTimezone } from '@/lib/timezone';
import { prescriptionIsCurrent } from '@/lib/pharmacy/prescription-calendar';
import { readDispensingLabelSources } from '@/lib/pharmacy/dispensing-label-source';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { randomUUID } from 'node:crypto';
import {
  authorizeKhataCharge,
  FamilyKhataError,
  readSaleKhataAccounts,
  readSaleKhataStatement,
  signUpSaleKhata,
} from '@/lib/pharmacy/family-khata';
import {
  KHATA_REPAYMENT_TENDERS,
  recordKhataRepayment,
  searchKhataRepaymentAccounts,
} from '@/lib/pharmacy/khata-repayment';
import { PharmacyBookkeepingError } from '@/lib/pharmacy/bookkeeping';

import {
  PharmacyCounterError,
  readCounterCart,
  readCounterReceipt,
  searchCounterCatalog,
} from '@/lib/pharmacy/counter';
import {
  COUNTER_KEYMAP_PRESETS,
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
import { PharmacySaleBatchError } from '@/lib/pharmacy/sale-batch-safety';
import {
  assertStoredPharmacyMayOperate,
  BranchOperationDeniedError,
} from '@/lib/pharmacy/regulatory';
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
  rankSameSaltBrandsByMargin,
  suggestHigherMarginBrandMix,
} from '@/lib/pharmacy/substitute-finder';
import { findUpsellSuggestions, UPSELL_MAX_TRIGGERS } from '@/lib/pharmacy/upsell-suggestions';
import {
  DuplicateSaltAcknowledgementError,
  verifyDuplicateSaltAcknowledgement,
} from '@/lib/pharmacy/duplicate-salt-acknowledgement';
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
  lockOpenPharmacyDrawer,
  openPharmacyDrawer,
  readOpenPharmacyDrawer,
  PharmacySettlementError,
  readPharmacyTenderOutcome,
  recordPharmacyCashMovement,
  refundPharmacyTender,
  requireCurrentPharmacyBusinessDate,
} from '@/lib/pharmacy/settlement';
import {
  actorMayRefund,
  authenticateRefundPin,
  REFUND_FORBIDDEN,
  REFUND_PIN_POLICY,
} from '@/lib/pharmacy/refund-authorization';

import { assertInOrganization } from '../org-refs';
import {
  adminProcedure,
  auditedProtectedProcedure,
  capabilityProcedure,
  protectedProcedure,
  router,
} from '../trpc';
import type { TRPCContext } from '../trpc';

const branchId = z.string().trim().min(1).max(128);
// Preserve field order and parsing: settlement hashes JSON.stringify(parsed input).
const tenderInput = z
  .object({
    branchId,
    saleId: z.string().min(1),
    deviceId: z.string().min(1),
    businessDate: z.date(),
    type: z.enum([
      'CASH',
      'CARD',
      'BANK_TRANSFER',
      'WALLET',
      'CREDIT',
      'KHATA',
      'RAAST',
      'JAZZCASH',
      'EASYPAISA',
    ]),
    amountMinor: z.number().int().positive(),
    cashReceivedMinor: z.number().int().nonnegative().optional(),
    idempotencyKey: z.string().trim().min(1).max(160),
    familyAccountId: z.string().trim().min(1).max(128).optional(),
    ownerOverride: z.boolean().optional(),
    // Wallets: last 4–6 transaction digits. Manual card: last 4 digits or terminal
    // reference, never a full card number. Each tender's shape is enforced in settlement.
    providerRef: z.string().regex(MANUAL_CARD_REFERENCE).optional(),
    payerName: z.string().trim().min(1).max(100).optional(),
    referenceSkipped: z.boolean().optional(),
    /** DEV-713: approval code from a standalone card terminal slip. */
    approvalCode: z.string().regex(MANUAL_CARD_APPROVAL_CODE).optional(),
  })
  .strict();
const saleUnit = z.enum(['PACK', 'STRIP', 'UNIT']);
const counterApprovalPin = z
  .object({ staffProfileId: z.string().trim().min(1).max(128), pin: z.string().regex(/^\d{4,8}$/) })
  .strict();
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

async function scopeFor(ctx: TRPCContext, branch: string): Promise<LedgerScope> {
  const organizationId = ctx.entitlements?.organizationId;
  const actorId = ctx.session?.user?.id;
  if (!organizationId || !actorId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  await assertInOrganization(ctx.db.pharmacyBranch, organizationId, [branch], { active: true });
  return { organizationId, branchId: branch, actorId };
}

/**
 * #745: margin and cost are never shown at the till. Only a pharmacist, a buyer
 * (for the purchasing view) or a manager/owner may read brand margins.
 */
async function marginScopeFor(
  ctx: TRPCContext,
  branch: string,
  actions: readonly ('pharmacy:dispense' | 'pharmacy:procurement' | 'pharmacy:manage')[]
): Promise<LedgerScope> {
  const scope = await branchScopeOrForbidden(ctx, branch);
  const user = ctx.session!.user;
  const subject = subjectFromSession(user);
  let permitted = false;
  for (const action of actions) {
    if (await can(subject, action, undefined, { db: ctx.db, source: 'TRPC' })) {
      permitted = true;
      break;
    }
  }
  if (!permitted) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Pharmacist or manager permission is required to view brand margins.',
    });
  }
  // Branch stock, cost and margin stay inside the caller's active branch assignment.
  // Only a session ADMIN of this organization may read any of its active branches.
  if (user.role === 'ADMIN' && user.organizationId === scope.organizationId) return scope;
  const assignment = await ctx.db.pharmacyBranchAssignment.findMany({
    where: {
      organizationId: scope.organizationId,
      userId: user.id,
      branchId: branch,
      active: true,
      branch: { organizationId: scope.organizationId, active: true },
    },
    select: { branchId: true },
  });
  if (!assignment.some((row) => row.branchId === branch)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
  }
  return scope;
}

type SaleLineInput = Parameters<typeof addSaleLine>[2];
type CounterLineRequest = Omit<
  SaleLineInput,
  'override' | 'approvedByUserId' | 'approvalPolicy'
> & {
  discountApproval?: CounterApprovalPin;
  override?: { inventoryLotId: string; reason: string; approval?: CounterApprovalPin };
};

/**
 * #520: build the domain line input with server-verified approvals only. A discount needs a
 * manager's PIN (solo rule: the sole approver re-enters their own); a FEFO override needs the
 * pharmacist on duty or a pharmacist's PIN. Each approval is labelled on the audit row.
 * Runs before the sale transaction opens; `confirmLineApprovals` re-checks inside it.
 */
async function approvedLineInput(
  ctx: TRPCContext,
  db: ScopedDb,
  scope: LedgerScope,
  input: CounterLineRequest
): Promise<{
  lineInput: SaleLineInput;
  approvals: Array<{ kind: CounterApprovalKind; approval: CounterApproval }>;
}> {
  const approvals: Array<{ kind: CounterApprovalKind; approval: CounterApproval }> = [];
  const lineInput: SaleLineInput = {
    saleId: input.saleId,
    medicineId: input.medicineId,
    presentationId: input.presentationId,
    packLevelId: input.packLevelId,
    saleUnit: input.saleUnit,
    quantity: input.quantity,
    canonicalUnitsPerSaleUnit: input.canonicalUnitsPerSaleUnit,
    discountKind: input.discountKind,
    discountMinor: input.discountMinor,
    idempotencyKey: input.idempotencyKey,
  };
  const { override } = input;
  if ((input.discountMinor ?? 0) > 0) {
    const approval = await authorizeCounterApproval(db, scope, 'DISCOUNT', input.discountApproval);
    approvals.push({ kind: 'DISCOUNT', approval });
    lineInput.approvedByUserId = approval.approvedByUserId;
    lineInput.approvalPolicy = approval.approvalPolicy;
    annotateAudit(ctx, { metadata: { discountApproval: approval } });
  }
  if (override) {
    const approval = await authorizeCounterApproval(db, scope, 'FEFO_OVERRIDE', override.approval);
    approvals.push({ kind: 'FEFO_OVERRIDE', approval });
    lineInput.override = {
      inventoryLotId: override.inventoryLotId,
      reason: override.reason,
      approvalPolicy: fefoOverrideApprovalPolicy(approval, scope.actorId),
    };
    annotateAudit(ctx, {
      metadata: {
        approvalPolicy: approval.approvalPolicy,
        approvedByUserId: approval.approvedByUserId,
      },
    });
  }
  return { lineInput, approvals };
}

async function khataScope(ctx: TRPCContext, branch: string, access: 'read' | 'write') {
  const scope = await branchScopeOrForbidden(ctx, branch);
  if (
    ctx.organization?.vertical !== 'PHARMACY' ||
    ctx.organization.id !== scope.organizationId ||
    ctx.session!.user.organizationId !== scope.organizationId ||
    !hasModule(ctx.entitlements, 'pharmacy-counter')
  )
    throw new TRPCError({ code: 'FORBIDDEN' });
  const subject = subjectFromSession(ctx.session!.user);
  const hasCounterAccess = await can(subject, 'pharmacy:counter', undefined, {
    db: ctx.db,
    source: 'TRPC',
  });
  const financialReadAccess =
    !hasCounterAccess &&
    access === 'read' &&
    (await can(subject, 'reports:financial', undefined, {
      db: ctx.db,
      source: 'TRPC',
    }));
  if (!hasCounterAccess && !financialReadAccess)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message:
        access === 'write'
          ? 'Pharmacy counter permission required.'
          : 'Pharmacy counter or financial reports permission required.',
    });
  // Finance reads and counter money operations share the active member/branch boundary.
  return requireCounterReceiptAccess(ctx, branch, false, (rules) => {
    const decision = counterCapabilityDecision(rules, KHATA_CAPABILITIES);
    return decision === 'ALLOW' || (decision !== 'DENY' && financialReadAccess);
  });
}

async function bindKhataBranch(db: ScopedDb, scope: LedgerScope) {
  await db.$queryRaw(
    Prisma.sql`SELECT set_config('app.current_branch_id', ${scope.branchId}, true)`
  );
}

function ledgerTender(input: z.infer<typeof tenderInput>) {
  return { ...input, type: input.type === 'KHATA' ? ('CREDIT' as const) : input.type };
}

function fail(error: unknown): never {
  if (error instanceof BranchOperationDeniedError)
    throw new TRPCError({ code: 'FORBIDDEN', message: error.reason });
  if (error instanceof PharmacyRxSaleDenied)
    throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
  if (error instanceof PharmacyRxReferenceError)
    throw new TRPCError({
      code: error.reason === 'PRESCRIPTION_NEEDS_PHARMACIST' ? 'FORBIDDEN' : 'BAD_REQUEST',
      message: error.message,
    });
  if (error instanceof ControlledRestorationDenied)
    throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
  if (error instanceof CounterApprovalDenied)
    throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
  if (error instanceof PharmacyPaymentSandboxError)
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  if (error instanceof FamilyKhataError)
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.reason });
  if (error instanceof PharmacyBookkeepingError)
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.reason });
  // #633: the transaction rolled back, so the counter may treat this as a refused payment.
  if (error instanceof PharmacySaleBatchError)
    throw new TRPCError({ code: 'FORBIDDEN', message: error.reason });
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
          : error.reason === 'LOYALTY_CONSENT_REQUIRED' || error.reason === 'SALE_NOT_LINKED'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST',
      message: error.reason,
    });
  }
  if (error instanceof PharmacySettlementError) {
    // A drawer that is already open is a state conflict, not a malformed request.
    throw new TRPCError({
      code: error.reason === 'OPEN_DRAWER' ? 'CONFLICT' : 'BAD_REQUEST',
      message: error.reason,
    });
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
  if (error instanceof Error && (error.message === 'BALANCE' || error.message === 'STOCK')) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The controlled register balance does not match the stock on hand.',
    });
  }
  if (error instanceof Error && error.message === 'CONFLICT') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'That register serial is already on this branch.',
    });
  }
  throw error;
}

async function loadCounterReceipt(
  ctx: Omit<TRPCContext, 'db'> & { db: ScopedDb },
  scope: LedgerScope,
  saleId: string
) {
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

// DEV-295: accept canonical colon-delimited grants beside legacy dotted grants so migrated
// Cashier roles and un-migrated roles pass the same counter/receipt gate.
const RECEIPT_READ_CAPABILITIES = [
  'pharmacy:dispense',
  'pharmacy.dispense',
  'pharmacy:receipt',
  'pharmacy.receipt',
  'pharmacy:counter',
  'pharmacy.counter',
] as const;
// Clinical restrictions do not revoke independently granted Khata access.
const KHATA_CAPABILITIES = RECEIPT_READ_CAPABILITIES.filter(
  (action) => action !== 'pharmacy:dispense' && action !== 'pharmacy.dispense'
);

function capabilityCovers(rule: string, action: string): boolean {
  // Dispensing is regulated: only its canonical, exact ALLOW can grant it. The
  // central matcher still lets wildcard DENYs revoke that exact grant.
  if (action === 'pharmacy:dispense') return capabilityMatches(rule, action, 'ALLOW');
  if (rule === '*' || rule === action) return true;
  if (rule.endsWith(':*') || rule.endsWith('.*')) return action.startsWith(rule.slice(0, -1));
  return false;
}

function counterCapabilityDecision(
  rules: { capability: string; effect: string }[],
  capabilities: readonly string[] = RECEIPT_READ_CAPABILITIES
): 'ALLOW' | 'DENY' | null {
  const matched = rules.filter((rule) =>
    capabilities.some((action) =>
      action === 'pharmacy:dispense' && rule.effect === 'DENY'
        ? capabilityMatches(rule.capability, action, 'DENY')
        : capabilityCovers(rule.capability, action)
    )
  );
  if (matched.some((rule) => rule.effect === 'DENY')) return 'DENY';
  if (matched.some((rule) => rule.effect === 'ALLOW')) return 'ALLOW';
  return null;
}

/**
 * Dispense, receipt, or counter capability, then an active pharmacy branch
 * assignment in the session organization. Restaurant staff profiles are not
 * consulted. An empty assignment denies a non-admin. A session `ADMIN` of this
 * organization may use every active branch, including when they also have an
 * explicit assignment elsewhere. That exception is recorded on the audit.
 */
/** A branch outside the session organization is a scope denial, not a bad request. */
async function branchScopeOrForbidden(ctx: TRPCContext, branch: string): Promise<LedgerScope> {
  try {
    return await scopeFor(ctx, branch);
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'BAD_REQUEST') {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
    }
    throw error;
  }
}

type CounterReceiptGrant = { scope: LedgerScope; assigned: Set<string>; orgAdmin: boolean };

/** `true` is the counter's own canonical action; a named action replaces it. */
type CanonicalGate = boolean | 'pharmacy:counter' | 'pharmacy:manage';

/** Session, capability and active-branch checks shared by every counter receipt path. */
async function counterReceiptGrant(
  ctx: TRPCContext,
  branch: string,
  requireCanonical: CanonicalGate = false,
  authorizeMember?: (rules: { capability: string; effect: string }[]) => boolean
): Promise<CounterReceiptGrant> {
  const scope = await branchScopeOrForbidden(ctx, branch);
  const user = ctx.session!.user;
  if (!user.organizationId || user.organizationId !== scope.organizationId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
  }

  const canonicalAction = requireCanonical === true ? 'pharmacy:counter' : requireCanonical;
  if (
    canonicalAction &&
    !(await can(subjectFromSession(user), canonicalAction, undefined, { db: ctx.db }))
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
  }

  const member = await ctx.db.user.findUnique({
    where: { id: user.id },
    select: {
      status: true,
      organizationId: true,
      organizationRole: {
        select: { permissions: { select: { capability: true, effect: true } } },
      },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  if (
    !member ||
    member.organizationId !== scope.organizationId ||
    !member.status ||
    !ACTIVE_STATUSES.has(member.status)
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
  }

  const overrides = member.permissionOverrides;
  const roleRules = member.organizationRole?.permissions ?? [];
  // Treat the names as one capability family. Otherwise an ALLOW on one alias
  // can accidentally outrun an explicit DENY on another alias.
  // Combine user overrides and role rules into ONE family decision so any
  // explicit DENY (user or role, on any alias) beats any ALLOW.
  const rules = [...overrides, ...roleRules];
  const capable = authorizeMember
    ? authorizeMember(rules)
    : counterCapabilityDecision(rules) === 'ALLOW';
  if (!capable) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
  }

  const available = await ctx.db.pharmacyBranch.findFirst({
    where: { id: branch, organizationId: scope.organizationId, active: true },
    select: { id: true },
  });
  if (!available) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
  }

  const rows = await ctx.db.pharmacyBranchAssignment.findMany({
    where: {
      organizationId: scope.organizationId,
      userId: user.id,
      active: true,
      branch: { organizationId: scope.organizationId, active: true },
    },
    select: { branchId: true },
  });
  const assigned = new Set(rows.map((row) => row.branchId));
  // Session role only. An organization-role key is not an administrator grant.
  // An assigned admin still reaches every other active branch of this organization.
  const orgAdmin = user.role === 'ADMIN' && user.organizationId === scope.organizationId;
  return { scope, assigned, orgAdmin };
}

function annotateOrgAdminReceiptAccess(ctx: TRPCContext, branch: string, assigned: Set<string>) {
  annotateAudit(ctx, {
    targetType: 'PharmacyBranch',
    targetId: branch,
    metadata: {
      branchId: branch,
      reason:
        assigned.size === 0
          ? 'org-admin-receipt-access-without-branch-assignment'
          : 'org-admin-receipt-access',
    },
  });
}

async function requireCounterReceiptAccess(
  ctx: TRPCContext,
  branch: string,
  requireCanonical: CanonicalGate = false,
  authorizeMember?: (rules: { capability: string; effect: string }[]) => boolean
): Promise<LedgerScope> {
  const { scope, assigned, orgAdmin } = await counterReceiptGrant(
    ctx,
    branch,
    requireCanonical,
    authorizeMember
  );
  if (assigned.has(branch)) return scope;
  if (orgAdmin) {
    annotateOrgAdminReceiptAccess(ctx, branch, assigned);
    return scope;
  }
  throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
}

/** Navigation uses the counter's grant and branch rules without recording an access. */
export async function canAccessPharmacyCounter(ctx: TRPCContext): Promise<boolean> {
  const user = ctx.session?.user;
  const organizationId = ctx.entitlements?.organizationId;
  if (
    !user ||
    !organizationId ||
    user.organizationId !== organizationId ||
    !hasModule(ctx.entitlements, 'pharmacy-counter')
  ) {
    return false;
  }

  const branch = await ctx.db.pharmacyBranch.findFirst({
    where: {
      organizationId,
      active: true,
      ...(user.role === 'ADMIN'
        ? {}
        : { branchAssignments: { some: { organizationId, userId: user.id, active: true } } }),
    },
    select: { id: true },
  });
  if (!branch) return false;
  try {
    const { assigned, orgAdmin } = await counterReceiptGrant(ctx, branch.id);
    return orgAdmin || assigned.has(branch.id);
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'FORBIDDEN') return false;
    throw error;
  }
}

const closeDate = z
  .date()
  .refine(
    (date) =>
      date.getUTCHours() === 0 &&
      date.getUTCMinutes() === 0 &&
      date.getUTCSeconds() === 0 &&
      date.getUTCMilliseconds() === 0,
    'Choose a date without a time.'
  );
const MANAGER_CAPABILITIES = ['pharmacy:manage', 'pharmacy.manage'] as const;

/**
 * DEV-31: taking cash out of or into a drawer, closing it with a count, and
 * declaring an opening float are manager or owner actions. The canonical
 * `pharmacy:manage` grant (the Manager, Owner and Owner / Operator templates;
 * a solo owner holds it through `pharmacy:*`) is checked through `can()`, then
 * as one deny-wins decision with the counter family, so an explicit counter
 * DENY still binds a manager. The branch rules are the counter's: an active
 * assignment, or the audited organization-administrator exception. A cashier
 * holding only `pharmacy:counter` is refused before any lock or write.
 */
function requireDrawerManagerAccess(ctx: TRPCContext, branch: string): Promise<LedgerScope> {
  return requireCounterReceiptAccess(
    ctx,
    branch,
    'pharmacy:manage',
    (rules) =>
      counterCapabilityDecision(rules, MANAGER_CAPABILITIES) === 'ALLOW' &&
      counterCapabilityDecision(rules) !== 'DENY'
  );
}

/**
 * The day-close decision shared by the close procedures and the pharmacy rail.
 * With `branch`, it is the procedures' gate for that branch. Without one, it
 * answers whether the member may close at some branch, so the rail and the
 * day-close console (DEV-127) never hide a close the procedures would allow.
 */
async function closeAccessDecision(ctx: TRPCContext, branch?: string): Promise<boolean> {
  const user = ctx.session?.user;
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  const subject = subjectFromSession(user);
  const options = { db: ctx.db, source: 'TRPC' as const };
  if (await can(subject, 'pharmacy:close', undefined, options)) return true;
  // DEV-31: a manager may close the day too, but only on a branch they are
  // actively assigned to. An explicit `pharmacy:close` DENY, from the role or a
  // user override, still wins over the manager grant.
  const organizationId = ctx.entitlements?.organizationId;
  if (organizationId && (await can(subject, 'pharmacy:manage', undefined, options))) {
    const member = await ctx.db.user.findUnique({
      where: { id: user.id },
      select: {
        status: true,
        organizationId: true,
        organizationRole: {
          select: { permissions: { select: { capability: true, effect: true } } },
        },
        permissionOverrides: {
          where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          select: { capability: true, effect: true },
        },
      },
    });
    const rules = [
      ...(member?.permissionOverrides ?? []),
      ...(member?.organizationRole?.permissions ?? []),
    ];
    const closeDenied = rules.some(
      (rule) =>
        rule.effect === 'DENY' && capabilityMatches(rule.capability, 'pharmacy:close', 'DENY')
    );
    // The stored member must still be active in this organization: a session
    // claim can outlive a suspension until it is revalidated.
    const activeMember =
      member?.organizationId === organizationId &&
      !!member.status &&
      ACTIVE_STATUSES.has(member.status);
    const assignment =
      closeDenied || !activeMember
        ? null
        : await ctx.db.pharmacyBranchAssignment.findFirst({
            where: {
              organizationId,
              userId: user.id,
              ...(branch === undefined ? {} : { branchId: branch }),
              active: true,
              branch: { organizationId, active: true },
            },
            select: { branchId: true },
          });
    if (member && assignment) return true;
  }
  return false;
}

/** Whether the signed-in member may close the day at some branch (rail and console). */
export function canClosePharmacyDay(ctx: TRPCContext): Promise<boolean> {
  return closeAccessDecision(ctx);
}

async function requireCloseAccess(ctx: TRPCContext, branch: string) {
  if (!(await closeAccessDecision(ctx, branch)))
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Day-close permission is required to reconcile and close a day.',
    });
}

export const pharmacySalesRouter = router({
  manualPaymentSettings: protectedProcedure
    .input(z.object({ branchId }))
    .query(async ({ ctx, input }) => {
      const scope =
        ctx.session!.user.role === 'ADMIN'
          ? await branchScopeOrForbidden(ctx, input.branchId)
          : await requireCounterReceiptAccess(ctx, input.branchId, true);
      return readManualPaymentSettings(ctx.db, scope);
    }),
  saveManualPaymentSettings: adminProcedure
    .input(
      z
        .object({
          branchId,
          revision: z.number().int().nonnegative(),
          settings: manualPaymentSettingsSchema,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      // QR and payer destinations must not be copied into request audit payloads.
      annotateAudit(ctx, {
        skipInput: true,
        targetType: 'PharmacyBranch',
        targetId: input.branchId,
        metadata: {
          revision: input.revision,
          manualMerchantPolicies: manualMerchantPolicies(input.settings),
        },
      });
      const scope = await branchScopeOrForbidden(ctx, input.branchId);
      return ctx.db.$transaction((tx) => saveManualPaymentSettings(txDb(tx), scope, input));
    }),
  sandboxPayment: adminProcedure.input(sandboxPaymentInput).mutation(async ({ ctx, input }) => {
    annotateAudit(ctx, { skipInput: true });
    try {
      return await ctx.db.$transaction(async (tx) =>
        executeSandboxPayment(txDb(tx), await scopeFor(ctx, input.branchId), input)
      );
    } catch (error) {
      fail(error);
    }
  }),
  customerDirectory: adminProcedure
    .input(z.object({ branchId, query: z.string().trim().max(100).default('') }).strict())
    .query(async ({ ctx, input }) => {
      if (!hasModule(ctx.entitlements, 'pharmacy-crm')) throw new TRPCError({ code: 'FORBIDDEN' });
      const scope = await scopeFor(ctx, input.branchId);
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
    .query(async ({ ctx, input }) => {
      if (!hasModule(ctx.entitlements, 'pharmacy-core')) throw new TRPCError({ code: 'FORBIDDEN' });
      return readCounterEvidence(ctx.db, await scopeFor(ctx, input.branchId), input.saleId);
    }),
  dailyCloseEvidence: adminProcedure
    .input(z.object({ branchId, closeId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      if (!hasModule(ctx.entitlements, 'pharmacy-core')) throw new TRPCError({ code: 'FORBIDDEN' });
      return readDailyCloseEvidence(ctx.db, await scopeFor(ctx, input.branchId), input.closeId);
    }),
  khataAccounts: protectedProcedure
    .input(z.object({ branchId, saleId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await khataScope(ctx, input.branchId, 'read');
      return ctx.db.$transaction(async (tx) => {
        const db = txDb(tx);
        await bindKhataBranch(db, scope);
        return readSaleKhataAccounts(db, scope, input.saleId);
      });
    }),
  khataStatement: protectedProcedure
    .input(
      z.object({ branchId, saleId: z.string().min(1), familyAccountId: z.string().min(1) }).strict()
    )
    .query(async ({ ctx, input }) => {
      try {
        const scope = await khataScope(ctx, input.branchId, 'read');
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          await bindKhataBranch(db, scope);
          return readSaleKhataStatement(db, scope, input.saleId, input.familyAccountId);
        });
      } catch (error) {
        fail(error);
      }
    }),
  // K4 (DEV-731): the counter's khata repayment picker. Not tied to a sale: the
  // customer walks in to pay down the account, so any active account of the branch.
  khataPaymentAccounts: protectedProcedure
    .input(z.object({ branchId, query: z.string().trim().max(100).default('') }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await khataScope(ctx, input.branchId, 'read');
      return ctx.db.$transaction(async (tx) => {
        const db = txDb(tx);
        await bindKhataBranch(db, scope);
        return searchKhataRepaymentAccounts(db, scope, input.query);
      });
    }),
  // K4 (DEV-731): receive a khata repayment at the counter. Counter (write) access only;
  // cash is paid into this device's open drawer, and a retried key returns the same slip.
  recordKhataPayment: protectedProcedure
    .input(
      z
        .object({
          branchId,
          familyAccountId: z.string().trim().min(1).max(128),
          amountMinor: z.number().int().positive().max(2147483647),
          tender: z.enum(KHATA_REPAYMENT_TENDERS),
          deviceId: z.string().min(1).optional(),
          payerReference: z.string().trim().min(4).max(40).optional(),
          businessDate: z.date(),
          idempotencyKey: z.string().trim().min(1).max(160),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const scope = await khataScope(ctx, input.branchId, 'write');
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          await bindKhataBranch(db, scope);
          // DEV-630: money taken now books on today, never a client-chosen day.
          await requireCurrentPharmacyBusinessDate(db, scope, input.businessDate);
          return recordKhataRepayment(db, scope, input);
        });
      } catch (error) {
        fail(error);
      }
    }),
  // DEV-716: inline Khata signup from the Khata tender. Counter write access only;
  // the new account always starts at a 0 limit (raising it needs the owner gate).
  khataSignup: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1),
          patientId: z.string().min(1).max(128).optional(),
          displayName: z.string().trim().min(1).max(200),
          phone: z
            .string()
            .trim()
            .regex(/^\+?[\d\s-]{7,20}$/)
            .optional(),
          consentGranted: z.literal(true),
        })
        .strict()
        .refine((value) => value.patientId !== undefined || value.phone !== undefined, {
          message: 'Phone is required for a new patient.',
          path: ['phone'],
        })
    )
    .mutation(async ({ ctx, input }) => {
      // Patient name and phone are personal data; keep them out of the audit input copy.
      annotateAudit(ctx, { skipInput: true });
      try {
        const scope = await khataScope(ctx, input.branchId, 'write');
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          await bindKhataBranch(db, scope);
          return signUpSaleKhata(db, scope, input);
        });
      } catch (error) {
        fail(error);
      }
    }),
  // The close family raises the same typed `PharmacySettlementError`s as the
  // drawer family (OPEN_DRAWER, REOPEN_REASON_REQUIRED, DRAWER_NOT_OPEN, ...), so
  // it answers through `fail` too: a typed refusal, never a 500 carrying the reason.
  closePreview: protectedProcedure
    .input(z.object({ branchId, businessDate: closeDate }).strict())
    .query(async ({ ctx, input }) => {
      await requireCloseAccess(ctx, input.branchId);
      try {
        return await ctx.db.$transaction(async (tx) =>
          readPharmacyClose(txDb(tx), await scopeFor(ctx, input.branchId), input.businessDate)
        );
      } catch (error) {
        fail(error);
      }
    }),
  closeDay: protectedProcedure
    .input(
      z
        .object({
          branchId,
          businessDate: closeDate,
          sourceHash: z.string().length(64),
          counts: z
            .array(
              z
                .object({
                  drawerSessionId: z.string().min(1),
                  countedCashMinor: z.number().int().min(0).max(2147483647),
                })
                .strict()
            )
            .max(500),
          varianceNote: z.string().trim().max(1000),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await requireCloseAccess(ctx, input.branchId);
      try {
        return await ctx.db.$transaction(async (tx) =>
          closePharmacyDay(txDb(tx), await scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  // #728: the owner's read-only cash-close anomaly check (close variance, refunds,
  // voids) with its narrative. Owner-only like the anomaly signals it sits beside;
  // a query that takes no day lock and writes nothing, so a flag never blocks or
  // alters the close itself. Licensed by `pharmacy-counter` with this router (it is
  // a panel on the close screen); the Ask Fathom tool is licensed by
  // `pharmacy-reports` like the other report tools — see `cashCloseCheckTool`.
  closeAnomalyCheck: adminProcedure
    .input(z.object({ branchId, businessDate: closeDate }).strict())
    .query(async ({ ctx, input }) => {
      // `adminProcedure` only checks the grantable `admin:access` capability; this
      // check is owner-only, so a delegated EMPLOYEE is refused before any read.
      if (ctx.session?.user.role !== 'ADMIN')
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Owner access required.' });
      // Refund/void analytics and staff findings are financial reporting: an owner
      // explicitly denied `reports:financial` is refused before any evidence read,
      // as the anomaly report and the Ask Fathom tool already do.
      if (
        !(await can(subjectFromSession(ctx.session!.user), 'reports:financial', undefined, {
          db: ctx.db,
          source: 'TRPC',
        }))
      )
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Financial reports permission required.',
        });
      try {
        const scope = await scopeFor(ctx, input.branchId);
        return await ctx.db.$transaction(async (tx) =>
          readPharmacyCashCloseCheck(txDb(tx), scope, input.businessDate)
        );
      } catch (error) {
        fail(error);
      }
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
          await scopeFor(ctx, input.branchId),
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
        return await ctx.db.$transaction(async (tx) =>
          linkCustomerToSale(txDb(tx), await scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  // Loyalty redemption can complete any sale, including an all-OTC sale, so it
  // always requires the exact dispense capability before entering the domain.
  redeemPoints: capabilityProcedure('pharmacy:dispense')
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
        const scope = await scopeFor(ctx, input.branchId);
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          // DEV-630: a points tender settles the sale, so it books on today too.
          await requireCurrentPharmacyBusinessDate(db, scope, input.businessDate);
          return redeemSalePoints(db, scope, input);
        });
      } catch (error) {
        fail(error);
      }
    }),
  /** The OPEN drawer for this counter device, so the counter never offers a second open. */
  drawerStatus: protectedProcedure
    .input(z.object({ branchId, deviceId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => ({
      openDrawer: await readOpenPharmacyDrawer(
        ctx.db,
        await scopeFor(ctx, input.branchId),
        input.deviceId
      ),
    })),
  // The drawer family raises typed `PharmacySettlementError`s (OPEN_DRAWER,
  // DRAWER_NOT_OPEN, DAY_CLOSED, INVALID_AMOUNT); `fail` turns them into typed
  // tRPC errors the counter can word, instead of a 500 with the raw reason.
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
    .mutation(async ({ ctx, input }) => {
      try {
        // DEV-279: drawers hold cash, so they take the cash-tender gate before any
        // lock or write: canonical `pharmacy:counter` through `can()`, then the
        // counter family check, then an active branch assignment. Both checks are
        // deny-wins: a role DENY or user DENY beats any ALLOW (DEV-659).
        // DEV-31: a cashier opens an empty drawer; declaring a float is a manager's.
        const scope =
          input.openingFloatMinor > 0
            ? await requireDrawerManagerAccess(ctx, input.branchId)
            : await requireCounterReceiptAccess(ctx, input.branchId, true);
        // DEV-630: a drawer opens on the branch's current business day only.
        return await ctx.db.$transaction(async (tx) =>
          openPharmacyDrawer(txDb(tx), scope, input, { requireCurrentBusinessDate: true })
        );
      } catch (error) {
        fail(error);
      }
    }),
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
    .mutation(async ({ ctx, input }) => {
      try {
        const scope = await requireDrawerManagerAccess(ctx, input.branchId);
        return await ctx.db.$transaction(async (tx) =>
          recordPharmacyCashMovement(txDb(tx), scope, input)
        );
      } catch (error) {
        fail(error);
      }
    }),
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
    .mutation(async ({ ctx, input }) => {
      try {
        const scope = await requireDrawerManagerAccess(ctx, input.branchId);
        return await ctx.db.$transaction(async (tx) => closePharmacyDrawer(txDb(tx), scope, input));
      } catch (error) {
        fail(error);
      }
    }),
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
    .mutation(async ({ ctx, input }) => {
      await requireCloseAccess(ctx, input.branchId);
      try {
        return await ctx.db.$transaction(async (tx) =>
          cutPharmacyDailyClose(txDb(tx), await scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  tenderOutcome: protectedProcedure.input(tenderInput).query(async ({ ctx, input }) => {
    if (isManualTender(input.type) || input.approvalCode !== undefined)
      annotateAudit(ctx, { skipInput: true });
    const scope =
      input.type === 'KHATA' || input.type === 'CREDIT' || input.familyAccountId
        ? await khataScope(ctx, input.branchId, 'read')
        : // DEV-713: a card outcome needs the same counter access as the card write.
          isManualTender(input.type) || input.type === 'CARD'
          ? await requireCounterReceiptAccess(ctx, input.branchId, true)
          : await scopeFor(ctx, input.branchId);
    return readPharmacyTenderOutcome(ctx.db, scope, ledgerTender(input));
  }),
  tender: protectedProcedure.input(tenderInput).mutation(async ({ ctx, input }) => {
    if (isManualTender(input.type) || input.approvalCode !== undefined)
      annotateAudit(ctx, { skipInput: true });
    try {
      if (input.type !== 'KHATA' && input.type !== 'CREDIT') {
        if (input.familyAccountId !== undefined || input.ownerOverride !== undefined)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Khata fields require Khata tender.',
          });
        const scope = await requireCounterReceiptAccess(ctx, input.branchId, true);
        // applyPharmacyTender enforces the persisted regulatory gate in this transaction.
        // DEV-630: a new counter payment books on today; a recorded retry still replays.
        return await ctx.db.$transaction((tx) =>
          applyPharmacyTender(txDb(tx), scope, ledgerTender(input), undefined, {
            requireCurrentBusinessDate: true,
          })
        );
      }
      const scope = await khataScope(ctx, input.branchId, 'write');
      if (!input.familyAccountId) throw new FamilyKhataError('ACCOUNT_NOT_FOUND');
      const normalized = ledgerTender(input);
      const ownerAuthorized =
        input.ownerOverride === true &&
        ctx.session!.user.role === 'ADMIN' &&
        (await can(subjectFromSession(ctx.session!.user), 'admin:access', undefined, {
          db: ctx.db,
          source: 'TRPC',
        }));
      return await ctx.db.$transaction(async (tx) => {
        const db = txDb(tx);
        // Fail before any Khata limit work; applyPharmacyTender re-checks under the same locks.
        await assertStoredPharmacyMayOperate(db, scope.organizationId, scope.branchId, {
          name: 'pharmacy.sale.tender',
        });
        await bindKhataBranch(db, scope);
        await db.$queryRaw(
          Prisma.sql`SELECT id FROM pharmacy_sales WHERE id=${input.saleId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`
        );
        const prior = await readPharmacyTenderOutcome(db, scope, normalized);
        if (prior.status === 'ACCEPTED') return { ...prior.result, replayed: true };
        const account = await authorizeKhataCharge(
          db,
          scope,
          { ...input, familyAccountId: input.familyAccountId! },
          {
            authorized: ownerAuthorized,
            passwordAuthenticatedAt: ctx.session!.user.passwordAuthenticatedAt,
          }
        );
        const result = await applyPharmacyTender(db, scope, normalized, undefined, {
          requireCurrentBusinessDate: true,
        });
        if (!('tenderId' in result) || typeof result.tenderId !== 'string')
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
        await db.pharmacyKhataEvent.create({
          data: {
            id: `khata:${result.tenderId}`,
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            familyAccountId: input.familyAccountId!,
            kind: 'CHARGE',
            memberId: account.memberId,
            dueAt: input.businessDate,
            amountMinor: input.amountMinor,
            actorId: scope.actorId,
            note: `Tender ${result.tenderId}`,
          },
        });
        return result;
      });
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
          // Compatibility field: settled sales are always capped by returned value (F13);
          // true additionally caps a refund on a sale that is not settled.
          requireReturnedValue: z.boolean().optional(),
          idempotencyKey: z.string().trim().min(1).max(160),
          // DEV-647: the signed-in manager's or owner's own PIN, re-entered for every refund.
          managerPin: z.string().regex(/^\d{4,8}$/),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        let receiptAccess = false;
        const scope = await requireCounterReceiptAccess(ctx, input.branchId, false, (rules) => {
          receiptAccess = counterCapabilityDecision(rules) === 'ALLOW';
          // The stored tender selects the permission boundary after member/branch checks.
          return receiptAccess || counterCapabilityDecision(rules, KHATA_CAPABILITIES) === 'ALLOW';
        });
        // DEV-647: cashiers cannot start refunds; a manager or owner re-enters their PIN.
        if (!(await actorMayRefund(ctx.db, ctx.session!.user)))
          throw new TRPCError({ code: 'FORBIDDEN', message: REFUND_FORBIDDEN });
        // The PIN never reaches the refund's idempotency payload hash.
        const { managerPin, ...refund } = input;
        // An independent transaction, so a refused PIN commits its lockout strike.
        const pin = await authenticateRefundPin({
          organizationId: scope.organizationId,
          actorId: scope.actorId,
          pin: managerPin,
          action: 'pharmacySales.refundTender',
        });
        annotateAudit(ctx, {
          metadata: {
            policy: REFUND_PIN_POLICY,
            approverId: scope.actorId,
            pinVerified: 'verified' in pin,
          },
        });
        if ('blocked' in pin) return pin;
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          const tender = await db.pharmacyTender.findFirst({
            where: {
              id: input.originalTenderId,
              organizationId: scope.organizationId,
              branchId: scope.branchId,
            },
            select: { type: true },
          });
          if (tender?.type !== 'CREDIT') {
            if (!receiptAccess)
              throw new TRPCError({
                code: 'FORBIDDEN',
                message: 'You do not have permission for this action.',
              });
            return refundPharmacyTender(db, scope, refund, { requireCurrentBusinessDate: true });
          }
          await khataScope(ctx, input.branchId, 'write');
          await bindKhataBranch(db, scope);
          const charge = await db.pharmacyKhataEvent.findFirst({
            where: {
              id: `khata:${input.originalTenderId}`,
              organizationId: scope.organizationId,
              branchId: scope.branchId,
            },
          });
          if (charge) {
            await db.$queryRaw(
              Prisma.sql`SELECT id FROM pharmacy_family_accounts WHERE id=${charge.familyAccountId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`
            );
          }
          const result = await refundPharmacyTender(db, scope, refund, {
            requireCurrentBusinessDate: true,
          });
          if (charge && 'refundId' in result && typeof result.refundId === 'string') {
            const id = `khata-refund:${result.refundId}`;
            const prior = await db.pharmacyKhataEvent.findFirst({
              where: { id, organizationId: scope.organizationId, branchId: scope.branchId },
            });
            if (!prior)
              await db.pharmacyKhataEvent.create({
                data: {
                  id,
                  organizationId: scope.organizationId,
                  branchId: scope.branchId,
                  familyAccountId: charge.familyAccountId,
                  kind: 'PAYMENT',
                  amountMinor: input.amountMinor,
                  settlesChargeId: charge.id,
                  actorId: scope.actorId,
                  note: `Refund ${result.refundId}`,
                },
              });
          }
          return result;
        });
      } catch (error) {
        fail(error);
      }
    }),
  create: protectedProcedure
    .input(
      z
        .object({
          branchId,
          quotation: z.boolean().default(false),
          // DEV-725: the counter device whose drawer will take this bill's cash.
          deviceId: z.string().min(1).optional(),
        })
        .strict()
        .refine((value) => value.quotation || value.deviceId !== undefined, {
          message: 'A counter bill needs the counter device.',
          path: ['deviceId'],
        })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        // DEV-607: the same member, capability and branch-assignment gate as
        // `counterCart`, so nobody opens a bill they cannot then read or pay.
        const scope = await requireCounterReceiptAccess(ctx, input.branchId);
        // createSale enforces the persisted regulatory gate in this transaction.
        // DEV-725: opening the drawer is the first step of the shift. A counter
        // bill is never started on a device with no OPEN drawer, so the cashier
        // cannot build a bill they are then refused at payment. Checked after the
        // regulatory gate (which keeps its own refusal and audit), before the insert.
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          return createSale(db, scope, input.quotation, async () => {
            if (input.quotation) return;
            if (!input.deviceId) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
            await lockOpenPharmacyDrawer(db, scope, input.deviceId);
          });
        });
      } catch (error) {
        fail(error);
      }
    }),
  addLine: protectedProcedure
    .input(
      z
        .object({
          controlledAuthorization: z
            .object({
              prescriptionLineId: z.string().min(1).optional(),
              patientId: z.string().min(1),
              patientAddress: z.string().trim().min(3).max(300),
              staffProfileId: z.string().min(1),
              pin: z.string().regex(/^\d{4,8}$/),
              rxSerialWritten: z.boolean(),
              emergency: z.boolean(),
              prescriberName: z.string().trim().min(1).max(160).optional(),
              prescriberRegNo: z.string().trim().max(80).optional(),
              refSerial: z.number().int().positive().optional(),
            })
            .strict()
            .refine((value) => value.emergency || Boolean(value.prescriptionLineId), {
              message: 'A prescription line is required unless this is an emergency supply.',
              path: ['prescriptionLineId'],
            })
            .refine((value) => !value.emergency || Boolean(value.prescriberName), {
              message: 'An emergency supply needs the prescriber name.',
              path: ['prescriberName'],
            })
            .optional(),
          // #518: the prescription a pharmacist dispenses a non-controlled line against. It must
          // resolve to a real, current prescription line for this patient and medicine.
          prescription: z
            .object({
              prescriptionLineId: z.string().trim().min(1).max(128),
              patientId: z.string().trim().min(1).max(128),
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
          // #520: the approver is proven by a PIN the server verifies, never named by the caller.
          discountApproval: counterApprovalPin.optional(),
          override: z
            .object({
              inventoryLotId: z.string().min(1),
              reason: z.string().trim().min(1).max(500),
              approval: counterApprovalPin.optional(),
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
          },
        });
      }
      try {
        // DEV-607: refused before any stock is allocated, with the gate `counterCart` uses.
        const scope = await requireCounterReceiptAccess(ctx, input.branchId);
        // #520: PINs are verified before the sale transaction takes a connection.
        const { lineInput, approvals } = await approvedLineInput(
          ctx,
          ctx.db as unknown as ScopedDb,
          scope,
          input
        );
        const outcome = await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          for (const { kind, approval } of approvals)
            await confirmCounterApproval(db, scope, kind, approval);
          const medicine = await db.medicine.findFirst({
            where: { id: input.medicineId, organizationId: scope.organizationId },
          });
          if (!medicine?.controlled) {
            // #518: a controlled authorization, and the prescription reference inside it, means
            // nothing on this line, so it is refused instead of being silently ignored.
            if (input.controlledAuthorization)
              throw new PharmacyRxReferenceError('CONTROLLED_AUTHORIZATION_NOT_APPLICABLE');
            // #518: an Rx/restricted line needs the exact dispense grant (DENY wins).
            if (medicine) await assertRxSaleAllowed(db, scope, [medicine]);
            const { prescription } = input;
            if (!prescription) return addSaleLine(db, scope, lineInput);
            // Recording a prescription fill is a pharmacist's act, whatever the medicine.
            if (
              !(await can(subjectFromSession(ctx.session!.user), 'pharmacy:dispense', undefined, {
                db,
              }))
            )
              throw new PharmacyRxReferenceError('PRESCRIPTION_NEEDS_PHARMACIST');
            const units = input.quantity * input.canonicalUnitsPerSaleUnit;
            const reference = await resolvePrescriptionReference(db, scope, {
              ...prescription,
              saleId: input.saleId,
              medicineId: input.medicineId,
              presentationId: input.presentationId,
              units,
            });
            const result = await addSaleLine(db, scope, lineInput);
            await attachPrescriptionReference(db, scope, {
              ...reference,
              saleLineId: result.line.id,
            });
            annotateAudit(ctx, {
              metadata: {
                prescriptionLineId: reference.prescriptionLineId,
                prescriptionSaleLineId: result.line.id,
              },
            });
            return result;
          }
          // #518: a controlled line takes its prescription only through controlledAuthorization.
          if (input.prescription)
            throw new PharmacyRxReferenceError('CONTROLLED_PRESCRIPTION_IN_AUTHORIZATION');
          if (
            !(await can(subjectFromSession(ctx.session!.user), 'pharmacy:dispense', undefined, {
              db,
            }))
          ) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'You do not have permission to dispense a controlled medicine.',
            });
          }
          const authorization = input.controlledAuthorization;
          const blocked = {
            blocked:
              'Controlled medicine requires the patient address, an independent pharmacist PIN, and either a valid prescription or an emergency supply with the prescriber name.',
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
          const refEntry = await earlierRegisterEntry(db, scope, authorization.refSerial);
          if (authorization.refSerial && !refEntry) {
            return { blocked: 'That earlier register serial is not on this branch.' };
          }
          if (authorization.emergency) {
            const patient = await db.pharmacyPatient.findFirst({
              where: { id: authorization.patientId, organizationId: scope.organizationId },
            });
            if (!patient?.cnic?.trim() || !authorization.prescriberName) return blocked;
            const units = input.quantity * input.canonicalUnitsPerSaleUnit;
            const regulatoryProfile = await db.branchRegulatoryProfile.findFirst({
              where: {
                organizationId: scope.organizationId,
                branchId: scope.branchId,
                effectiveFrom: { lte: now },
                OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
              },
              select: {
                provinceCode: true,
                jurisdictionRuleSet: { select: { id: true, controlledRegisterFlags: true } },
              },
              orderBy: { effectiveFrom: 'desc' },
            });
            const policy = resolveEmergencySupplyPolicy(
              regulatoryProfile?.jurisdictionRuleSet ?? null
            );
            annotateAudit(ctx, {
              metadata: {
                emergencySupply: {
                  ruleSetId: policy.ruleSetId,
                  provinceCode: regulatoryProfile?.provinceCode ?? null,
                  source: policy.source,
                  maxUnits: policy.maxUnits,
                  repeatWindowHours: policy.repeatWindowHours,
                  medicineId: medicine.id,
                  requestedCanonicalUnits: units,
                },
              },
            });
            const since = new Date(now.getTime() - policy.repeatWindowMs);
            // The limit is organization-wide, so serialize this patient/medicine eligibility
            // check independently of the branch lock used for stock and register numbering.
            await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope.organizationId + ':controlled-emergency:' + authorization.patientId + ':' + medicine.id},0))`;
            const recentSupplies = await db.pharmacyControlledRegisterEntry.count({
              where: {
                organizationId: scope.organizationId,
                patientId: authorization.patientId,
                medicineId: medicine.id,
                entryKind: 'SALE',
                emergency: true,
                createdAt: { gte: since },
              },
            });
            const openFollowUp = await db.pharmacyEmergencyRxFollowUp.findFirst({
              where: {
                organizationId: scope.organizationId,
                patientId: authorization.patientId,
                medicineId: medicine.id,
                status: 'OPEN',
              },
              select: { id: true },
            });
            const emergencyRefusal = emergencyNoRxDecision({
              units,
              recentSupplies,
              openFollowUp: Boolean(openFollowUp),
              policy,
            });
            if (emergencyRefusal) return { blocked: emergencyRefusal };
            const consent = await db.patientConsent.findFirst({
              where: {
                organizationId: scope.organizationId,
                patientId: authorization.patientId,
                purpose: 'DISPENSING',
              },
              orderBy: { version: 'desc' },
            });
            if (!consent?.granted || consent.revokedAt) {
              return { blocked: 'Patient dispensing consent is required.' };
            }
            await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope.organizationId + ':' + scope.branchId},0))`;
            const result = await addSaleLine(db, scope, lineInput);
            await appendControlledSaleEntries(db, {
              organizationId: scope.organizationId,
              branchId: scope.branchId,
              movementIds: result.allocation.movementIds,
              patientId: authorization.patientId,
              patientAddress: authorization.patientAddress,
              medicineId: medicine.id,
              manufacturer: medicine.manufacturer,
              prescriberId: null,
              prescriberName: authorization.prescriberName,
              prescriberRegNo: authorization.prescriberRegNo ?? null,
              prescriptionId: null,
              prescriptionLineId: null,
              emergency: true,
              rxSerialWritten: authorization.rxSerialWritten,
              refEntryId: refEntry?.id ?? null,
              recordedByUserId: scope.actorId,
              witnessedByUserId: pharmacist.id,
              signatureRef: `pin:${pharmacist.id}`,
            });
            await db.pharmacyEmergencyRxFollowUp.create({
              data: {
                organizationId: scope.organizationId,
                branchId: scope.branchId,
                patientId: authorization.patientId,
                medicineId: medicine.id,
                saleLineId: result.line.id,
                quantityCanonicalUnits: units,
                recordedByUserId: scope.actorId,
                witnessedByUserId: pharmacist.id,
              },
            });
            return result;
          }
          if (!authorization.prescriptionLineId) return blocked;
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
          const organization = await db.organization.findUnique({
            where: { id: scope.organizationId },
            select: { timezone: true },
          });
          if (
            !rx ||
            rx.prescription.patientId !== authorization.patientId ||
            !rx.prescription.patient.cnic?.trim() ||
            !rx.prescription.prescriber.registrationNumber.trim() ||
            !prescriptionIsCurrent(
              rx.prescription.validFrom,
              rx.prescription.validUntil,
              now,
              workspaceTimezone(organization?.timezone)
            )
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
          const result = await addSaleLine(db, scope, lineInput);
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
          const decision = await db.pharmacyPharmacistReviewDecision.create({
            data: {
              organizationId: scope.organizationId,
              reviewItemId: review.id,
              kind: 'SIGN',
              actorUserId: pharmacist.id,
              signedAt: now,
            },
          });
          await appendControlledSaleEntries(db, {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            movementIds: result.allocation.movementIds,
            patientId: authorization.patientId,
            patientAddress: authorization.patientAddress,
            medicineId: medicine.id,
            manufacturer: medicine.manufacturer,
            prescriberId: rx.prescription.prescriberId,
            prescriberName: rx.prescription.prescriber.name,
            prescriberRegNo: rx.prescription.prescriber.registrationNumber,
            prescriptionId: rx.prescriptionId,
            prescriptionLineId: rx.id,
            emergency: false,
            rxSerialWritten: authorization.rxSerialWritten,
            refEntryId: refEntry?.id ?? null,
            recordedByUserId: scope.actorId,
            witnessedByUserId: pharmacist.id,
            signatureRef: decision.id,
          });
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
          action: z.enum(['hold', 'resume', 'convertQuotation', 'void']),
          reason: z.string().trim().min(1).optional(),
          controlledWitness: z
            .object({ staffProfileId: z.string().min(1), pin: z.string().regex(/^\d{4,8}$/) })
            .strict()
            .optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) => {
          try {
            return await changeSaleStatus(
              txDb(tx),
              await requireCounterReceiptAccess(ctx, input.branchId),
              input.saleId,
              input.action,
              input.reason,
              input.controlledWitness
            );
          } catch (error) {
            if (error instanceof ControlledRestorationDenied && !error.forbidden)
              return { blocked: error.message };
            throw error;
          }
        });
      } catch (error) {
        fail(error);
      }
    }),
  lookupReceiptByNumber: auditedProtectedProcedure
    .input(z.object({ branchId, receiptNumber: z.number().int().positive() }).strict())
    .query(async ({ ctx, input }) => {
      const { scope, assigned, orgAdmin } = await counterReceiptGrant(ctx, input.branchId);
      // Cashiers search only active, assigned branches. An unassigned active
      // branch has the same response as a missing receipt. Keep the audited
      // session-admin exception for the requested active branch.
      if (!assigned.has(scope.branchId)) {
        if (!orgAdmin) return [];
        annotateOrgAdminReceiptAccess(ctx, scope.branchId, assigned);
      }
      // Receipt sequences are per device/date. Fetch the active branch first so
      // its matches remain first even when another branch has newer receipts.
      const select = {
        id: true,
        branchId: true,
        visibilityAnchor: { select: { name: true } },
        receiptNumber: true,
        receiptDeviceId: true,
        businessDate: true,
      } as const;
      const active = await ctx.db.pharmacySale.findMany({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          receiptNumber: input.receiptNumber,
          status: 'COMPLETED',
        },
        select,
        orderBy: [{ completedAt: 'desc' }, { id: 'asc' }],
        take: 50,
      });
      const otherBranches = [...assigned].filter((id) => id !== scope.branchId);
      if (!otherBranches.length || active.length === 50) return active;
      const others = await ctx.db.pharmacySale.findMany({
        where: {
          organizationId: scope.organizationId,
          branchId: { in: otherBranches },
          receiptNumber: input.receiptNumber,
          status: 'COMPLETED',
        },
        select,
        orderBy: [{ completedAt: 'desc' }, { id: 'asc' }],
        take: 50 - active.length,
      });
      return [...active, ...others];
    }),
  returnHistory: protectedProcedure
    .input(z.object({ branchId, saleId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      try {
        const scope = await requireCounterReceiptAccess(ctx, input.branchId);
        return await readReturnHistory(ctx.db, scope, input.saleId);
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
          controlledWitness: z
            .object({ staffProfileId: z.string().min(1), pin: z.string().regex(/^\d{4,8}$/) })
            .strict()
            .optional(),
          // Omitted legacy/unknown lot is accepted only into unidentified quarantine custody.
          lotId: z.string().min(1).optional(),
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
        const scope = await requireCounterReceiptAccess(ctx, input.branchId);
        return await ctx.db.$transaction(async (tx) => {
          try {
            return await returnSaleLine(txDb(tx), scope, input);
          } catch (error) {
            if (error instanceof ControlledRestorationDenied && !error.forbidden)
              return { blocked: error.message };
            throw error;
          }
        });
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
        return await captureDemand(ctx.db, await scopeFor(ctx, input.branchId), input);
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
        return await findSubstituteProposals(ctx.db, await scopeFor(ctx, input.branchId), input);
      } catch (error) {
        if (error instanceof PharmacySubstituteError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: error.code });
        }
        throw error;
      }
    }),
  /** #745: pharmacist-facing same-salt/strength brand ranking by branch margin. */
  sameSaltMarginRanking: protectedProcedure
    .input(
      z
        .object({
          branchId,
          medicineId: z.string().min(1),
          presentationId: z.string().min(1),
          quantityCanonicalUnits: z.number().int().positive(),
          limit: z.number().int().min(1).max(50).optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const scope = await marginScopeFor(ctx, input.branchId, [
        'pharmacy:dispense',
        'pharmacy:manage',
      ]);
      try {
        return await rankSameSaltBrandsByMargin(ctx.db, scope, input);
      } catch (error) {
        if (error instanceof PharmacySubstituteError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: error.code });
        }
        throw error;
      }
    }),
  /** #745: purchasing view; suggests a higher-margin brand mix within exact equivalents. */
  higherMarginBrandMix: protectedProcedure
    .input(
      z
        .object({
          branchId,
          minUnitMarginGainMinor: z.number().int().nonnegative().optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const scope = await marginScopeFor(ctx, input.branchId, [
        'pharmacy:procurement',
        'pharmacy:dispense',
        'pharmacy:manage',
      ]);
      return suggestHigherMarginBrandMix(ctx.db, scope, {
        minUnitMarginGainMinor: input.minUnitMarginGainMinor,
      });
    }),
  /**
   * #730: rule-based complementary-item suggestions for the bill. Read-only;
   * never suggests Rx-only, controlled, restricted or high-alert items.
   */
  upsellSuggestions: protectedProcedure
    .input(
      z
        .object({
          branchId,
          medicineIds: z.array(z.string().min(1).max(128)).min(1).max(UPSELL_MAX_TRIGGERS),
          limit: z.number().int().min(1).max(20).optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) =>
      findUpsellSuggestions(ctx.db, await scopeFor(ctx, input.branchId), {
        medicineIds: input.medicineIds,
        limit: input.limit,
      })
    ),
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
        const scope = await scopeFor(ctx, input.branchId);
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
  /**
   * #724: the operator read the duplicate-salt warning and chose to continue.
   * Never blocks or mutates the sale; the audit entry IS the acknowledgement,
   * so it carries the recomputed salt and medicines, not client-supplied text.
   */
  acknowledgeDuplicateSalt: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1),
          ingredientKey: z.string().trim().min(1).max(200),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId);
      try {
        const acknowledgement = await verifyDuplicateSaltAcknowledgement(ctx.db, scope, input);
        annotateAudit(ctx, {
          category: 'PHARMACY_SAFETY',
          action: 'duplicate_salt_acknowledged',
          targetType: 'PharmacySale',
          targetId: acknowledgement.saleId,
          description: `Counter acknowledged a duplicate active ingredient (${acknowledgement.ingredientName}) on one bill.`,
          metadata: {
            branchId: acknowledgement.branchId,
            ingredientKey: acknowledgement.ingredientKey,
            ingredientName: acknowledgement.ingredientName,
            medicineIds: acknowledgement.medicines.map((medicine) => medicine.medicineId),
            saleLineIds: acknowledgement.medicines.map((medicine) => medicine.ref),
          },
        });
        // This audit row IS the acknowledgement. The audit middleware awaits
        // writes bound to ctx.db and propagates failures; the HTTP boundary
        // commits this tenant transaction before sending a successful response.
        ctx.audit.db = ctx.db;
        return acknowledgement;
      } catch (error) {
        if (error instanceof DuplicateSaltAcknowledgementError) {
          throw new TRPCError({
            code: error.reason === 'NOT_FOUND' ? 'NOT_FOUND' : 'BAD_REQUEST',
            message: error.reason,
          });
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
          await scopeFor(ctx, input.branchId),
          input.demandId,
          input.saleLineId
        );
      } catch (error) {
        fail(error);
      }
    }),
  demandAggregate: protectedProcedure
    .input(z.object({ branchId, from: z.date(), to: z.date() }).strict())
    .query(async ({ ctx, input }) =>
      demandAggregate(ctx.db, await scopeFor(ctx, input.branchId), input.from, input.to)
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
        return await ctx.db.$transaction(async (tx) =>
          addRestockInterest(txDb(tx), await scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  captureSafeRestockArrival: protectedProcedure
    .input(z.object({ branchId, inventoryLotId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) =>
          captureSafeRestockArrival(txDb(tx), await scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  optOutRestockInterest: protectedProcedure
    .input(z.object({ branchId, interestId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) =>
          optOutRestockInterest(txDb(tx), await scopeFor(ctx, input.branchId), input.interestId)
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
        return await ctx.db.$transaction(async (tx) =>
          recoverRestockInterest(txDb(tx), await scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  restockRecoveryReport: protectedProcedure
    .input(
      z.object({ branchId, campaignKey: z.string().trim().min(1).max(160).optional() }).strict()
    )
    .query(async ({ ctx, input }) =>
      restockRecoveryReport(ctx.db, await scopeFor(ctx, input.branchId), input.campaignKey)
    ),

  // ── PH-POS counter reads (POS-01, POS-02, POS-08) ─────────────────────────

  /** DEV-647: whether the counter offers refunds. refundTender enforces the same rule. */
  refundAccess: protectedProcedure.query(async ({ ctx }) => ({
    authorized: await actorMayRefund(ctx.db, ctx.session.user),
  })),

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
        select: { currency: true, timezone: true },
      }),
    ]);
    return {
      branches,
      currency: organization?.currency ?? 'PKR',
      // The workspace's zone: the day close picks "today" in it before any
      // close has been read. A stored value Intl refuses is handed over as UTC.
      timezone: workspaceTimezone(organization?.timezone),
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
        return await searchCounterCatalog(ctx.db, await scopeFor(ctx, input.branchId), {
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
      const scope = await scopeFor(ctx, input.branchId);
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
      const scope = await scopeFor(ctx, input.branchId);
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
        const scope = await requireCounterReceiptAccess(ctx, input.branchId);
        return await readCounterCart(ctx.db, scope, input.saleId);
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
  counterReceipt: auditedProtectedProcedure
    .input(z.object({ branchId, saleId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId);
      try {
        const receipt = await loadCounterReceipt(ctx, scope, input.saleId);
        const [dispensingLabelSources, taxIdentity] = await Promise.all([
          readDispensingLabelSources(ctx.db, scope, receipt),
          receipt.completedAt
            ? readPharmacyReceiptTaxIdentity(ctx.db, scope, new Date(receipt.completedAt))
            : Promise.resolve({ ntn: null, strn: null }),
        ]);
        // F8: sourced Rx label payloads come only from this authorized receipt read.
        return {
          ...receipt,
          dispensingLabelSources,
          // Completion-time identity keeps browser, A4, and Urdu copies aligned with ESC/POS.
          taxIdentity,
        };
      } catch (error) {
        fail(error);
      }
    }),

  /**
   * PH-A7: the settled receipt as a validated ESC/POS `RECEIPT` job, using the
   * branch's saved format. Each delivered job atomically claims a durable copy
   * number; only copy one is an original, regardless of caller hints, reloads,
   * retries, or concurrent requests. This never changes the sale's receipt
   * number. Text the raw baseline cannot print returns the browser/OS fallback.
   */
  counterReceiptPrintJob: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1),
          locale: z.enum(['en', 'ur']),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId);
      try {
        return await ctx.db.$transaction(async (tx) => {
          const receipt = await loadCounterReceipt({ ...ctx, db: txDb(tx) }, scope, input.saleId);
          if (receipt.receiptNumber === null || !receipt.completedAt) {
            throw new PharmacyReceiptPrintError('RECEIPT_NOT_ISSUED');
          }
          const [format, taxIdentity] = await Promise.all([
            readPharmacyReceiptFormat(tx, scope),
            readPharmacyReceiptTaxIdentity(tx, scope, new Date(receipt.completedAt)),
          ]);
          // Validate both variants before writing. ScopedDb may reuse an outer
          // transaction, where returning FALLBACK would commit an allocation.
          const options = { layout: format.layout, taxIdentity };
          const originalJob = buildPharmacyReceiptEscPosJob(receipt, input.locale, {
            ...options,
            reprint: false,
          });
          const reprintJob = buildPharmacyReceiptEscPosJob(receipt, input.locale, {
            ...options,
            reprint: true,
          });

          // Issuance after the migration cutover creates an authoritative zero
          // count. Missing state cannot prove original eligibility: start at two.
          // The upsert serializes concurrent requests on the unique sale key.
          const [state] = await tx.$queryRaw<[{ copyCount: number }]>(Prisma.sql`
            INSERT INTO "pharmacy_receipt_print_states"
              ("id", "organizationId", "branchId", "saleId", "copyCount", "updatedAt")
            VALUES
              (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${input.saleId}, 2, NOW())
            ON CONFLICT ("organizationId", "branchId", "saleId") DO UPDATE
              SET "copyCount" = "pharmacy_receipt_print_states"."copyCount" + 1,
                  "updatedAt" = NOW()
            RETURNING "copyCount"
          `);
          if (!state) throw new Error('Receipt print copy allocation failed.');
          const job = state.copyCount > 1 ? reprintJob : originalJob;
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO "pharmacy_receipt_print_dispatches"
              ("id", "organizationId", "branchId", "saleId", "copyNumber", "actorId", "locale")
            VALUES
              (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${input.saleId},
               ${state.copyCount}, ${ctx.session.user.id}, ${input.locale})
          `);
          return { status: 'READY' as const, ...job, copyNumber: state.copyCount };
        });
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

  /** Allocate a browser/OS receipt copy. A separate call records dialog handoff. */
  counterReceiptBrowserPrint: auditedProtectedProcedure
    .input(
      z.object({ branchId, saleId: z.string().min(1).max(128), locale: z.enum(['en', 'ur']) }).strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId);
      try {
        return await ctx.db.$transaction(async (tx) => {
          const receipt = await loadCounterReceipt({ ...ctx, db: txDb(tx) }, scope, input.saleId);
          if (receipt.receiptNumber === null || !receipt.completedAt) {
            throw new PharmacyReceiptPrintError('RECEIPT_NOT_ISSUED');
          }
          const [state] = await tx.$queryRaw<[{ copyCount: number }]>(Prisma.sql`
            INSERT INTO "pharmacy_receipt_print_states"
              ("id", "organizationId", "branchId", "saleId", "copyCount", "updatedAt")
            VALUES
              (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${input.saleId}, 2, NOW())
            ON CONFLICT ("organizationId", "branchId", "saleId") DO UPDATE
              SET "copyCount" = "pharmacy_receipt_print_states"."copyCount" + 1,
                  "updatedAt" = NOW()
            RETURNING "copyCount"
          `);
          if (!state) throw new Error('Receipt print copy allocation failed.');
          // Bind the copy to this operator and locale; only this allocation's
          // owner can later confirm its dialog handoff.
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO "pharmacy_receipt_print_allocations"
              ("id", "organizationId", "branchId", "saleId", "copyNumber", "actorId", "locale")
            VALUES
              (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${input.saleId},
               ${state.copyCount}, ${ctx.session.user.id}, ${input.locale})
          `);
          return { copyNumber: state.copyCount, reprint: state.copyCount > 1 };
        });
      } catch (error) {
        if (error instanceof PharmacyReceiptPrintError) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This bill is not settled, so it has no receipt to print.',
          });
        }
        fail(error);
      }
    }),

  /** Failed browser preflight is durable evidence, without claiming a copy. */
  counterReceiptBrowserPrintFailed: auditedProtectedProcedure
    .input(
      z.object({ branchId, saleId: z.string().min(1).max(128), locale: z.enum(['en', 'ur']) }).strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId);
      try {
        await loadCounterReceipt(ctx, scope, input.saleId);
        // Await this write directly: the general tRPC audit is best-effort.
        await ctx.db.auditLog.create({
          data: {
            organizationId: scope.organizationId,
            actorId: ctx.session.user.id,
            source: 'TRPC',
            category: 'PHARMACY',
            operation: 'EXECUTE',
            action: 'pharmacySales.counterReceiptBrowserPrintFailed',
            targetType: 'PharmacySale',
            targetId: input.saleId,
            outcome: 'FAILURE',
            errorCode: 'BROWSER_PRINT_NOT_READY',
            metadata: { branchId: scope.branchId, locale: input.locale },
          },
        });
        return { recorded: true as const };
      } catch (error) {
        fail(error);
      }
    }),

  /**
   * Append the audit event only after the browser accepted the print-dialog
   * request. The event must match an allocation made by the same operator in
   * the same locale, and repeating a confirmation that is already recorded is
   * an idempotent success so clients can safely retry after a lost response.
   */
  counterReceiptBrowserPrintDispatched: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1).max(128),
          locale: z.enum(['en', 'ur']),
          copyNumber: z.number().int().positive(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId);
      const actorId = ctx.session.user.id;
      try {
        const inserted = await ctx.db.$executeRaw(Prisma.sql`
          INSERT INTO "pharmacy_receipt_print_dispatches"
            ("id", "organizationId", "branchId", "saleId", "copyNumber", "actorId", "locale")
          SELECT ${randomUUID()}, "organizationId", "branchId", "saleId",
                 "copyNumber", "actorId", "locale"
          FROM "pharmacy_receipt_print_allocations"
          WHERE "organizationId" = ${scope.organizationId}
            AND "branchId" = ${scope.branchId}
            AND "saleId" = ${input.saleId}
            AND "copyNumber" = ${input.copyNumber}
            AND "actorId" = ${actorId}
            AND "locale" = ${input.locale}
          ON CONFLICT ("organizationId", "branchId", "saleId", "copyNumber") DO NOTHING
        `);
        if (inserted === 1) return { recorded: true as const };
        // Retry of an already-recorded confirmation by the allocation's owner.
        const [existing] = await ctx.db.$queryRaw<{ recorded: boolean }[]>(Prisma.sql`
          SELECT TRUE AS "recorded"
          FROM "pharmacy_receipt_print_dispatches" d
          JOIN "pharmacy_receipt_print_allocations" a
            ON a."organizationId" = d."organizationId"
           AND a."branchId" = d."branchId"
           AND a."saleId" = d."saleId"
           AND a."copyNumber" = d."copyNumber"
           AND a."actorId" = d."actorId"
           AND a."locale" = d."locale"
          WHERE d."organizationId" = ${scope.organizationId}
            AND d."branchId" = ${scope.branchId}
            AND d."saleId" = ${input.saleId}
            AND d."copyNumber" = ${input.copyNumber}
            AND d."actorId" = ${actorId}
            AND d."locale" = ${input.locale}
          LIMIT 1
        `);
        if (existing?.recorded) return { recorded: true as const };
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This print allocation is invalid or belongs to another operator.',
        });
      } catch (error) {
        fail(error);
      }
    }),

  /** PH-A7: this branch's saved receipt format (shared layout), for the counter. */
  counterReceiptFormat: auditedProtectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) =>
      readPharmacyReceiptFormat(ctx.db, await requireCounterReceiptAccess(ctx, input.branchId))
    ),

  /** PH-A7: save the branch receipt format. Optimistic revision; admins only. */
  counterSaveReceiptFormat: adminProcedure
    .input(SaveReceiptLayoutSchema)
    .mutation(async ({ ctx, input }) => {
      // Active, in-organization branch or FORBIDDEN (scopeFor checks it).
      const scope = await branchScopeOrForbidden(ctx, input.branchId);
      return savePharmacyReceiptFormat(ctx.db, scope.organizationId, input);
    }),

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
      if (!resolved.preset.confirmed && ctx.session.user.role !== 'ADMIN') {
        // Retain the saved proposal for owner review, but never teach it to staff.
        return { ...resolveCounterKeymap({ preset: 'devfathom' }), stored: false };
      }
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
      if (!COUNTER_KEYMAP_PRESETS[input.preset].confirmed && ctx.session.user.role !== 'ADMIN') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'This preset is not available to staff.' });
      }
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
