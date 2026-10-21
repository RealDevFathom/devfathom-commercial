import { lockOrganizationSeat } from '@/lib/organization-seat';
import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import type { CacheProvider } from '@node-saml/node-saml';
import type { OrganizationIdentityConnection } from '@/generated/prisma/client';
import { resolveProvisionedDepartmentKey } from '@/lib/department-provisioning';
import { publicRequestOrigin } from '@/lib/http-origin';
import { decryptSecret } from '@/lib/secret-crypto';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { normalizeEmail } from '@/lib/email-address';
import { requireOrganizationForRequest } from '@/lib/tenancy/host';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

export const SSO_TICKET_COOKIE = 'df_sso_ticket';

export type ActiveIdentityConnection = OrganizationIdentityConnection & {
  organization: { id: string; slug: string; status: string };
};

export async function requireIdentityConnection(
  request: Request,
  connectionId: string,
  protocol: 'OIDC' | 'SAML'
): Promise<ActiveIdentityConnection> {
  const organization = await requireOrganizationForRequest(request);
  return withTenantDb(organization.id, async (db) => {
    const entitlements = await resolveOrganizationEntitlements(organization.id, db);
    if (!hasModule(entitlements, 'identity')) {
      throw new Error('Enterprise identity is not licensed for this organization.');
    }
    const connection = await db.organizationIdentityConnection.findFirst({
      where: {
        id: connectionId,
        organizationId: organization.id,
        protocol,
        status: 'ACTIVE',
      },
      include: { organization: { select: { id: true, slug: true, status: true } } },
    });
    if (!connection) throw new Error('Active identity connection not found.');
    return connection;
  });
}

export function callbackUrl(
  request: Request,
  protocol: 'oidc' | 'saml',
  connectionId: string
): string {
  return `${publicRequestOrigin(request)}/api/sso/${protocol}/${connectionId}/callback`;
}

function claimString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const item = value.find((entry) => typeof entry === 'string');
    return typeof item === 'string' ? item.trim() : null;
  }
  return null;
}

function roleFromClaims(
  connection: OrganizationIdentityConnection,
  claims: Record<string, unknown>
): 'ADMIN' | 'EMPLOYEE' | 'HR' {
  const configuration =
    connection.configuration &&
    typeof connection.configuration === 'object' &&
    !Array.isArray(connection.configuration)
      ? (connection.configuration as Record<string, unknown>)
      : {};
  const claimName =
    typeof configuration.roleClaim === 'string' ? configuration.roleClaim : 'groups';
  const raw = claims[claimName];
  const values = (Array.isArray(raw) ? raw : [raw])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase());
  const mappings =
    connection.roleMappings &&
    typeof connection.roleMappings === 'object' &&
    !Array.isArray(connection.roleMappings)
      ? (connection.roleMappings as Record<string, unknown>)
      : {};
  for (const value of values) {
    const mapped = mappings[value];
    if (mapped === 'ADMIN' || mapped === 'HR' || mapped === 'EMPLOYEE') return mapped;
  }
  return 'EMPLOYEE';
}

function assertAllowedEmail(connection: OrganizationIdentityConnection, email: string) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain || (connection.domains.length && !connection.domains.includes(domain))) {
    throw new Error('The identity email domain is not allowed for this connection.');
  }
}

