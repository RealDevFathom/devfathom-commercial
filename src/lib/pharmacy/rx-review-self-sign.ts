import 'server-only';

import { can, subjectFromSession } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { counterBranchAssignmentDenial } from './counter-capability';
import { RX_ON_DUTY_DECLARATION, type RxDeclaredSoloSignOff } from './rx-solo-shift';
import { readRxSoloShiftPolicy } from './rx-solo-shift-policy';

/**
 * DEV-950 — a pharmacist working alone signs the RX-03 review of a prescription line they rang
 * up themselves (the solo rule, owner decision on DEV-622, 15 Nov 2026: "Controls that need a
 * second person keep the solo rule: self-approval with a fresh PIN and an audit record").
 *
 * The review asks for a second person: `addLine` queues it with the seller as requester, and the
 * database refuses a decision by the requester (`pharmacy_review_no_self_approval`). A different
 * pharmacist still signs it from the pharmacist queue (`decideReview`), as before. The requester
 * may sign it only when all of this holds, checked again inside the write's transaction:
 *   - they may decide a review at the line's branch (`rxReviewSignerDenial`: ACTIVE, not on
 *     leave, `pharmacy:dispense`, an active assignment to it or a tenant owner);
 *   - nobody else could sign it there: no other member `rxReviewSignerDenial` accepts there.
 *     Whether they have a PIN does not matter: a second pharmacist signs the review from the
 *     pharmacist queue without one (`decideReview`), so anyone who could do that is someone else
 *     who could sign. This is the solo rule's "nobody else could act here" test, with the
 *     pharmacist's right and the branch assignment (a pharmacist signs reviews without the
 *     counter grant). The card-terminal rule (`otherCardTerminalReviewers`) is unchanged: its
 *     resolver needs a PIN, so there only people with a working PIN count;
 *   - the medicine is not controlled: a controlled line's review is signed by the independent
 *     pharmacist who witnesses the controlled register, and that rule is unchanged;
 *   - they re-entered their own PIN for this signature (checked by the caller, shared lockout);
 *   - the review is not signed yet.
 * The audit entry (who, when, which sale and line, marked self-approved) is written first, in the
 * same transaction, and the signature names it. The database admits a requester's signature only
 * with that entry (migration 20261118124600), so the entry cannot be skipped.
 *
 * DEV-960 — a declared solo sign-off. When others are on the branch's staff list, the requester may
 * still sign alone if, and only if, the owner turned "One pharmacist per shift" on at that branch
 * (`readRxSoloShiftPolicy`, read under the branch's setting lock) and the requester confirms the
 * current declaration "I am the only pharmacist on duty now" with this signature. Every other rule
 * above still holds (the signer's own right and branch, never a controlled medicine, a fresh PIN,
 * not signed yet). The audit entry is the same self-approved, PIN-verified entry the database
 * requires, plus a marker that it was declared, the declaration, the setting's version and the
 * other people who could have signed at that moment (`otherRxReviewSigners`). With the setting off
 * nothing changes: a declaration is refused exactly as a self-signature with a colleague on the list.
 */

export const RX_SELF_SIGN_AUDIT_ACTION = 'pharmacyDispensing.selfSignReview';
export const RX_SELF_SIGN_POLICY = 'PHARMACY_RX_REVIEW_SOLO_SELF_SIGN_PIN';

export type RxSelfSignScope = { organizationId: string; branchId: string; actorId: string };

/**
 * DEV-955 — who may decide (sign, override, verify or any other decision) a prescription review
 * at a branch. One rule, used by `decideReview`, by the self-signer's own check and by the solo
 * rule's "who else could sign here" (`otherRxReviewSigners`), so the three never disagree:
 *   - a member of this organization, read live;
 *   - ACTIVE: a person on leave (or inactive, or invited) is not available. Sessions and other
 *     permission checks admit ON_LEAVE; this legally weighted signature does not, so a pharmacist
 *     on leave neither signs nor counts as someone else who could sign;
 *   - holds `pharmacy:dispense` (deny wins);
 *   - may act at the branch: an active assignment to it, or a tenant owner of the organization
 *     (`counterBranchAssignmentDenial`, the counter's branch rule).
 * A suspended staff profile does not change it: that profile carries the PIN, and a review is
 * decided from the pharmacist queue without one.
 */
