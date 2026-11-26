import { pharmacyRefundPostingMutation } from '@/server/pharmacy-finance-gate';
import { anyCardTerminalTender } from '@/lib/pharmacy/card-terminal/open-attempts';
import {
  authenticatePrepaidPin,
  prepaidPin,
  PrepaidError,
  PrepaidPinError,
  PREPAID_PIN_REFUSED,
} from '@/lib/pharmacy/prepaid-tiers';
import { ControlledRestorationDenied } from '@/lib/pharmacy/controlled-restoration-authorization';
import { pharmacyPromotionInput, promotionCreatorMayManage } from '@/lib/pharmacy/promotions';
import { counterLabel } from '@/lib/pharmacy/counter-label';
import { HostedReceiptError } from '@/lib/pharmacy/hosted-receipt';
import { sendWhatsAppReceiptLink } from '@/lib/pharmacy/hosted-receipt-service';
import {
  authorizeCounterApproval,
  confirmCounterApproval,
  CounterApprovalDenied,
  counterProofRequired,
  fefoOverrideApprovalPolicy,
  isSoleActiveApprover,
  listCounterApprovers,
  mayApproveCounterLine,
  type CounterApproval,
  type CounterApprovalKind,
} from '@/lib/pharmacy/counter-line-approval';
import { assertRxSaleAllowed, PharmacyRxSaleDenied } from '@/lib/pharmacy/rx-sale-gate';
import { readPharmacistCheckPolicy } from '@/lib/pharmacy/pharmacist-check-policy';
import { pharmacistCheckOffSignature } from '@/lib/pharmacy/pharmacist-check';
import { PharmacyDispensingError } from '@/lib/pharmacy/dispensing';
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
  BANK_TRANSFER_REFERENCE_MAX_LENGTH,
  hasValidTenderProviderReference,
} from '@/lib/pharmacy/manual-payments';
import {
  readManualPaymentSettings,
  saveManualPaymentSettings,
} from '@/lib/pharmacy/manual-payment-settings';
import {
  discountPolicySchema,
  maxDiscountBpsSchema,
  NO_MAXIMUM_DISCOUNT_BPS,
} from '@/lib/pharmacy/smart-discount';
import {
  OWNER_EXPORT_PIN_MAX_INPUT,
  verifyOwnerExportPin,
} from '@/lib/pharmacy/owner-data-export-pin';
import {
  MAX_DISCOUNT_CHANGE_REFUSED,
  readDiscountPolicySettings,
  readDiscountSuggestions,
  readMaxDiscountSettings,
  recordCompetitorPrice,
  saveDiscountPolicy,
  saveMaxDiscountBps,
} from '@/lib/pharmacy/smart-discount-service';
import {
  readKhataReminderSettings,
  saveKhataReminderSettings,
} from '@/lib/pharmacy/khata-reminder-branch-settings';
import { khataReminderSettingsSchema } from '@/lib/pharmacy/khata-reminder-settings';
import {
  executeSandboxPayment,
  sandboxPaymentInput,
  PharmacyPaymentSandboxError,
} from '@/lib/pharmacy/payment-sandbox';
import { paymentSandboxAdmitted } from '@/lib/pharmacy/payment-sandbox-admission';
import { readCounterEvidence, readDailyCloseEvidence } from '@/lib/pharmacy/counter-evidence';
import { can, subjectFromSession } from '@/lib/abac';
import { BRANCH_NOT_ASSIGNED, NO_INDEPENDENT_PHARMACIST } from '@/lib/pharmacy/counter-setup';
import { readPharmacyApprovalStatus } from '@/lib/pharmacy/onboarding';
import { RefusalReason } from '@/server/refusal-reason';
import {
  evaluateCounterSaleReadiness,
  type CounterSaleReadiness,
} from '@/lib/pharmacy/sale-readiness';
import { capabilityMatches } from '@/lib/abac/capabilities';
import {
  actorManagesBranchDrawers,
  CART_WRITE_CAPABILITIES,
  counterCapabilityDecision,
  RECEIPT_READ_CAPABILITIES,
} from '@/lib/pharmacy/counter-capability';
import {
  appendControlledSaleEntries,
  lockRegister,
  earlierRegisterEntry,
  emergencyNoRxDecision,
  resolveEmergencySupplyPolicy,
} from '@/lib/pharmacy/controlled-register';
import { ACTIVE_STATUSES, APPROVAL_AUTHENTICATOR_SETUP_MESSAGE } from '@/lib/auth/session-state';
import { annotateAudit, recordAudit } from '@/server/audit';
import { annotateAuditBranch } from '@/server/audit-branch';
import {
  authenticateVoucherCashierPin,
  counterVoucherInput,
  lookupCounterVoucher,
} from '@/lib/pharmacy/vouchers';
import {
  isLockedOut,
  registerFailedAttempt,
  clearLockout,
} from '@/lib/restaurant/operator-credentials';
import { approvalSecretKindFor, verifyApprovalSecret } from '@/lib/approval-authenticator';
import {
  closePharmacyDay,
  readPharmacyClose,
  reopenPharmacyDayForTrading,
} from '@/lib/pharmacy/day-close';
import { listOpenBills } from '@/lib/pharmacy/open-bills';
import { readPharmacyCashCloseCheck } from '@/lib/pharmacy/cash-close-check-operations';
import { readPharmacyShiftHandover } from '@/lib/pharmacy/shift-handover-operations';
import {
  authorizeCashShiftVariance,
  closePharmacyCashShift,
  openPharmacyCashShift,
  organizationCurrency,
  readPharmacyCashShiftPolicy,
  readPharmacyCashShiftReport,
  readPharmacyDrawerShift,
  shiftVarianceApprovers,
} from '@/lib/pharmacy/cash-shifts';
import { workspaceTimezone } from '@/lib/timezone';
import {
  pharmacyBusinessDate,
  pharmacyBusinessDay,
  withClientPharmacyDayEnd,
} from '@/lib/pharmacy/business-day';
import { readPharmacyDayClock } from '@/lib/pharmacy/business-day-clock';
import {
  PharmacyDayEndHourError,
  pharmacyDayEndHourSchema,
  readPharmacyDayEndHourSetting,
  savePharmacyDayEndHour,
} from '@/lib/pharmacy/business-day-settings';
import { prescriptionIsCurrent } from '@/lib/pharmacy/prescription-calendar';
import { readDispensingLabelSources } from '@/lib/pharmacy/dispensing-label-source';
import { TRPCError } from '@trpc/server';
import { isLiveOrganizationOwner } from '@/lib/pharmacy/owner-data-export';
import { CounterApprovalChoice } from '@/lib/pharmacy/counter-approval-choice';
import { NO_PIN_SET_MESSAGE } from '@/lib/pharmacy/own-pin-policy';
import {
  applyBillDiscount,
  BILL_DISCOUNT_CHANGE_REFUSED,
  readBillDiscountEnabled,
  saveBillDiscountEnabled,
} from '@/lib/pharmacy/bill-discount-service';
import { z } from 'zod';
import { saleVoidReasonSchema, saleVoidReasonText } from '@/lib/pharmacy/sale-void-reasons';
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
import { linkLoyaltyCardToSale } from '@/lib/pharmacy/loyalty-card';
import { PharmacyInventoryError } from '@/lib/pharmacy/inventory';
import { PharmacySaleBatchError } from '@/lib/pharmacy/sale-batch-safety';
import {
  assertStoredPharmacyMayOperate,
  BranchOperationDeniedError,
} from '@/lib/pharmacy/regulatory';
import { regulatoryProfileInForceWhere } from '@/lib/pharmacy/regulatory-start';
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
  changeSaleLine,
  removeSaleLine,
  replaySaleLine,
  addRestockInterest,
  captureSafeRestockArrival,
  saleHasPaymentActivity,
  captureDemand,
  discountBillLine,
  recordCounterDemand,
  changeSaleStatus,
  createSale,
  demandAggregate,
  optOutRestockInterest,
  PharmacySaleError,
  recoverDemandWithAlternate,
  linkRestockRecoveries,
  recoverRestockInterest,
  restockRecoveryReport,
  returnSaleLine,
  returnSaleLines,
  readReturnHistory,
  quoteSaleLineReturn,
  saleReturnValueMinor,
} from '@/lib/pharmacy/sales';
import { PharmacySerializedPackError } from '@/lib/pharmacy/serialized-pack-sale';
import type { LedgerScope } from '@/lib/pharmacy/stock-ledger';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { authenticatePharmacyPack } from '@/lib/pharmacy/pack-authentication-operations';
import {
  applyPharmacyTender,
  closePharmacyDrawer,
  drawerOperatingCashierId,
  handoverPharmacyDrawer,
  cutPharmacyDailyClose,
  lockOpenPharmacyDrawer,
  openPharmacyDrawer,
  pharmacyDayClosedForTrading,
  readOpenPharmacyDrawer,
  requireTodaysPharmacyDrawer,
  requirePharmacyTodayOpenForTrading,
  requireCashShiftForLineChange,
  PharmacySettlementError,
  readPharmacyTenderOutcome,
  discardPharmacyTenderAttempt,
  recordPharmacyCashMovement,
  refundPharmacyTender,
  requireCurrentPharmacyBusinessDate,
} from '@/lib/pharmacy/settlement';
import {
  actorMayRefund,
  authenticateRefundPin,
  REFUND_FORBIDDEN,
  refundApprovalAudit,
  RETURN_FORBIDDEN,
  RETURN_PIN_BLOCKED,
} from '@/lib/pharmacy/refund-authorization';
import {
  authenticateDayReopenPin,
  DAY_REOPEN_PIN_POLICY,
} from '@/lib/pharmacy/day-reopen-authorization';

import { assertInOrganization } from '../org-refs';
import { managerBranchIds } from '../pharmacy-manager-branches';
import {
  LOST_SALE_OUTCOMES,
  LostSalesError,
  lostSalesSummary,
  setDemandOutcome,
  settleLostSales,
  updateLostSalesSettings,
  MAX_COUNTER_DEMAND_QUANTITY,
} from '@/lib/pharmacy/lost-sales';
import {
  adminProcedure,
  auditedProtectedProcedure,
  capabilityProcedure,
  protectedProcedure,
  router,
} from '../trpc';
import type { TRPCContext } from '../trpc';

const controlledAddress = z.string().trim().min(3).max(300);
const branchId = z.string().trim().min(1).max(128);
/** DEV-929: the owner's maximum discount in the audit description ("no maximum" or "10%"). */
const maximumWords = (bps: number) =>
  bps >= NO_MAXIMUM_DISCOUNT_BPS ? 'no maximum' : `${bps / 100}%`;
// Preserve field order and parsing: settlement hashes JSON.stringify(parsed input).
const counterApprovalPin = z
  .object({ staffProfileId: z.string().trim().min(1).max(128), pin: z.string().regex(/^\d{4,8}$/) })
  .strict();
// Anonymous approval is meaningful only with the independently verified till session.
const counterLineApproval = z.union([
  counterApprovalPin,
  z.strictObject({
    pin: z.string().regex(/^\d{6}$/),
    matchingStaffProfileId: z.string().trim().min(1).max(128).optional(),
  }),
]);
type CounterLineApprovalRequest = z.infer<typeof counterLineApproval>;

function authorizeSaleApproval(
  ctx: TRPCContext,
  db: ScopedDb,
  scope: LedgerScope,
  kind: CounterApprovalKind,
  input?: CounterLineApprovalRequest
) {
  if (!input) return authorizeCounterApproval(db, scope, kind, input);
  const counter = ctx.approvalCounter;
  if (counter) return authorizeCounterApproval(db, scope, kind, { ...input, counter });
  if ('staffProfileId' in input) return authorizeCounterApproval(db, scope, kind, input);
  throw counterProofRequired(kind);
}
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
    // DEV-290: why an owner or manager approved charging past the family credit limit.
    overrideReason: z.string().trim().min(1).max(500).optional(),
    /**
     * DEV-290: a manager's or owner's staff PIN entered at the cashier's till to approve the
     * over-limit charge. Verified by the server; never stored, hashed or replayed.
     */
    overLimitApproval: counterLineApproval.optional(),
    // Wallets: last 4–6 transaction digits. Manual card: last 4 digits or terminal
    // reference, never a full card number. Bank transfers use the bank statement reference.
    // Each tender's shape is enforced in settlement.
    providerRef: z.string().max(BANK_TRANSFER_REFERENCE_MAX_LENGTH).optional(),
    payerName: z.string().trim().min(1).max(100).optional(),
    referenceSkipped: z.boolean().optional(),
    /** DEV-713: approval code from a standalone card terminal slip. */
    approvalCode: z.string().regex(MANUAL_CARD_APPROVAL_CODE).optional(),
    /**
     * DEV-863: the customer's own prepaid spend PIN, typed by the customer. Verified by the
     * server; never stored, hashed into the payment or replayed.
     */
    prepaidPin: prepaidPin.optional(),
    // #708: the buyer the Sindh cash memo names. Last, so existing payload hashes hold.
    buyerName: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069<>]*$/u, 'Use a plain name.')
      .optional(),
  })
  .strict()
  .refine(hasValidTenderProviderReference, {
    path: ['providerRef'],
    message: 'Invalid payment reference.',
  });
// The outcome and write have the same public type. Only a write takes an anonymous code.
const tenderReadInput = tenderInput.refine(
  (input) => !input.overLimitApproval || 'staffProfileId' in input.overLimitApproval,
  { message: 'Approval codes are only accepted when taking payment.' }
);
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
const lostSaleOutcome = z.enum(LOST_SALE_OUTCOMES);
/** DEV-81: optional notify-when-back phone; digits with an optional leading +. */
const notifyPhone = z
  .string()
  .trim()
  .max(20)
  .regex(/^\+?[\d\s-]{10,19}$/);
const txDb = (tx: unknown) => tx as ScopedDb;

