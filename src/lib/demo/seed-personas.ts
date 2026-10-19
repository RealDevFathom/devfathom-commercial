import 'server-only';

import { enrollDevice } from '@/lib/restaurant/devices';
import { createJobRole, grantJobRole } from '@/lib/restaurant/job-roles';
import { createStaffProfile, updateStaffProfile } from '@/lib/restaurant/staff';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { RESTAURANT_JOB_ROLE_TEMPLATES, RESTAURANT_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import {
  DEMO_PERSONA_KEYS,
  DEMO_PERSONAS,
  demoPersonaEmail,
  demoPersonaUserId,
  demoPersonaUserRole,
  demoPersonaDeviceName,
  type DemoPersona,
} from './personas';
import { demoSeatIdentity, type DemoRestaurantSeed } from './seed-data';
import type { DemoRestaurantCatalogIds } from './seed-catalog';

export function demoPersonaExtraCapabilities(persona: DemoPersona): string[] {
  if (persona === 'inventory') return ['purchasing:create', 'purchasing:approve'];
  return ['cashier', 'waiter', 'kitchen'].includes(persona) ? ['terminal:operate'] : [];
}

/** Called only by the existing guarded seat rebuild, inside its tenant transaction. */
export async function seedDemoPersonas(
  db: ScopedDb,
  seed: DemoRestaurantSeed,
  catalog: DemoRestaurantCatalogIds,
  managerStaffProfileId: string
): Promise<Partial<Record<DemoPersona, string>>> {
  const identity = demoSeatIdentity(seed.identity.seatNumber);
  const organization = await db.organization.findFirst({
    where: {
      id: identity.organizationId,
      slug: identity.slug,
      isDemo: true,
      vertical: 'RESTAURANT',
      deploymentMode: 'SHARED',
    },
    select: { id: true, slug: true, isDemo: true, vertical: true, deploymentMode: true },
  });
  if (
    seed.identity.organizationId !== identity.organizationId ||
    !organization?.isDemo ||
    organization.id !== identity.organizationId ||
    organization.slug !== identity.slug ||
    organization.vertical !== 'RESTAURANT' ||
    organization.deploymentMode !== 'SHARED'
  ) {
    throw new Error('Persona seeding requires the canonical shared restaurant demo.');
  }
  const branchId = catalog.branch[seed.branches[0]!.id];
  if (!branchId) throw new Error('Demo primary branch is missing.');
  const staff: Partial<Record<DemoPersona, string>> = { manager: managerStaffProfileId };
  for (const persona of DEMO_PERSONA_KEYS) {
    if (persona === 'manager') continue;
    const definition = DEMO_PERSONAS[persona];
    const id = demoPersonaUserId(identity.seatNumber, persona);
    const email = demoPersonaEmail(identity.seatNumber, persona);
    const role = await db.organizationRole.findUnique({
      where: {
        organizationId_key: { organizationId: identity.organizationId, key: definition.roleKey },
      },
      select: { id: true },
    });
    if (!role) throw new Error(`Missing restaurant role ${definition.roleKey}.`);
    const existing = await db.user.findUnique({ where: { id } });
    if (
      existing &&
      (existing.organizationId !== identity.organizationId ||
        existing.email !== email ||
        existing.password !== null ||
        existing.status !== 'ACTIVE' ||
        existing.role !== demoPersonaUserRole(persona) ||
        existing.organizationRoleId !== role.id)
    ) {
      throw new Error(`Demo ${persona} identity is occupied.`);
    }
    if (!existing)
      await db.user.create({
        data: {
          id,
          email,
          name: `Demo ${definition.label}`,
          password: null,
          role: demoPersonaUserRole(persona),
          organizationRoleId: role.id,
          department: definition.department,
          title: definition.label,
          status: 'ACTIVE',
        },
      });
    const extras = demoPersonaExtraCapabilities(persona);
    for (const capability of extras)
      await db.userPermissionOverride.upsert({
        where: { userId_capability: { userId: id, capability } },
        create: {
          userId: id,
          capability,
          effect: 'ALLOW',
          reason: 'Synthetic demo persona duties.',
        },
        update: { effect: 'ALLOW', expiresAt: null, reason: 'Synthetic demo persona duties.' },
      });
    const profiles = await db.restaurantStaffProfile.findMany({
      where: { OR: [{ userId: id }, { email }] },
      select: { id: true, userId: true, email: true },
      take: 2,
    });
    if (
      profiles.length > 1 ||
      profiles.some((profile) => profile.userId !== id || profile.email !== email)
    ) {
      throw new Error(`Demo ${persona} staff identity is occupied.`);
    }
    const profile =
      profiles[0] ??
      (await createStaffProfile(db, {
        userId: id,
        email,
        displayName: `Demo ${definition.label}`,
        primaryBranchId: branchId,
        status: 'ACTIVE',
      }));
    if (profiles[0])
      await updateStaffProfile(db, profile.id, { primaryBranchId: branchId, status: 'ACTIVE' });
    staff[persona] = profile.id;

    const jobTemplate = RESTAURANT_JOB_ROLE_TEMPLATES.find(
      (item) => item.key === definition.roleKey
    );
    const webTemplate = RESTAURANT_ROLE_TEMPLATES.find((item) => item.key === definition.roleKey)!;
    const capabilities = [
      ...new Set([
        ...(definition.deviceKind && jobTemplate
          ? jobTemplate.capabilities
          : webTemplate.capabilities),
        ...extras,
      ]),
    ];
    const jobRole = await createJobRole(db, {
      key: `demo-persona-${persona}`,
      name: definition.label,
      isSystem: true,
      capabilities,
    });
    for (const grantedBranchId of persona === 'owner'
      ? Object.values(catalog.branch)
      : [branchId]) {
      await grantJobRole(db, {
        staffProfileId: profile.id,
        branchId: grantedBranchId,
        jobRoleId: jobRole.id,
        actorStaffProfileId: managerStaffProfileId,
      });
    }
    const kinds: ('POS' | 'KDS')[] =
      persona === 'owner' ? ['POS', 'KDS'] : definition.deviceKind ? [definition.deviceKind] : [];
    for (const kind of kinds) {
      const stationId =
        kind === 'KDS' ? catalog.station[`${seed.branches[0]!.id}:HOT_KITCHEN`] : null;
      if (kind === 'KDS' && !stationId) throw new Error('Demo kitchen station is missing.');
      await enrollDevice(db, {
        branchId,
        kind,
        name: demoPersonaDeviceName(identity.seatNumber, persona, kind),
        stationId,
      });
    }
  }
  return staff;
}