export type RxReviewSignerRefusal = 'NOT_MEMBER' | 'NOT_ACTIVE' | 'NO_RIGHT' | 'BRANCH';

export const RX_REVIEW_SIGNER_MESSAGES: Record<RxReviewSignerRefusal, string> = {
  NOT_MEMBER: 'You do not have permission for this action.',
  NOT_ACTIVE: 'You are on leave or not active, so you cannot sign or decide a prescription check.',
  NO_RIGHT: 'You do not have permission for this action.',
  BRANCH:
    'You are not assigned to this branch. Only a pharmacist assigned to this branch can sign or decide its prescription checks.',
};

const SIGNER_SELECT = {
  id: true,
  name: true,
  organizationId: true,
  role: true,
  department: true,
  status: true,
} as const;

type SignerRow = {
  id: string;
  name: string | null;
  organizationId: string;
  role: string;
  department: string | null;
  status: string;
};

/**
 * The same rule for a member row already read (live, in the caller's transaction), so a caller
 * that lists people does not read each again. Refill approval uses it too (DEV-962), so a
 * refill cycle's approver and a prescription check's signer are decided by one rule.
 */
export async function rxReviewSignerRowDenial(
  db: ScopedDb,
  row: Omit<SignerRow, 'name'>,
  scope: { organizationId: string; branchId: string },
  now: Date
): Promise<RxReviewSignerRefusal | null> {
  if (row.organizationId !== scope.organizationId) return 'NOT_MEMBER';
  if (row.status !== 'ACTIVE') return 'NOT_ACTIVE';
  if (
    !(await can(subjectFromSession(row), 'pharmacy:dispense', undefined, {
      db,
      now,
      source: 'TRPC',
    }))
  )
    return 'NO_RIGHT';
  if (await counterBranchAssignmentDenial(db, row, scope.organizationId, scope.branchId))
    return 'BRANCH';
  return null;
}

/** Why this person may not decide a prescription review at this branch; null when they may. */
export async function rxReviewSignerDenial(
  db: ScopedDb,
  input: { organizationId: string; branchId: string; userId: string },
  now = new Date()
): Promise<RxReviewSignerRefusal | null> {
  const row = await db.user.findFirst({
    where: { id: input.userId, organizationId: input.organizationId },
    select: SIGNER_SELECT,
  });
  if (!row) return 'NOT_MEMBER';
  return rxReviewSignerRowDenial(db, row, input, now);
}

/**
 * The other people who could sign a prescription review at this branch; empty means solo. Every
 * other member `rxReviewSignerDenial` accepts at the branch, with or without a PIN. Never the
 * actor. Stable order, so the refusal names the same person.
 */
export async function otherRxReviewSigners(
  db: ScopedDb,
  scope: RxSelfSignScope,
  now = new Date()
): Promise<{ id: string; name: string | null }[]> {
  // A narrowing only: everyone the rule accepts is ACTIVE and either potentially an owner or assigned here.
  const members = await db.user.findMany({
    where: {
      organizationId: scope.organizationId,
      status: 'ACTIVE',
      id: { not: scope.actorId },
      OR: [
        { role: 'ADMIN' },
        { organizationRole: { isSystem: true, key: 'owner' } },
        {
          pharmacyBranchAssignments: {
            some: {
              organizationId: scope.organizationId,
              branchId: scope.branchId,
              active: true,
              branch: { organizationId: scope.organizationId, active: true },
            },
          },
        },
      ],
    },
    select: SIGNER_SELECT,
    orderBy: { id: 'asc' },
  });
  const signers: { id: string; name: string | null }[] = [];
  for (const other of members) {
    if (other.id === scope.actorId) continue;
    // The same rule `decideReview` applies, read live.
    if (await rxReviewSignerRowDenial(db, other, scope, now)) continue;
    signers.push({ id: other.id, name: other.name });
  }
  return signers;
}