export async function provisionIdentityUser(
  connection: ActiveIdentityConnection,
  claims: Record<string, unknown>
) {
  // D10/D20: an IdP may assert ALEX@COMPANY.COM for the person stored as
  // alex@company.com. Both sides are normalized to the one canonical form so the
  // lookup below MATCHES the existing user instead of silently provisioning a
  // second account for the same person in the same organization.
  const email = normalizeEmail(
    claimString(claims.email) ??
      claimString(claims.mail) ??
      claimString(claims['urn:oid:0.9.2342.19200300.100.1.3']) ??
      ''
  );
  if (!email || !email.includes('@')) throw new Error('Identity provider did not return an email.');
  if (claims.email_verified === false) throw new Error('Identity email is not verified.');
  assertAllowedEmail(connection, email);
  const name =
    claimString(claims.name) ??
    claimString(claims.displayName) ??
    claimString(claims.given_name) ??
    email.split('@')[0]!;

  return withTenantDb(connection.organizationId, async (db) => {
    const current = await db.user.findFirst({ where: { email } });
    if (current) {
      if (!['ACTIVE', 'ON_LEAVE'].includes(current.status)) {
        throw new Error('The matching organization account is inactive.');
      }
      await db.user.update({
        where: { id: current.id },
        data: { lastActiveAt: new Date() },
      });
      return current;
    }
    if (!connection.allowJit) throw new Error('No provisioned account matches this identity.');
    const entitlements = await resolveOrganizationEntitlements(connection.organizationId, db);
    if (entitlements.activeSeats >= entitlements.seatLimit) {
      throw new Error('The organization seat limit has been reached.');
    }
    // D20: never let the composite unique index surface as a raw Prisma error.
    // The lookup above already normalizes, so reaching here with a duplicate
    // means a concurrent provision — report it, do not create a second row.
    if (await db.user.findFirst({ where: { email }, select: { id: true } })) {
      throw new Error('An account with this email already exists in this organization.');
    }
    const role = roleFromClaims(connection, claims);
    // WHA-290: departments are tenant-configured rows, not a fixed enum — a
    // hardcoded 'LEADERSHIP'/'ENGINEERING' pair would raise the composite
    // foreign key for every restaurant tenant. Derive the key from this
    // organization's own active catalog instead.
    const department = await resolveProvisionedDepartmentKey(db, connection.organizationId, role);
    return db.$transaction(async (tx) => {
      await lockOrganizationSeat(tx, connection.organizationId, entitlements.seatLimit);
      return tx.user.create({
      data: {
        organizationId: connection.organizationId,
        name,
        email,
        password: null,
        role,
        department,
        title: role === 'ADMIN' ? 'Organization administrator' : 'Team member',
        status: 'ACTIVE',
        lastActiveAt: new Date(),
      },
    });
    });
  });
}

export async function issueSsoTicket(organizationId: string, userId: string) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 2 * 60_000);
  await withTenantDb(organizationId, (db) =>
    db.tenantSsoTicket.create({
      data: {
        organizationId,
        userId,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt,
      },
    })
  );
  return { token, expiresAt };
}

export function ssoTicketCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    expires: expiresAt,
  };
}

export async function createAuthorizationState(
  db: ScopedDb,
  input: {
    organizationId: string;
    identityConnectionId: string;
    kind: string;
    payload: Record<string, unknown>;
    ttlMs?: number;
  }
) {
  const key = randomBytes(24).toString('base64url');
  await db.organizationSsoState.create({
    data: {
      organizationId: input.organizationId,
      identityConnectionId: input.identityConnectionId,
      key,
      kind: input.kind,
      payload: JSON.parse(JSON.stringify(input.payload)),
      expiresAt: new Date(Date.now() + (input.ttlMs ?? 10 * 60_000)),
    },
  });
  return key;
}

export async function consumeAuthorizationState(
  db: ScopedDb,
  connectionId: string,
  key: string,
  kind: string
): Promise<Record<string, unknown>> {
  const state = await db.organizationSsoState.findFirst({
    where: {
      key,
      identityConnectionId: connectionId,
      kind,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (!state) throw new Error('The identity authorization state is invalid or expired.');
  const consumed = await db.organizationSsoState.updateMany({
    where: { id: state.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (consumed.count !== 1) throw new Error('The identity authorization state was already used.');
  return state.payload as Record<string, unknown>;
}

export function oidcClientSecret(connection: OrganizationIdentityConnection): string | undefined {
  return connection.encryptedClientSecret
    ? decryptSecret(connection.encryptedClientSecret)
    : undefined;
}

export class PrismaSamlCache implements CacheProvider {
  constructor(
    private readonly db: ScopedDb,
    private readonly organizationId: string,
    private readonly connectionId: string
  ) {}

  async saveAsync(key: string, value: string) {
    await this.db.organizationSsoState.create({
      data: {
        organizationId: this.organizationId,
        identityConnectionId: this.connectionId,
        key,
        kind: 'SAML_REQUEST',
        payload: { value },
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    return { value, createdAt: Date.now() };
  }

  async getAsync(key: string) {
    const state = await this.db.organizationSsoState.findFirst({
      where: {
        key,
        identityConnectionId: this.connectionId,
        kind: 'SAML_REQUEST',
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    return state ? claimString((state.payload as Record<string, unknown>).value) : null;
  }

  async removeAsync(key: string | null) {
    if (!key) return null;
    const value = await this.getAsync(key);
    await this.db.organizationSsoState.updateMany({
      where: { key, identityConnectionId: this.connectionId, usedAt: null },
      data: { usedAt: new Date() },
    });
    return value;
  }
}
