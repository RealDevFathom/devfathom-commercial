import 'server-only';

import type { Session } from 'next-auth';
import {
  bootstrapDemoRestaurantOrganizationInTransaction,
  demoRestaurantApproverUserId,
} from '@/lib/platform/commands';
import { createJobRole, setJobRoleCapabilities, updateJobRole } from '@/lib/restaurant/job-roles';
import {
  issueOperatorCredential,
  rotateOperatorCredential,
} from '@/lib/restaurant/credential-lifecycle';
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { createStaffProfile, updateStaffProfile } from '@/lib/restaurant/staff';
import { type ScopedDb } from '@/lib/tenancy/scoped-db';
import { isTenantLifecycleAccessible, type TenantOrganization } from '@/lib/tenancy/host';
import { RESTAURANT_CAPABILITIES } from '@/lib/vertical-catalog';
import { createTRPCContext, type TRPCContext } from '@/server/trpc';
import { demoApproverEmail, deriveDemoApproverPin } from './approval';
import { DEMO_SESSION_MAX_AGE } from './config';
import { demoSeatIdentity, type DemoSeatIdentity } from './seed-data';

export const DEMO_RESTAURANT_JOB_ROLE_KEY = 'demo-restaurant-operator';

function canonicalIdentity(identity: DemoSeatIdentity): DemoSeatIdentity {
  const canonical = demoSeatIdentity(identity.seatNumber);
  for (const key of Object.keys(canonical) as (keyof DemoSeatIdentity)[]) {
    if (identity[key] !== canonical[key]) {
      throw new Error(`Demo seat ${identity.seatNumber} has a non-canonical ${key}.`);
    }
  }
  return canonical;
}

function identityFromOrganizationId(organizationId: string): DemoSeatIdentity {
  const match = /^org_demo_restaurant_seat_(\d+)$/.exec(organizationId);
  if (!match) throw new Error('A canonical demo restaurant organization ID is required.');
  const identity = demoSeatIdentity(Number(match[1]));
  if (identity.organizationId !== organizationId) {
    throw new Error('A canonical demo restaurant organization ID is required.');
  }
  return identity;
}

async function runInTenantScope<T>(
  db: ScopedDb,
  organizationId: string,
  run: () => Promise<T>
): Promise<T> {
  const [previousScope] = await db.$queryRawUnsafe<
    { organizationId: string | null; isPlatformAdmin: string | null }[]
  >(
    `SELECT current_setting('app.current_organization_id', true) AS "organizationId",
            current_setting('app.is_platform_admin', true) AS "isPlatformAdmin"`
  );
  if (!previousScope) throw new Error('The current demo bootstrap database scope is required.');
  await db.$queryRawUnsafe(
    `SELECT set_config('app.current_organization_id', $1, true),
            set_config('app.is_platform_admin', 'false', true)`,
    organizationId
  );
  try {
    return await run();
  } finally {
    await db.$queryRawUnsafe(
      `SELECT set_config('app.current_organization_id', $1, true),
              set_config('app.is_platform_admin', $2, true)`,
      previousScope.organizationId ?? '',
      previousScope.isPlatformAdmin ?? 'false'
    );
  }
}