async function scopeFor(ctx: TRPCContext, branch: string): Promise<LedgerScope> {
  const organizationId = ctx.entitlements?.organizationId;
  const actorId = ctx.session?.user?.id;
  if (!organizationId || !actorId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  await assertInOrganization(ctx.db.pharmacyBranch, organizationId, [branch], { active: true });
  return { organizationId, branchId: branch, actorId };
}

/**
 * DEV-817: a demand-event response never carries the customer's notify-when-back
 * phone. The counter only learns whether a contact is on file; the notification
 * sender reads the number on the server.
 */
function redactDemandContact<T extends { notifyPhone?: string | null }>(
  row: T
): Omit<T, 'notifyPhone'> & { hasNotifyContact: boolean } {
  const { notifyPhone, ...rest } = row;
  return { ...rest, hasNotifyContact: Boolean(notifyPhone) };
}

/**
 * DEV-845: a restock-arrival response names each queued notification by id and
 * status only. The destination is the customer's phone; the sender reads it on
 * the server, so no role ever receives it.
 */
function redactRestockArrival<
  T extends { notification: { id: string; status: string; destination?: unknown } | null },
>(entry: T) {
  const { notification, ...rest } = entry;
  return {
    ...rest,
    notification: notification
      ? { id: notification.id, status: notification.status, hasContact: true }
      : null,
  };
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

/**
 * DEV-876: a counter read (stock, lots, substitutes, upsells, pack scans, the
 * drawer and the customer's loyalty and credit) stays inside the caller's active
 * branch assignment, as the counter's writes already do. A branch outside the
 * workspace keeps `scopeFor`'s refusal; only a session ADMIN of this organization
 * may read an active branch they are not assigned to.
 */
async function assignedBranchScope(ctx: TRPCContext, branch: string): Promise<LedgerScope> {
  const scope = await scopeFor(ctx, branch);
  const user = ctx.session!.user;
  if (user.organizationId !== scope.organizationId)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
  if (user.role === 'ADMIN') return scope;
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

/**
 * DEV-909: a customer's detailed points history is shown for every branch only to a session
 * ADMIN of the organization (the owner). Other staff, branch managers included, see it for the
 * active branches they are assigned to; the shared points balance is not limited.
 */
async function visibleLoyaltyBranches(
  ctx: TRPCContext,
  scope: LedgerScope
): Promise<string[] | undefined> {
  const user = ctx.session!.user;
  if (user.role === 'ADMIN' && user.organizationId === scope.organizationId) return undefined;
  const rows = await ctx.db.pharmacyBranchAssignment.findMany({
    where: {
      organizationId: scope.organizationId,
      userId: user.id,
      active: true,
      branch: { organizationId: scope.organizationId, active: true },
    },
    select: { branchId: true },
  });
  return [...new Set([scope.branchId, ...rows.map((row) => row.branchId)])];
}

type SaleLineInput = Parameters<typeof addSaleLine>[2];
/** #727: the online counter prices each line against the branch's live promotions. */
const COUNTER_LINE_PRICING = { applyCounterPromotions: true } as const;

/**
 * #727: promotions are managed by a `pharmacy:manage` holder (capability checked by the
 * procedure) for a branch they are assigned to; an organization ADMIN may use any branch.
 */
async function promotionScope(ctx: TRPCContext, branch: string): Promise<LedgerScope> {
  const scope = await branchScopeOrForbidden(ctx, branch);
  if (ctx.organization?.vertical !== 'PHARMACY')
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Pharmacy workspace required.' });
  const user = ctx.session!.user;
  if (user.role === 'ADMIN' && user.organizationId === scope.organizationId) return scope;
  const assignment = await ctx.db.pharmacyBranchAssignment.findFirst({
    where: {
      organizationId: scope.organizationId,
      userId: user.id,
      branchId: branch,
      active: true,
      branch: { organizationId: scope.organizationId, active: true },
    },
    select: { branchId: true },
  });
  if (assignment?.branchId !== branch)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
  return scope;
}
type CounterLineRequest = Omit<
  SaleLineInput,
  'override' | 'approvedByUserId' | 'approvalPolicy' | 'voucherCashierPinVerified' | 'scannedPack'
> & {
  discountApproval?: CounterLineApprovalRequest;
  /** DEV-819: the redeeming cashier's own PIN, required with a voucher. */
  voucherPin?: string;
  override?: { inventoryLotId: string; reason: string; approval?: CounterLineApprovalRequest };
  /** DEV-843: a manager or owner PIN approves a scanned pack that is not from the FEFO lot. */
  scannedPack?: { payload: string; approval?: CounterLineApprovalRequest };
};

/**
 * DEV-843: a scanned pack taken out of FEFO order is labelled on the audit row like a typed
 * batch override (PH-A4): sold with a manager's approval, refused without one, or refused
 * because the manager PIN sent for it was wrong or ineligible.
 */
function labelScannedPackFefo(
  ctx: TRPCContext,
  input: { branchId: string; saleId: string; medicineId: string },
  outcome: 'sold' | 'refused' | 'pin_refused'
) {
  annotateAudit(ctx, {
    category: 'PHARMACY_SAFETY',
    action: 'fefo_override',
    targetType: 'PharmacySale',
    targetId: input.saleId,
    description:
      outcome === 'sold'
        ? 'Counter sold a scanned pack out of FEFO order.'
        : outcome === 'refused'
          ? 'Counter refused a scanned pack out of FEFO order without a manager approval.'
          : // Refused before the pack was resolved, so this does not claim it was out of order.
            'Counter refused the manager PIN sent with a scanned pack.',
    metadata: { branchId: input.branchId, medicineId: input.medicineId, scannedPack: true },
  });
}

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
    ...(input.shelfLabelLotId ? { shelfLabelLotId: input.shelfLabelLotId } : {}),
    medicineId: input.medicineId,
    presentationId: input.presentationId,
    packLevelId: input.packLevelId,
    saleUnit: input.saleUnit,
    quantity: input.quantity,
    canonicalUnitsPerSaleUnit: input.canonicalUnitsPerSaleUnit,
    discountKind: input.discountKind,
    discountMinor: input.discountMinor,
    voucherId: input.voucherId,
    idempotencyKey: input.idempotencyKey,
  };
  const { override } = input;
  // DEV-819: a voucher is redeemed only after the signed-in cashier re-enters their own PIN,
  // verified in its own transaction so a wrong PIN's lockout strike is kept.
  if (input.voucherId) {
    const verified = await authenticateVoucherCashierPin({
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      pin: input.voucherPin,
    });
    annotateAudit(ctx, { metadata: { voucherId: input.voucherId, voucherPinVerified: verified } });
    if (!verified) throw new PharmacySaleError('VOUCHER_PIN_REQUIRED');
    lineInput.voucherCashierPinVerified = true;
  }
  if ((input.discountMinor ?? 0) > 0) {
    const approval = await authorizeSaleApproval(
      ctx,
      db,
      scope,
      'DISCOUNT',
      input.discountApproval
    );
    approvals.push({ kind: 'DISCOUNT', approval });
    lineInput.approvedByUserId = approval.approvedByUserId;
    lineInput.approvalPolicy = approval.approvalPolicy;
    annotateAudit(ctx, { metadata: { discountApproval: approval } });
  }
  const { scannedPack } = input;
  if (scannedPack) {
    lineInput.scannedPack = { payload: scannedPack.payload };
    // DEV-843: whether the pack's lot is FEFO's choice is known only once the sale resolves
    // it, so a manager or owner PIN sent with the scan is verified here and the domain refuses
    // an out-of-order pack without one. There is no on-duty default, and a batch override's
    // pharmacist approval does not stand in. A wrong or ineligible PIN is refused outright;
    // a scan with no PIN may still sell a pack from the earliest-expiry lot.
    if (scannedPack.approval) {
      const approval = await authorizeSaleApproval(
        ctx,
        db,
        scope,
        'SCANNED_PACK_FEFO',
        scannedPack.approval
      );
      approvals.push({ kind: 'SCANNED_PACK_FEFO', approval });
      lineInput.scannedPack.fefoApprovalPolicy = fefoOverrideApprovalPolicy(
        approval,
        scope.actorId
      );
      annotateAudit(ctx, {
        metadata: {
          scannedPackApprovalPolicy: approval.approvalPolicy,
          scannedPackApprovedByUserId: approval.approvedByUserId,
        },
      });
    }
  }
  if (override) {
    const approval = await authorizeSaleApproval(
      ctx,
      db,
      scope,
      'FEFO_OVERRIDE',
      override.approval
    );
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

/**
 * DEV-825: lock the sale row before a controlled line takes the branch register
 * lock. The sale row is a document lock, which stock-lock-order.ts puts ahead of
 * the register; `addSaleLine` would otherwise first touch it after the register.
 */
/**
 * DEV-977B: a line is changed or removed only by someone who may sell its medicine, the same
 * #518 grant `addLine` checks for an Rx/restricted line (DENY wins). A controlled line is
 * refused by the domain whatever the grant.
 */
async function assertLineMedicineSellable(db: ScopedDb, scope: LedgerScope, saleLineId: string) {
  const line = await db.pharmacySaleLine.findFirst({
    where: { id: saleLineId, organizationId: scope.organizationId, branchId: scope.branchId },
    select: { medicine: true },
  });
  if (line && !line.medicine.controlled) await assertRxSaleAllowed(db, scope, [line.medicine]);
}

async function lockSaleForControlledLine(db: ScopedDb, scope: LedgerScope, saleId: string) {
  await db.$queryRaw`SELECT id FROM pharmacy_sales WHERE id=${saleId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR NO KEY UPDATE`;
}

async function bindKhataBranch(db: ScopedDb, scope: LedgerScope) {
  await db.$queryRaw(
    Prisma.sql`SELECT set_config('app.current_branch_id', ${scope.branchId}, true)`
  );
}

type TenderRefund = Parameters<typeof refundPharmacyTender>[2];

/**
 * refundTender's work inside its transaction: the stored tender selects the permission
 * boundary (Khata credit vs. receipt access), then the settlement caps and posts the refund.
 * DEV-501: returnAndRefund runs the same step right after recording the return.
 */
async function refundTenderInTransaction(
  ctx: TRPCContext,
  db: ScopedDb,
  scope: LedgerScope,
  refund: TenderRefund,
  receiptAccess: boolean
) {
  const tender = await db.pharmacyTender.findFirst({
    where: {
      id: refund.originalTenderId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    select: { id: true, type: true, provider: true },
  });
  if (tender?.type !== 'CREDIT') {
    if (!receiptAccess)
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'You do not have permission for this action.',
      });
    // Both callers (refundTender, returnAndRefund) have already required a manager or
    // owner with a fresh PIN (DEV-647), so any open till of the branch may pay the
    // refund out (DEV-821).
    const terminalPosting = tender && (await anyCardTerminalTender(db, scope, [tender]));
    const book = () =>
      refundPharmacyTender(db, scope, refund, {
        ...(terminalPosting ? { recordProviderRefundOwed: true } : {}),
        requireCurrentBusinessDate: true,
        drawerOperator: { kind: 'COUNTER', actorIsManager: true },
      });
    if (terminalPosting) {
      // This counter command also books a provider liability. Invoke the accounts write
      // procedure in this transaction, after the existing refund and branch controls.
      const accounts = router({ bookTerminalRefund: pharmacyRefundPostingMutation.mutation(book) });
      return accounts.createCaller({ ...ctx, db }).bookTerminalRefund();
    }
    return book();
  }
  await khataScope(ctx, scope.branchId, 'write');
  await bindKhataBranch(db, scope);
  const charge = await db.pharmacyKhataEvent.findFirst({
    where: {
      id: `khata:${refund.originalTenderId}`,
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
          amountMinor: refund.amountMinor,
          settlesChargeId: charge.id,
          actorId: scope.actorId,
          note: `Refund ${result.refundId}`,
        },
      });
  }
  return result;
}

const SOLE_APPROVER_PASSWORD_REAUTH = 'SOLE_APPROVER_PASSWORD_REAUTH';

function ledgerTender(input: z.infer<typeof tenderInput>) {
  // DEV-290: the approver's PIN is one-time evidence, never part of the idempotent payload.
  const { overLimitApproval, prepaidPin: customerPin, ...tender } = input;
  void overLimitApproval;
  void customerPin;
  return { ...tender, type: tender.type === 'KHATA' ? ('CREDIT' as const) : tender.type };
}

const HOSTED_RECEIPT_ERROR_MESSAGES: Record<HostedReceiptError['reason'], string> = {
  NOT_CONFIGURED: 'WhatsApp receipts are not set up for this pharmacy.',
  LINK_HOST_NOT_CONFIGURED: 'Receipt links are not set up for this workspace.',
  NOT_SETTLED: 'Only a settled receipt can be sent.',
  NO_CUSTOMER: 'Link a customer to this sale before sending a WhatsApp receipt.',
  NO_CONSENT: 'This customer has not opted in to WhatsApp messages.',
  NO_PHONE: 'This customer has no valid WhatsApp number on file.',
  NOT_NEUTRAL: 'The receipt message would name a medicine, so it was not sent.',
};

/** DEV-743: the card-terminal router answers a tender guard's refusal exactly as a tender does. */
export function failPharmacySale(error: unknown): never {
  return fail(error);
}

/** DEV-958A: the day-end hour setting's refusals, in the owner's words. */
function failDayEndHour(error: unknown): never {
  if (error instanceof PharmacyDayEndHourError) {
    if (error.reason === 'BRANCH_NOT_FOUND')
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Choose an active branch.' });
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'This setting changed while you were editing it. Reload and try again.',
    });
  }
  return fail(error);
}

/**
 * DEV-958B: the gate for the cash-shift procedures. A manager or owner at the branch (the
 * drawer-manager gate: the manage grant with no counter DENY, an assigned branch or ADMIN) may act
 * on any shift of the branch, even without the counter grant; anyone else needs the counter gate
 * and acts only on their own shift (cash-shifts.ts refuses another cashier's).
 */
async function cashShiftScope(
  ctx: TRPCContext,
  branch: string
): Promise<{ scope: LedgerScope; actorIsManager: boolean }> {
  try {
    return { scope: await requireDrawerManagerAccess(ctx, branch), actorIsManager: true };
  } catch (error) {
    if (!(error instanceof TRPCError) || error.code !== 'FORBIDDEN') throw error;
    return {
      scope: await requireCounterReceiptAccess(ctx, branch, true),
      actorIsManager: false,
    };
  }
}

/**
 * DEV-977B: the cash-shift gate of a line change, on the branch's current business day: the same
 * rule a payment meets (settlement.ts), plus a bill whose shift has closed.
 */
async function lineChangeCashShift(
  db: ScopedDb,
  scope: LedgerScope,
  deviceId: string | undefined,
  bill: { createdAt: Date; createdByUserId: string }
) {
  const businessDate = pharmacyBusinessDate(await readPharmacyDayClock(db, scope));
  return requireCashShiftForLineChange(
    db,
    scope,
    { deviceId: deviceId ?? null, businessDate },
    bill
  );
}

/** DEV-958B: shift refusals that are a state the counter must refresh, not a bad request. */
const SHIFT_CONFLICTS = new Set<string>([
  'SHIFT_OPEN',
  'SHIFT_ALREADY_OPEN',
  'SHIFT_ALREADY_CLOSED',
  'SHIFT_CHANGED',
  'SHIFT_COUNT_MISMATCH',
  'SHIFT_NOT_OPEN',
]);

