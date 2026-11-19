import { z } from 'zod';
import { can, subjectFromSession } from '@/lib/abac';
import { auditedProtectedProcedure, capabilityProcedure, router } from '../trpc';
import { TRPCError } from '@trpc/server';
import { annotateAuditBranch } from '../audit-branch';
import type { TRPCContext } from '../trpc';
import { annotateAudit } from '@/server/audit';
import { authenticateRefundPin } from '@/lib/pharmacy/refund-authorization';
import { readOwnPinState } from '@/lib/pharmacy/own-pin';
import { NO_PIN_SET_MESSAGE } from '@/lib/pharmacy/own-pin-policy';
import { counterBranchAssignmentDenial } from '@/lib/pharmacy/counter-capability';
import {
  assertRxSelfSignAllowed,
  otherRxReviewSigners,
  RX_SELF_SIGN_AUDIT_ACTION,
  RX_SELF_SIGN_POLICY,
  RxSelfSignError,
  selfSignRxReview,
} from '@/lib/pharmacy/rx-review-self-sign';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const dispense = capabilityProcedure('pharmacy:dispense');

/**
 * DEV-913: a review or substitution is about one counter sale line, so its audit
 * entry carries that sale's branch. Read only for the entry; a line that does not
 * resolve leaves it workspace-wide and the write decides the outcome as before.
 */
async function tagSaleLineBranch(ctx: TRPCContext, saleLineId: string | null | undefined) {
  if (!saleLineId) return;
  const line = await ctx.db.pharmacySaleLine.findFirst({
    where: { id: saleLineId },
    select: { branchId: true },
  });
  annotateAuditBranch(ctx, line?.branchId);
}

// DEV-832: dispensing queues show who the prescription is for, nothing more.
// CNIC, phone, address and date of birth stay behind the audited, masked
// patient-read route (`pharmacyPrescriptions.readPatient`).
const queuePatient = { select: { id: true, displayName: true } } as const;

const RX_SELF_SIGN_CODES: Record<RxSelfSignError['reason'], TRPCError['code']> = {
  NOT_FOUND: 'NOT_FOUND',
  NOT_REQUESTER: 'FORBIDDEN',
  NOT_ALLOWED: 'FORBIDDEN',
  CONTROLLED: 'FORBIDDEN',
  ALREADY_SIGNED: 'CONFLICT',
  SECOND_PHARMACIST: 'FORBIDDEN',
};

function rxSelfSignFailure(error: unknown): never {
  if (error instanceof RxSelfSignError)
    throw new TRPCError({ code: RX_SELF_SIGN_CODES[error.reason], message: error.message });
  throw error;
}

/** DEV-950: why the person's own PIN was not accepted, in plain words. */
export const RX_SELF_SIGN_PIN_REFUSED = 'That PIN was not accepted. Enter your own PIN to sign.';
export const RX_SELF_SIGN_PIN_LOCKED =
  'Your PIN is locked after too many wrong tries. Wait until the lock ends, then try again.';

