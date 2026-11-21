import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { actorManagesBranchDrawers } from './counter-capability';
import { countOpenCardTerminalAttempts } from './card-terminal/open-attempts';
import {
  cashShiftNeedsApproval,
  computeCashShiftFigures,
  type CashShiftReport,
  type CashShiftTypeTotal,
} from './cash-shift-report';
import {
  assertBranchCashier,
  drawerOperatingCashierId,
  lockPharmacyDay,
  PharmacySettlementError,
  requirePharmacyDayOpen,
  requireTodaysPharmacyDrawer,
  withCashShiftRefusal,
} from './settlement';
import type { LedgerScope } from './stock-ledger';

/**
 * DEV-958B (phase 2 of DEV-958): cash shifts on a pharmacy drawer.
 *
 * Built on the drawer: a branch that runs shifts still opens one drawer per counter for the
 * business day, and the day close still counts and closes every drawer. Inside the drawer, one
 * cashier's shift follows another. Each is opened with a counted float and closed with a counted
 * amount; its report is frozen on the shift row at the close, and the database never lets a closed
 * shift change. Every tender, refund and drawer movement is put in the drawer's open shift by the
 * database itself, under a share lock on the shift row, so no instant is in two shifts or none and
 * a close cannot race a payment. A branch that does not run shifts (every branch until the owner
 * chooses, phase 3) records no shift and behaves exactly as before.
 *
 * Who may: a cashier opens and closes their own shift; a manager or owner (the drawer-manager
 * gate: the manage grant at the branch) opens a shift for another cashier and closes anyone's.
 * An over or short above the branch's tolerance needs a manager's approval through the shared
 * approval path (their PIN or authenticator code, with its lockout strikes); a manager, owner or
 * sole pharmacist approves their own with a fresh PIN. Every open and close is audited in its own
 * transaction.
 */

export const SHIFT_VARIANCE_APPROVAL_POLICY = 'PHARMACY_SHIFT_VARIANCE_MANAGER_PIN';
export const SHIFT_VARIANCE_SOLO_POLICY = 'PHARMACY_SHIFT_VARIANCE_SOLO_SELF_PIN';

export async function readPharmacyCashShiftPolicy(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string }
) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: scope.branchId, organizationId: scope.organizationId, active: true },
    select: { cashShiftsEnabled: true, cashShiftVarianceToleranceMinor: true },
  });
  if (!branch) throw new PharmacySettlementError('SHIFT_NOT_FOUND');
  return {
    enabled: branch.cashShiftsEnabled,
    toleranceMinor: branch.cashShiftVarianceToleranceMinor,
  };
}

async function audit(
  db: ScopedDb,
  scope: LedgerScope,
  action: string,
  shiftId: string,
  metadata: Prisma.InputJsonObject
) {
  await db.auditLog.create({
    data: {
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      actorType: 'USER',
      source: 'TRPC',
      category: 'PHARMACY',
      operation: 'EXECUTE',
      action,
      targetType: 'PharmacyCashShift',
      targetId: shiftId,
      outcome: 'SUCCESS',
      metadata: { branchId: scope.branchId, ...metadata },
    },
  });
}

