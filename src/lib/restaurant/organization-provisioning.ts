import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { withOrganizationDefaults } from '@/lib/tenancy/scoped-db';
import {
  ensureAdministratorStaffProfile,
  type AdministratorStaffProfileResult,
} from '@/lib/restaurant/administrator-staff-profile';
import { ensureDefaultJobRoles, grantJobRole } from '@/lib/restaurant/job-roles';

/**
 * WHA-1181 — everything a restaurant organization needs before its first
 * administrator can actually use the workspace, in ONE idempotent write path.
 *
 * This module names no vertical (§2.3): everything under `src/lib/restaurant/`
 * is restaurant-only by construction, so there is nothing to branch on here. The
 * caller that DOES hold an organization's vertical — `src/lib/platform/commands.ts`,
 * the one approved server enforcement point — decides whether to call it.
 *
 * The owner reported this as four separate staging failures. They are one bug:
 * the platform control plane creates an organization, a branch, a user and a
 * back-office `OrganizationRole`, and then stops — while every restaurant
 * surface reads a different set of rows that nothing ever wrote.
 *
 *   - no `RestaurantStaffProfile` → every restaurant procedure answers 403
 *     ("not linked to a restaurant staff profile"), and the client polled it;
 *   - no `RestaurantJobRole` rows → the role-profile dialog reads "No active
 *     role profiles exist", so every capability had to be granted one at a time
 *     as a DIRECT exception rather than inherited from a role;
 *   - no `RestaurantKitchenStation` → "Enroll this browser" as a kitchen display
 *     dead-ends on an empty, required station select.
 *
 * ONE ENTRY POINT, NOT THREE. {@link provisionRestaurantOrganization} is called
 * from both places the control plane can produce an administrator — the
 * `organization.create` administrator step and the `organization.transition` to
 * ACTIVE — so a repair is never half-applied and an organization created before
 * this code is fully repaired the next time it is activated.
 *
 * IDEMPOTENCE IS PER-CONCERN, NOT A GLOBAL FLAG. Each step below decides for
 * itself whether its rows already exist, so a partially provisioned organization
 * converges rather than being skipped wholesale. Nothing here ever RECONCILES an
 * existing row: renamed stations, deactivated roles and suspended profiles
 * survive a re-run. An active owner role is regranted when its holding is absent;
 * callers authorize this repair as organization-wide administrator provisioning.
 *
 * TENANT DEFAULTS. The whole body runs inside {@link withOrganizationDefaults}
 * because the reused domain writers (`job-roles.ts`, and the station insert
 * below) let `organizationId` fall to its schema default, which reads
 * `app.current_organization_id` — blank under the platform control plane.
 */

/** The back-office administrator's floor role: `owner`, from the vertical catalog. */
export const ADMINISTRATOR_JOB_ROLE_KEY = 'owner';

/**
 * The station every branch gets. A station with no routing rules is the branch's
 * routing fall-through (see `station-routing.ts`: product > category > default),
 * so one default "Kitchen" receives tickets for ALL categories without a single
 * rule row — which is exactly the "Kitchen, all categories" the owner asked for.
 */
export const DEFAULT_KITCHEN_STATION_NAME = 'Kitchen';

export type RestaurantAdministratorInput = {
  id: string;
  name: string | null;
  email: string | null;
};

export type ProvisionedAdministrator = AdministratorStaffProfileResult & {
  userId: string;
  /** True when this run granted the `owner` job role; false when already held. */
  roleProfileGranted: boolean;
};

export type RestaurantProvisioningResult = {
  administrators: ProvisionedAdministrator[];
  /** Job-role keys created by this run. Empty on a re-run. */
  jobRolesCreated: string[];
  /** Branches that received their first kitchen station in this run. */
  stationsCreated: { branchId: string; stationId: string; name: string }[];
};

/**
 * Seed the branch's default kitchen station when the branch has NONE.
 *
 * The guard is "no stations at all", not "no default station": an operator who
 * created "Grill" and "Bar" and made one of them the default has a working
 * branch, and adding a "Kitchen" they never asked for would silently start
 * routing tickets somewhere nobody is looking. A branch with zero stations is
 * the only unambiguous gap.
 *
 * `isDefault: true` is safe to set directly here precisely because the branch has
 * no stations — there is no incumbent default to clear, so this never races the
 * partial unique index the way a general `createStation` must.
 */
async function ensureDefaultKitchenStation(db: ScopedDb, branchId: string) {
  const existing = await db.restaurantKitchenStation.findFirst({
    where: { branchId },
    select: { id: true },
  });
  if (existing) return null;

  return db.restaurantKitchenStation.create({
    data: { branchId, name: DEFAULT_KITCHEN_STATION_NAME, isDefault: true },
    select: { id: true, name: true, branchId: true },
  });
}

export async function provisionRestaurantOrganization(
  db: ScopedDb,
  input: { organizationId: string; administrators: readonly RestaurantAdministratorInput[] }
): Promise<RestaurantProvisioningResult> {
  return withOrganizationDefaults(db, input.organizationId, async (tx) => {
    // Roles first: the administrator's profile is granted one below, and a grant
    // cannot name a role that does not exist yet.
    const { created: jobRolesCreated } = await ensureDefaultJobRoles(tx);

    const branches = await tx.restaurantBranch.findMany({
      where: { organizationId: input.organizationId, active: true },
      select: { id: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const stationsCreated: RestaurantProvisioningResult['stationsCreated'] = [];
    for (const branch of branches) {
      const station = await ensureDefaultKitchenStation(tx, branch.id);
      if (station) {
        stationsCreated.push({
          branchId: branch.id,
          stationId: station.id,
          name: station.name,
        });
      }
    }

    // The `owner` role is looked up by key rather than taken from
    // `jobRolesCreated` so a re-run still finds the row a previous run seeded.
    // An operator who deactivated it gets no grant: `grantJobRole` rejects an
    // inactive role, and reactivating one behind their back is not a repair.
    const ownerRole = await tx.restaurantJobRole.findFirst({
      where: { organizationId: input.organizationId, key: ADMINISTRATOR_JOB_ROLE_KEY },
      select: { id: true, active: true },
    });

    const administrators: ProvisionedAdministrator[] = [];
    for (const administrator of input.administrators) {
      const profile = await ensureAdministratorStaffProfile(tx, {
        organizationId: input.organizationId,
        userId: administrator.id,
        displayName: administrator.name,
        email: administrator.email,
      });
      // Job-role holdings are per branch, and the administrator's is the branch
      // their profile points at. An owner holding already reaches every active
      // branch at decision time (`resolveStaffCapabilityDecision`,
      // `staffBranchMembership`), so no per-branch holding or branch assignment
      // is persisted here: generated rows would outlive revocation of ownership.
      // A branch-less organization gets the profile and no holding.
      const roleProfileGranted =
        ownerRole?.active && profile.primaryBranchId
          ? (
              await grantJobRole(tx, {
                staffProfileId: profile.staffProfileId,
                jobRoleId: ownerRole.id,
                branchId: profile.primaryBranchId,
              })
            ).changed
          : false;
      administrators.push({ ...profile, userId: administrator.id, roleProfileGranted });
    }

    return { administrators, jobRolesCreated, stationsCreated };
  });
}