function fail(error: unknown): never {
  if (error instanceof PrepaidPinError)
    throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
  if (error instanceof PrepaidError)
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  if (error instanceof LostSalesError)
    throw new TRPCError({
      code:
        error.reason === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.reason === 'CONSENT_REQUIRED'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST',
      message: error.reason,
    });
  if (error instanceof BranchOperationDeniedError)
    throw new TRPCError({ code: 'FORBIDDEN', message: error.reason });
  if (error instanceof PharmacyRxSaleDenied)
    throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
  // DEV-629: an Rx line whose pharmacist review is not signed is a bill the counter must correct.
  if (error instanceof PharmacyDispensingError)
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  if (error instanceof PharmacyRxReferenceError)
    throw new TRPCError({
      code: error.reason === 'PRESCRIPTION_NEEDS_PHARMACIST' ? 'FORBIDDEN' : 'BAD_REQUEST',
      message: error.message,
    });
  if (error instanceof ControlledRestorationDenied)
    throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
  if (error instanceof CounterApprovalChoice)
    throw new TRPCError({ code: 'FORBIDDEN', message: error.message, cause: error });
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
        error.reason === 'CUSTOMER_NOT_FOUND' || error.reason === 'LOYALTY_CARD_NOT_RECOGNISED'
          ? 'NOT_FOUND'
          : error.reason === 'LOYALTY_CONSENT_REQUIRED' || error.reason === 'SALE_NOT_LINKED'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST',
      message: error.reason,
    });
  }
  if (error instanceof PharmacySettlementError) {
    // A drawer that is already open, or a terminal payment still open on the day being closed
    // (DEV-743), is a state conflict, not a malformed request.
    throw new TRPCError({
      code:
        error.reason === 'OPEN_DRAWER' ||
        error.reason === 'CARD_TERMINAL_PAYMENT_OPEN' ||
        SHIFT_CONFLICTS.has(error.reason)
          ? 'CONFLICT'
          : error.reason === 'DRAWER_NOT_YOURS' || error.reason.startsWith('SHIFT_APPROVAL_')
            ? 'FORBIDDEN'
            : error.reason === 'SHIFT_NOT_FOUND'
              ? 'NOT_FOUND'
              : 'BAD_REQUEST',
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
  if (error instanceof PharmacySerializedPackError) {
    // A pack that was already sold is a state conflict the operator must see.
    throw new TRPCError({
      code:
        error.reason === 'SERIAL_ALREADY_SOLD'
          ? 'CONFLICT'
          : error.reason === 'SERIAL_FEFO_APPROVAL_REQUIRED'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST',
      message: error.reason,
    });
  }
  if (error instanceof PharmacySaleError) {
    throw new TRPCError({
      code:
        error.reason === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.reason === 'CROSS_BRANCH_REFERENCE' || error.reason === 'NOT_BILL_OWNER'
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

// Clinical restrictions do not revoke independently granted Khata access.
const KHATA_CAPABILITIES = RECEIPT_READ_CAPABILITIES.filter(
  (action) => action !== 'pharmacy:dispense' && action !== 'pharmacy.dispense'
);

/**
 * Dispense, receipt, or counter capability, then an active pharmacy branch
 * assignment in the session organization. Restaurant staff profiles are not
 * consulted. An empty assignment denies a non-admin. A session `ADMIN` of this
 * organization may use every active branch, including when they also have an
 * explicit assignment elsewhere. That exception is recorded on the audit.
 */
/** A branch outside the session organization is a scope denial, not a bad request. */
export async function branchScopeOrForbidden(
  ctx: TRPCContext,
  branch: string
): Promise<LedgerScope> {
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

export async function requireCounterReceiptAccess(
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
  // DEV-860: by now the branch is an active branch of the caller's own organization and
  // the caller an active member with counter access, so naming the missing assignment
  // reveals nothing about another tenant or user. Every earlier refusal names no reason.
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'Branch is outside your scope.',
    cause: new RefusalReason(BRANCH_NOT_ASSIGNED),
  });
}

// Keep existing denials across the entire receipt family, including a receipt-only DENY.
function requireCartWriteAccess(ctx: TRPCContext, branch: string): Promise<LedgerScope> {
  return requireCounterReceiptAccess(
    ctx,
    branch,
    false,
    (rules) =>
      counterCapabilityDecision(rules, CART_WRITE_CAPABILITIES) === 'ALLOW' &&
      counterCapabilityDecision(rules) !== 'DENY'
  );
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
export function requireDrawerManagerAccess(ctx: TRPCContext, branch: string): Promise<LedgerScope> {
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

// Both reads expose the existing owner-only financial findings.
async function requireOwnerFinancialReports(ctx: TRPCContext) {
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
}

async function requireCloseAccess(ctx: TRPCContext, branch: string) {
  if (!(await closeAccessDecision(ctx, branch)))
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Day-close permission is required to reconcile and close a day.',
    });
}

/**
 * DEV-505: the branches `requireCloseAccess` would let this actor close, so the
 * day-close screen offers only those (DEV-127's `canClosePharmacyDay` answers
 * the rail and the console gate from the same rule). An administrator or a
 * `pharmacy:close` holder reaches every active branch; a Manager
 * (`pharmacy:manage`) only the active branches they are assigned to, unless
 * `pharmacy:close` is explicitly denied. Everyone else gets none. Each close
 * still re-runs `requireCloseAccess` on its branch.
 */
export async function dayCloseBranchIds(ctx: TRPCContext): Promise<'ALL' | string[]> {
  const user = ctx.session?.user;
  const organizationId = ctx.entitlements?.organizationId;
  if (
    !user ||
    !organizationId ||
    user.organizationId !== organizationId ||
    !hasModule(ctx.entitlements, 'pharmacy-counter')
  )
    return [];
  if (user.role === 'ADMIN') return 'ALL';
  const options = { db: ctx.db, source: 'TRPC' as const };
  if (await can(subjectFromSession(user), 'pharmacy:close', undefined, options)) return 'ALL';
  return managerBranchIds(ctx, 'pharmacy:close');
}

/**
 * DEV-290: the password route is the signed-in operator approving their own over-limit
 * charge, so the second-person rule applies: it is allowed only for an owner or manager
 * (`pharmacy:manage`) who is genuinely the sole active owner/manager. Everyone else needs a
 * different manager's or owner's PIN at the till. DEV-806: the tenant ADMIN role alone does
 * not approve, on this route or the PIN route.
 */
async function mayApproveKhataOverLimit(ctx: TRPCContext, scope: LedgerScope): Promise<boolean> {
  const db = ctx.db as unknown as ScopedDb;
  // DEV-806: the same approver check the till's PIN route applies to the PIN holder.
  const approver = await mayApproveCounterLine(
    db,
    subjectFromSession(ctx.session!.user),
    'KHATA_OVER_LIMIT',
    { source: 'TRPC' }
  );
  if (!approver || !(await isSoleActiveApprover(db, scope, 'KHATA_OVER_LIMIT'))) return false;
  if (await isLiveOrganizationOwner(db, scope.organizationId, scope.actorId)) {
    const { organizationId, actorId: userId } = scope;
    const [pin, authenticator] = await Promise.all([
      db.restaurantOperatorCredential.findFirst({
        where: {
          organizationId,
          type: 'PIN',
          revokedAt: null,
          deviceId: null,
          staffProfile: { organizationId, userId, status: 'ACTIVE' },
        },
        select: { id: true },
      }),
      db.approvalAuthenticator.findFirst({
        where: { organizationId, userId, enabledAt: { not: null } },
        select: { id: true },
      }),
    ]);
    if (!pin && !authenticator)
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          (await approvalSecretKindFor(db, organizationId)) === 'PIN'
            ? NO_PIN_SET_MESSAGE
            : APPROVAL_AUTHENTICATOR_SETUP_MESSAGE,
      });
  }
  return true;
}

/** Shared durable copy allocation for download and queued thermal transport. Caller holds the transaction. */
export async function allocateSettledCounterReceiptPrintJob(
  ctx: TRPCContext & { session: NonNullable<TRPCContext['session']> },
  tx: Prisma.TransactionClient,
  scope: LedgerScope,
  input: { saleId: string; locale: 'en' | 'ur' }
) {
  const receipt = await loadCounterReceipt({ ...ctx, db: txDb(tx) }, scope, input.saleId);
  if (receipt.receiptNumber === null || !receipt.completedAt) {
    throw new PharmacyReceiptPrintError('RECEIPT_NOT_ISSUED');
  }
  const [format, taxIdentity] = await Promise.all([
    readPharmacyReceiptFormat(tx, scope),
    readPharmacyReceiptTaxIdentity(
      tx,
      scope,
      new Date(receipt.completedAt),
      ctx.organization?.timezone
    ),
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
  return {
    receiptNumber: receipt.receiptNumber,
    result: { status: 'READY' as const, ...job, copyNumber: state.copyCount },
  };
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
  // DEV-76: the owner sets each branch's khata reminder cadence and balance floor.
  khataReminderSettings: adminProcedure
    .input(z.object({ branchId }))
    .query(async ({ ctx, input }) =>
      readKhataReminderSettings(ctx.db, await branchScopeOrForbidden(ctx, input.branchId))
    ),
  saveKhataReminderSettings: adminProcedure
    .input(
      z
        .object({
          branchId,
          revision: z.number().int().nonnegative(),
          settings: khataReminderSettingsSchema,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, {
        targetType: 'PharmacyBranch',
        targetId: input.branchId,
        metadata: { revision: input.revision, khataReminderSettings: input.settings },
      });
      const scope = await branchScopeOrForbidden(ctx, input.branchId);
      return ctx.db.$transaction((tx) => saveKhataReminderSettings(txDb(tx), scope, input));
    }),
  /**
   * DEV-66: the owner's maximum discount for the organization (none set until the owner sets one), and
   * whether the caller is the owner who may change it. Anyone at the branch may read it.
   */
  discountMaximum: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await branchScopeOrForbidden(ctx, input.branchId);
      const settings = await readMaxDiscountSettings(ctx.db, scope);
      // A support or impersonation session may see the setting but never change it.
      const support = Boolean(ctx.support || ctx.session?.user?.isSupportSession);
      return { ...settings, canChange: settings.canChange && !support };
    }),
  /**
   * DEV-66: the owner alone sets the maximum discount; it binds everyone. Every change needs
   * the owner's fresh PIN (as the other owner settings do) and is audited with the old and
   * the new value. A support or impersonation session is refused.
   */
  saveDiscountMaximum: protectedProcedure
    .input(
      z
        .object({
          branchId,
          maxDiscountBps: maxDiscountBpsSchema,
          pin: z.string().max(OWNER_EXPORT_PIN_MAX_INPUT),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      // The PIN never reaches the audit row.
      annotateAudit(ctx, { skipInput: true, targetType: 'Organization' });
      const scope = await branchScopeOrForbidden(ctx, input.branchId);
      if (ctx.support || ctx.session?.user?.isSupportSession)
        throw new TRPCError({ code: 'FORBIDDEN', message: MAX_DISCOUNT_CHANGE_REFUSED });
      if (!(await readMaxDiscountSettings(ctx.db, scope)).canChange)
        throw new TRPCError({ code: 'FORBIDDEN', message: MAX_DISCOUNT_CHANGE_REFUSED });
      if (!input.pin)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Enter your own PIN to confirm.' });
      // Its own tenant transaction, so a wrong-PIN strike commits even though we refuse.
      const pin = await verifyOwnerExportPin({
        organizationId: scope.organizationId,
        userId: scope.actorId,
        pin: input.pin,
        action: 'pharmacy.maxDiscount',
      });
      if (pin === 'NO_PIN')
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: NO_PIN_SET_MESSAGE });
      if (pin === 'LOCKED')
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Your PIN is locked after too many wrong tries. Wait and try again.',
        });
      if (pin !== 'OK')
        throw new TRPCError({ code: 'FORBIDDEN', message: 'That PIN is not correct.' });
      const saved = await ctx.db.$transaction((tx) =>
        saveMaxDiscountBps(txDb(tx), scope, input.maxDiscountBps)
      );
      annotateAudit(ctx, {
        operation: 'UPDATE',
        targetType: 'Organization',
        targetId: scope.organizationId,
        description: `Changed the maximum discount from ${maximumWords(saved.previousMaxDiscountBps)} to ${maximumWords(saved.maxDiscountBps)}`,
        changes: {
          pharmacyMaxDiscountBps: {
            before: saved.previousMaxDiscountBps,
            after: saved.maxDiscountBps,
          },
        },
        metadata: { pinVerified: true },
      });
      return { maxDiscountBps: saved.maxDiscountBps };
    }),
  /** DEV-66: smart-discount policy (minimum margin, evidence windows). */
  discountPolicy: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await marginScopeFor(ctx, input.branchId, ['pharmacy:manage']);
      return readDiscountPolicySettings(ctx.db, scope);
    }),
  saveDiscountPolicy: adminProcedure
    .input(
      z
        .object({
          branchId,
          revision: z.number().int().nonnegative(),
          policy: discountPolicySchema,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, {
        targetType: 'PharmacyBranch',
        targetId: input.branchId,
        metadata: { revision: input.revision, discountPolicy: input.policy },
      });
      const scope = await branchScopeOrForbidden(ctx, input.branchId);
      return ctx.db.$transaction((tx) => saveDiscountPolicy(txDb(tx), scope, input));
    }),
  /** DEV-66: append-only competitor discount log (price per sealed pack). */
  recordCompetitorPrice: protectedProcedure
    .input(
      z
        .object({
          branchId,
          medicineId: z.string().trim().min(1).max(128),
          packLevelId: z.string().trim().min(1).max(128),
          competitorLabel: z.string().trim().min(1).max(80),
          observedPriceMinor: z.number().int().positive().max(1_000_000_000),
          observedAt: z.coerce.date(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await marginScopeFor(ctx, input.branchId, ['pharmacy:manage']);
      annotateAudit(ctx, {
        targetType: 'PharmacyCompetitorPriceObservation',
        metadata: { medicineId: input.medicineId },
      });
      return recordCompetitorPrice(ctx.db, scope, input);
    }),
  /**
   * DEV-66: discount suggestions capped at MRP, floored by the minimum-margin
   * guard, never for regulated (Rx-only, restricted, controlled) stock.
   */
  discountSuggestions: protectedProcedure
    .input(
      z
        .object({
          branchId,
          medicineIds: z.array(z.string().trim().min(1).max(128)).min(1).max(50),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const scope = await marginScopeFor(ctx, input.branchId, [
        'pharmacy:dispense',
        'pharmacy:manage',
      ]);
      return readDiscountSuggestions(ctx.db, scope, { medicineIds: input.medicineIds });
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
          // DEV-821: cash goes only into a till this user runs, unless a manager or owner.
          return recordKhataRepayment(db, scope, input, {
            kind: 'COUNTER',
            actorIsManager:
              input.tender === 'CASH' &&
              (await actorManagesBranchDrawers(
                db,
                ctx.session!.user,
                scope.organizationId,
                scope.branchId,
                { source: 'TRPC' }
              )),
          });
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
  // DEV-631: the owner or a manager reopens today's closed business day for trading,
  // with a reason and a fresh re-authentication (their own staff PIN). The DEV-31
  // manager gate: `pharmacy:manage` (deny wins) on an assigned branch, or the audited
  // organization-administrator exception; a cashier is refused before any PIN check.
  // The reopen row records who, when and why; the request is audited.
  reopenDay: protectedProcedure
    .input(
      z
        .object({
          branchId,
          businessDate: closeDate,
          closeId: z.string().min(1).max(128),
          reason: z.string().trim().min(1).max(1000),
          // The actor's own staff PIN, re-entered for this reopen (redacted from audit input).
          ownerPin: z.string().regex(/^\d{4,8}$/),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const scope = await requireDrawerManagerAccess(ctx, input.branchId);
        // Fresh re-authentication, in its own transaction so a refusal keeps its strike.
        const pin = await authenticateDayReopenPin({
          organizationId: scope.organizationId,
          actorId: scope.actorId,
          pin: input.ownerPin,
        });
        annotateAudit(ctx, {
          metadata: { policy: DAY_REOPEN_PIN_POLICY, pinVerified: 'verified' in pin },
        });
        if ('blocked' in pin) throw new TRPCError({ code: 'FORBIDDEN', message: pin.blocked });
        const reopen = await ctx.db.$transaction(async (tx) =>
          reopenPharmacyDayForTrading(txDb(tx), scope, {
            businessDate: input.businessDate,
            closeId: input.closeId,
            reason: input.reason,
          })
        );
        annotateAudit(ctx, {
          targetType: 'PharmacyDailyClose',
          targetId: reopen.closeId,
          metadata: {
            reopenId: reopen.id,
            businessDate: input.businessDate.toISOString().slice(0, 10),
          },
        });
        return reopen;
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
      await requireOwnerFinancialReports(ctx);
      try {
        const scope = await scopeFor(ctx, input.branchId);
        return await ctx.db.$transaction(async (tx) =>
          readPharmacyCashCloseCheck(txDb(tx), scope, input.businessDate)
        );
      } catch (error) {
        fail(error);
      }
    }),
  // A read-only draft after drawer close, with the same access as DEV-84.
  shiftHandoverNote: adminProcedure
    .input(z.object({ branchId, drawerSessionId: z.string().min(1).max(128) }).strict())
    .query(async ({ ctx, input }) => {
      await requireOwnerFinancialReports(ctx);
      try {
        const scope = await scopeFor(ctx, input.branchId);
        return await ctx.db.$transaction(
          async (tx) => readPharmacyShiftHandover(txDb(tx), scope, input.drawerSessionId),
          { isolationLevel: 'RepeatableRead' }
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
        // DEV-965: a customer's credit, balance and history are a counter read: the
        // counter's member, capability (counter or dispense) and branch-assignment gate.
        await assignedBranchScope(ctx, input.branchId);
        const scope = await requireCounterReceiptAccess(ctx, input.branchId);
        return await readCustomerSnapshot(
          ctx.db,
          scope,
          input.customerId,
          input.page,
          await visibleLoyaltyBranches(ctx, scope)
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
        // DEV-830 (F04): the counter's member, capability and branch-assignment gate.
        const scope = await requireCartWriteAccess(ctx, input.branchId);
        return await ctx.db.$transaction(async (tx) => linkCustomerToSale(txDb(tx), scope, input));
      } catch (error) {
        fail(error);
      }
    }),
  // DEV-748: a scanned (or typed) physical loyalty card links its customer to the open bill,
  // through the same counter gate and consent checks as linking a customer by name.
  scanLoyaltyCard: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1),
          // Named so the audit layer redacts it from the recorded input, even on a refusal.
          cardToken: z.string().trim().min(1).max(64),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const scope = await requireCartWriteAccess(ctx, input.branchId);
        const linked = await ctx.db.$transaction(async (tx) =>
          linkLoyaltyCardToSale(txDb(tx), scope, { saleId: input.saleId, code: input.cardToken })
        );
        // The card code is a bearer token: it is never written to the audit log.
        annotateAudit(ctx, {
          category: 'PHARMACY',
          operation: 'UPDATE',
          action: 'pharmacyLoyalty.scanCard',
          targetType: 'PharmacySale',
          targetId: input.saleId,
          metadata: {
            branchId: input.branchId,
            cardId: linked.cardId,
            customerId: linked.customerId,
          },
        });
        return { id: linked.customerId, displayName: linked.displayName };
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
        // DEV-830 (F04): the counter's member, capability and branch-assignment gate.
        const scope = await requireCounterReceiptAccess(ctx, input.branchId);
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
  /** Closed-day status is also available to dispensers who do not operate a drawer. */
  tradingDayStatus: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId);
      // DEV-958A: the branch's business day, which ends at its "day ends at" hour.
      const businessDate = pharmacyBusinessDay(await readPharmacyDayClock(ctx.db, scope));
      return {
        businessDate,
        dayClosed: await pharmacyDayClosedForTrading(
          ctx.db,
          scope,
          new Date(`${businessDate}T00:00:00.000Z`)
        ),
      };
    }),
  /** The OPEN drawer for this counter device, so the counter never offers a second open. */
  drawerStatus: protectedProcedure
    .input(z.object({ branchId, deviceId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await assignedBranchScope(ctx, input.branchId);
      const openDrawer = await readOpenPharmacyDrawer(ctx.db, scope, input.deviceId);
      if (!openDrawer) return { openDrawer, operatingCashier: null };
      // DEV-958B: a drawer that runs cash shifts also says whose shift is open, or that the next
      // cashier opens one. A drawer without shifts answers exactly as before.
      const cashShift = openDrawer.cashShifts
        ? await readPharmacyDrawerShift(ctx.db, scope, openDrawer.id)
        : undefined;
      // DEV-821: who runs this till, so the counter can say so before a cash payment.
      const cashierId = drawerOperatingCashierId(openDrawer);
      const cashier = await ctx.db.user.findFirst({
        where: { id: cashierId, organizationId: scope.organizationId },
        select: { name: true },
      });
      return {
        openDrawer,
        operatingCashier: { name: cashier?.name ?? null, isYou: cashierId === scope.actorId },
        ...(cashShift ? { cashShift } : {}),
      };
    }),
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
          /** DEV-821: who runs the till; naming someone else is a manager's. */
          operatingCashierId: z.string().trim().min(1).max(128).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const namesAnotherCashier =
          input.operatingCashierId !== undefined &&
          input.operatingCashierId !== ctx.session?.user?.id;
        // DEV-279: drawers hold cash, so they take the cash-tender gate before any
        // lock or write: canonical `pharmacy:counter` through `can()`, then the
        // counter family check, then an active branch assignment. Both checks are
        // deny-wins: a role DENY or user DENY beats any ALLOW (DEV-659).
        // DEV-31: a cashier opens an empty drawer; declaring a float is a manager's.
        // DEV-821: so is handing the till to another cashier at open.
        const scope =
          input.openingFloatMinor > 0 || namesAnotherCashier
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
        // A manager's paid-in/out may use any open drawer of the branch (DEV-821).
        return await ctx.db.$transaction(async (tx) =>
          recordPharmacyCashMovement(
            txDb(tx),
            scope,
            // DEV-958B: never onto a drawer left open from an earlier business day.
            { ...input, requireCurrentBusinessDate: true },
            { kind: 'COUNTER', actorIsManager: true }
          )
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
  /**
   * DEV-958B: the next cashier opens a cash shift on this counter's open drawer, with the cash
   * they count in it. A count that differs from the last shift's closing count needs a note. A
   * cashier opens their own shift (the counter gate); naming another cashier is a manager's or
   * owner's (the drawer-manager gate). Audited, with the handover, in the same transaction.
   */
  openShift: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId,
          drawerSessionId: z.string().min(1).max(128),
          openingFloatMinor: z.number().int().min(0).max(2147483647),
          openingNote: z.string().trim().max(500).optional(),
          cashierId: z.string().trim().min(1).max(128).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const namesAnotherCashier =
          input.cashierId !== undefined && input.cashierId !== ctx.session?.user?.id;
        const { scope, actorIsManager } = namesAnotherCashier
          ? { scope: await requireDrawerManagerAccess(ctx, input.branchId), actorIsManager: true }
          : await cashShiftScope(ctx, input.branchId);
        const result = await ctx.db.$transaction(async (tx) =>
          openPharmacyCashShift(txDb(tx), scope, input, { actorIsManager })
        );
        annotateAudit(ctx, {
          targetType: 'PharmacyCashShift',
          targetId: result.shift.id,
          metadata: { drawerSessionId: input.drawerSessionId, replayed: result.replayed },
        });
        return result;
      } catch (error) {
        fail(error);
      }
    }),
  /**
   * DEV-958B: the cashier closes their shift with the cash they count; a manager or owner closes
   * anyone's (the explicit, audited manager step before a day close). A difference needs a note,
   * and one above the branch's tolerance a manager's approval through the shared approval path
   * (their PIN or authenticator code, with its strikes), verified before the close's transaction.
   * A replay with the same count returns the recorded report.
   */
  closeShift: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId,
          shiftId: z.string().min(1).max(128),
          countedCashMinor: z.number().int().min(0).max(2147483647),
          varianceNote: z.string().trim().max(1000).optional(),
          approval: z
            .object({
              approverId: z.string().trim().min(1).max(128),
              // Redacted from the audit input (a key ending in "pin").
              approverPin: z.string().trim().min(4).max(12),
            })
            .strict()
            .optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const { scope, actorIsManager } = await cashShiftScope(ctx, input.branchId);
        const approval = input.approval
          ? await authorizeCashShiftVariance(
              ctx.db,
              scope,
              {
                shiftId: input.shiftId,
                approverId: input.approval.approverId,
                pin: input.approval.approverPin,
              },
              { actorIsManager }
            )
          : undefined;
        const result = await ctx.db.$transaction(async (tx) =>
          closePharmacyCashShift(
            txDb(tx),
            scope,
            {
              shiftId: input.shiftId,
              countedCashMinor: input.countedCashMinor,
              varianceNote: input.varianceNote,
            },
            { actorIsManager, approval }
          )
        );
        annotateAudit(ctx, {
          targetType: 'PharmacyCashShift',
          targetId: input.shiftId,
          metadata: {
            replayed: result.replayed,
            varianceMinor: result.report.varianceMinor,
            approverId: approval?.approverId ?? null,
            approvalPolicy: approval?.policy ?? null,
          },
        });
        return result.report;
      } catch (error) {
        fail(error);
      }
    }),
  /**
   * DEV-958B: a shift's report: frozen at its close, or the figures so far for an open shift. A
   * cashier reads their own shift; a manager or owner any shift of the branch.
   */
  shiftReport: protectedProcedure
    .input(z.object({ branchId, shiftId: z.string().min(1).max(128) }).strict())
    .query(async ({ ctx, input }) => {
      try {
        const { scope, actorIsManager } = await cashShiftScope(ctx, input.branchId);
        const [report, policy, currency] = await Promise.all([
          readPharmacyCashShiftReport(ctx.db, scope, input.shiftId, { actorIsManager }),
          readPharmacyCashShiftPolicy(ctx.db, scope),
          organizationCurrency(ctx.db, scope.organizationId),
        ]);
        return { report, toleranceMinor: policy.toleranceMinor, currency };
      } catch (error) {
        fail(error);
      }
    }),
  /**
   * DEV-958B: who may approve this shift's over or short: the branch's managers and owners with a
   * PIN set up other than the shift's cashier, and the cashier only when nobody else can.
   */
  shiftApprovers: protectedProcedure
    .input(z.object({ branchId, shiftId: z.string().min(1).max(128) }).strict())
    .query(async ({ ctx, input }) => {
      try {
        const { scope } = await cashShiftScope(ctx, input.branchId);
        return await shiftVarianceApprovers(ctx.db, scope, input.shiftId);
      } catch (error) {
        fail(error);
      }
    }),
  /**
   * DEV-958A: the hour this branch's business day ends at today (midnight by default), any change
   * already set for a later day, and the first day a change made now applies to. Owner or
   * manager at the branch.
   */
  dayEndHour: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      try {
        const scope = await requireDrawerManagerAccess(ctx, input.branchId);
        return await readPharmacyDayEndHourSetting(ctx.db, scope);
      } catch (error) {
        failDayEndHour(error);
      }
    }),
  /**
   * DEV-958A: an owner, or a manager at the branch (the drawer-manager gate), sets when the
   * branch's business day ends. It applies from the day after the next business day, so no day
   * that has begun, and no past day or report, moves; audited with the before and after hour.
   */
  saveDayEndHour: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId,
          revision: z.number().int().nonnegative(),
          dayEndsAtHour: pharmacyDayEndHourSchema,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const scope = await requireDrawerManagerAccess(ctx, input.branchId);
        const user = ctx.session!.user;
        return await ctx.db.$transaction(async (tx) =>
          savePharmacyDayEndHour(txDb(tx), scope, input, {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            isSupportSession: user.isSupportSession,
            supportSessionId: user.supportSessionId,
            platformUserId: user.platformUserId,
          })
        );
      } catch (error) {
        failDayEndHour(error);
      }
    }),
  /**
   * DEV-821: the cashiers a manager or owner may name to run a till on this branch:
   * active members with an active assignment to it.
   */
  drawerCashiers: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      try {
        const scope = await requireDrawerManagerAccess(ctx, input.branchId);
        const rows = await ctx.db.pharmacyBranchAssignment.findMany({
          where: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            active: true,
            user: { organizationId: scope.organizationId, status: 'ACTIVE' },
          },
          select: { user: { select: { id: true, name: true } } },
        });
        return rows
          .map((row) => ({ id: row.user.id, name: row.user.name ?? 'Unnamed member' }))
          .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      } catch (error) {
        fail(error);
      }
    }),
  /**
   * DEV-821: a manager or owner hands an open till to another cashier of the
   * branch. Recorded append-only with the reason; the close reports read it.
   */
  handoverDrawer: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId,
          drawerSessionId: z.string().min(1),
          toCashierId: z.string().trim().min(1).max(128),
          reason: z.string().trim().min(1).max(500),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const scope = await requireDrawerManagerAccess(ctx, input.branchId);
        const result = await ctx.db.$transaction(async (tx) =>
          handoverPharmacyDrawer(txDb(tx), scope, input)
        );
        // Metadata only: the branch access audit keeps its own target.
        annotateAudit(ctx, {
          metadata: {
            drawerSessionId: input.drawerSessionId,
            toCashierId: input.toCashierId,
            handoverId: result.handover?.id ?? null,
          },
        });
        return result;
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
  tenderOutcome: protectedProcedure.input(tenderReadInput).query(async ({ ctx, input }) => {
    if (
      isManualTender(input.type) ||
      input.approvalCode !== undefined ||
      input.buyerName !== undefined
    )
      annotateAudit(ctx, { skipInput: true });
    const scope =
      input.type === 'KHATA' || input.type === 'CREDIT' || input.familyAccountId
        ? await khataScope(ctx, input.branchId, 'read')
        : // DEV-713: a card outcome needs the same counter access as the card write.
          isManualTender(input.type) || input.type === 'CARD'
          ? await requireCounterReceiptAccess(ctx, input.branchId, true)
          : await assignedBranchScope(ctx, input.branchId);
    return readPharmacyTenderOutcome(ctx.db, scope, ledgerTender(input));
  }),
  /**
   * DEV-712: who can approve discarding a payment attempt whose outcome is unknown: other
   * active managers or owners with a live counter PIN or, when there is nobody else (solo
   * rule), the signed-in user's own profile. Names and staff profile ids only.
   */
  tenderDiscardApprovers: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId, true);
      return listCounterApprovers(ctx.db as unknown as ScopedDb, scope, 'TENDER_DISCARD');
    }),
  /**
   * DEV-712: a manager or owner releases a counter payment attempt whose outcome is unknown,
   * with their PIN and a reason. The attempt's key is claimed so it can never be recorded
   * later; an attempt that did commit is returned as accepted instead of being discarded.
   */
  discardTenderAttempt: protectedProcedure
    .input(
      z
        .object({
          attempt: tenderReadInput,
          reason: z.string().trim().min(3).max(500),
          approval: counterLineApproval,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { attempt } = input;
      annotateAuditBranch(ctx, attempt.branchId);
      // Manual capture references stay out of the audit input, as on the tender itself.
      if (isManualTender(attempt.type) || attempt.approvalCode !== undefined)
        annotateAudit(ctx, { skipInput: true });
      try {
        const scope =
          attempt.type === 'KHATA' || attempt.type === 'CREDIT' || attempt.familyAccountId
            ? await khataScope(ctx, attempt.branchId, 'write')
            : await requireCounterReceiptAccess(ctx, attempt.branchId, true);
        // Verified in its own transaction, so a wrong PIN keeps its lockout strike.
        const approval = await authorizeSaleApproval(
          ctx,
          ctx.db as unknown as ScopedDb,
          scope,
          'TENDER_DISCARD',
          input.approval
        );
        annotateAudit(ctx, {
          metadata: {
            tenderDiscard: {
              saleId: attempt.saleId,
              approvedByUserId: approval.approvedByUserId,
              approvalPolicy: approval.approvalPolicy,
              selfApproved: approval.selfApproved,
              reason: input.reason,
            },
          },
        });
        const result = await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          await confirmCounterApproval(db, scope, 'TENDER_DISCARD', approval);
          return discardPharmacyTenderAttempt(db, scope, ledgerTender(attempt), {
            reason: input.reason,
            approvedByUserId: approval.approvedByUserId,
            approvalPolicy: approval.approvalPolicy,
            selfApproved: approval.selfApproved,
          });
        });
        if (!result) throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND' });
        annotateAudit(ctx, { metadata: { tenderDiscardOutcome: result.status } });
        return result;
      } catch (error) {
        fail(error);
      }
    }),
  tender: protectedProcedure.input(tenderInput).mutation(async ({ ctx, input }) => {
    if (
      isManualTender(input.type) ||
      input.approvalCode !== undefined ||
      input.buyerName !== undefined
    )
      annotateAudit(ctx, { skipInput: true });
    try {
      if (input.type !== 'KHATA' && input.type !== 'CREDIT') {
        if (
          input.familyAccountId !== undefined ||
          input.ownerOverride !== undefined ||
          input.overrideReason !== undefined ||
          input.overLimitApproval !== undefined
        )
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Khata fields require Khata tender.',
          });
        const scope = await requireCounterReceiptAccess(ctx, input.branchId, true);
        // DEV-821: cash goes only into a till this user runs, unless a manager or owner.
        const actorIsManager =
          input.type === 'CASH' &&
          (await actorManagesBranchDrawers(
            ctx.db,
            ctx.session!.user,
            scope.organizationId,
            scope.branchId,
            { source: 'TRPC' }
          ));
        // DEV-863: a counter wallet payment spends the linked customer's prepaid balance. Their
        // PIN is checked here in its own transaction so a wrong PIN commits its lockout strike,
        // then re-checked under the customer lock inside the payment.
        // A recorded payment replays without the PIN: the customer is not asked again.
        const recorded =
          input.type === 'WALLET'
            ? await ctx.db.pharmacyMoneyIdempotencyKey.findUnique({
                where: {
                  organizationId_deviceId_key: {
                    organizationId: scope.organizationId,
                    deviceId: input.deviceId,
                    key: input.idempotencyKey,
                  },
                },
                select: { resultPayload: true },
              })
            : null;
        if (input.type === 'WALLET' && !recorded?.resultPayload) {
          const sale = await ctx.db.pharmacySale.findFirst({
            where: {
              id: input.saleId,
              organizationId: scope.organizationId,
              branchId: scope.branchId,
            },
            select: { customerId: true },
          });
          if (
            sale?.customerId &&
            !(await authenticatePrepaidPin({
              organizationId: scope.organizationId,
              actorId: scope.actorId,
              customerId: sale.customerId,
              pin: input.prepaidPin,
            }))
          )
            throw new TRPCError({ code: 'FORBIDDEN', message: PREPAID_PIN_REFUSED });
        }
        // applyPharmacyTender enforces the persisted regulatory gate in this transaction.
        // DEV-630: a new counter payment books on today; a recorded retry still replays.
        return await ctx.db.$transaction((tx) =>
          applyPharmacyTender(txDb(tx), scope, ledgerTender(input), undefined, {
            requireCurrentBusinessDate: true,
            drawerOperator: { kind: 'COUNTER', actorIsManager },
            prepaidPin: input.prepaidPin,
          })
        );
      }
      const scope = await khataScope(ctx, input.branchId, 'write');
      if (!input.familyAccountId) throw new FamilyKhataError('ACCOUNT_NOT_FOUND');
      const normalized = ledgerTender(input);
      // DEV-290: an owner or manager (`pharmacy:manage`: Owner, Owner / Operator, Manager)
      // approves an over-limit charge, with a required reason, in one of two ways:
      // - at the cashier's till with their own staff PIN (the counter-approval path: a
      //   different approver, or a sole owner/manager re-entering their own PIN), or
      // - as the signed-in user (or a tenant ADMIN) with a fresh password re-authentication.
      // The approver and reason are written to the append-only limit-decision record.
      // PINs are verified before the transaction so a refusal still commits its lockout strike.
      const pinApproval =
        input.ownerOverride === true && input.overLimitApproval
          ? await authorizeSaleApproval(
              ctx,
              ctx.db as unknown as ScopedDb,
              scope,
              'KHATA_OVER_LIMIT',
              input.overLimitApproval
            )
          : undefined;
      if (pinApproval)
        annotateAudit(ctx, {
          metadata: {
            khataOverLimitApproval: {
              approvedByUserId: pinApproval.approvedByUserId,
              approvalPolicy: pinApproval.approvalPolicy,
              selfApproved: pinApproval.selfApproved,
            },
          },
        });
      const ownerAuthorized =
        input.ownerOverride === true &&
        (pinApproval !== undefined || (await mayApproveKhataOverLimit(ctx, scope)));
      if (input.ownerOverride === true && !pinApproval && ownerAuthorized)
        annotateAudit(ctx, {
          metadata: {
            khataOverLimitApproval: {
              approvedByUserId: scope.actorId,
              approvalPolicy: SOLE_APPROVER_PASSWORD_REAUTH,
              selfApproved: true,
            },
          },
        });
      return await ctx.db.$transaction(async (tx) => {
        const db = txDb(tx);
        if (pinApproval) await confirmCounterApproval(db, scope, 'KHATA_OVER_LIMIT', pinApproval);
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
            pinApproval,
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
  /**
   * DEV-290: who can approve an over-limit Khata charge at this till with their PIN: other
   * active managers or owners with a live counter PIN, or, when there is nobody else (solo
   * rule), the signed-in user's own profile. Names and staff profile ids only.
   */
  khataOverLimitApprovers: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await khataScope(ctx, input.branchId, 'write');
      return listCounterApprovers(ctx.db as unknown as ScopedDb, scope, 'KHATA_OVER_LIMIT');
    }),
  /**
   * DEV-929: who can approve a manual discount at this till with their PIN: other active
   * managers or owners with a live counter PIN, or, when there is nobody else (solo rule),
   * the signed-in user's own profile. Names and staff profile ids only.
   */
  discountApprovers: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId);
      return listCounterApprovers(ctx.db as unknown as ScopedDb, scope, 'DISCOUNT');
    }),
  /**
   * DEV-956: whether the owner has switched on the whole-bill discount at the counter, and
   * whether the caller is the owner who may change it. Anyone at the branch may read it.
   */
  billDiscountSetting: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await branchScopeOrForbidden(ctx, input.branchId);
      const [enabled, maximum] = await Promise.all([
        readBillDiscountEnabled(ctx.db as unknown as ScopedDb, scope.organizationId),
        readMaxDiscountSettings(ctx.db, scope),
      ]);
      // A support or impersonation session may see the setting but never change it.
      const support = Boolean(ctx.support || ctx.session?.user?.isSupportSession);
      return { enabled, canChange: maximum.canChange && !support };
    }),
  /**
   * DEV-956: the owner alone turns the whole-bill discount on or off, with their fresh PIN,
   * as for the maximum discount. Every change is audited with the old and the new value.
   */
  saveBillDiscountSetting: protectedProcedure
    .input(
      z
        .object({
          branchId,
          enabled: z.boolean(),
          pin: z.string().max(OWNER_EXPORT_PIN_MAX_INPUT),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      // The PIN never reaches the audit row.
      annotateAudit(ctx, { skipInput: true, targetType: 'Organization' });
      const scope = await branchScopeOrForbidden(ctx, input.branchId);
      if (ctx.support || ctx.session?.user?.isSupportSession)
        throw new TRPCError({ code: 'FORBIDDEN', message: BILL_DISCOUNT_CHANGE_REFUSED });
      if (!(await readMaxDiscountSettings(ctx.db, scope)).canChange)
        throw new TRPCError({ code: 'FORBIDDEN', message: BILL_DISCOUNT_CHANGE_REFUSED });
      if (!input.pin)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Enter your own PIN to confirm.' });
      // Its own tenant transaction, so a wrong-PIN strike commits even though we refuse.
      const pin = await verifyOwnerExportPin({
        organizationId: scope.organizationId,
        userId: scope.actorId,
        pin: input.pin,
        action: 'pharmacy.billDiscount',
      });
      if (pin === 'NO_PIN')
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: NO_PIN_SET_MESSAGE });
      if (pin === 'LOCKED')
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Your PIN is locked after too many wrong tries. Wait and try again.',
        });
      if (pin !== 'OK')
        throw new TRPCError({ code: 'FORBIDDEN', message: 'That PIN is not correct.' });
      const saved = await ctx.db.$transaction((tx) =>
        saveBillDiscountEnabled(txDb(tx), scope, input.enabled)
      );
      annotateAudit(ctx, {
        operation: 'UPDATE',
        targetType: 'Organization',
        targetId: scope.organizationId,
        description: `${saved.enabled ? 'Turned on' : 'Turned off'} the whole-bill discount at the counter`,
        changes: {
          pharmacyBillDiscountEnabled: { before: saved.previous, after: saved.enabled },
        },
        metadata: { pinVerified: true },
      });
      return { enabled: saved.enabled };
    }),
  discountBillLine: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1),
          saleLineId: z.string().min(1),
          deviceId: z.string().min(1).optional(),
          requestId: z.uuid(),
          discount: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('PERCENT'), bps: maxDiscountBpsSchema }).strict(),
            z
              .object({
                kind: z.literal('AMOUNT'),
                minor: z.number().int().positive().max(2000000000),
              })
              .strict(),
          ]),
          discountApproval: counterLineApproval.optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, {
        skipInput: true,
        targetType: 'PharmacySaleLine',
        targetId: input.saleLineId,
      });
      try {
        const scope = await requireCounterReceiptAccess(ctx, input.branchId, true);
        const approval = await authorizeSaleApproval(
          ctx,
          ctx.db,
          scope,
          'DISCOUNT',
          input.discountApproval
        );
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          await requirePharmacyTodayOpenForTrading(db, scope);
          await assertLineMedicineSellable(db, scope, input.saleLineId);
          return discountBillLine(db, scope, {
            saleId: input.saleId,
            saleLineId: input.saleLineId,
            discount: input.discount,
            idempotencyKey: input.requestId,
            actorIsManager: await actorMayRefund(db, ctx.session!.user),
            cashShift: (bill) => lineChangeCashShift(db, scope, input.deviceId, bill),
            approval,
            confirmApproval: () => confirmCounterApproval(db, scope, 'DISCOUNT', approval),
          });
        });
      } catch (error) {
        fail(error);
      }
    }),
  /**
   * DEV-956: give, change or remove (zero) the one whole-bill discount on an open, unpaid bill,
   * as an amount or a percentage. It is approved exactly as an item discount is: the operator's
   * own discount right, or a manager's or owner's PIN (solo: the sole approver re-enters their
   * own). The server shares it onto the lines under the owner's maximum, cost and minimum
   * margin, and refuses what the bill cannot take in full, naming the most it can take.
   */
  applyBillDiscount: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().trim().min(1).max(128),
          discount: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('PERCENT'), bps: maxDiscountBpsSchema }).strict(),
            z
              .object({
                kind: z.literal('AMOUNT'),
                minor: z.number().int().nonnegative().max(2_000_000_000),
              })
              .strict(),
          ]),
          // #520: the approver is proven by a PIN the server verifies, never named by the caller.
          discountApproval: counterLineApproval.optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      // The PIN never reaches the audit row; the bill and the request do.
      annotateAudit(ctx, {
        skipInput: true,
        targetType: 'PharmacySale',
        targetId: input.saleId,
        metadata: { branchId: input.branchId, billDiscount: input.discount },
      });
      try {
        const scope = await requireCartWriteAccess(ctx, input.branchId);
        // A switched-off feature never reaches a PIN check, so a wrong PIN is never a lockout
        // strike for it. The domain re-checks the switch inside the sale transaction.
        if (!(await readBillDiscountEnabled(ctx.db as unknown as ScopedDb, scope.organizationId)))
          throw new PharmacySaleError('BILL_DISCOUNT_OFF');
        const removal =
          input.discount.kind === 'PERCENT' ? input.discount.bps === 0 : input.discount.minor === 0;
        // #520: PINs are verified before the sale transaction takes a connection.
        const approval = removal
          ? null
          : await authorizeSaleApproval(
              ctx,
              ctx.db as unknown as ScopedDb,
              scope,
              'DISCOUNT',
              input.discountApproval
            );
        const outcome = await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          if (approval) await confirmCounterApproval(db, scope, 'DISCOUNT', approval);
          return applyBillDiscount(db, scope, {
            saleId: input.saleId,
            request: input.discount,
            approval,
          });
        });
        annotateAudit(ctx, {
          operation: 'UPDATE',
          description:
            outcome.status === 'REFUSED'
              ? 'Counter refused a whole-bill discount the bill cannot take in full.'
              : removal
                ? 'Counter removed the whole-bill discount.'
                : 'Counter gave a whole-bill discount.',
          metadata: {
            branchId: input.branchId,
            billDiscount: input.discount,
            outcome: outcome.status,
            ...(outcome.status === 'APPLIED'
              ? { totalMinor: outcome.totalMinor, previousTotalMinor: outcome.previousTotalMinor }
              : { reason: outcome.reason, capacityMinor: outcome.capacityMinor }),
            givenByUserId: scope.actorId,
            ...(approval
              ? {
                  approvedByUserId: approval.approvedByUserId,
                  approvalPolicy: approval.approvalPolicy,
                  selfApproved: approval.selfApproved,
                }
              : {}),
          },
        });
        return outcome;
      } catch (error) {
        fail(error);
      }
    }),
  fefoOverrideApprovers: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await requireCartWriteAccess(ctx, input.branchId);
      return listCounterApprovers(ctx.db as unknown as ScopedDb, scope, 'FEFO_OVERRIDE');
    }),
  /** Eligible manager/owner PIN profiles for a scanned pack's first-expiry approval. */
  scannedPackFefoApprovers: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId);
      return listCounterApprovers(ctx.db as unknown as ScopedDb, scope, 'SCANNED_PACK_FEFO');
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
          metadata: refundApprovalAudit({
            initiatedById: scope.actorId,
            approverId: scope.actorId,
            pin,
          }),
        });
        if ('blocked' in pin) return pin;
        return await ctx.db.$transaction((tx) =>
          refundTenderInTransaction(ctx, txDb(tx), scope, refund, receiptAccess)
        );
      } catch (error) {
        fail(error);
      }
    }),
  /**
   * DEV-860: what stops this counter selling, listed before the first scan. The same
   * member, capability and branch gate as `create`; a missing branch assignment is
   * reported rather than thrown. Codes only: the counter maps them to text, and only an
   * organization administrator (`canFixSetup`) is linked to the setup pages.
   */
  saleReadiness: protectedProcedure
    .input(
      z
        .object({
          branchId,
          deviceId: z.string().min(1).max(200).optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const { scope, assigned, orgAdmin } = await counterReceiptGrant(ctx, input.branchId);
      if (!assigned.has(input.branchId) && !orgAdmin) {
        return {
          ready: false,
          blockers: [BRANCH_NOT_ASSIGNED],
          warnings: [],
          canFixSetup: false,
        } satisfies CounterSaleReadiness & { canFixSetup: boolean };
      }
      const takesPayment = await can(
        subjectFromSession(ctx.session!.user),
        'pharmacy:counter',
        undefined,
        { db: ctx.db }
      );
      const readiness = await evaluateCounterSaleReadiness(ctx.db as unknown as ScopedDb, {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        actorId: scope.actorId,
        deviceId: input.deviceId ?? null,
        takesPayment,
      });
      // DEV-905: a workspace that is not active may simply be waiting for DevFathom
      // approval, or still have onboarding steps open. Say which, instead of the generic
      // "not active". The read is additive: if it fails, the generic message stays.
      const approval = readiness.blockers.includes('ORGANIZATION_NOT_ACTIVE')
        ? await readPharmacyApprovalStatus(
            ctx.db as unknown as ScopedDb,
            scope.organizationId
          ).catch(() => null)
        : null;
      // DEV-911: the counter shows the owner's switch; the gates read it again themselves.
      // Only an explicit stored OFF is reported, so a missing or unreadable setting means on.
      const pharmacistCheck = await readPharmacistCheckPolicy(
        ctx.db as unknown as ScopedDb,
        scope.organizationId
      );
      if (pharmacistCheck.enabled)
        return { ...readiness, canFixSetup: orgAdmin, ...(approval ? { approval } : {}) };
      return {
        ...readiness,
        // Nobody needs to countersign while the check is off.
        warnings: readiness.warnings.filter((warning) => warning !== NO_INDEPENDENT_PHARMACIST),
        canFixSetup: orgAdmin,
        ...(approval ? { approval } : {}),
        pharmacistCheckOff: true as const,
      };
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
        const scope = await requireCartWriteAccess(ctx, input.branchId);
        // DEV-97: only someone who takes payment opens a drawer. A pharmacist without
        // `pharmacy:counter` builds the bill and hands it to counter staff, whose
        // tender keeps its own capability and drawer checks.
        const takesPayment =
          !input.quotation &&
          (await can(subjectFromSession(ctx.session.user), 'pharmacy:counter', undefined, {
            db: ctx.db,
          }));
        // createSale enforces the persisted regulatory gate in this transaction.
        // DEV-725: opening the drawer is the first step of the shift. A counter
        // bill is never started on a device with no OPEN drawer, so the cashier
        // cannot build a bill they are then refused at payment. Checked after the
        // regulatory gate (which keeps its own refusal and audit), before the insert.
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          return createSale(db, scope, input.quotation, async () => {
            if (input.quotation) return;
            // DEV-631: no counter bill is opened while today's business day is closed.
            await requirePharmacyTodayOpenForTrading(db, scope);
            if (!takesPayment) return;
            if (!input.deviceId) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
            const drawer = await lockOpenPharmacyDrawer(db, scope, input.deviceId);
            // DEV-769: cash is refused on a drawer from an earlier day, so the bill is too.
            await requireTodaysPharmacyDrawer(db, scope, drawer);
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
              patientAddress: z.union([
                controlledAddress,
                z.object({ useAddressOnFile: z.literal(true) }).strict(),
              ]),
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
          // DEV-27: a voucher is redeemed by its stored id; the server sets the amount and
          // enforces the voucher's eligible categories. A client cannot label a voucher.
          voucherId: z.string().trim().min(1).max(128).optional(),
          // DEV-819: the redeeming cashier's own staff PIN, required with a voucher.
          voucherPin: z
            .string()
            .regex(/^\d{4,8}$/)
            .optional(),
          // #520: the approver is proven by a PIN the server verifies, never named by the caller.
          discountApproval: counterLineApproval.optional(),
          override: z
            .object({
              inventoryLotId: z.string().min(1),
              reason: z.string().trim().min(1).max(500),
              approval: counterLineApproval.optional(),
            })
            .strict()
            .optional(),
          // DEV-90: a constraint only; it cannot authorize a batch override.
          shelfLabelLotId: z.string().trim().min(1).max(128).optional(),
          // DEV-92: the raw DataMatrix of one serialized pack; the server re-reads it.
          scannedPack: z
            .object({
              payload: z.string().trim().min(1).max(256),
              // DEV-843: a manager or owner PIN for a pack that is not from the FEFO lot.
              approval: counterLineApproval.optional(),
            })
            .strict()
            .optional(),
          idempotencyKey: z.string().trim().min(1).max(160),
        })
        .strict()
        // DEV-843: a scanned pack decides its own batch, so a typed batch override (and its
        // pharmacist approval and reason) never travels with one.
        .refine((line) => !(line.scannedPack && line.override), {
          message: 'A scanned pack sets its own batch; send it without a batch override.',
          path: ['override'],
        })
    )
    .mutation(async ({ ctx, input }) => {
      // The input stays out of the audit row (it can carry a controlled PIN), but
      // the bill it targeted is named so a refused add can be traced (DEV-712).
      annotateAudit(ctx, {
        skipInput: true,
        targetType: 'PharmacySale',
        targetId: input.saleId,
        metadata: { branchId: input.branchId },
      });
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
        const scope = await requireCartWriteAccess(ctx, input.branchId);
        // #520: PINs are verified before the sale transaction takes a connection.
        const { lineInput, approvals } = await approvedLineInput(
          ctx,
          ctx.db as unknown as ScopedDb,
          scope,
          input
        );
        const outcome = await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
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
            // No stock is reserved while today's business day is closed.
            await requirePharmacyTodayOpenForTrading(db, scope);
            const { prescription } = input;
            // Recording a prescription fill is a pharmacist's act, whatever the medicine.
            if (
              prescription &&
              !(await can(subjectFromSession(ctx.session!.user), 'pharmacy:dispense', undefined, {
                db,
              }))
            )
              throw new PharmacyRxReferenceError('PRESCRIPTION_NEEDS_PHARMACIST');
            const replay = await replaySaleLine(db, scope, lineInput);
            if (replay) {
              // The counter's key omits the prescription, so a changed reference is a new request.
              if (
                replay.line.prescriptionLineId !== (prescription?.prescriptionLineId ?? null) ||
                replay.line.prescriptionPatientId !== (prescription?.patientId ?? null)
              )
                throw new PharmacySaleError('IDEMPOTENCY_CONFLICT');
              return replay;
            }
            for (const { kind, approval } of approvals)
              await confirmCounterApproval(db, scope, kind, approval);
            if (!prescription) return addSaleLine(db, scope, lineInput, COUNTER_LINE_PRICING);
            const units = input.quantity * input.canonicalUnitsPerSaleUnit;
            const reference = await resolvePrescriptionReference(db, scope, {
              ...prescription,
              saleId: input.saleId,
              medicineId: input.medicineId,
              presentationId: input.presentationId,
              units,
            });
            const result = await addSaleLine(db, scope, lineInput, COUNTER_LINE_PRICING);
            await attachPrescriptionReference(db, scope, {
              ...reference,
              saleLineId: result.line.id,
            });
            // DEV-629: queue the RX-03 pharmacist review; payment waits for its SIGN decision.
            await db.pharmacyPharmacistReviewItem.create({
              data: {
                organizationId: scope.organizationId,
                prescriptionLineId: reference.prescriptionLineId,
                saleLineId: result.line.id,
                requestedByUserId: scope.actorId,
              },
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
          const mayDispense = await can(
            subjectFromSession(ctx.session!.user),
            'pharmacy:dispense',
            undefined,
            { db }
          );
          const authorization = input.controlledAuthorization;
          // DEV-911: the pharmacist check at each sale is on unless the owner switched it off.
          // It is read only where today's gate would refuse (no dispense grant, or no
          // pharmacist authorization), so with the check on nothing below changes. While it is
          // off the line sells like any other item, and the controlled register still gets its
          // entry, marked as written with the check switched off by the owner.
          if (!mayDispense || !authorization) {
            const pharmacistCheck = await readPharmacistCheckPolicy(db, scope.organizationId);
            if (!pharmacistCheck.enabled) {
              await requirePharmacyTodayOpenForTrading(db, scope);
              const replay = await replaySaleLine(db, scope, lineInput);
              if (replay) return replay;
              for (const { kind, approval } of approvals)
                await confirmCounterApproval(db, scope, kind, approval);
              // DEV-825: the sale row is a document lock, so it precedes the register lock.
              await lockSaleForControlledLine(db, scope, input.saleId);
              await lockRegister(db, scope.organizationId, scope.branchId);
              const result = await addSaleLine(db, scope, lineInput, COUNTER_LINE_PRICING);
              await appendControlledSaleEntries(db, {
                organizationId: scope.organizationId,
                branchId: scope.branchId,
                movementIds: result.allocation.movementIds,
                patientId: null,
                patientAddress: null,
                medicineId: medicine.id,
                manufacturer: medicine.manufacturer,
                prescriberId: null,
                prescriberName: null,
                prescriberRegNo: null,
                prescriptionId: null,
                prescriptionLineId: null,
                emergency: false,
                rxSerialWritten: false,
                refEntryId: null,
                recordedByUserId: scope.actorId,
                witnessedByUserId: scope.actorId,
                signatureRef: pharmacistCheckOffSignature(pharmacistCheck.version),
              });
              annotateAudit(ctx, {
                metadata: {
                  pharmacistCheck: 'SWITCHED_OFF_BY_OWNER',
                  pharmacistCheckPolicyVersion: pharmacistCheck.version,
                  controlledSaleLineId: result.line.id,
                },
              });
              return result;
            }
          }
          if (!mayDispense) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'You do not have permission to dispense a controlled medicine.',
            });
          }
          const blocked = async () => ({
            blocked:
              (await approvalSecretKindFor(db, scope.organizationId)) === 'PIN'
                ? 'Controlled medicine requires the patient address, an independent pharmacist PIN, and either a valid prescription or an emergency supply with the prescriber name.'
                : 'Controlled medicine requires the patient address, an independent pharmacist authenticator code, and either a valid prescription or an emergency supply with the prescriber name.',
          });
          if (!authorization) return blocked();
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
            return blocked();
          if (!(await can(pharmacist, 'pharmacy:dispense', undefined, { db, now })))
            return blocked();
          if (
            !(await verifyApprovalSecret(db, {
              organizationId: scope.organizationId,
              approverUserId: pharmacist.id,
              credentialHash: credential.credentialHash,
              secret: authorization.pin,
              action: 'pharmacySales.controlledAuthorization',
              approverRight: 'pharmacy:dispense',
              requestedById: scope.actorId,
              now,
            }))
          ) {
            await db.restaurantOperatorCredential.update({
              where: { id: credential.id },
              data: registerFailedAttempt(credential, now),
            });
            return blocked();
          }
          await db.restaurantOperatorCredential.update({
            where: { id: credential.id },
            data: clearLockout(),
          });
          // Check the actor and witness before taking the day lock. The day lock
          // still precedes document/register locks and every stock allocation.
          await requirePharmacyTodayOpenForTrading(db, scope);
          // A retry is validated like a new request before replay, so an unknown earlier
          // serial is refused either way.
          const refEntry = await earlierRegisterEntry(db, scope, authorization.refSerial);
          if (authorization.refSerial && !refEntry) {
            return { blocked: 'That earlier register serial is not on this branch.' };
          }
          // Resolve the address only for this witnessed supply. The routine patient panel
          // never needs to read it, and the controlled response never returns it.
          const resolveAddress = async () => {
            if (typeof authorization.patientAddress === 'string')
              return authorization.patientAddress;
            const patient = await db.pharmacyPatient.findFirst({
              where: { id: authorization.patientId, organizationId: scope.organizationId },
              select: { address: true },
            });
            await recordAudit(
              {
                organizationId: scope.organizationId,
                actorId: scope.actorId,
                source: 'TRPC',
                category: 'PHARMACY_PATIENT',
                operation: 'READ',
                action: 'pharmacy.patient.controlledAddress.read',
                targetType: 'PharmacyPatient',
                targetId: authorization.patientId,
                metadata: {
                  branchId: scope.branchId,
                  saleId: input.saleId,
                  witnessedByUserId: pharmacist.id,
                },
              },
              db
            );
            const address = controlledAddress.safeParse(patient?.address);
            return address.success ? address.data : null;
          };
          const addressRequired = {
            blocked:
              'Enter the patient address for this supply. The address on file is missing or incomplete.',
          };
          // DEV-874: a retry replays only after the independent pharmacist PIN passes again,
          // so a missing or wrong PIN never returns the saved controlled line.
          const replay = await replaySaleLine(db, scope, lineInput);
          if (replay) {
            // The counter key omits the patient and dispensing authority, so a retry must
            // carry every detail the register recorded for this line.
            const recorded = await db.pharmacyControlledRegisterEntry.findMany({
              where: {
                organizationId: scope.organizationId,
                stockMovementId: { in: replay.allocation.movementIds },
              },
              select: {
                patientId: true,
                patientAddress: true,
                prescriptionLineId: true,
                emergency: true,
                prescriberName: true,
                prescriberRegNo: true,
                rxSerialWritten: true,
                refEntryId: true,
              },
            });
            if (
              recorded.length === 0 ||
              recorded.some((entry) => entry.patientId !== authorization.patientId)
            )
              throw new PharmacySaleError('IDEMPOTENCY_CONFLICT');
            const patientAddress = await resolveAddress();
            const emergency = authorization.emergency;
            const prescriptionLineId = emergency
              ? null
              : (authorization.prescriptionLineId ?? null);
            if (
              !patientAddress ||
              recorded.some(
                (entry) =>
                  entry.patientAddress !== patientAddress ||
                  entry.emergency !== emergency ||
                  entry.prescriptionLineId !== prescriptionLineId ||
                  entry.rxSerialWritten !== authorization.rxSerialWritten ||
                  entry.refEntryId !== (refEntry?.id ?? null) ||
                  // A prescription fill snapshots its prescriber from the prescription line.
                  (emergency &&
                    (entry.prescriberName !== (authorization.prescriberName ?? null) ||
                      entry.prescriberRegNo !== (authorization.prescriberRegNo ?? null)))
              )
            )
              throw new PharmacySaleError('IDEMPOTENCY_CONFLICT');
            return replay;
          }
          for (const { kind, approval } of approvals)
            await confirmCounterApproval(db, scope, kind, approval);
          if (authorization.emergency) {
            const patient = await db.pharmacyPatient.findFirst({
              where: { id: authorization.patientId, organizationId: scope.organizationId },
              select: { cnic: true },
            });
            if (!patient?.cnic?.trim() || !authorization.prescriberName) return blocked();
            const units = input.quantity * input.canonicalUnitsPerSaleUnit;
            const regulatoryProfile = await db.branchRegulatoryProfile.findFirst({
              where: {
                organizationId: scope.organizationId,
                branchId: scope.branchId,
                // DEV-298: the profile dated today applies from the workspace's local midnight.
                ...regulatoryProfileInForceWhere(now, ctx.organization?.timezone),
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
            const patientAddress = await resolveAddress();
            if (!patientAddress) return addressRequired;
            // DEV-825: the sale row is a document lock, so it precedes the register
            // lock (stock-lock-order.ts); a concurrent void takes them in that order.
            await lockSaleForControlledLine(db, scope, input.saleId);
            await lockRegister(db, scope.organizationId, scope.branchId);
            const result = await addSaleLine(db, scope, lineInput, COUNTER_LINE_PRICING);
            await appendControlledSaleEntries(db, {
              organizationId: scope.organizationId,
              branchId: scope.branchId,
              movementIds: result.allocation.movementIds,
              patientId: authorization.patientId,
              patientAddress,
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
          if (!authorization.prescriptionLineId) return blocked();
          // Lock prescription and branch before stock allocation, fill numbering and register numbering.
          await db.$queryRaw`SELECT id FROM pharmacy_prescription_lines WHERE "organizationId"=${scope.organizationId} AND id=${authorization.prescriptionLineId} FOR UPDATE`;
          await lockSaleForControlledLine(db, scope, input.saleId);
          await lockRegister(db, scope.organizationId, scope.branchId);
          const rx = await db.prescriptionLine.findFirst({
            where: {
              id: authorization.prescriptionLineId,
              organizationId: scope.organizationId,
              medicineId: input.medicineId,
              presentationId: input.presentationId,
            },
            include: {
              prescription: { include: { patient: { select: { cnic: true } }, prescriber: true } },
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
            return blocked();
          const units = input.quantity * input.canonicalUnitsPerSaleUnit;
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
          const patientAddress = await resolveAddress();
          if (!patientAddress) return addressRequired;
          const result = await addSaleLine(db, scope, lineInput, COUNTER_LINE_PRICING);
          await db.prescriptionFill.create({
            data: {
              organizationId: scope.organizationId,
              // DEV-962: the dispensing branch, so only it records this fill's refill reminder.
              branchId: scope.branchId,
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
            patientAddress,
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
        const scannedOutOfOrder = Boolean(
          input.scannedPack && 'line' in outcome && outcome.allocation.overrideId
        );
        // DEV-843: a scanned pack sold out of FEFO order is the same safety decision.
        if (scannedOutOfOrder && !input.override) labelScannedPackFefo(ctx, input, 'sold');
        if ('line' in outcome && (input.override || scannedOutOfOrder)) {
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
        if (
          !input.override &&
          error instanceof PharmacySerializedPackError &&
          error.reason === 'SERIAL_FEFO_APPROVAL_REQUIRED'
        )
          labelScannedPackFefo(ctx, input, 'refused');
        else if (
          input.scannedPack?.approval &&
          error instanceof CounterApprovalDenied &&
          error.kind === 'SCANNED_PACK_FEFO'
        )
          labelScannedPackFefo(ctx, input, 'pin_refused');
        fail(error);
      }
    }),
  // DEV-977B (Counter v2): the quantity and sale unit of a bill line are changed on the line
  // itself. The same builder and branch gate as `addLine`; the Rx/restricted grant and the
  // trading-day gate are checked as an add checks them, and the domain refuses a line with
  // dispensing records, an approval tied to its quantity, a held/closed or paid bill, and
  // another cashier's bill unless the actor is a manager or owner (as a void does).
  changeLine: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1),
          saleLineId: z.string().trim().min(1).max(128),
          packLevelId: z.string().min(1),
          saleUnit,
          quantity: z.number().int().positive(),
          canonicalUnitsPerSaleUnit: z.number().int().positive(),
          idempotencyKey: z.string().trim().min(1).max(160),
          // DEV-958B: the counter device whose drawer's shift must be open on a shift branch.
          deviceId: z.string().min(1).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, {
        targetType: 'PharmacySale',
        targetId: input.saleId,
        metadata: { branchId: input.branchId, saleLineId: input.saleLineId },
      });
      try {
        const scope = await requireCartWriteAccess(ctx, input.branchId);
        const outcome = await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          await requirePharmacyTodayOpenForTrading(db, scope);
          await assertLineMedicineSellable(db, scope, input.saleLineId);
          return changeSaleLine(db, scope, {
            ...input,
            actorIsManager: await actorMayRefund(db, ctx.session!.user),
            cashShift: (bill) => lineChangeCashShift(db, scope, input.deviceId, bill),
          });
        });
        if (outcome.replacedSaleLineId)
          annotateAudit(ctx, {
            metadata: {
              replacedSaleLineId: outcome.replacedSaleLineId,
              saleLineId: outcome.line.id,
            },
          });
        return outcome;
      } catch (error) {
        fail(error);
      }
    }),
  // DEV-977B (Counter v2): takes one line off an open, unpaid bill, with the gates of `changeLine`.
  removeLine: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1),
          saleLineId: z.string().trim().min(1).max(128),
          idempotencyKey: z.string().trim().min(1).max(160),
          // DEV-958B: the counter device whose drawer's shift must be open on a shift branch.
          deviceId: z.string().min(1).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, {
        targetType: 'PharmacySale',
        targetId: input.saleId,
        metadata: { branchId: input.branchId, saleLineId: input.saleLineId },
      });
      try {
        const scope = await requireCartWriteAccess(ctx, input.branchId);
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          await requirePharmacyTodayOpenForTrading(db, scope);
          await assertLineMedicineSellable(db, scope, input.saleLineId);
          return removeSaleLine(db, scope, {
            ...input,
            actorIsManager: await actorMayRefund(db, ctx.session!.user),
            cashShift: (bill) => lineChangeCashShift(db, scope, input.deviceId, bill),
          });
        });
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
          reason: z.string().trim().min(1).max(500).optional(),
          // DEV-508: a counter void must say why, from the fixed reason codes.
          voidReason: saleVoidReasonSchema.optional(),
          controlledWitness: z
            .object({ staffProfileId: z.string().min(1), pin: z.string().regex(/^\d{4,8}$/) })
            .strict()
            .optional(),
        })
        .strict()
        .superRefine((value, issue) => {
          if (value.action === 'void' && !value.voidReason)
            issue.addIssue({
              code: 'custom',
              path: ['voidReason'],
              message: 'Choose a reason for this void.',
            });
          if (value.action === 'void' && value.reason !== undefined)
            issue.addIssue({
              code: 'custom',
              path: ['reason'],
              message: 'A void takes its reason from voidReason.',
            });
          if (value.action !== 'void' && value.voidReason)
            issue.addIssue({
              code: 'custom',
              path: ['voidReason'],
              message: 'Only a void takes a void reason.',
            });
        })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const scope = await requireCartWriteAccess(ctx, input.branchId);
        return await ctx.db.$transaction(async (tx) => {
          try {
            const db = txDb(tx);
            const voidReason = input.action === 'void' ? input.voidReason : undefined;
            return await changeSaleStatus(
              db,
              scope,
              input.saleId,
              input.action,
              {
                kind: 'COUNTER',
                // DEV-821: only the bill's cashier or a manager/owner may void it.
                actorIsManager:
                  input.action === 'void' && (await actorMayRefund(db, ctx.session!.user)),
              },
              voidReason ? saleVoidReasonText(voidReason) : input.reason,
              input.controlledWitness,
              ...(voidReason
                ? [
                    {
                      voidReasonCode: voidReason.code,
                      ...(voidReason.note ? { voidNote: voidReason.note } : {}),
                    },
                  ]
                : [])
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
      const withLabels = async <T extends { branchId: string; receiptDeviceId: string | null }>(
        rows: T[]
      ) => {
        const ids = [
          ...new Set(rows.flatMap((row) => (row.receiptDeviceId ? [row.receiptDeviceId] : []))),
        ];
        const devices = ids.length
          ? await ctx.db.pharmacyRegisteredDevice.findMany({
              where: { organizationId: scope.organizationId, id: { in: ids } },
              select: { id: true, branchId: true, name: true },
            })
          : [];
        return rows.map((row) => ({
          ...row,
          counterLabel: counterLabel(
            row.receiptDeviceId,
            devices.find((d) => d.id === row.receiptDeviceId && d.branchId === row.branchId)?.name
          ),
        }));
      };
      if (!otherBranches.length || active.length === 50) return withLabels(active);
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
      return withLabels([...active, ...others]);
    }),
  /** DEV-501: the exact refund a proposed return is worth, so the counter can prefill it. */
  returnQuote: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleLineId: z.string().min(1),
          lotId: z.string().min(1).optional(),
          canonicalUnits: z.number().int().positive(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      try {
        const scope = await requireCounterReceiptAccess(ctx, input.branchId);
        const { branchId: _branch, ...quote } = input;
        void _branch;
        return await quoteSaleLineReturn(ctx.db, scope, quote);
      } catch (error) {
        fail(error);
      }
    }),
  returnHistory: protectedProcedure
    .input(z.object({ branchId, saleId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      try {
        const scope = await requireCounterReceiptAccess(ctx, input.branchId);
        const history = await readReturnHistory(ctx.db, scope, input.saleId);
        // DEV-911: the return panel asks for no pharmacist witness while the owner has the
        // check off. The server reads the setting again when the return is recorded.
        const pharmacistCheck = await readPharmacistCheckPolicy(
          ctx.db as unknown as ScopedDb,
          scope.organizationId
        );
        return pharmacistCheck.enabled
          ? history
          : { ...history, pharmacistCheckOff: true as const };
      } catch (error) {
        fail(error);
      }
    }),
  returnLines: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1),
          requestId: z.uuid(),
          reason: z.string().trim().min(1).max(500),
          managerPin: z.string().regex(/^\d{4,8}$/),
          controlledWitness: counterApprovalPin.optional(),
          lines: z
            .array(
              z
                .object({
                  saleLineId: z.string().min(1),
                  canonicalUnits: z.number().int().positive(),
                  lotId: z.string().min(1).optional(),
                  disposition: z.enum(['RESTOCK', 'QUARANTINE']),
                  quarantineLocationId: z.string().min(1).optional(),
                  integrityDecision: z.string().trim().min(1).max(500),
                })
                .strict()
            )
            .min(2)
            .max(100),
          refund: z
            .object({
              originalTenderId: z.string().min(1),
              deviceId: z.string().min(1),
              businessDate: z.date(),
              amountMinor: z.number().int().positive().optional(),
              manualCashFallback: z.boolean(),
            })
            .strict()
            .optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, { skipInput: true, targetType: 'PharmacySale', targetId: input.saleId });
      try {
        const scope = await requireCounterReceiptAccess(ctx, input.branchId);
        if (!(await actorMayRefund(ctx.db, ctx.session!.user)))
          throw new TRPCError({ code: 'FORBIDDEN', message: RETURN_FORBIDDEN });
        const { managerPin, ...request } = input;
        const pin = await authenticateRefundPin({
          organizationId: scope.organizationId,
          actorId: scope.actorId,
          pin: managerPin,
          action: 'pharmacySales.returnLines',
        });
        annotateAudit(ctx, {
          metadata: refundApprovalAudit({
            initiatedById: scope.actorId,
            approverId: scope.actorId,
            pin,
          }),
        });
        if ('blocked' in pin) return { blocked: RETURN_PIN_BLOCKED };
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          const refund = request.refund;
          if (
            refund &&
            !(await db.pharmacyTender.findFirst({
              where: {
                id: refund.originalTenderId,
                organizationId: scope.organizationId,
                branchId: scope.branchId,
                saleId: request.saleId,
              },
              select: { id: true },
            }))
          )
            throw new PharmacySaleError('CROSS_BRANCH_REFERENCE');
          let result;
          try {
            result = await returnSaleLines(db, scope, request);
          } catch (e) {
            // The group verifies its witness before its first stock or return write.
            if (e instanceof ControlledRestorationDenied && !e.forbidden)
              return { blocked: e.message };
            throw e;
          }
          if (!refund) return result;
          const amountMinor = refund.amountMinor ?? result.returnedMinor;
          if (amountMinor <= 0 || amountMinor > result.returnedMinor)
            throw new PharmacySettlementError('REFUND_EXCEEDS_TENDER');
          const paid = await refundTenderInTransaction(
            ctx,
            db,
            scope,
            {
              ...refund,
              amountMinor,
              reason: request.reason,
              idempotencyKey: result.returnId + ':refund',
            },
            true
          );
          return { ...result, refund: paid };
        });
      } catch (e) {
        fail(e);
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
          disposition: z.enum(['RESTOCK', 'QUARANTINE']),
          reason: z.string().trim().min(1),
          integrityDecision: z.string().trim().min(1),
          idempotencyKey: z.string().trim().min(1),
          // DEV-621: the signed-in manager's or owner's own PIN, re-entered for every return.
          managerPin: z.string().regex(/^\d{4,8}$/),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const scope = await requireCounterReceiptAccess(ctx, input.branchId);
        // DEV-621: a return restocks stock and posts the refund liability, so a cashier
        // alone cannot record one. A manager or owner (a solo owner included) re-enters
        // their own PIN, exactly as for refundTender.
        if (!(await actorMayRefund(ctx.db, ctx.session!.user)))
          throw new TRPCError({ code: 'FORBIDDEN', message: RETURN_FORBIDDEN });
        // The PIN never reaches the return's idempotency payload.
        const { managerPin, ...line } = input;
        // An independent transaction, so a refused PIN commits its lockout strike.
        const pin = await authenticateRefundPin({
          organizationId: scope.organizationId,
          actorId: scope.actorId,
          pin: managerPin,
          action: 'pharmacySales.returnLine',
        });
        annotateAudit(ctx, {
          metadata: refundApprovalAudit({
            initiatedById: scope.actorId,
            approverId: scope.actorId,
            pin,
          }),
        });
        if ('blocked' in pin) return { blocked: RETURN_PIN_BLOCKED };
        return await ctx.db.$transaction(async (tx) => {
          try {
            return await returnSaleLine(txDb(tx), scope, line);
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
  /**
   * DEV-501: record one returned line and refund it to an original tender with a single
   * manager/owner PIN and a single confirm. Both run in one transaction, so a refused refund
   * (closed day, no open drawer, tender or returned-value cap) also leaves no return behind.
   * The same gates apply as for returnLine and refundTender: counter receipt access, a manager
   * or owner (a solo owner included) re-entering their own PIN, the controlled-medicine witness,
   * and the active branch scope. The refund is bounded by this return's own value.
   */
  returnAndRefund: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleLineId: z.string().min(1),
          controlledWitness: z
            .object({ staffProfileId: z.string().min(1), pin: z.string().regex(/^\d{4,8}$/) })
            .strict()
            .optional(),
          lotId: z.string().min(1).optional(),
          canonicalUnits: z.number().int().positive(),
          quarantineLocationId: z.string().min(1).optional(),
          disposition: z.enum(['RESTOCK', 'QUARANTINE']),
          reason: z.string().trim().min(1),
          integrityDecision: z.string().trim().min(1),
          idempotencyKey: z.string().trim().min(1).max(120),
          refund: z
            .object({
              originalTenderId: z.string().min(1),
              deviceId: z.string().min(1),
              businessDate: z.date(),
              // Omitted: refund this return's full value. Otherwise at most that value.
              amountMinor: z.number().int().positive().optional(),
              manualCashFallback: z.boolean().optional(),
            })
            .strict(),
          managerPin: z.string().regex(/^\d{4,8}$/),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const scope = await requireCounterReceiptAccess(ctx, input.branchId);
        if (!(await actorMayRefund(ctx.db, ctx.session!.user)))
          throw new TRPCError({ code: 'FORBIDDEN', message: RETURN_FORBIDDEN });
        // The PIN never reaches either idempotency payload.
        const { managerPin, refund, ...line } = input;
        // An independent transaction, so a refused PIN commits its lockout strike.
        const pin = await authenticateRefundPin({
          organizationId: scope.organizationId,
          actorId: scope.actorId,
          pin: managerPin,
          action: 'pharmacySales.returnAndRefund',
        });
        annotateAudit(ctx, {
          metadata: refundApprovalAudit({
            initiatedById: scope.actorId,
            approverId: scope.actorId,
            pin,
          }),
        });
        if ('blocked' in pin) return { blocked: RETURN_PIN_BLOCKED };
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          // The refund settles this return's own receipt, never another sale's liability.
          const soldLine = await db.pharmacySaleLine.findFirst({
            where: {
              id: line.saleLineId,
              organizationId: scope.organizationId,
              branchId: scope.branchId,
            },
            select: { saleId: true },
          });
          if (!soldLine) throw new PharmacySaleError('NOT_FOUND');
          const sameSaleTender = await db.pharmacyTender.findFirst({
            where: {
              id: refund.originalTenderId,
              organizationId: scope.organizationId,
              branchId: scope.branchId,
              saleId: soldLine.saleId,
            },
            select: { id: true },
          });
          if (!sameSaleTender)
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Refund the return to a tender from the same receipt.',
            });
          let returned: Awaited<ReturnType<typeof returnSaleLine>>;
          try {
            returned = await returnSaleLine(db, scope, line);
          } catch (error) {
            if (error instanceof ControlledRestorationDenied && !error.forbidden)
              return { blocked: error.message };
            throw error;
          }
          const valueMinor = await saleReturnValueMinor(db, scope, returned.returnId);
          const amountMinor = refund.amountMinor ?? valueMinor;
          if (amountMinor <= 0 || amountMinor > valueMinor)
            throw new PharmacySettlementError('REFUND_EXCEEDS_TENDER');
          const refunded = await refundTenderInTransaction(
            ctx,
            db,
            scope,
            {
              originalTenderId: refund.originalTenderId,
              deviceId: refund.deviceId,
              businessDate: refund.businessDate,
              amountMinor,
              reason: line.reason,
              idempotencyKey: `${line.idempotencyKey}:refund`,
              ...(refund.manualCashFallback === undefined
                ? {}
                : { manualCashFallback: refund.manualCashFallback }),
            },
            true
          );
          return {
            returnId: returned.returnId,
            returnedMinor: valueMinor,
            refund: refunded,
            replayed: returned.replayed,
          };
        });
      } catch (error) {
        fail(error);
      }
    }),
  recordCounterDemand: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1).optional(),
          requestId: z.uuid(),
          requestedText: z.string().trim().min(1).max(250),
          requestedMedicineId: z.string().min(1).optional(),
          quantity: z.number().int().positive().max(MAX_COUNTER_DEMAND_QUANTITY),
          reason: z.enum([
            'STOCKOUT',
            'NOT_CARRIED',
            'PACK_UNAVAILABLE',
            'PRICE_REJECTED',
            'SUBSTITUTE_DECLINED',
          ]),
          followUp: z
            .object({
              customerId: z.string().min(1),
              channel: z.enum(['SMS', 'WHATSAPP']),
              reserveOnArrival: z.boolean(),
            })
            .strict()
            .optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const { branchId, ...request } = input;
        const scope = await requireCounterReceiptAccess(ctx, branchId, true);
        return await ctx.db.$transaction((tx) => recordCounterDemand(txDb(tx), scope, request));
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
          // DEV-81 lost-sales capture. Price, visit and loss are server-derived.
          terminalId: z.string().trim().min(1).max(128).optional(),
          requestedQty: z.number().int().positive().optional(),
          outcome: lostSaleOutcome.optional(),
          notifyOptIn: z.boolean().optional(),
          notifyPhone: notifyPhone.optional(),
          freeText: z.string().trim().max(500).optional(),
          matchedProductId: z.string().min(1).optional(),
          matchConfidence: z.number().min(0).max(1).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const { branchId: branch, ...demand } = input;
        // DEV-817: the counter's gate, before any demand row is written.
        const scope = await requireCounterReceiptAccess(ctx, branch, true);
        const event = demand.saleId
          ? await ctx.db.$transaction((tx) =>
              captureDemand(txDb(tx), scope, { ...demand, shareBillDemand: true })
            )
          : await captureDemand(ctx.db, scope, demand);
        return redactDemandContact(event);
      } catch (error) {
        fail(error);
      }
    }),
  /**
   * DEV-81: one tap on a counter outcome chip. Optional; never gates tender.
   * DEV-817: the counter's gate (canonical `pharmacy:counter`, the deny-wins
   * counter family and an active branch assignment) runs before the event is
   * read, so a member without counter access cannot relabel an outcome or touch
   * the customer's notify-when-back phone. The phone is never echoed back.
   */
  setDemandOutcome: protectedProcedure
    .input(
      z
        .object({
          branchId,
          demandId: z.string().min(1),
          outcome: lostSaleOutcome,
          substituteProductId: z.string().min(1).optional(),
          notifyOptIn: z.boolean().optional(),
          notifyPhone: notifyPhone.optional(),
          freeText: z.string().trim().max(500).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const { branchId: branch, ...outcome } = input;
        const scope = await requireCounterReceiptAccess(ctx, branch, true);
        return redactDemandContact(await setDemandOutcome(ctx.db, scope, outcome));
      } catch (error) {
        fail(error);
      }
    }),
  /**
   * DEV-81: flips unanswered WILL_RETURN lines after 7 days and refreshes estimates.
   * DEV-817: it rewrites the branch's lost-sales estimates, so it takes the same
   * manager or owner gate (and active branch assignment) as `lostSalesSummary`.
   */
  settleLostSales: protectedProcedure
    .input(z.object({ branchId }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const scope = await requireDrawerManagerAccess(ctx, input.branchId);
        return await settleLostSales(ctx.db, scope);
      } catch (error) {
        fail(error);
      }
    }),
  /** DEV-81: estimated lost sales by visit; a manager or owner view. */
  lostSalesSummary: protectedProcedure
    .input(z.object({ branchId, from: z.date(), to: z.date() }).strict())
    .query(async ({ ctx, input }) =>
      lostSalesSummary(
        ctx.db,
        await requireDrawerManagerAccess(ctx, input.branchId),
        input.from,
        input.to
      )
    ),
  /**
   * DEV-81: the branch's estimate parameters. The 0.43 default is an
   * illustrative grocery-study figure, so a manager or owner (a solo owner
   * holds `pharmacy:manage`) may tune it; every change is audited.
   */
  updateLostSalesSettings: protectedProcedure
    .input(
      z
        .object({
          branchId,
          unknownLossProbability: z.number().min(0).max(1).optional(),
          measuredRateMinEvents: z.number().int().min(1).max(100_000).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await requireDrawerManagerAccess(ctx, input.branchId);
      try {
        const { branchId: branch, ...settings } = input;
        const result = await updateLostSalesSettings(ctx.db, scope, settings);
        annotateAudit(ctx, {
          category: 'PHARMACY',
          action: 'lost_sales_settings_updated',
          targetType: 'PharmacyBranch',
          targetId: branch,
          description: 'Lost-sales estimate parameters changed.',
          metadata: { branchId: branch, ...settings },
        });
        return result;
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
        return await findSubstituteProposals(
          ctx.db,
          await assignedBranchScope(ctx, input.branchId),
          input
        );
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
  /** #727: every promotion of a branch, newest first, including disabled ones. */
  promotions: capabilityProcedure('pharmacy:manage')
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await promotionScope(ctx, input.branchId);
      const rows = await ctx.db.pharmacyPromotion.findMany({
        where: { organizationId: scope.organizationId, branchId: scope.branchId },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: 200,
      });
      // QA-8: the counter skips a promotion whose creator no longer qualifies; say so here.
      const qualifies = new Map<string, boolean>();
      for (const row of rows) {
        if (!qualifies.has(row.createdByUserId))
          qualifies.set(
            row.createdByUserId,
            await promotionCreatorMayManage(
              ctx.db,
              scope.organizationId,
              scope.branchId,
              row.createdByUserId
            )
          );
      }
      return rows.map((row) => {
        const creatorQualifies = qualifies.get(row.createdByUserId) === true;
        return {
          ...row,
          creatorQualifies,
          inactiveReason:
            row.active && !creatorQualifies
              ? ('The creator no longer holds the manage right for this branch.' as const)
              : null,
        };
      });
    }),
  /**
   * #727: publish a dated promotion. The creating manager authorizes every discount it
   * grants, so it is recorded as the line approver. A medicine target must be saleable and
   * non-regulated; the counter also never applies a promotion to an Rx, restricted or
   * controlled medicine.
   */
  createPromotion: capabilityProcedure('pharmacy:manage')
    .input(pharmacyPromotionInput)
    .mutation(async ({ ctx, input }) => {
      const scope = await promotionScope(ctx, input.branchId);
      if (input.medicineId) {
        const medicine = await ctx.db.medicine.findFirst({
          where: { id: input.medicineId, organizationId: scope.organizationId, saleable: true },
          select: { rx: true, restricted: true, controlled: true },
        });
        if (!medicine || medicine.rx || medicine.restricted || medicine.controlled)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Choose a saleable medicine that is not Rx, restricted or controlled.',
          });
      }
      annotateAudit(ctx, {
        action: 'pharmacy_promotion_created',
        targetType: 'PharmacyPromotion',
        metadata: {
          branchId: scope.branchId,
          medicineId: input.medicineId ?? null,
          effectiveFrom: input.effectiveFrom.toISOString(),
          effectiveTo: input.effectiveTo.toISOString(),
          benefitBasisPoints: input.benefitBasisPoints ?? null,
          benefitMinor: input.benefitMinor ?? null,
        },
      });
      const promotion = await ctx.db.pharmacyPromotion.create({
        data: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          name: input.name,
          medicineId: input.medicineId ?? null,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          benefitBasisPoints: input.benefitBasisPoints ?? null,
          benefitMinor: input.benefitMinor ?? null,
          priority: input.priority,
          createdByUserId: scope.actorId,
        },
      });
      annotateAudit(ctx, { targetId: promotion.id });
      return promotion;
    }),
  /** #727: one-way disable. Lines already priced keep their discount and receipt name. */
  disablePromotion: capabilityProcedure('pharmacy:manage')
    .input(z.object({ branchId, promotionId: z.string().trim().min(1).max(128) }).strict())
    .mutation(async ({ ctx, input }) => {
      const scope = await promotionScope(ctx, input.branchId);
      annotateAudit(ctx, {
        action: 'pharmacy_promotion_disabled',
        targetType: 'PharmacyPromotion',
        targetId: input.promotionId,
      });
      const disabled = await ctx.db.pharmacyPromotion.updateMany({
        where: {
          id: input.promotionId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          active: true,
        },
        data: { active: false, disabledAt: new Date(), disabledByUserId: scope.actorId },
      });
      if (disabled.count !== 1)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Active promotion not found.' });
      return { promotionId: input.promotionId, active: false };
    }),
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
      findUpsellSuggestions(ctx.db, await assignedBranchScope(ctx, input.branchId), {
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
        // DEV-817: the counter's gate, before any demand row is written.
        const scope = await requireCounterReceiptAccess(ctx, input.branchId, true);
        return await ctx.db.$transaction(async (tx) => {
          const event = await captureDemand(txDb(tx), scope, {
            ...input,
            reason: 'SUBSTITUTE_DECLINED',
          });
          return redactDemandContact(await declineSubstitute(txDb(tx), scope, event.id));
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
      const scope = await requireCartWriteAccess(ctx, input.branchId);
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
        // DEV-817: the counter's gate, before the demand row is read.
        const scope = await requireCounterReceiptAccess(ctx, input.branchId, true);
        return redactDemandContact(
          await recoverDemandWithAlternate(ctx.db, scope, input.demandId, input.saleLineId)
        );
      } catch (error) {
        fail(error);
      }
    }),
  demandAggregate: protectedProcedure
    .input(z.object({ branchId, from: z.date(), to: z.date() }).strict())
    // DEV-817: a branch report with estimated value and margin; manager or owner only.
    .query(async ({ ctx, input }) =>
      demandAggregate(
        ctx.db,
        await requireDrawerManagerAccess(ctx, input.branchId),
        input.from,
        input.to
      )
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
        // DEV-817: restock interests hang off demand events; the counter's gate.
        const scope = await requireCounterReceiptAccess(ctx, input.branchId, true);
        return await ctx.db.$transaction(async (tx) => addRestockInterest(txDb(tx), scope, input));
      } catch (error) {
        fail(error);
      }
    }),
  captureSafeRestockArrival: protectedProcedure
    .input(z.object({ branchId, inventoryLotId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        // DEV-817: restock interests hang off demand events; the counter's gate.
        const scope = await requireCounterReceiptAccess(ctx, input.branchId, true);
        const captured = await ctx.db.$transaction(async (tx) =>
          captureSafeRestockArrival(txDb(tx), scope, input)
        );
        return captured.map(redactRestockArrival);
      } catch (error) {
        fail(error);
      }
    }),
  optOutRestockInterest: protectedProcedure
    .input(z.object({ branchId, interestId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        // DEV-817: restock interests hang off demand events; the counter's gate.
        const scope = await requireCounterReceiptAccess(ctx, input.branchId, true);
        return await ctx.db.$transaction(async (tx) =>
          optOutRestockInterest(txDb(tx), scope, input.interestId)
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
        // DEV-817: restock interests hang off demand events; the counter's gate.
        const scope = await requireCounterReceiptAccess(ctx, input.branchId, true);
        return await ctx.db.$transaction(async (tx) =>
          recoverRestockInterest(txDb(tx), scope, input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  /** DEV-79: link notified requests to the sale that recovered them (also run by the job). */
  linkRestockRecoveries: protectedProcedure
    .input(z.object({ branchId }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const scope = await requireCounterReceiptAccess(ctx, input.branchId, true);
        return await ctx.db.$transaction(async (tx) => linkRestockRecoveries(txDb(tx), scope));
      } catch (error) {
        fail(error);
      }
    }),
  restockRecoveryReport: protectedProcedure
    .input(
      z.object({ branchId, campaignKey: z.string().trim().min(1).max(160).optional() }).strict()
    )
    // DEV-817: a branch report over demand events; manager or owner only.
    .query(async ({ ctx, input }) =>
      restockRecoveryReport(
        ctx.db,
        await requireDrawerManagerAccess(ctx, input.branchId),
        input.campaignKey
      )
    ),

  // ── PH-POS counter reads (POS-01, POS-02, POS-08) ─────────────────────────

  /**
   * DEV-97: whether the counter offers the drawer and payment controls. Presentation
   * only: openDrawer and tender keep their own `pharmacy:counter` checks.
   */
  settlementAccess: protectedProcedure.query(async ({ ctx }) => ({
    userId: ctx.session.user.id,
    organizationId: ctx.session.user.organizationId,
    authorized: await can(subjectFromSession(ctx.session.user), 'pharmacy:counter', undefined, {
      db: ctx.db,
    }),
  })),

  /** DEV-647: whether the counter offers refunds. refundTender enforces the same rule. */
  refundAccess: protectedProcedure.query(async ({ ctx }) => ({
    authorized: await actorMayRefund(ctx.db, ctx.session.user),
  })),
  /**
   * DEV-631: whether Day close offers "Reopen day for trading" on this branch: the
   * same branch-scoped owner-or-manager gate as `reopenDay` (`pharmacy:manage`,
   * deny wins, an active branch assignment or the audited administrator exception),
   * so the form is never offered where the reopen would be refused. `reopenDay`
   * still re-checks all of it and the PIN.
   */
  dayReopenAccess: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      try {
        await requireDrawerManagerAccess(ctx, input.branchId);
        return { authorized: true };
      } catch (error) {
        if (error instanceof TRPCError && error.code === 'FORBIDDEN') return { authorized: false };
        throw error;
      }
    }),

  /**
   * The branches this counter may open a bill against, with the money format.
   * DEV-830 (F04): the caller's active assignments, as the counter's gate admits them;
   * a session ADMIN of this organization keeps every active branch.
   */
  counterBranches: protectedProcedure.query(async ({ ctx }) => {
    const organizationId = ctx.entitlements?.organizationId;
    if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
    const user = ctx.session.user;
    const orgAdmin = user.role === 'ADMIN' && user.organizationId === organizationId;
    const [branches, organization] = await Promise.all([
      ctx.db.pharmacyBranch.findMany({
        where: {
          organizationId,
          active: true,
          ...(orgAdmin
            ? {}
            : {
                branchAssignments: {
                  some: { organizationId, userId: user.id, active: true },
                },
              }),
        },
        // DEV-958A: the hour each branch's business day ends at, so the counter stamps the
        // same day the server checks.
        select: {
          id: true,
          code: true,
          name: true,
          city: true,
          provinceCode: true,
          businessDayEndsAtHistory: true,
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      ctx.db.organization.findUnique({
        where: { id: organizationId },
        select: { currency: true, timezone: true },
      }),
    ]);
    return {
      // DEV-958A: each branch's day-end history as days and hours only, never who set it.
      branches: branches.map(withClientPharmacyDayEnd),
      currency: organization?.currency ?? 'PKR',
      // The workspace's zone: the day close picks "today" in it before any
      // close has been read. A stored value Intl refuses is handed over as UTC.
      timezone: workspaceTimezone(organization?.timezone),
      paymentSandboxAvailable: ctx.session.user.role === 'ADMIN' && paymentSandboxAdmitted(),
      // DEV-860: a member who is not an administrator and lists no branch is not assigned
      // to any active branch. That names only the caller's own standing: nothing about
      // which branches exist or who else is assigned. An administrator sees every active
      // branch, so an empty list for them means no branch is set up.
      setupReason: !orgAdmin && branches.length === 0 ? BRANCH_NOT_ASSIGNED : null,
      canFixSetup: orgAdmin,
    };
  }),

  /**
   * DEV-505: the branches the day-close screen offers, from the same decision as
   * `requireCloseAccess`. A Manager sees only their assigned branches; a member
   * with no day-close reach is refused, so the screen never offers a branch the
   * close itself would refuse.
   */
  dayCloseBranches: protectedProcedure.query(async ({ ctx }) => {
    const organizationId = ctx.entitlements?.organizationId;
    if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
    const allowed = await dayCloseBranchIds(ctx);
    if (allowed !== 'ALL' && !allowed.length)
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Day-close permission is required to reconcile and close a day.',
      });
    const [branches, organization] = await Promise.all([
      ctx.db.pharmacyBranch.findMany({
        where: {
          organizationId,
          active: true,
          ...(allowed === 'ALL' ? {} : { id: { in: allowed } }),
        },
        // DEV-958A: the close picks "today" on each branch's own clock.
        select: { id: true, code: true, name: true, city: true, businessDayEndsAtHistory: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      ctx.db.organization.findUnique({
        where: { id: organizationId },
        select: { currency: true, timezone: true },
      }),
    ]);
    return {
      // DEV-958A: each branch's day-end history as days and hours only, never who set it.
      branches: branches.map(withClientPharmacyDayEnd),
      currency: organization?.currency ?? 'PKR',
      timezone: workspaceTimezone(organization?.timezone),
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
        // DEV-876's branch-assignment read scope first (its refusals stay as they
        // are), then DEV-878's counter grant before any catalogue or alternative read.
        await assignedBranchScope(ctx, input.branchId);
        const scope = await requireCounterReceiptAccess(ctx, input.branchId);
        // DEV-907: the owner's switch decides whether the other-branch line is
        // computed at all; the client cannot ask for it.
        const organization = await ctx.db.organization.findUnique({
          where: { id: scope.organizationId },
          select: { pharmacyOtherBranchAvailability: true },
        });
        return await searchCounterCatalog(ctx.db, scope, {
          query: input.query,
          limit: input.limit,
          otherBranchAvailability: organization?.pharmacyOtherBranchAvailability === true,
        });
      } catch (error) {
        fail(error);
      }
    }),

  /**
   * DEV-780: the counter reads a typed or scanned voucher code before applying it to the next
   * item. Read-only: the voucher is redeemed (and every rule re-checked) only by `addLine`.
   */
  counterVoucher: protectedProcedure
    .input(counterVoucherInput.extend({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      try {
        await assignedBranchScope(ctx, input.branchId);
        const scope = await requireCounterReceiptAccess(ctx, input.branchId);
        return await lookupCounterVoucher(ctx.db as unknown as ScopedDb, scope, input.code);
      } catch (error) {
        fail(error);
      }
    }),

  checkBillLinePack: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1),
          saleLineId: z.string().min(1),
          payload: z.string().trim().min(1).max(512),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, {
        skipInput: true,
        targetType: 'PharmacySaleLine',
        targetId: input.saleLineId,
      });
      const scope = await requireCounterReceiptAccess(ctx, input.branchId, true);
      return ctx.db.$transaction(async (tx) => {
        const db = txDb(tx);
        const [sale] = await db.$queryRaw<
          { status: string; createdByUserId: string }[]
        >`SELECT status,"createdByUserId" FROM pharmacy_sales WHERE id=${input.saleId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`;
        if (
          !sale ||
          (sale.createdByUserId !== scope.actorId && !(await actorMayRefund(db, ctx.session!.user)))
        )
          throw new TRPCError({ code: 'FORBIDDEN' });
        if (sale.status !== 'OPEN' || (await saleHasPaymentActivity(db, scope, input.saleId)))
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Pack checks require an open, unpaid bill.',
          });
        const where = {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          saleId: input.saleId,
        };
        const line = await db.pharmacySaleLine.findFirst({
          where: { ...where, id: input.saleLineId },
          include: { allocations: { include: { lot: { include: { batch: true } } } } },
        });
        if (!line) throw new TRPCError({ code: 'NOT_FOUND' });
        const scan = await authenticatePharmacyPack(db, {
          ...scope,
          source: 'DISPENSING',
          payload: input.payload,
        });
        const code = scan.parsed;
        const barcode =
          code &&
          (await db.medicineBarcode.findFirst({
            where: {
              organizationId: scope.organizationId,
              normalizedCode: code.gtin,
              presentationId: line.presentationId,
            },
            select: { packLevelId: true },
          }));
        const packLevelId = barcode ? (barcode.packLevelId ?? line.packLevelId) : null;
        const serial = await db.pharmacySoldPackSerial.findFirst({
          where: { ...where, saleLineId: line.id, releasedAt: null },
        });
        const matched = Boolean(
          scan.status === 'VERIFIED' &&
          code &&
          packLevelId === line.packLevelId &&
          (!serial || (serial.serialNumber === code.serial && serial.gtin === code.gtin)) &&
          line.allocations.some(
            (a) =>
              a.lot.receivedAt &&
              a.lot.packLevelId === packLevelId &&
              (!serial?.inventoryLotId || a.lot.id === serial.inventoryLotId) &&
              a.lot.batch.state === 'ACTIVE' &&
              (!code.batch || a.lot.batch.batchNumber === code.batch) &&
              a.lot.batch.medicineId === line.medicineId &&
              (!code.expiry ||
                a.lot.batch.expiresAt?.toISOString().slice(2, 10).replaceAll('-', '') ===
                  code.expiry)
          )
        );
        await db.pharmacySaleLine.update({
          where: { id: line.id },
          data: { packCheckBlocked: !matched },
        });
        await db.pharmacySaleEvent.create({
          data: {
            ...where,
            actorId: scope.actorId,
            kind: 'PACK_CHECK',
            payload: { saleLineId: line.id, scanId: scan.id, matched },
          },
        });
        return { matched, batchChecked: Boolean(code?.batch) };
      });
    }),
  /** SAFE-05: advisory pack authentication; only the existing recall path blocks. */
  authenticatePack: auditedProtectedProcedure
    .input(z.object({ branchId, payload: z.string().max(512) }).strict())
    .mutation(async ({ ctx, input }) => {
      // DEV-965: the scan record feeds the flag reports, so only a member who may sell or
      // dispense at this branch (the counter gate) writes one.
      await assignedBranchScope(ctx, input.branchId);
      const scope = await requireCartWriteAccess(ctx, input.branchId);
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
      const scope = await assignedBranchScope(ctx, input.branchId);
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
            expiresAt: lot.batch.expiresAt?.toISOString() ?? null,
            sellableUnits,
            blockedBy:
              sellableUnits > 0
                ? null
                : (mine.find((bucket) => bucket.blockedBy !== null)?.blockedBy ?? null),
          },
        ];
      });
    }),

  /**
   * DEV-623: the branch's unpaid OPEN and HELD bills. A bill lost to a reload or
   * another browser keeps its stock allocated, so the counter lists them here to
   * resume or void. The same gate as `counterCart` and `transition`.
   */
  openBills: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      try {
        const scope = await requireCounterReceiptAccess(ctx, input.branchId);
        return await listOpenBills(ctx.db, scope);
      } catch (error) {
        fail(error);
      }
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
          readDispensingLabelSources(ctx.db, scope, receipt, ctx.organization?.timezone),
          receipt.completedAt
            ? readPharmacyReceiptTaxIdentity(
                ctx.db,
                scope,
                new Date(receipt.completedAt),
                ctx.organization?.timezone
              )
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
          return (await allocateSettledCounterReceiptPrintJob(ctx, tx, scope, input)).result;
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
      z
        .object({ branchId, saleId: z.string().min(1).max(128), locale: z.enum(['en', 'ur']) })
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

  /**
   * DEV-16: send the settled receipt to the customer's WhatsApp, only on the
   * customer's request at the counter. The template carries the branch,
   * receipt number, total, method and a tokenized hosted link — never an item.
   */
  counterReceiptWhatsApp: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1).max(128),
          customerRequested: z.literal(true),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId);
      try {
        return await sendWhatsAppReceiptLink({
          db: ctx.db,
          scope,
          saleId: input.saleId,
          actorUserId: ctx.session.user.id,
        });
      } catch (error) {
        if (error instanceof HostedReceiptError)
          throw new TRPCError({
            code:
              error.reason === 'NOT_CONFIGURED' || error.reason === 'LINK_HOST_NOT_CONFIGURED'
                ? 'PRECONDITION_FAILED'
                : 'BAD_REQUEST',
            message: HOSTED_RECEIPT_ERROR_MESSAGES[error.reason],
          });
        fail(error);
      }
    }),

  /** Failed browser preflight is durable evidence, without claiming a copy. */
  counterReceiptBrowserPrintFailed: auditedProtectedProcedure
    .input(
      z
        .object({ branchId, saleId: z.string().min(1).max(128), locale: z.enum(['en', 'ur']) })
        .strict()
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
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'This preset is not available to staff.',
        });
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
