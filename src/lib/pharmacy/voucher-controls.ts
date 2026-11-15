import { can, subjectFromSession } from '@/lib/abac';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-819 (SEC-E): a voucher's per-use discount is capped, and a voucher whose
 * per-use value or total value (discount x use limit) is above the value cap
 * needs a second approver: a different active manager or owner proven by their
 * PIN. The issuer never counts as that approver, except a solo owner, who
 * re-enters their own fresh PIN and leaves an audit record.
 */
export const VOUCHER_MAX_DISCOUNT_MINOR = 1_000_000;
export const VOUCHER_VALUE_CAP_MINOR = 100_000;
export const VOUCHER_TOTAL_VALUE_CAP_MINOR = 1_000_000;
export const VOUCHER_MAX_USES = 10_000;
export const VOUCHER_MAX_VALIDITY_DAYS = 365;

export const VOUCHER_WITHIN_CAP_POLICY = 'VOUCHER_WITHIN_CAP';
export const VOUCHER_SECOND_APPROVER_POLICY = 'MANAGER_PIN';
export const VOUCHER_SOLE_OWNER_POLICY = 'SOLE_APPROVER_PIN_REAUTH';

export function voucherNeedsSecondApprover(voucher: { discountMinor: number; maxUses: number }) {
  return (
    voucher.discountMinor > VOUCHER_VALUE_CAP_MINOR ||
    voucher.discountMinor * voucher.maxUses > VOUCHER_TOTAL_VALUE_CAP_MINOR
  );
}

type RedeemableVoucher = {
  id: string;
  discountMinor: number;
  issuedByUserId: string;
  approvedByUserId: string | null;
  approvalPolicy: string | null;
  maxUses: number;
};

async function activeMemberMay(
  db: ScopedDb,
  organizationId: string,
  userId: string,
  options: { owner: boolean }
) {
  const user = await db.user.findFirst({
    where: { id: userId, organizationId, status: 'ACTIVE' },
  });
  if (!user || user.organizationId !== organizationId || user.status !== 'ACTIVE') return false;
  // The issuer: the same owner gate that let them issue (an active workspace owner).
  if (options.owner) return user.role === 'ADMIN';
  // The second approver: the capability `authorizeCounterApproval` verified with their PIN.
  return can(subjectFromSession(user), 'pharmacy:manage', undefined, { db });
}

/**
 * DEV-819: at redemption the CRM module must be licensed, the branch active, the issuer still an active owner of this workspace, and the
 * recorded approval must still stand: within the cap the issuer's own; above it a different
 * active manager, or the solo owner's recorded fresh-PIN self-approval. Returns the approver
 * the sale line records.
 */
export async function assertVoucherIssuerRights(
  db: ScopedDb,
  organizationId: string,
  branchId: string,
  voucher: RedeemableVoucher
): Promise<string> {
  // Issuance needed the CRM licence and an active branch; redemption re-checks both.
  const branch = await db.pharmacyBranch.findFirst({
    where: { organizationId, id: branchId, active: true },
    select: { id: true },
  });
  if (!branch) throw new VoucherIssuerRevoked();
  if (!hasModule(await resolveOrganizationEntitlements(organizationId, db), 'pharmacy-crm'))
    throw new VoucherIssuerRevoked();
  if (!(await activeMemberMay(db, organizationId, voucher.issuedByUserId, { owner: true })))
    throw new VoucherIssuerRevoked();
  const approver = voucher.approvedByUserId;
  if (!approver || !voucher.approvalPolicy) throw new VoucherIssuerRevoked();
  if (!voucherNeedsSecondApprover(voucher)) {
    if (voucher.approvalPolicy !== VOUCHER_WITHIN_CAP_POLICY) throw new VoucherIssuerRevoked();
    return approver;
  }
  const selfApproved = approver === voucher.issuedByUserId;
  const expectedPolicy = selfApproved ? VOUCHER_SOLE_OWNER_POLICY : VOUCHER_SECOND_APPROVER_POLICY;
  if (voucher.approvalPolicy !== expectedPolicy) throw new VoucherIssuerRevoked();
  if (!selfApproved && !(await activeMemberMay(db, organizationId, approver, { owner: false })))
    throw new VoucherIssuerRevoked();
  return approver;
}

export class VoucherIssuerRevoked extends Error {
  constructor() {
    super('VOUCHER_ISSUER_REVOKED');
  }
}