export const pharmacyDispensingRouter = router({
  // Separate, repeatable OTC-capable work queue. These holdings remain quarantined;
  // a verification task never grants permission to credit AVAILABLE inventory.
  // DEV-897: the queue stays inside the caller's active branch assignment; only a
  // session ADMIN of this organization may open any of its branches. A branch the
  // caller may not open gets the same refusal as one that does not exist.
  returnVerificationQueue: dispense
    .input(z.object({ branchId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.entitlements?.organizationId;
      if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
      const branch = await ctx.db.pharmacyBranch.findFirst({
        where: { id: input.branchId, organizationId },
      });
      if (!branch) throw new TRPCError({ code: 'NOT_FOUND' });
      const user = ctx.session!.user;
      if (!(user.role === 'ADMIN' && user.organizationId === organizationId)) {
        const assignment = await ctx.db.pharmacyBranchAssignment.findFirst({
          where: {
            organizationId,
            userId: user.id,
            branchId: input.branchId,
            active: true,
            branch: { organizationId, active: true },
          },
          select: { branchId: true },
        });
        if (assignment?.branchId !== input.branchId) throw new TRPCError({ code: 'NOT_FOUND' });
      }
      return ctx.db.pharmacyReturnVerificationTask.findMany({
        where: { organizationId, branchId: input.branchId },
        orderBy: { requestedAt: 'asc' },
        include: {
          holding: {
            include: {
              location: { select: { name: true } },
              saleLine: { select: { medicine: { select: { productName: true } }, saleId: true } },
            },
          },
        },
      });
    }),
  reviewQueue: dispense.query(async ({ ctx }) => ({
    currentUserId: ctx.session!.user.id,
    items: await ctx.db.pharmacyPharmacistReviewItem.findMany({
      orderBy: { requestedAt: 'asc' },
      include: {
        line: {
          include: {
            medicine: true,
            presentation: true,
            prescription: {
              include: { patient: queuePatient, prescriber: { select: { id: true, name: true } } },
            },
          },
        },
        decisions: { orderBy: { createdAt: 'asc' } },
      },
    }),
  })),
  // DEV-35: the substitution workspace opens for a dispensing pharmacist or a
  // Pharmacy Safety holder (the same pair the rail offers it to). Only a
  // dispensing pharmacist may record evidence (`recordSubstitution`), so the
  // read says which of the two this caller is.
  // QA-7: patient records are a separate permission. The patient (id and name
  // only, per DEV-832) is read and returned only for a caller holding
  // `pharmacy:prescriptions`, the patient-record permission `readPatient` enforces.
  substitutionWorkspace: auditedProtectedProcedure.query(async ({ ctx }) => {
    const user = ctx.session!.user;
    const subject = subjectFromSession(user);
    const options = { db: ctx.db, source: 'TRPC' as const, ip: ctx.requestMeta.ip };
    const canRecord =
      Boolean(user.id) && (await can(subject, 'pharmacy:dispense', undefined, options));
    if (
      !canRecord &&
      !(Boolean(user.id) && (await can(subject, 'pharmacy:safety', undefined, options)))
    ) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'You do not have permission for this action.',
      });
    }
    const canViewPatients = await can(subject, 'pharmacy:prescriptions', undefined, options);
    const orderBy = { requestedAt: 'desc' } as const;
    const medicine = { include: { presentations: { orderBy: { presentation: 'asc' } } } } as const;
    // Without that permission the patient relation is never read and every line
    // carries `patient: null`.
    const lines = canViewPatients
      ? await ctx.db.pharmacyPharmacistReviewItem.findMany({
          orderBy,
          include: {
            line: {
              include: {
                medicine,
                presentation: true,
                prescription: { include: { patient: queuePatient } },
              },
            },
          },
        })
      : (
          await ctx.db.pharmacyPharmacistReviewItem.findMany({
            orderBy,
            include: { line: { include: { medicine, presentation: true, prescription: true } } },
          })
        ).map((item) => ({
          ...item,
          line: { ...item.line, prescription: { ...item.line.prescription, patient: null } },
        }));
    return { canRecord, canViewPatients, lines };
  }),
  enqueueReview: dispense
    .input(
      z.object({ prescriptionLineId: z.string().min(1), saleLineId: z.string().min(1) }).strict()
    )
    .mutation(async ({ ctx, input }) => {
      await tagSaleLineBranch(ctx, input.saleLineId);
      return ctx.db.pharmacyPharmacistReviewItem.create({
        data: { ...input, requestedByUserId: ctx.session!.user.id },
      });
    }),
  decideReview: dispense
    .input(
      z
        .object({
          reviewItemId: z.string().min(1),
          kind: z.enum(['VERIFY', 'CLARIFY', 'REFUSE', 'OVERRIDE', 'COUNSEL', 'SIGN']),
          reason: z.string().trim().min(1).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const item = await ctx.db.pharmacyPharmacistReviewItem.findFirst({
        where: { id: input.reviewItemId },
        select: { saleLineId: true },
      });
      await tagSaleLineBranch(ctx, item?.saleLineId);
      return ctx.db.pharmacyPharmacistReviewDecision.create({
        data: {
          ...input,
          actorUserId: ctx.session!.user.id,
          signedAt: input.kind === 'SIGN' ? new Date() : undefined,
        },
      });
    }),
  // DEV-950: the counter asks, for the bill in front of it, which prescription lines still wait
  // for a pharmacist's signature and whether this person may sign one alone (the solo rule).
  // Read only; the sign itself re-checks everything (`selfSignReview`).
  counterSignStatus: dispense
    .input(z.object({ branchId: z.string().min(1), saleId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.entitlements?.organizationId;
      if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
      const user = ctx.session!.user;
      const db = ctx.db as unknown as ScopedDb;
      if (await counterBranchAssignmentDenial(db, user, organizationId, input.branchId))
        return { lines: [], pin: null };
      const saleLines = await ctx.db.pharmacySaleLine.findMany({
        where: { organizationId, branchId: input.branchId, saleId: input.saleId },
        select: { id: true, medicine: { select: { productName: true, controlled: true } } },
      });
      if (saleLines.length === 0) return { lines: [], pin: null };
      const items = await ctx.db.pharmacyPharmacistReviewItem.findMany({
        where: { organizationId, saleLineId: { in: saleLines.map((line) => line.id) } },
        orderBy: { requestedAt: 'asc' },
        select: {
          id: true,
          saleLineId: true,
          requestedByUserId: true,
          decisions: {
            where: { kind: 'SIGN', signedAt: { not: null } },
            select: { id: true },
            take: 1,
          },
        },
      });
      const waiting = items.filter((item) => item.decisions.length === 0);
      if (waiting.length === 0) return { lines: [], pin: null };
      const [other] = await otherRxReviewSigners(db, {
        organizationId,
        branchId: input.branchId,
        actorId: user.id,
      });
      const lines = waiting.map((item) => {
        const line = saleLines.find((saleLine) => saleLine.id === item.saleLineId)!;
        const mine = item.requestedByUserId === user.id;
        return {
          reviewItemId: item.id,
          saleLineId: item.saleLineId,
          productName: line.medicine.productName,
          controlled: line.medicine.controlled,
          rungUpByYou: mine,
          // The solo rule: nobody else at this branch could sign it, and it is not controlled.
          maySelfSign: mine && !line.medicine.controlled && !other,
          askName: mine && other ? other.name : null,
        };
      });
      const pin = lines.some((line) => line.maySelfSign)
        ? await readOwnPinState(db, organizationId, user.id)
        : null;
      return { lines, pin };
    }),
  // DEV-950: the requester signs their own review under the solo rule, with their own PIN
  // re-entered now. Everything is refused before the PIN is checked when the rule does not apply,
  // so no lockout strike is spent on it.
  selfSignReview: dispense
    .input(
      z
        .object({
          reviewItemId: z.string().min(1),
          // The signed-in pharmacist's own PIN, re-entered for every self-signature. The request
          // audit redacts it by key.
          pin: z.string().regex(/^\d{4,8}$/),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.entitlements?.organizationId;
      if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
      const actor = ctx.session!.user;
      const db = ctx.db as unknown as ScopedDb;
      let context;
      try {
        context = await assertRxSelfSignAllowed(db, {
          organizationId,
          actor,
          reviewItemId: input.reviewItemId,
        });
      } catch (error) {
        rxSelfSignFailure(error);
      }
      annotateAuditBranch(ctx, context.branchId);
      // Its own transaction (the shared own-PIN check and lockout), so a refused PIN keeps its
      // strike and its FAILURE audit entry although this request is refused.
      const pin = await authenticateRefundPin({
        organizationId,
        actorId: actor.id,
        pin: input.pin,
        action: RX_SELF_SIGN_AUDIT_ACTION,
        policy: RX_SELF_SIGN_POLICY,
        errorCode: 'RX_SELF_SIGN_PIN_REFUSED',
      });
      if ('blocked' in pin) {
        const state = await readOwnPinState(db, organizationId, actor.id);
        throw new TRPCError({
          code: 'FORBIDDEN',
          message:
            state.state !== 'SET'
              ? NO_PIN_SET_MESSAGE
              : state.locked
                ? RX_SELF_SIGN_PIN_LOCKED
                : RX_SELF_SIGN_PIN_REFUSED,
        });
      }
      try {
        const signed = await selfSignRxReview(db, {
          organizationId,
          actor,
          reviewItemId: input.reviewItemId,
        });
        annotateAudit(ctx, {
          metadata: {
            policy: RX_SELF_SIGN_POLICY,
            selfApproved: true,
            pinVerified: true,
            selfApprovalAuditId: signed.auditId,
            reviewItemId: signed.reviewItemId,
            saleId: signed.saleId,
            saleLineId: signed.saleLineId,
          },
        });
        return { decisionId: signed.decision.id, signedAt: signed.decision.signedAt };
      } catch (error) {
        rxSelfSignFailure(error);
      }
    }),
  recordSubstitution: dispense
    .input(
      z
        .object({
          prescriptionLineId: z.string().min(1),
          saleLineId: z.string().min(1),
          prescribedPresentationId: z.string().min(1),
          suppliedPresentationId: z.string().min(1),
          equivalenceBasis: z.string().trim().min(1),
          patientCommunication: z.string().trim().min(1),
          jurisdictionRuleRef: z.string().trim().min(1),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await tagSaleLineBranch(ctx, input.saleLineId);
      return ctx.db.pharmacySubstitutionRecord.create({
        data: { ...input, actorUserId: ctx.session!.user.id },
      });
    }),
});