async function lockShiftRow(db: ScopedDb, scope: LedgerScope, shiftId: string) {
  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_cash_shifts
    WHERE id = ${shiftId} AND "organizationId" = ${scope.organizationId}
      AND "branchId" = ${scope.branchId} FOR UPDATE`);
}

/**
 * The next cashier opens a shift on the same drawer with the cash they count in it. A count that
 * differs from the last closing count is the handover difference, recorded with a note. A
 * replayed open returns the shift it opened.
 */
export async function openPharmacyCashShift(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    drawerSessionId: string;
    openingFloatMinor: number;
    openingNote?: string;
    /** Who runs the shift; naming someone other than yourself is a manager's or owner's. */
    cashierId?: string;
  },
  options: { actorIsManager: boolean; now?: Date }
) {
  if (!Number.isSafeInteger(input.openingFloatMinor) || input.openingFloatMinor < 0)
    throw new PharmacySettlementError('INVALID_AMOUNT');
  const drawer = await db.pharmacyDrawerSession.findFirst({
    where: {
      id: input.drawerSessionId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
  });
  if (!drawer || drawer.status !== 'OPEN') throw new PharmacySettlementError('DRAWER_NOT_OPEN');
  if (!drawer.cashShifts) throw new PharmacySettlementError('SHIFTS_NOT_ENABLED');
  // A shift opens on today's drawer only; an earlier day's drawer is closed with its day.
  await requireTodaysPharmacyDrawer(db, scope, drawer, options.now);
  await requirePharmacyDayOpen(db, scope, drawer.businessDate);
  const cashierId = input.cashierId ?? scope.actorId;
  if (cashierId !== scope.actorId && !options.actorIsManager)
    throw new PharmacySettlementError('DRAWER_NOT_YOURS');
  if (cashierId !== scope.actorId) await assertBranchCashier(db, scope, cashierId);
  const note = input.openingNote?.trim() || null;

  const shifts = await db.pharmacyCashShift.findMany({
    where: { organizationId: scope.organizationId, drawerSessionId: drawer.id },
    orderBy: { sequence: 'desc' },
    take: 1,
  });
  const previous = shifts[0];
  if (!previous) throw new PharmacySettlementError('SHIFT_NOT_FOUND');
  if (previous.status === 'OPEN') {
    // A transport retry of this same open answers with the shift it opened.
    if (
      previous.cashierId === cashierId &&
      previous.openingFloatMinor === input.openingFloatMinor &&
      previous.openedByActorId === scope.actorId
    )
      return { shift: previous, replayed: true as const };
    throw new PharmacySettlementError('SHIFT_ALREADY_OPEN');
  }
  const openingDifferenceMinor = input.openingFloatMinor - (previous.countedCashMinor ?? 0);
  if (openingDifferenceMinor !== 0 && !note)
    throw new PharmacySettlementError('SHIFT_NOTE_REQUIRED');
  let shift;
  try {
    shift = await db.pharmacyCashShift.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        drawerSessionId: drawer.id,
        deviceId: drawer.deviceId,
        businessDate: drawer.businessDate,
        sequence: previous.sequence + 1,
        cashierId,
        openedByActorId: scope.actorId,
        openingFloatMinor: input.openingFloatMinor,
        openingDifferenceMinor,
        openingNote: note,
      },
    });
  } catch (error) {
    // Two opens racing past the read above: the one-open-shift index refuses the second.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw new PharmacySettlementError('SHIFT_ALREADY_OPEN');
    throw error;
  }
  // The till now belongs to this shift's cashier. The handover row keeps the drawer's run of
  // cashiers, which the close reports read, exactly as a manager's handover does.
  const fromCashierId = drawerOperatingCashierId(drawer);
  if (fromCashierId !== cashierId) {
    await db.pharmacyDrawerHandover.create({
      data: {
        organizationId: scope.organizationId,
        drawerSessionId: drawer.id,
        fromCashierId,
        toCashierId: cashierId,
        actorId: scope.actorId,
        reason: `Shift ${shift.sequence} opened`,
      },
    });
    await db.pharmacyDrawerSession.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: drawer.id } },
      data: { operatingCashierId: cashierId },
    });
  }
  await audit(db, scope, 'pharmacy.cashShift.open', shift.id, {
    drawerSessionId: drawer.id,
    sequence: shift.sequence,
    cashierId,
    previousShiftId: previous.id,
    previousCountedMinor: previous.countedCashMinor,
    openingFloatMinor: shift.openingFloatMinor,
    openingDifferenceMinor,
    handover: fromCashierId !== cashierId ? { fromCashierId, toCashierId: cashierId } : null,
  });
  return { shift, replayed: false as const };
}

type ShiftRow = NonNullable<Awaited<ReturnType<ScopedDb['pharmacyCashShift']['findFirst']>>>;

async function userNames(db: ScopedDb, organizationId: string, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map<string, string | null>();
  const users = await db.user.findMany({
    where: { organizationId, id: { in: wanted } },
    select: { id: true, name: true },
  });
  return new Map(users.map((user) => [user.id, user.name] as const));
}

/** The shift's figures from the rows the database put in it. */
async function readShiftFigures(db: ScopedDb, scope: LedgerScope, shift: ShiftRow) {
  const where = { organizationId: scope.organizationId, shiftId: shift.id };
  const [tenders, refunds, movements, lineVoids] = await Promise.all([
    db.pharmacyTender.findMany({
      where: { ...where, branchId: scope.branchId },
      select: { type: true, amountMinor: true, saleId: true },
    }),
    db.pharmacyRefund.findMany({
      where: { ...where, branchId: scope.branchId },
      select: {
        amountMinor: true,
        drawerSessionId: true,
        originalTender: { select: { type: true } },
      },
    }),
    db.pharmacyDrawerMovement.findMany({ where, select: { kind: true, amountMinor: true } }),
    // DEV-977B: the bill lines changed or removed in this shift; each void names the one open
    // shift the change happened in (sales.ts), so it is counted here and in no other shift.
    db.pharmacySaleEvent.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        kind: 'VOIDED',
        payload: { path: ['shiftId'], equals: shift.id },
      },
      select: { payload: true },
    }),
  ]);
  return computeCashShiftFigures({
    openingFloatMinor: shift.openingFloatMinor,
    tenders,
    refunds: refunds.map(refundByTender),
    movements,
    lineVoids: lineVoids.map((event) => event.payload),
  });
}

/** A refund's tender as the day close counts it: paid from the drawer is cash (manual-payments). */
function refundByTender(refund: {
  amountMinor: number;
  drawerSessionId: string | null;
  originalTender: { type: string };
}) {
  return {
    type: refund.drawerSessionId ? 'CASH' : refund.originalTender.type,
    amountMinor: refund.amountMinor,
  };
}

async function buildReport(
  db: ScopedDb,
  scope: LedgerScope,
  shift: ShiftRow,
  toleranceMinor: number,
  close?: {
    closedByActorId: string;
    closedAt: Date;
    countedMinor: number;
    varianceNote: string | null;
    approvedById: string | null;
    policy: string | null;
  }
): Promise<CashShiftReport> {
  const figures = await readShiftFigures(db, scope, shift);
  const names = await userNames(db, scope.organizationId, [
    shift.cashierId,
    shift.openedByActorId,
    close?.closedByActorId ?? shift.closedByActorId,
    close?.approvedById ?? shift.varianceApprovedById,
  ]);
  const person = (id: string | null) => (id ? { id, name: names.get(id) ?? null } : null);
  const countedMinor = close?.countedMinor ?? shift.countedCashMinor;
  return {
    ...figures,
    shiftId: shift.id,
    sequence: shift.sequence,
    drawerSessionId: shift.drawerSessionId,
    deviceId: shift.deviceId,
    // The stored business date (a date column), not a day worked out from an instant.
    businessDate: shift.businessDate.toISOString().slice(0, 10),
    cashier: person(shift.cashierId)!,
    openedBy: person(shift.openedByActorId)!,
    openedAt: shift.openedAt.toISOString(),
    openingDifferenceMinor: shift.openingDifferenceMinor,
    openingNote: shift.openingNote,
    closedBy: person(close?.closedByActorId ?? shift.closedByActorId),
    closedAt: (close?.closedAt ?? shift.closedAt)?.toISOString() ?? null,
    countedMinor,
    varianceMinor: countedMinor === null ? null : countedMinor - figures.cash.expectedMinor,
    varianceNote: close ? close.varianceNote : shift.varianceNote,
    varianceApprovedBy: person(close ? close.approvedById : shift.varianceApprovedById),
    varianceApprovalPolicy: close ? close.policy : shift.varianceApprovalPolicy,
    toleranceMinor,
  };
}

async function findShift(db: ScopedDb, scope: LedgerScope, shiftId: string) {
  const shift = await db.pharmacyCashShift.findFirst({
    where: { id: shiftId, organizationId: scope.organizationId, branchId: scope.branchId },
  });
  if (!shift) throw new PharmacySettlementError('SHIFT_NOT_FOUND');
  return shift;
}

/**
 * The shift report: frozen at the close for a closed shift, and the figures so far (with the cash
 * the drawer should hold) for an open one. A cashier reads their own shift; a manager any shift.
 */
export async function readPharmacyCashShiftReport(
  db: ScopedDb,
  scope: LedgerScope,
  shiftId: string,
  options: { actorIsManager: boolean }
): Promise<CashShiftReport & { status: 'OPEN' | 'CLOSED' }> {
  const shift = await findShift(db, scope, shiftId);
  if (shift.cashierId !== scope.actorId && !options.actorIsManager)
    throw new PharmacySettlementError('DRAWER_NOT_YOURS');
  if (shift.status === 'CLOSED')
    return { ...(shift.report as unknown as CashShiftReport), status: 'CLOSED' };
  const policy = await readPharmacyCashShiftPolicy(db, scope);
  return { ...(await buildReport(db, scope, shift, policy.toleranceMinor)), status: 'OPEN' };
}

export type CashShiftVarianceApproval = {
  /** The shift this approval was given for; it approves no other close. */
  shiftId: string;
  approverId: string;
  policy: typeof SHIFT_VARIANCE_APPROVAL_POLICY | typeof SHIFT_VARIANCE_SOLO_POLICY;
  /** The approver is the cashier whose shift it is (allowed only when nobody else can approve). */
  selfApproved: boolean;
};

type BranchMember = {
  id: string;
  name: string | null;
  role: string | null;
  department: string | null;
  status: string | null;
};

/**
 * The people who hold the approval right at this branch: active members of the organization,
 * assigned to the branch (or the organization's administrators, who reach every branch), who pass
 * the drawer-manager gate (the manage grant, no counter DENY). Optionally only those with a PIN.
 */
async function branchApprovers(
  db: ScopedDb,
  scope: LedgerScope,
  options: { withPin: boolean }
): Promise<BranchMember[]> {
  const members = await db.user.findMany({
    where: {
      organizationId: scope.organizationId,
      status: 'ACTIVE',
      OR: [
        { role: 'ADMIN' },
        {
          pharmacyBranchAssignments: {
            some: { organizationId: scope.organizationId, branchId: scope.branchId, active: true },
          },
        },
      ],
      ...(options.withPin
        ? {
            restaurantStaffProfiles: {
              some: {
                organizationId: scope.organizationId,
                status: 'ACTIVE',
                credentials: { some: { type: 'PIN', revokedAt: null, deviceId: null } },
              },
            },
          }
        : {}),
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, role: true, department: true, status: true },
  });
  const approvers: BranchMember[] = [];
  for (const member of members)
    if (
      await actorManagesBranchDrawers(db, member, scope.organizationId, scope.branchId, {
        source: 'TRPC',
      })
    )
      approvers.push(member);
  return approvers;
}

/** Whether `userId` has a live approval credential (an unrevoked operator PIN of their own). */
async function hasApprovalCredential(db: ScopedDb, scope: LedgerScope, userId: string) {
  return (
    (await db.restaurantOperatorCredential.count({
      where: {
        organizationId: scope.organizationId,
        type: 'PIN',
        revokedAt: null,
        deviceId: null,
        staffProfile: { organizationId: scope.organizationId, userId, status: 'ACTIVE' },
      },
    })) > 0
  );
}

/**
 * The people at the branch who could approve a shift's over or short as a second person: managers
 * and owners with the drawer-manager right and a live approval credential, other than the shift's
 * cashier and the person closing it and counting the cash. Someone with the right but no credential
 * cannot approve, so they never count as "another approver".
 */
async function independentApprovers(
  db: ScopedDb,
  scope: LedgerScope,
  parties: ReadonlySet<string>
) {
  return (await branchApprovers(db, scope, { withPin: true })).filter(
    (member) => !parties.has(member.id)
  );
}

/**
 * Whether one of the shift's own people (its cashier, or the person closing it) may approve its over
 * or short alone, once nobody else can: a manager or owner, or a solo owner or sole pharmacist under
 * the solo-pharmacy rule. It is recorded as a solo approval.
 */
async function partyMaySelfApprove(db: ScopedDb, scope: LedgerScope, member: BranchMember) {
  if (
    await actorManagesBranchDrawers(db, member, scope.organizationId, scope.branchId, {
      source: 'TRPC',
    })
  )
    return true;
  return soloSelfApprovalAllowed(db, { ...scope, actorId: member.id });
}

/**
 * The approval of an over or short above the tolerance, for one shift, verified before the close's
 * transaction so a refusal's strike or spent attempt and its audit row commit. The caller must be
 * allowed to close that shift (its own cashier, or a manager or owner of the branch) before any
 * PIN is checked. A second person approves: a manager or owner at the branch (the drawer-manager
 * gate) who is neither the shift's cashier nor the person closing it and counting the cash. Either
 * of those two approves alone only when nobody else with a live approval credential can, and it is
 * recorded as a solo approval. Every approval takes the approver's fresh PIN or authenticator code
 * through the shared path, and a refusal says so.
 */
export async function authorizeCashShiftVariance(
  db: ScopedDb,
  scope: LedgerScope,
  input: { shiftId: string; approverId: string; pin: string },
  options: { actorIsManager: boolean }
): Promise<CashShiftVarianceApproval> {
  const shift = await findShift(db, scope, input.shiftId);
  if (!options.actorIsManager && shift.cashierId !== scope.actorId)
    throw new PharmacySettlementError('DRAWER_NOT_YOURS');
  const approver = await db.user.findFirst({
    where: { id: input.approverId, organizationId: scope.organizationId, status: 'ACTIVE' },
    select: { id: true, name: true, role: true, department: true, status: true },
  });
  if (!approver) throw new PharmacySettlementError('SHIFT_APPROVAL_NOT_ELIGIBLE');
  const parties = new Set([shift.cashierId, scope.actorId]);
  const selfApproved = parties.has(approver.id);
  let policy: CashShiftVarianceApproval['policy'] = SHIFT_VARIANCE_APPROVAL_POLICY;
  if (selfApproved) {
    if ((await independentApprovers(db, scope, parties)).length > 0)
      throw new PharmacySettlementError('SHIFT_APPROVAL_NEEDS_ANOTHER');
    if (!(await partyMaySelfApprove(db, scope, approver)))
      throw new PharmacySettlementError('SHIFT_APPROVAL_NOT_ELIGIBLE');
    policy = SHIFT_VARIANCE_SOLO_POLICY;
  } else if (
    !(await actorManagesBranchDrawers(db, approver, scope.organizationId, scope.branchId, {
      source: 'TRPC',
    }))
  ) {
    throw new PharmacySettlementError('SHIFT_APPROVAL_NOT_ELIGIBLE');
  }
  // Someone with no approval credential cannot approve, whoever types: refused as not eligible,
  // before any PIN is checked or any guess spent.
  if (!(await hasApprovalCredential(db, scope, approver.id)))
    throw new PharmacySettlementError('SHIFT_APPROVAL_NOT_ELIGIBLE');
  // The approver typed their own PIN: the shared self check (PIN or authenticator code through
  // verifyApprovalSecret, with the credential's lockout strikes), in its own transaction so a
  // refusal's strike and FAILURE audit row commit, exactly as a manager's refund. Someone else
  // typed it (a cashier asking their manager): see verifyOtherApproverPin.
  const outcome =
    input.approverId === scope.actorId
      ? await verifyOwnApproverPin(scope, input.approverId, input.pin, policy)
      : await verifyOtherApproverPin(scope, input.approverId, input.pin, policy);
  if (outcome !== 'VERIFIED')
    throw new PharmacySettlementError(
      outcome === 'LOCKED'
        ? 'SHIFT_APPROVAL_LOCKED'
        : outcome === 'NOT_ELIGIBLE'
          ? 'SHIFT_APPROVAL_NOT_ELIGIBLE'
          : 'SHIFT_APPROVAL_REFUSED'
    );
  return { shiftId: shift.id, approverId: input.approverId, policy, selfApproved };
}

type ApproverPinOutcome = 'VERIFIED' | 'REFUSED' | 'LOCKED' | 'NOT_ELIGIBLE';

const SHIFT_APPROVAL_ACTION = 'pharmacySales.closeShift';
const SHIFT_APPROVAL_PIN_REFUSED = 'SHIFT_VARIANCE_PIN_REFUSED';

async function verifyOwnApproverPin(
  scope: LedgerScope,
  approverId: string,
  pin: string,
  policy: string
): Promise<ApproverPinOutcome> {
  const [{ authenticateRefundPin }, { withTenantDb }, { isLockedOut }] = await Promise.all([
    import('./refund-authorization'),
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/operator-credentials'),
  ]);
  const verified = await authenticateRefundPin({
    organizationId: scope.organizationId,
    actorId: approverId,
    pin,
    action: SHIFT_APPROVAL_ACTION,
    policy,
    errorCode: SHIFT_APPROVAL_PIN_REFUSED,
  });
  if (!('blocked' in verified)) return 'VERIFIED';
  const credential = await withTenantDb(
    scope.organizationId,
    (db) =>
      db.restaurantOperatorCredential.findFirst({
        where: approverPinWhere(scope.organizationId, approverId),
        orderBy: { id: 'asc' },
        select: { failedAttempts: true, lockedUntil: true },
      }),
    { skipDrain: true }
  );
  return credential && isLockedOut(credential, new Date()) ? 'LOCKED' : 'REFUSED';
}

function approverPinWhere(organizationId: string, approverId: string) {
  return {
    organizationId,
    type: 'PIN' as const,
    revokedAt: null,
    deviceId: null,
    staffProfile: {
      organizationId,
      userId: approverId,
      status: 'ACTIVE' as const,
      user: { organizationId, status: 'ACTIVE' as const },
    },
  };
}

/**
 * Someone else typed the approver's PIN at their counter. The PIN is the approver's shared operator
 * credential, so guesses typed by another person must not strike it and lock the approver out of
 * their refunds and other approvals. They spend instead the approver's one budget for guesses typed
 * by others (five per lockout window), shared with purchase approval (approver-pin-guess-budget.ts).
 * The secret is still checked through the shared path (verifyApprovalSecret: PIN or authenticator
 * code); an approver already locked out stays refused, and one with no PIN cannot approve at all.
 * Runs in its own transaction so the FAILURE audit row commits.
 */
async function verifyOtherApproverPin(
  scope: LedgerScope,
  approverId: string,
  pin: string,
  policy: string
): Promise<ApproverPinOutcome> {
  const [{ withTenantDb }, credentials, { verifyApprovalSecret }, budgets] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/operator-credentials'),
    import('@/lib/approval-authenticator'),
    import('@/lib/approver-pin-guess-budget'),
  ]);
  const { organizationId } = scope;
  return withTenantDb(
    organizationId,
    async (db) => {
      const refuse = async (outcome: Exclude<ApproverPinOutcome, 'VERIFIED'>) => {
        await db.auditLog.create({
          data: {
            organizationId,
            actorId: scope.actorId,
            source: 'TRPC',
            category: 'PHARMACY',
            operation: 'EXECUTE',
            action: SHIFT_APPROVAL_ACTION,
            outcome: 'FAILURE',
            errorCode: SHIFT_APPROVAL_PIN_REFUSED,
            metadata: { policy, approverId, pinVerified: false, refusal: outcome },
          },
        });
        return outcome;
      };
      const credential = await db.restaurantOperatorCredential.findFirst({
        where: approverPinWhere(organizationId, approverId),
        orderBy: { id: 'asc' },
        select: { credentialHash: true, failedAttempts: true, lockedUntil: true },
      });
      if (!credential) return refuse('NOT_ELIGIBLE');
      const now = new Date();
      if (credentials.isLockedOut(credential, now)) return refuse('LOCKED');
      if (!/^\d{4,8}$/.test(pin)) return refuse('REFUSED');
      const budget = await budgets.spendApproverPinGuessTypedByAnother(organizationId, approverId);
      if (!budget.ok) return refuse('LOCKED');
      // Built before the call, so it also carries the approver right the shared check will
      // require once DEV-961 (PR 2240) lands: the drawer-manager gate this approver passed.
      const secretCheck = {
        organizationId,
        approverUserId: approverId,
        credentialHash: credential.credentialHash,
        secret: pin,
        action: 'pharmacy.shiftVarianceApproval',
        approverRight: 'pharmacy:manage' as const,
        requestedById: scope.actorId,
        now,
      };
      const verified = await verifyApprovalSecret(db, secretCheck);
      if (!verified) return refuse(budget.remaining === 0 ? 'LOCKED' : 'REFUSED');
      await budgets.clearApproverPinGuessesTypedByAnother(organizationId, approverId);
      return 'VERIFIED';
    },
    { skipDrain: true }
  );
}

/** Nobody else works at the branch, and the actor is its solo owner or sole pharmacist. */
async function soloSelfApprovalAllowed(db: ScopedDb, scope: LedgerScope) {
  const [{ isSolePharmacist }, { soloOwnerApprovalAllowed }] = await Promise.all([
    import('./controlled-restoration-authorization'),
    import('./purchase-approval'),
  ]);
  const others = await db.user.count({
    where: {
      organizationId: scope.organizationId,
      status: 'ACTIVE',
      id: { not: scope.actorId },
      pharmacyBranchAssignments: {
        some: { organizationId: scope.organizationId, branchId: scope.branchId, active: true },
      },
    },
  });
  if (others > 0) return false;
  return (
    (await soloOwnerApprovalAllowed(db, scope.organizationId, scope.actorId, scope.branchId)) ||
    (await isSolePharmacist(db, scope.organizationId, scope.actorId))
  );
}

/**
 * Exactly the people `authorizeCashShiftVariance` would accept for this shift, among those with a
 * PIN set up: the branch's managers and owners other than the shift's cashier, and the cashier
 * themself only when nobody else can approve.
 */
export async function shiftVarianceApprovers(db: ScopedDb, scope: LedgerScope, shiftId: string) {
  const shift = await findShift(db, scope, shiftId);
  // The caller is the person who would close the shift and count it.
  const parties = new Set([scope.actorId, shift.cashierId]);
  const approvers: BranchMember[] = await independentApprovers(db, scope, parties);
  if (!approvers.length)
    for (const id of parties) {
      const member = await db.user.findFirst({
        where: { id, organizationId: scope.organizationId, status: 'ACTIVE' },
        select: { id: true, name: true, role: true, department: true, status: true },
      });
      if (
        member &&
        (await hasApprovalCredential(db, scope, member.id)) &&
        (await partyMaySelfApprove(db, scope, member))
      )
        approvers.push(member);
    }
  return approvers.map((member) => ({
    id: member.id,
    name: member.name,
    isYou: member.id === scope.actorId,
  }));
}

/**
 * Closes a shift with the counted cash and freezes its report. A difference needs a note; one
 * above the branch's tolerance needs a manager's approval. A replay with the same count returns
 * the recorded close. The database re-checks the expected cash under the shift's row lock.
 */
export async function closePharmacyCashShift(
  db: ScopedDb,
  scope: LedgerScope,
  input: { shiftId: string; countedCashMinor: number; varianceNote?: string },
  options: { actorIsManager: boolean; approval?: CashShiftVarianceApproval }
) {
  if (!Number.isSafeInteger(input.countedCashMinor) || input.countedCashMinor < 0)
    throw new PharmacySettlementError('INVALID_AMOUNT');
  const found = await findShift(db, scope, input.shiftId);
  // The day lock every money write and the day close take, then the shift row itself.
  await lockPharmacyDay(db, scope, found.businessDate);
  await lockShiftRow(db, scope, found.id);
  const shift = await findShift(db, scope, input.shiftId);
  if (shift.cashierId !== scope.actorId && !options.actorIsManager)
    throw new PharmacySettlementError('DRAWER_NOT_YOURS');
  if (shift.status === 'CLOSED') {
    // A transport retry of the same close answers with what it recorded.
    if (shift.countedCashMinor === input.countedCashMinor)
      return { shift, report: shift.report as unknown as CashShiftReport, replayed: true as const };
    throw new PharmacySettlementError('SHIFT_ALREADY_CLOSED');
  }
  // A terminal payment still open may already have charged the customer; the shift would miss it.
  if ((await countOpenCardTerminalAttempts(db, scope, shift.businessDate)) > 0)
    throw new PharmacySettlementError('CARD_TERMINAL_PAYMENT_OPEN');
  const policy = await readPharmacyCashShiftPolicy(db, scope);
  const figures = await readShiftFigures(db, scope, shift);
  const varianceMinor = input.countedCashMinor - figures.cash.expectedMinor;
  const varianceNote = input.varianceNote?.trim() || null;
  if (varianceMinor !== 0 && !varianceNote)
    throw new PharmacySettlementError('SHIFT_NOTE_REQUIRED');
  // An approval answers for the one shift it was given for.
  if (options.approval && options.approval.shiftId !== shift.id)
    throw new PharmacySettlementError('SHIFT_APPROVAL_REQUIRED');
  const approval = cashShiftNeedsApproval(varianceMinor, policy.toleranceMinor)
    ? options.approval
    : undefined;
  if (cashShiftNeedsApproval(varianceMinor, policy.toleranceMinor) && !approval)
    throw new PharmacySettlementError('SHIFT_APPROVAL_REQUIRED');
  const closedAt = new Date();
  const report = await buildReport(db, scope, shift, policy.toleranceMinor, {
    closedByActorId: scope.actorId,
    closedAt,
    countedMinor: input.countedCashMinor,
    varianceNote,
    approvedById: approval?.approverId ?? null,
    policy: approval?.policy ?? null,
  });
  const closed = await withCashShiftRefusal(
    db.pharmacyCashShift.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: shift.id } },
      data: {
        status: 'CLOSED',
        closedByActorId: scope.actorId,
        closedAt,
        countedCashMinor: input.countedCashMinor,
        expectedCashMinor: figures.cash.expectedMinor,
        varianceMinor,
        varianceNote,
        varianceApprovedById: approval?.approverId ?? null,
        varianceApprovalPolicy: approval?.policy ?? null,
        report: report as unknown as Prisma.InputJsonObject,
      },
    })
  );
  await audit(db, scope, 'pharmacy.cashShift.close', shift.id, {
    drawerSessionId: shift.drawerSessionId,
    sequence: shift.sequence,
    cashierId: shift.cashierId,
    closedByManagerStep: shift.cashierId !== scope.actorId,
    expectedMinor: figures.cash.expectedMinor,
    countedMinor: input.countedCashMinor,
    varianceMinor,
    toleranceMinor: policy.toleranceMinor,
    approval: approval
      ? {
          approverId: approval.approverId,
          policy: approval.policy,
          selfApproved: approval.selfApproved,
          pinVerified: true,
        }
      : null,
  });
  return { shift: closed, report, replayed: false as const };
}

/** The counter's view of a shift drawer: its open shift, or the last closed one to follow. */
export async function readPharmacyDrawerShift(
  db: ScopedDb,
  scope: LedgerScope,
  drawerSessionId: string
) {
  const shifts = await db.pharmacyCashShift.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      drawerSessionId,
    },
    orderBy: { sequence: 'desc' },
    take: 1,
    select: {
      id: true,
      sequence: true,
      status: true,
      cashierId: true,
      openedAt: true,
      openingFloatMinor: true,
      closedAt: true,
      countedCashMinor: true,
    },
  });
  const latest = shifts[0] ?? null;
  const currency = await organizationCurrency(db, scope.organizationId);
  if (!latest) return { openShift: null, lastClosedShift: null, currency };
  const names = await userNames(db, scope.organizationId, [latest.cashierId]);
  const row = {
    ...latest,
    cashierName: names.get(latest.cashierId) ?? null,
    isYours: latest.cashierId === scope.actorId,
  };
  return latest.status === 'OPEN'
    ? { openShift: row, lastClosedShift: null, currency }
    : { openShift: null, lastClosedShift: row, currency };
}

/** The workspace's currency, as the receipts and the day close print it. */
export async function organizationCurrency(db: ScopedDb, organizationId: string) {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { currency: true },
  });
  return organization?.currency ?? 'PKR';
}

/**
 * The shifts of a business day at the branch, for the day close: each shift's report (frozen, or
 * so far), and the late arrivals: offline sales replayed after the shift they were sold in closed.
 */
export async function readPharmacyDayShifts(
  db: ScopedDb,
  scope: LedgerScope,
  businessDate: Date,
  toleranceMinor: number
) {
  const shifts = await db.pharmacyCashShift.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, businessDate },
    orderBy: [{ drawerSessionId: 'asc' }, { sequence: 'asc' }],
  });
  if (!shifts.length) return { shifts: [], lateArrivals: null };
  const reports = [];
  for (const shift of shifts)
    reports.push({
      ...(shift.status === 'CLOSED'
        ? (shift.report as unknown as CashShiftReport)
        : await buildReport(db, scope, shift, toleranceMinor)),
      status: shift.status,
    });
  const ids = shifts.map((s) => s.id);
  const lateWhere = { organizationId: scope.organizationId, lateArrivalShiftId: { in: ids } };
  const [lateTenders, lateRefunds, lateMovements] = await Promise.all([
    db.pharmacyTender.findMany({
      where: { ...lateWhere, branchId: scope.branchId },
      select: { type: true, amountMinor: true, saleId: true, lateArrivalShiftId: true },
    }),
    db.pharmacyRefund.findMany({
      where: { ...lateWhere, branchId: scope.branchId },
      select: {
        amountMinor: true,
        drawerSessionId: true,
        originalTender: { select: { type: true } },
      },
    }),
    db.pharmacyDrawerMovement.findMany({
      where: lateWhere,
      select: { kind: true, amountMinor: true },
    }),
  ]);
  const late = computeCashShiftFigures({
    openingFloatMinor: 0,
    tenders: lateTenders,
    refunds: lateRefunds.map(refundByTender),
    movements: lateMovements,
  });
  return {
    shifts: reports,
    lateArrivals: {
      tenders: late.tenders as CashShiftTypeTotal[],
      refunds: late.refunds as CashShiftTypeTotal[],
      cashNetMinor: late.cash.expectedMinor,
      salesCount: late.salesCount,
    },
  };
}
