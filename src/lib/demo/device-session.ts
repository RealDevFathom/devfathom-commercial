import 'server-only';

import type {
  RestaurantRegisteredDevice,
  RestaurantTerminalSession,
} from '@/generated/prisma/client';
import type { Session } from 'next-auth';
import { liveDemoAccessExpiry } from '@/lib/auth/session-state';
import { operatorHasCapability } from '@/lib/restaurant/checkout-routes';
import { mintPosComposerProof } from '@/lib/restaurant/pos-composer-proof';
import {
  isDeviceSecretFormat,
  isDeviceUsable,
  resolveDeviceBySecret,
  rotateDeviceSecret,
} from '@/lib/restaurant/devices';
import {
  bindOperator,
  establishSession,
  evaluateTerminalSession,
  isTerminalSessionTokenFormat,
  resolveSessionByToken,
} from '@/lib/restaurant/terminal-session';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { DEMO_SESSION_MAX_AGE, demoSeatFromOrganizationId } from './config';
import {
  DEMO_PERSONAS,
  demoPersonaForUser,
  demoPersonaCanUseDevice,
  demoPersonaDeviceName,
  demoPersonaUserRole,
  isCanonicalDemoOrganization,
} from './personas';

export type DemoDeviceKind = 'POS' | 'KDS';
export const DEMO_TERMINAL_SESSION_COOKIE = 'devfathom-demo-terminal-session';

type ExistingDemoTerminal = {
  deviceSecret?: string | null;
  sessionToken?: string | null;
};

async function resolveReusableDevice(
  db: ScopedDb,
  deviceId: string,
  secret: string | null | undefined
): Promise<RestaurantRegisteredDevice | null> {
  if (!secret || !isDeviceSecretFormat(secret)) return null;
  const device = await resolveDeviceBySecret(db, secret);
  return device?.id === deviceId && isDeviceUsable(device) ? device : null;
}

async function resolveReusableOperatorSession(
  db: ScopedDb,
  device: RestaurantRegisteredDevice,
  staffProfileId: string,
  token: string | null | undefined,
  now: Date
): Promise<RestaurantTerminalSession | null> {
  if (!token || !isTerminalSessionTokenFormat(token)) return null;
  const session = await resolveSessionByToken(db, token);
  if (!session || session.activeStaffProfileId !== staffProfileId) return null;
  const validation = evaluateTerminalSession(session, device, now);
  return validation.ok && validation.state === 'UNLOCKED' ? session : null;
}

export function demoTerminalCookieOptions(demoAccessExpiresAt: unknown, now = new Date()) {
  const expiresAt = liveDemoAccessExpiry(demoAccessExpiresAt, now.getTime());
  if (!expiresAt || expiresAt - now.getTime() > DEMO_SESSION_MAX_AGE * 1000) return null;
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: new Date(expiresAt),
    maxAge: Math.max(
      1,
      Math.min(DEMO_SESSION_MAX_AGE, Math.floor((expiresAt - now.getTime()) / 1000))
    ),
  };
}

export async function prepareDemoDeviceSession(
  db: ScopedDb,
  user: Session['user'],
  kind: DemoDeviceKind,
  now = new Date(),
  existing: ExistingDemoTerminal = {}
) {
  const organization = await db.organization.findFirst({
    select: {
      id: true,
      slug: true,
      isDemo: true,
      status: true,
      vertical: true,
      deploymentMode: true,
    },
  });
  const seat = organization ? demoSeatFromOrganizationId(organization.id) : null;
  const persona = seat ? demoPersonaForUser(seat, user) : null;
  if (
    !organization ||
    !isCanonicalDemoOrganization(organization) ||
    !seat ||
    !persona ||
    !demoPersonaCanUseDevice(persona, kind) ||
    !demoTerminalCookieOptions(user.demoAccessExpiresAt, now) ||
    user.organizationId !== organization.id ||
    user.role !== demoPersonaUserRole(persona)
  ) {
    return null;
  }

  const profiles = await db.restaurantStaffProfile.findMany({
    where: {
      userId: user.id,
      status: 'ACTIVE',
      primaryBranch: { active: true },
      user: {
        organizationId: organization.id,
        email: user.email!,
        password: null,
        status: 'ACTIVE',
        role: demoPersonaUserRole(persona),
        organizationRole: { key: DEMO_PERSONAS[persona].roleKey },
      },
    },
    select: {
      id: true,
      displayName: true,
      primaryBranchId: true,
      user: { select: { title: true, organizationRole: { select: { name: true } } } },
    },
    orderBy: { id: 'asc' },
    take: 2,
  });
  const staff = profiles[0];
  if (profiles.length !== 1 || !staff?.primaryBranchId) return null;

  const [canOperateTerminal, canOperateKind] = await Promise.all([
    operatorHasCapability(db, staff.id, 'terminal:operate', now, staff.primaryBranchId),
    operatorHasCapability(
      db,
      staff.id,
      kind === 'POS' ? 'pos:operate' : 'kitchen:operate',
      now,
      staff.primaryBranchId
    ),
  ]);
  if (!canOperateTerminal || !canOperateKind) return null;

  // The transaction-scoped lock makes every duplicate read the hash left by its predecessor.
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`demo-device-session:${organization.id}:${persona}:${kind}`}, 0))`;
  const device = await db.restaurantRegisteredDevice.findFirst({
    where: {
      branchId: staff.primaryBranchId,
      kind,
      name:
        persona === 'manager'
          ? { startsWith: `Demo ${kind} S${seat} ` }
          : demoPersonaDeviceName(seat, persona, kind),
      status: 'ACTIVE',
      revokedAt: null,
      ...(kind === 'KDS' ? { station: { active: true } } : {}),
    },
    select: {
      id: true,
      branchId: true,
      name: true,
      kind: true,
      stationId: true,
      deviceSecretHash: true,
      branch: { select: { name: true } },
    },
    orderBy: { id: 'asc' },
  });
  if (!device) return null;

  let trustedDevice = await resolveReusableDevice(db, device.id, existing.deviceSecret);
  let deviceSecret = existing.deviceSecret ?? '';
  if (!trustedDevice) {
    const rotated = await rotateDeviceSecret(db, device.id, device.deviceSecretHash);
    trustedDevice = rotated.device;
    deviceSecret = rotated.secret;
  }

  let sessionToken = existing.sessionToken ?? '';
  let session = await resolveReusableOperatorSession(
    db,
    trustedDevice,
    staff.id,
    existing.sessionToken,
    now
  );
  if (!session) {
    const established = await establishSession(db, device.id, now);
    session = await bindOperator(db, established.session.id, staff.id, now);
    sessionToken = established.token;
  }
  return {
    deviceSecret,
    branchId: device.branchId,
    sessionToken,
    composerProof: mintPosComposerProof(
      {
        organizationId: organization.id,
        branchId: device.branchId,
        deviceId: device.id,
        sessionId: session.id,
        staffProfileId: staff.id,
      },
      now
    ),
    session: {
      id: session.id,
      state: 'UNLOCKED' as const,
      activeStaffProfileId: staff.id,
      establishedAt: session.establishedAt.toISOString(),
    },
    device: {
      id: device.id,
      organizationId: organization.id,
      branchId: device.branchId,
      name: device.name,
      kind: device.kind,
      stationId: device.stationId,
      branchName: device.branch.name,
    },
    operator: {
      staffProfileId: staff.id,
      displayName: staff.displayName,
      role: staff.user?.organizationRole?.name ?? staff.user?.title ?? 'Manager',
    },
  };
}
