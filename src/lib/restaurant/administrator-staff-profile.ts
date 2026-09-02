import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { normalizeStaffEmail } from '@/lib/restaurant/staff';

/**
 * WHA-1181 — the organization administrator SuperAdmin creates for a restaurant
 * organization must own a `RestaurantStaffProfile`.
 *
 * Every restaurant surface resolves the signed-in web user to one: the shared
 * actor gate (`src/server/restaurant-actor.ts`) and the notification procedures
 * (`src/server/routers/restaurant-notifications.ts`) both answer FORBIDDEN
 * without it. Onboarding created the branch, the branch assignment and the role
 * templates but never the profile, so the workspace nav rendered over a session
 * whose every restaurant call was denied.
 *
 * Idempotence is keyed on the one-way `userId` link, and an existing profile is
 * returned untouched whatever its status: re-activating one an operator
 * deliberately SUSPENDED would be a privilege change, not a repair.
 *
 * `organizationId` is always explicit. The platform control plane runs its
 * commands through `withPlatformDb`, which sets `app.is_platform_admin=true` and
 * blanks `app.current_organization_id`, so the column's GUC default resolves to
 * the empty string there. Passing the id the caller already holds keeps the
 * platform and tenant entry points on one write.
 */

export type AdministratorStaffProfileInput = {
  organizationId: string;
  userId: string;
  /**
   * `User.name` is NOT NULL, so callers normally pass a real name. Widened
   * anyway because a staff profile REQUIRES a display name: falling back is
   * strictly better than throwing part-way through an activation.
   */
  displayName: string | null | undefined;
  email?: string | null;
};

export type AdministratorStaffProfileResult = {
  created: boolean;
  staffProfileId: string;
  primaryBranchId: string | null;
};

export async function ensureAdministratorStaffProfile(
  db: ScopedDb,
  input: AdministratorStaffProfileInput
): Promise<AdministratorStaffProfileResult> {
  const existing = await db.restaurantStaffProfile.findFirst({
    where: { organizationId: input.organizationId, userId: input.userId },
    select: { id: true, primaryBranchId: true },
    orderBy: { createdAt: 'asc' },
  });
  if (existing) {
    return {
      created: false,
      staffProfileId: existing.id,
      primaryBranchId: existing.primaryBranchId,
    };
  }

  // The default branch is the one restaurant onboarding creates (§9 Steps 3/5/6);
  // ordering falls back to the oldest active branch so an organization whose
  // default flag was moved still lands the administrator somewhere real. A
  // branch-less organization still gets the profile — the 403 is what blocks the
  // workspace, and `primaryBranchId` is nullable by design.
  const branch = await db.restaurantBranch.findFirst({
    where: { organizationId: input.organizationId, active: true },
    select: { id: true },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });

  // `email` on a staff profile is an operator-directory field carrying a partial
  // unique index per organization — it is NOT the login identity, which is the
  // `userId` link above. Yield it when another profile already claims the
  // address rather than failing an activation over a directory collision.
  const email = normalizeStaffEmail(input.email);
  const emailTaken =
    email === null
      ? false
      : (await db.restaurantStaffProfile.findFirst({
          where: { organizationId: input.organizationId, email },
          select: { id: true },
        })) !== null;

  const displayName = (input.displayName ?? '').trim() || 'Organization administrator';
  const profile = await db.restaurantStaffProfile.create({
    data: {
      organizationId: input.organizationId,
      userId: input.userId,
      displayName,
      email: emailTaken ? null : email,
      primaryBranchId: branch?.id ?? null,
      status: 'ACTIVE',
    },
    select: { id: true, primaryBranchId: true },
  });

  return { created: true, staffProfileId: profile.id, primaryBranchId: profile.primaryBranchId };
}