const MESSAGES = {
  NOT_FOUND: 'This prescription review was not found.',
  NOT_REQUESTER:
    'You did not ring up this line. Sign it from the pharmacist queue with your own decision.',
  NOT_ALLOWED:
    'Only a pharmacist with the dispensing permission at this branch can sign this line.',
  CONTROLLED:
    'A controlled medicine needs an independent pharmacist’s signature. It cannot be self-signed.',
  ALREADY_SIGNED: 'This prescription line is already signed.',
  SECOND_PHARMACIST: 'Another pharmacist at this branch must sign a line you rang up.',
  STALE_DECLARATION:
    'The on-duty declaration has changed. Reload, read it again and confirm it before signing.',
} as const;

export type RxSelfSignRefusal = keyof typeof MESSAGES;

export class RxSelfSignError extends Error {
  constructor(
    readonly reason: RxSelfSignRefusal,
    /** For SECOND_PHARMACIST: someone who can sign it here. */
    readonly askName: string | null = null
  ) {
    super(
      reason === 'SECOND_PHARMACIST'
        ? `${MESSAGES.SECOND_PHARMACIST} Ask ${askName ?? 'another pharmacist'} to sign it in the pharmacist queue.`
        : MESSAGES[reason]
    );
    this.name = 'RxSelfSignError';
  }
}

type Actor = {
  id: string;
  role?: string | null;
  department?: string | null;
  status?: string | null;
};

/** DEV-960: the declaration confirmed with a declared solo sign-off. */
export type RxOnDutyDeclaration = { onlyPharmacistOnDuty: true; version: string };

/** Who else could have signed, and the setting in force, for a declared solo sign-off. */
export type RxDeclaredSolo = {
  policyVersion: number;
  otherSigners: { id: string; name: string | null }[];
};

export type RxSelfSignContext = {
  reviewItemId: string;
  saleId: string;
  saleLineId: string;
  branchId: string;
  /** DEV-960: set only for a declared solo sign-off; null for the staff-list solo rule. */
  declared: RxDeclaredSolo | null;
};

/**
 * Every rule except the PIN, for one review item. Throws `RxSelfSignError`; returns the review's
 * sale, line and branch. `lock` takes the review row's lock first, so two signatures of one
 * review cannot both pass the "not signed yet" check.
 */
export async function assertRxSelfSignAllowed(
  db: ScopedDb,
  input: {
    organizationId: string;
    actor: Actor;
    reviewItemId: string;
    lock?: boolean;
    /** DEV-960: the requester declares they are the only pharmacist on duty now. */
    declaration?: RxOnDutyDeclaration | null;
  },
  now = new Date()
): Promise<RxSelfSignContext> {
  const { organizationId, actor, reviewItemId } = input;
  if (input.lock)
    await db.$queryRaw`SELECT id FROM pharmacy_pharmacist_review_items WHERE "organizationId"=${organizationId} AND id=${reviewItemId} FOR UPDATE`;
  const item = await db.pharmacyPharmacistReviewItem.findFirst({
    where: { id: reviewItemId, organizationId },
    select: { id: true, saleLineId: true, requestedByUserId: true },
  });
  if (!item) throw new RxSelfSignError('NOT_FOUND');
  const line = await db.pharmacySaleLine.findFirst({
    where: { id: item.saleLineId, organizationId },
    select: { id: true, saleId: true, branchId: true, medicine: { select: { controlled: true } } },
  });
  if (!line) throw new RxSelfSignError('NOT_FOUND');
  if (item.requestedByUserId !== actor.id) throw new RxSelfSignError('NOT_REQUESTER');
  // DEV-955: the same rule as any other signer (on leave cannot sign), read live.
  if (
    await rxReviewSignerDenial(
      db,
      { organizationId, branchId: line.branchId, userId: actor.id },
      now
    )
  )
    throw new RxSelfSignError('NOT_ALLOWED');
  if (line.medicine.controlled) throw new RxSelfSignError('CONTROLLED');
  const signed = await db.pharmacyPharmacistReviewDecision.findFirst({
    where: { organizationId, reviewItemId, kind: 'SIGN', signedAt: { not: null } },
    select: { id: true },
  });
  if (signed) throw new RxSelfSignError('ALREADY_SIGNED');
  const others = await otherRxReviewSigners(
    db,
    { organizationId, branchId: line.branchId, actorId: actor.id },
    now
  );
  const context = {
    reviewItemId,
    saleId: line.saleId,
    saleLineId: line.id,
    branchId: line.branchId,
  };
  const [other] = others;
  // The staff-list solo rule, unchanged: nobody else could sign here.
  if (!other) return { ...context, declared: null };
  // DEV-960: others are on the staff list. Only a declaration, under the owner's setting, signs.
  if (input.declaration?.onlyPharmacistOnDuty !== true)
    throw new RxSelfSignError('SECOND_PHARMACIST', other.name);
  const policy = await readRxSoloShiftPolicy(db, organizationId, line.branchId, {
    lock: input.lock ? 'share' : undefined,
  });
  if (!policy.enabled) throw new RxSelfSignError('SECOND_PHARMACIST', other.name);
  if (input.declaration.version !== RX_ON_DUTY_DECLARATION.version)
    throw new RxSelfSignError('STALE_DECLARATION');
  return { ...context, declared: { policyVersion: policy.version, otherSigners: others } };
}

