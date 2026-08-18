import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { router, capabilityProcedure } from '../trpc';
import { annotateAudit } from '../audit';
import {
  StaffProfileError,
  createStaffProfile,
  setStaffProfileStatus,
  updateStaffProfile,
} from '@/lib/restaurant/staff';
import {
  CredentialLifecycleError,
  issueOperatorCredential,
  revokeOperatorCredential,
  rotateOperatorCredential,
} from '@/lib/restaurant/credential-lifecycle';
import { CredentialPolicyError } from '@/lib/restaurant/operator-credentials';

/**
 * M2-L2 — back-office server surface for restaurant staff CRUD and operator
 * credential issue/rotate/revoke.
 *
 * Every procedure is gated by `capabilityProcedure('staff:manage')`: it audits
 * (mutations and sensitive reads), enforces the licensed module
 * (`restaurant-core`, see `module-catalog.ts`), and runs the ABAC decision for
 * `staff:manage` (org-role driven — see `abac/policies.ts`). Tenant scoping is by
 * the RLS-forced `organizationId` default on every row (C1); no resolver forges
 * an organization id.
 *
 * Credential-bearing mutations set `annotateAudit(..., { skipInput: true })` as
 * their FIRST statement so the plaintext PIN/badge is never captured in the audit
 * log — on the success path AND the failure path, since the audit middleware
 * records failures too (C4). Credential responses never include `credentialHash`.
 */

const STAFF_STATUS = z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']);
const CREDENTIAL_TYPE = z.enum(['PIN', 'BADGE']);