async function ensureStaffAndAuthority(db: ScopedDb, identity: DemoSeatIdentity): Promise<void> {
  const managerProfiles = await db.restaurantStaffProfile.findMany({
    where: { userId: identity.managerUserId },
    select: { id: true, email: true, status: true },
    take: 2,
  });
  if (managerProfiles.length > 1) {
    throw new Error('Demo manager must have exactly one restaurant staff profile.');
  }
  const managerProfile =
    managerProfiles[0] ??
    (await createStaffProfile(db, {
      displayName: 'Demo Restaurant Manager',
      email: identity.managerEmail,
      userId: identity.managerUserId,
      primaryBranchId: null,
      status: 'ACTIVE',
    }));
  if (managerProfile.email !== identity.managerEmail) {
    throw new Error('Demo manager staff profile has a non-canonical email.');
  }
  if (managerProfile.status !== 'ACTIVE') {
    await updateStaffProfile(db, managerProfile.id, { status: 'ACTIVE' });
  }

  const approverEmail = demoApproverEmail(identity.seatNumber);
  const approverUserId = demoRestaurantApproverUserId(identity.seatNumber);
  const approverProfiles = await db.restaurantStaffProfile.findMany({
    where: { OR: [{ userId: approverUserId }, { email: approverEmail }] },
    select: { id: true, userId: true, email: true, status: true },
    take: 2,
  });
  if (approverProfiles.length > 1) {
    throw new Error('Demo approver must have exactly one restaurant staff profile.');
  }
  const approver =
    approverProfiles[0] ??
    (await createStaffProfile(db, {
      displayName: 'Demo approving manager',
      email: approverEmail,
      userId: approverUserId,
      primaryBranchId: null,
      status: 'ACTIVE',
    }));
  if (
    approver.id === managerProfile.id ||
    approver.userId !== approverUserId ||
    approver.email !== approverEmail
  ) {
    throw new Error('Demo approver staff profile has a non-canonical linked user.');
  }
  if (approver.status !== 'ACTIVE') {
    await updateStaffProfile(db, approver.id, { status: 'ACTIVE' });
  }

  const existingRole = await db.restaurantJobRole.findUnique({
    where: {
      organizationId_key: {
        organizationId: identity.organizationId,
        key: DEMO_RESTAURANT_JOB_ROLE_KEY,
      },
    },
    select: { id: true, active: true },
  });
  const role =
    existingRole ??
    (await createJobRole(db, {
      key: DEMO_RESTAURANT_JOB_ROLE_KEY,
      name: 'Demo Restaurant Operator',
      description: 'All restaurant capabilities for bounded demo operations.',
      isSystem: true,
      capabilities: RESTAURANT_CAPABILITIES,
    }));
  if (!role.active) await updateJobRole(db, role.id, { active: true });
  if (existingRole) await setJobRoleCapabilities(db, role.id, RESTAURANT_CAPABILITIES);

  const approverPin = {
    staffProfileId: approver.id,
    type: 'PIN' as const,
    deviceId: null,
    revokedAt: null,
  };
  const credential = await db.restaurantOperatorCredential.findFirst({
    where: approverPin,
    select: { id: true, credentialHash: true },
  });
  const pin = deriveDemoApproverPin(identity.organizationId);
  if (!credential) {
    await issueOperatorCredential(db, {
      staffProfileId: approver.id,
      type: 'PIN',
      secret: pin,
      deviceId: null,
    });
  } else if (!(await verifyOperatorCredential('PIN', pin, credential.credentialHash))) {
    await rotateOperatorCredential(db, { credentialId: credential.id, secret: pin });
  }
  // This synthetic demo approver uses the deterministic seat fixture on every bootstrap.
  await db.restaurantOperatorCredential.updateMany({
    where: approverPin,
    data: { approvalPinMustChange: false },
  });
}

export async function provisionDemoRestaurantSeatInTransaction(
  db: ScopedDb,
  identity: DemoSeatIdentity,
  now: Date
): Promise<void> {
  const canonical = canonicalIdentity(identity);
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new Error('A valid demo bootstrap timestamp is required.');
  }
  await bootstrapDemoRestaurantOrganizationInTransaction(db, canonical, now);
  await runInTenantScope(db, canonical.organizationId, () =>
    ensureStaffAndAuthority(db, canonical)
  );
}

export async function createDemoRestaurantSeedContext(
  db: ScopedDb,
  organizationId: string
): Promise<TRPCContext> {
  const identity = identityFromOrganizationId(organizationId);
  const organizationRow = await db.organization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      slug: true,
      displayName: true,
      legalName: true,
      status: true,
      deploymentMode: true,
      timezone: true,
      locale: true,
      currency: true,
      seatLimit: true,
      isDemo: true,
      vertical: true,
    },
  });
  if (
    !organizationRow?.isDemo ||
    organizationRow.vertical !== 'RESTAURANT' ||
    organizationRow.deploymentMode !== 'SHARED' ||
    organizationRow.slug !== identity.slug ||
    organizationRow.displayName !== identity.displayName ||
    organizationRow.legalName !== identity.displayName ||
    !isTenantLifecycleAccessible(organizationRow.status)
  ) {
    throw new Error('Active canonical demo restaurant organization not found.');
  }

  const manager = await db.user.findUnique({
    where: { id: identity.managerUserId },
    select: {
      id: true,
      organizationId: true,
      name: true,
      email: true,
      role: true,
      department: true,
      title: true,
      avatar: true,
      status: true,
    },
  });
  if (
    !manager ||
    manager.organizationId !== organizationId ||
    manager.email !== identity.managerEmail ||
    manager.status !== 'ACTIVE'
  ) {
    throw new Error('Active canonical demo restaurant manager not found.');
  }
  const staffProfiles = await db.restaurantStaffProfile.findMany({
    where: { userId: manager.id, status: 'ACTIVE' },
    select: { id: true },
    take: 2,
  });
  if (staffProfiles.length !== 1) {
    throw new Error('Demo manager must have exactly one active restaurant staff profile.');
  }

  const organization: TenantOrganization = organizationRow;
  const expiresAt = Date.now() + DEMO_SESSION_MAX_AGE * 1000;
  const session: Session = {
    expires: new Date(expiresAt).toISOString(),
    user: {
      id: manager.id,
      organizationId,
      organizationSlug: organization.slug,
      organizationStatus: organization.status,
      name: manager.name,
      email: manager.email,
      role: manager.role,
      department: manager.department,
      title: manager.title,
      image: manager.avatar,
      status: manager.status,
      demoAccessExpiresAt: expiresAt,
    },
  };
  return createTRPCContext({
    db,
    auditDb: db,
    organization,
    session,
  });
}
