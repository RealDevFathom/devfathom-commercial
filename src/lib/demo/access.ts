import 'server-only';

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import {
  DEMO_ACCESS_COOKIE,
  DEMO_SESSION_MAX_AGE,
  demoManagerId,
  demoManagerEmail,
  demoOrganizationId,
  demoSeatName,
  demoSeatSlug,
  demoSeatFromOrganizationId,
  getDemoSeatCount,
} from './config';
import {
  DEMO_PERSONA_KEYS,
  DEMO_PERSONAS,
  demoPersonaEmail,
  demoPersonaUserId,
  demoPersonaUserRole,
  isCanonicalDemoOrganization,
  isDemoPersona,
  type DemoPersona,
} from './personas';

type DemoGrant = {
  v: 1;
  organizationId: string;
  seat: number;
  host: string;
  expiresAt: number;
};

export type DemoSeat = {
  seat: number;
  name: string;
  ready: boolean;
  personas: {
    key: DemoPersona;
    label: string;
    ready: boolean;
    callbackUrl: string;
    deviceKind: 'POS' | 'KDS' | null;
  }[];
};

export type ResolvedDemoSeat = Omit<DemoSeat, 'personas'> & {
  organizationId: string;
  managerUserId: string;
  managerEmail: string;
  persona: DemoPersona;
  userId: string;
  email: string;
};

const demoUserSelect = {
  id: true,
  email: true,
  password: true,
  status: true,
  role: true,
  organizationId: true,
  organizationRole: { select: { key: true } },
  restaurantStaffProfiles: {
    where: { status: 'ACTIVE' as const, primaryBranch: { active: true } },
    select: { id: true },
  },
} as const;

function isReadyPersona(
  user: {
    id: string;
    email: string;
    password: string | null;
    status: string;
    role: string;
    organizationId: string;
    organizationRole: { key: string } | null;
    restaurantStaffProfiles: { id: string }[];
  },
  seat: number,
  persona: DemoPersona
): boolean {
  return (
    user.id === demoPersonaUserId(seat, persona) &&
    user.email === demoPersonaEmail(seat, persona) &&
    user.organizationId === demoOrganizationId(seat) &&
    user.password === null &&
    user.status === 'ACTIVE' &&
    user.role === demoPersonaUserRole(persona) &&
    user.organizationRole?.key === DEMO_PERSONAS[persona].roleKey &&
    user.restaurantStaffProfiles.length === 1
  );
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function demoAccessCodeMatches(candidate: string): boolean {
  const expected = process.env.DEMO_ACCESS_CODE?.trim();
  if (!expected) return false;
  return timingSafeEqual(digest(candidate), digest(expected));
}

function signingSecret(): string | null {
  return process.env.AUTH_SECRET?.trim() || null;
}

function signature(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export function createDemoAccessGrant(input: {
  organizationId: string;
  seat: number;
  host: string;
  now?: Date;
}): { value: string; expiresAt: Date } {
  const secret = signingSecret();
  if (!secret) throw new Error('AUTH_SECRET is required for demo access.');
  if (
    demoSeatFromOrganizationId(input.organizationId) !== input.seat ||
    input.organizationId !== demoOrganizationId(input.seat)
  ) {
    throw new Error('A canonical demo seat is required.');
  }
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + DEMO_SESSION_MAX_AGE * 1000);
  const grant: DemoGrant = {
    v: 1,
    organizationId: input.organizationId,
    seat: input.seat,
    host: input.host,
    expiresAt: expiresAt.getTime(),
  };
  const payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
  const signed = signature(payload, secret).toString('base64url');
  return { value: `${payload}.${signed}`, expiresAt };
}

export function readDemoAccessGrant(
  value: string | null | undefined,
  host: string,
  now = new Date()
): DemoGrant | null {
  const secret = signingSecret();
  if (!secret || !value || value.length > 2048) return null;
  const [payload, supplied, extra] = value.split('.');
  if (!payload || !supplied || extra) return null;

  let suppliedBuffer: Buffer;
  try {
    suppliedBuffer = Buffer.from(supplied, 'base64url');
  } catch {
    return null;
  }
  const expectedBuffer = signature(payload, secret);
  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const grant = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    ) as Partial<DemoGrant>;
    if (
      grant.v !== 1 ||
      typeof grant.organizationId !== 'string' ||
      !Number.isInteger(grant.seat) ||
      grant.seat! < 1 ||
      grant.seat! > getDemoSeatCount() ||
      grant.organizationId !== demoOrganizationId(grant.seat!) ||
      grant.host !== host ||
      typeof grant.expiresAt !== 'number' ||
      grant.expiresAt <= now.getTime()
    ) {
      return null;
    }
    return grant as DemoGrant;
  } catch {
    return null;
  }
}

