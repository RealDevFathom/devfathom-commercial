import 'server-only';

import type { Prisma } from '@/generated/prisma/client';
import type { RestaurantStaffStatus } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * M2-L2 / §9 / C3 — restaurant staff-profile lifecycle (back-office server).
 *
 * A staff profile is deliberately NOT a `User` (C3): an operator can exist with
 * no web-login identity at all. So `email` is optional (unique within the
 * organization only when present — a partial unique index enforces that, and the
 * friendly pre-check below turns a collision into a domain error instead of a
 * raw Prisma unique-constraint throw), and `userId` is an optional, one-way
 * nullable link (the profile references a `User`; setting it does not turn the
 * profile into a login, and clearing it never deletes the user — `onDelete:
 * SetNull` on the relation).
 *
 * Every function takes a tenant-scoped `ScopedDb`: `organizationId` is supplied
 * by the RLS default on the row and must never be forged by the caller. This
 * module owns the staff CRUD business rules only; credential issue/rotate/revoke
 * lives in `credential-lifecycle.ts`, and the hashing/policy core stays in L1's
 * `operator-credentials.ts` (never reimplemented here).
 */

export type StaffProfileErrorReason =
  'INVALID' | 'EMAIL_TAKEN' | 'BRANCH_NOT_FOUND' | 'USER_NOT_FOUND' | 'NOT_FOUND';

export class StaffProfileError extends Error {
  constructor(
    message: string,
    readonly reason: StaffProfileErrorReason
  ) {
    super(message);
    this.name = 'StaffProfileError';
  }
}

/**
 * Normalise an optional email: trim + lowercase, and fold blank to `null`.
 * `null` means "no email" (C3), which is a valid state — not an error — and is
 * exempt from the uniqueness check. Lowercasing matches the platform's user
 * email handling so a differently-cased duplicate cannot slip past.
 */
export function normalizeStaffEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined) return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length === 0 ? null : normalized;
}

/**
 * Reject a duplicate email inside the organization before it reaches the partial
 * unique index. A `null` email is always available (many profiles may have none).
 * `excludeId` lets an update ignore the row it is editing.
 */
async function assertEmailAvailable(
  db: ScopedDb,
  email: string | null,
  excludeId: string | null
): Promise<void> {
  if (email === null) return;
  const clash = await db.restaurantStaffProfile.findFirst({
    where: { email, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  if (clash) {
    throw new StaffProfileError(
      'A staff profile with this email already exists in this organization.',
      'EMAIL_TAKEN'
    );
  }
}

/** A referenced primary branch must exist in the caller's organization (RLS scopes the lookup). */
async function assertBranchInScope(db: ScopedDb, branchId: string): Promise<void> {
  const branch = await db.restaurantBranch.findUnique({
    where: { id: branchId },
    select: { id: true },
  });
  if (!branch) {
    throw new StaffProfileError('The primary branch does not exist.', 'BRANCH_NOT_FOUND');
  }
}

/**
 * A linked `User` must exist in the caller's organization (RLS scopes the lookup).
 * Only the server's own invite path (DEV-253) may link a still-INVITED account.
 */
async function assertUserInScope(
  db: ScopedDb,
  userId: string,
  currentProfileId?: string,
  allowInvitedUser = false
): Promise<void> {
  const user = await db.user.findFirst({
    where: {
      id: userId,
      status: allowInvitedUser ? { in: ['ACTIVE', 'INVITED'] } : 'ACTIVE',
      restaurantStaffProfiles: currentProfileId
        ? { every: { id: currentProfileId } }
        : { none: {} },
    },
    select: { id: true },
  });
  if (!user) {
    throw new StaffProfileError('The selected organization user is unavailable.', 'USER_NOT_FOUND');
  }
}

export type CreateStaffProfileInput = {
  displayName: string;
  email?: string | null;
  userId?: string | null;
  primaryBranchId?: string | null;
  status?: RestaurantStaffStatus;
};

export type CreateStaffProfileOptions = {
  /** Server-internal: the account was just invited by this same request. */
  allowInvitedUser?: boolean;
};

export async function createStaffProfile(
  db: ScopedDb,
  input: CreateStaffProfileInput,
  options: CreateStaffProfileOptions = {}
) {
  const displayName = input.displayName.trim();
  if (displayName.length === 0) {
    throw new StaffProfileError('A staff profile requires a display name.', 'INVALID');
  }
  const email = normalizeStaffEmail(input.email);
  await assertEmailAvailable(db, email, null);
  if (input.primaryBranchId) await assertBranchInScope(db, input.primaryBranchId);
  if (input.userId) {
    await assertUserInScope(db, input.userId, undefined, options.allowInvitedUser);
  }

  return db.restaurantStaffProfile.create({
    data: {
      displayName,
      email,
      userId: input.userId ?? null,
      primaryBranchId: input.primaryBranchId ?? null,
      status: input.status ?? 'ACTIVE',
    },
  });
}

export type UpdateStaffProfileInput = {
  displayName?: string;
  email?: string | null;
  userId?: string | null;
  primaryBranchId?: string | null;
  status?: RestaurantStaffStatus;
};

/**
 * Partial update. A field absent from `patch` is left untouched; a field present
 * with `null` (email/userId/primaryBranch) clears it. The one-way user link can
 * be attached or detached here, but detaching only nulls the link — it never
 * deletes the `User` (C3).
 */
export async function updateStaffProfile(db: ScopedDb, id: string, patch: UpdateStaffProfileInput) {
  const existing = await db.restaurantStaffProfile.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!existing) {
    throw new StaffProfileError('Staff profile not found.', 'NOT_FOUND');
  }

  const data: Prisma.RestaurantStaffProfileUncheckedUpdateInput = {};

  if (patch.displayName !== undefined) {
    const displayName = patch.displayName.trim();
    if (displayName.length === 0) {
      throw new StaffProfileError('A staff profile requires a display name.', 'INVALID');
    }
    data.displayName = displayName;
  }
  if (patch.email !== undefined) {
    const email = normalizeStaffEmail(patch.email);
    await assertEmailAvailable(db, email, id);
    data.email = email;
  }
  if (patch.userId !== undefined) {
    if (patch.userId) await assertUserInScope(db, patch.userId, id);
    data.userId = patch.userId;
  }
  if (patch.primaryBranchId !== undefined) {
    if (patch.primaryBranchId) await assertBranchInScope(db, patch.primaryBranchId);
    data.primaryBranchId = patch.primaryBranchId;
  }
  if (patch.status !== undefined) {
    data.status = patch.status;
  }

  return db.restaurantStaffProfile.update({ where: { id }, data });
}

/**
 * Change a profile's lifecycle status. Deactivation (SUSPENDED) and archival
 * (ARCHIVED) gate operator sign-in without touching any web login — the terminal
 * path re-checks the profile status in the DB on every call (C5, enforced in
 * L3), so this is a plain, immediate status write. It does NOT revoke the
 * operator's credentials; revocation is an explicit, separate action
 * (`credential-lifecycle.ts`).
 */
export async function setStaffProfileStatus(
  db: ScopedDb,
  id: string,
  status: RestaurantStaffStatus
) {
  const existing = await db.restaurantStaffProfile.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!existing) {
    throw new StaffProfileError('Staff profile not found.', 'NOT_FOUND');
  }
  return db.restaurantStaffProfile.update({ where: { id }, data: { status } });
}