/** Translate a staff-domain error into the right tRPC status; rethrow anything else. */
function mapStaffError(err: unknown): never {
  if (err instanceof StaffProfileError) {
    const code =
      err.reason === 'EMAIL_TAKEN'
        ? 'CONFLICT'
        : err.reason === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  throw err;
}

/** Translate a credential policy/lifecycle error into the right tRPC status; rethrow anything else. */
function mapCredentialError(err: unknown): never {
  if (err instanceof CredentialPolicyError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
  }
  if (err instanceof CredentialLifecycleError) {
    const code =
      err.reason === 'ALREADY_EXISTS' || err.reason === 'REVOKED'
        ? 'CONFLICT'
        : err.reason === 'NOT_FOUND' || err.reason === 'STAFF_NOT_FOUND'
          ? 'NOT_FOUND'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  throw err;
}

const staffProcedure = capabilityProcedure('staff:manage');

export const restaurantStaffRouter = router({
  // ── Staff profiles ────────────────────────────────────────────────────────
  list: staffProcedure
    .input(
      z
        .object({
          status: STAFF_STATUS.optional(),
          branchId: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      return ctx.db.restaurantStaffProfile.findMany({
        where: {
          ...(input?.status ? { status: input.status } : {}),
          ...(input?.branchId ? { primaryBranchId: input.branchId } : {}),
        },
        select: {
          id: true,
          displayName: true,
          email: true,
          userId: true,
          primaryBranchId: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          primaryBranch: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
    }),

  create: staffProcedure
    .input(
      z.object({
        displayName: z.string().min(1).max(200),
        email: z.string().email().max(320).nullable().optional(),
        userId: z.string().nullable().optional(),
        primaryBranchId: z.string().nullable().optional(),
        status: STAFF_STATUS.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const staff = await createStaffProfile(ctx.db, input);
        annotateAudit(ctx, {
          targetType: 'RestaurantStaffProfile',
          targetId: staff.id,
          targetLabel: staff.displayName,
          description: `Created restaurant staff profile "${staff.displayName}"`,
          metadata: {
            hasUserLink: staff.userId != null,
            primaryBranchId: staff.primaryBranchId,
          },
        });
        return staff;
      } catch (err) {
        mapStaffError(err);
      }
    }),

  update: staffProcedure
    .input(
      z.object({
        id: z.string(),
        displayName: z.string().min(1).max(200).optional(),
        email: z.string().email().max(320).nullable().optional(),
        userId: z.string().nullable().optional(),
        primaryBranchId: z.string().nullable().optional(),
        status: STAFF_STATUS.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        const staff = await updateStaffProfile(ctx.db, id, patch);
        annotateAudit(ctx, {
          targetType: 'RestaurantStaffProfile',
          targetId: staff.id,
          targetLabel: staff.displayName,
          description: `Updated restaurant staff profile "${staff.displayName}"`,
        });
        return staff;
      } catch (err) {
        mapStaffError(err);
      }
    }),

  // Deactivate / reactivate / archive. Status gates operator sign-in (C5,
  // enforced at the terminal in L3); it does not itself revoke credentials.
  setStatus: staffProcedure
    .input(z.object({ id: z.string(), status: STAFF_STATUS }))
    .mutation(async ({ ctx, input }) => {
      try {
        const staff = await setStaffProfileStatus(ctx.db, input.id, input.status);
        annotateAudit(ctx, {
          targetType: 'RestaurantStaffProfile',
          targetId: staff.id,
          targetLabel: staff.displayName,
          description: `Set restaurant staff profile "${staff.displayName}" status to ${input.status}`,
          metadata: { status: input.status },
        });
        return staff;
      } catch (err) {
        mapStaffError(err);
      }
    }),

  // ── Operator credentials ──────────────────────────────────────────────────
  // Metadata only — `credentialHash` is never selected, so it cannot leak.
  listCredentials: staffProcedure
    .input(z.object({ staffProfileId: z.string(), includeRevoked: z.boolean().optional() }))
    .query(async ({ ctx, input }) => {
      return ctx.db.restaurantOperatorCredential.findMany({
        where: {
          staffProfileId: input.staffProfileId,
          ...(input.includeRevoked ? {} : { revokedAt: null }),
        },
        select: {
          id: true,
          staffProfileId: true,
          deviceId: true,
          type: true,
          failedAttempts: true,
          lockedUntil: true,
          revokedAt: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });
    }),

  issueCredential: staffProcedure
    .input(
      z.object({
        staffProfileId: z.string(),
        type: CREDENTIAL_TYPE,
        secret: z.string().min(1),
        deviceId: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // C4: never let the plaintext secret reach the audit log, even on failure.
      annotateAudit(ctx, { skipInput: true });
      try {
        const credential = await issueOperatorCredential(ctx.db, input);
        annotateAudit(ctx, {
          skipInput: true,
          targetType: 'RestaurantOperatorCredential',
          targetId: credential.id,
          description: `Issued ${credential.type} operator credential`,
          metadata: {
            staffProfileId: credential.staffProfileId,
            type: credential.type,
            deviceId: credential.deviceId,
          },
        });
        // Response carries no secret and no hash.
        return {
          id: credential.id,
          staffProfileId: credential.staffProfileId,
          type: credential.type,
          deviceId: credential.deviceId,
          createdAt: credential.createdAt,
        };
      } catch (err) {
        mapCredentialError(err);
      }
    }),

  rotateCredential: staffProcedure
    .input(z.object({ credentialId: z.string(), secret: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, { skipInput: true });
      try {
        const credential = await rotateOperatorCredential(ctx.db, input);
        annotateAudit(ctx, {
          skipInput: true,
          targetType: 'RestaurantOperatorCredential',
          targetId: credential.id,
          description: `Rotated ${credential.type} operator credential`,
          metadata: { type: credential.type },
        });
        return {
          id: credential.id,
          type: credential.type,
          updatedAt: credential.updatedAt,
        };
      } catch (err) {
        mapCredentialError(err);
      }
    }),

  revokeCredential: staffProcedure
    .input(z.object({ credentialId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Uniform C4 treatment for credential-bearing mutations: skip raw-input
      // capture (the credential id is still recorded below as the audit target).
      annotateAudit(ctx, { skipInput: true });
      try {
        const credential = await revokeOperatorCredential(ctx.db, input);
        annotateAudit(ctx, {
          skipInput: true,
          targetType: 'RestaurantOperatorCredential',
          targetId: credential.id,
          description: `Revoked ${credential.type} operator credential`,
          metadata: { type: credential.type, revokedAt: credential.revokedAt },
        });
        return {
          id: credential.id,
          type: credential.type,
          revokedAt: credential.revokedAt,
        };
      } catch (err) {
        mapCredentialError(err);
      }
    }),
});