export function demoAccessCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/demo',
    expires: expiresAt,
  };
}

export async function getDemoSeatOptions(): Promise<DemoSeat[]> {
  const seats = Array.from({ length: getDemoSeatCount() }, (_, index) => index + 1);
  const organizations = await withPlatformDb((db) =>
    db.organization.findMany({
      where: { isDemo: true, id: { in: seats.map(demoOrganizationId) } },
      select: {
        id: true,
        slug: true,
        displayName: true,
        status: true,
        vertical: true,
        deploymentMode: true,
        isDemo: true,
        users: {
          select: demoUserSelect,
        },
      },
    })
  );
  const byId = new Map(organizations.map((organization) => [organization.id, organization]));
  return seats.map((seat) => {
    const organization = byId.get(demoOrganizationId(seat));
    const validOrganization = Boolean(organization && isCanonicalDemoOrganization(organization));
    const personas = DEMO_PERSONA_KEYS.map((key) => ({
      key,
      label: DEMO_PERSONAS[key].label,
      callbackUrl: DEMO_PERSONAS[key].callbackUrl,
      deviceKind: DEMO_PERSONAS[key].deviceKind,
      ready:
        validOrganization &&
        Boolean(organization?.users.some((user) => isReadyPersona(user, seat, key))),
    }));
    return {
      seat,
      name: demoSeatName(seat),
      ready: personas.some(({ key, ready }) => key === 'manager' && ready),
      personas,
    };
  });
}

export async function resolveDemoSeat(
  seat: number,
  persona: DemoPersona = 'manager'
): Promise<ResolvedDemoSeat | null> {
  if (!Number.isInteger(seat) || seat < 1 || seat > getDemoSeatCount() || !isDemoPersona(persona))
    return null;
  const managerEmail = demoManagerEmail(seat);
  const managerUserId = demoManagerId(seat);
  const organization = await withPlatformDb((db) =>
    db.organization.findFirst({
      where: {
        id: demoOrganizationId(seat),
        slug: demoSeatSlug(seat),
        isDemo: true,
        status: 'ACTIVE',
        vertical: 'RESTAURANT',
        deploymentMode: 'SHARED',
      },
      select: {
        id: true,
        slug: true,
        isDemo: true,
        status: true,
        vertical: true,
        deploymentMode: true,
        users: {
          where: {
            id: demoPersonaUserId(seat, persona),
            email: demoPersonaEmail(seat, persona),
            password: null,
            status: 'ACTIVE',
            role: demoPersonaUserRole(persona),
          },
          select: demoUserSelect,
          take: 1,
        },
      },
    })
  );
  const user = organization?.users[0];
  if (
    !organization ||
    !isCanonicalDemoOrganization(organization) ||
    !user ||
    !isReadyPersona(user, seat, persona)
  )
    return null;
  return {
    seat,
    name: demoSeatName(seat),
    ready: true,
    organizationId: organization.id,
    managerUserId,
    managerEmail,
    persona,
    userId: user.id,
    email: user.email,
  };
}

export { DEMO_ACCESS_COOKIE };