/**
 * Write the self-signature: the rules again under the review's lock, then the audit entry, then
 * the SIGN decision that names it. Run inside the request's transaction, after the caller verified
 * the person's own PIN in its own transaction (so a wrong PIN keeps its lockout strike).
 */
export async function selfSignRxReview(
  db: ScopedDb,
  input: {
    organizationId: string;
    actor: Actor;
    reviewItemId: string;
    declaration?: RxOnDutyDeclaration | null;
  },
  now = new Date()
) {
  const context = await assertRxSelfSignAllowed(db, { ...input, lock: true }, now);
  const metadata = {
    policy: RX_SELF_SIGN_POLICY,
    selfApproved: true,
    pinVerified: true,
    soloRule: true,
    approverId: input.actor.id,
    initiatedById: input.actor.id,
    approvedAt: now.toISOString(),
    reviewItemId: context.reviewItemId,
    saleId: context.saleId,
    saleLineId: context.saleLineId,
    branchId: context.branchId,
  };
  const audit = await db.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorId: input.actor.id,
      source: 'TRPC',
      category: 'PHARMACY',
      operation: 'EXECUTE',
      action: RX_SELF_SIGN_AUDIT_ACTION,
      outcome: 'SUCCESS',
      description: context.declared
        ? 'Prescription line self-signed with a fresh PIN by the pharmacist on duty, declared the only pharmacist on duty'
        : 'Prescription line self-signed by a sole pharmacist with a fresh PIN',
      targetType: 'PharmacyPharmacistReviewItem',
      targetId: context.reviewItemId,
      metadata: context.declared
        ? {
            ...metadata,
            ...declaredSoloMetadata(context.declared),
          }
        : metadata,
    },
    select: { id: true },
  });
  const decision = await db.pharmacyPharmacistReviewDecision.create({
    data: {
      organizationId: input.organizationId,
      reviewItemId: context.reviewItemId,
      kind: 'SIGN',
      actorUserId: input.actor.id,
      signedAt: now,
      selfApprovalAuditId: audit.id,
    },
  });
  return { decision, auditId: audit.id, ...context };
}

/** DEV-960: the marker and evidence a declared solo sign-off's audit entry carries. */
export function declaredSoloMetadata(declared: RxDeclaredSolo) {
  return {
    declaredSolo: true,
    soloBasis: 'DECLARED_ON_DUTY',
    declaration: RX_ON_DUTY_DECLARATION.text,
    declarationVersion: RX_ON_DUTY_DECLARATION.version,
    soloShiftPolicyVersion: declared.policyVersion,
    otherEligibleSigners: declared.otherSigners.map((signer) => ({
      id: signer.id,
      name: signer.name,
    })),
  };
}

function otherSignersFrom(value: unknown): { id: string; name: string | null }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { id, name } = entry as { id?: unknown; name?: unknown };
    return typeof id === 'string' ? [{ id, name: typeof name === 'string' ? name : null }] : [];
  });
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : null);

/**
 * DEV-960 — every declared solo sign-off, newest first, for the owner's list: who, when, which
 * branch, sale and line, and who else was on the staff list then. Only audit entries a real
 * signature names (`selfApprovalAuditId`) are listed, so an entry written without its signature
 * never shows as a sign-off.
 */
export async function readDeclaredSoloSignOffs(
  db: ScopedDb,
  organizationId: string,
  options: { branchId?: string; limit?: number } = {}
): Promise<RxDeclaredSoloSignOff[]> {
  const take = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
  const entries = await db.auditLog.findMany({
    where: {
      organizationId,
      action: RX_SELF_SIGN_AUDIT_ACTION,
      outcome: 'SUCCESS',
      targetType: 'PharmacyPharmacistReviewItem',
      AND: [
        { metadata: { path: ['declaredSolo'], equals: true } },
        { metadata: { path: ['policy'], equals: RX_SELF_SIGN_POLICY } },
        ...(options.branchId
          ? [{ metadata: { path: ['branchId'], equals: options.branchId } }]
          : []),
      ],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
    select: { id: true, createdAt: true, actorId: true, targetId: true, metadata: true },
  });
  if (entries.length === 0) return [];
  const decisions = await db.pharmacyPharmacistReviewDecision.findMany({
    where: {
      organizationId,
      kind: 'SIGN',
      signedAt: { not: null },
      selfApprovalAuditId: { in: entries.map((entry) => entry.id) },
    },
    select: { selfApprovalAuditId: true, reviewItemId: true, actorUserId: true, signedAt: true },
  });
  const signed = new Map(decisions.map((decision) => [decision.selfApprovalAuditId, decision]));
  const rows = entries.flatMap((entry) => {
    const decision = signed.get(entry.id);
    // The signature must be the same person's, on the same review the entry names.
    if (
      !decision ||
      decision.actorUserId !== entry.actorId ||
      decision.reviewItemId !== entry.targetId
    )
      return [];
    const meta = (entry.metadata ?? {}) as Record<string, unknown>;
    return [
      {
        auditId: entry.id,
        signedAt: decision.signedAt ?? entry.createdAt,
        signerId: entry.actorId,
        branchId: text(meta.branchId),
        saleId: text(meta.saleId),
        saleLineId: text(meta.saleLineId),
        otherSigners: otherSignersFrom(meta.otherEligibleSigners),
      },
    ];
  });
  const ids = (values: (string | null)[]) => [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
  const [users, branches, sales, lines] = await Promise.all([
    db.user.findMany({
      where: { organizationId, id: { in: ids(rows.map((row) => row.signerId)) } },
      select: { id: true, name: true },
    }),
    db.pharmacyBranch.findMany({
      where: { organizationId, id: { in: ids(rows.map((row) => row.branchId)) } },
      select: { id: true, name: true },
    }),
    db.pharmacySale.findMany({
      where: { organizationId, id: { in: ids(rows.map((row) => row.saleId)) } },
      select: { id: true, receiptNumber: true },
    }),
    db.pharmacySaleLine.findMany({
      where: { organizationId, id: { in: ids(rows.map((row) => row.saleLineId)) } },
      select: { id: true, medicine: { select: { productName: true } } },
    }),
  ]);
  const userName = new Map(users.map((user) => [user.id, user.name]));
  const branchName = new Map(branches.map((branch) => [branch.id, branch.name]));
  const receipt = new Map(sales.map((sale) => [sale.id, sale.receiptNumber]));
  const product = new Map(lines.map((line) => [line.id, line.medicine.productName]));
  return rows.map((row) => ({
    ...row,
    signerName: row.signerId ? (userName.get(row.signerId) ?? null) : null,
    branchName: row.branchId ? (branchName.get(row.branchId) ?? null) : null,
    receiptNumber: row.saleId ? (receipt.get(row.saleId) ?? null) : null,
    productName: row.saleLineId ? (product.get(row.saleLineId) ?? null) : null,
  }));
}
