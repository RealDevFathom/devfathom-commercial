import 'server-only';

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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
import {
  guardPharmacyAccessChanges,
  isPharmacyOrganization,
} from '@/lib/team/pharmacy-access-guard';

export { SSO_TICKET_COOKIE } from '@/lib/sso-ticket-cookie';

/**
 * F10 / DEV-833 — login CSRF. Every SSO start sets an unpredictable value in
 * this cookie and stores only its hash with the server-side transaction (the
 * OIDC state, the SAML RelayState and the SAML AuthnRequest ID). A callback is
 * honored only in the browser holding the matching value, so an unused IdP
 * response transferred to another browser can no longer sign that browser into
 * the sender's account.
 */
export const SSO_BROWSER_BINDING_COOKIE = 'df_sso_binding';
const SSO_TRANSACTION_TTL_MS = 10 * 60_000;

export function createSsoBrowserBinding() {
  const value = randomBytes(32).toString('base64url');
  return { value, hash: hashSsoBrowserBinding(value) };
}

export function hashSsoBrowserBinding(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The SAML response is a cross-site form POST from the IdP, which a
 * `SameSite=Lax` cookie never accompanies, so the binding cookie is
 * `SameSite=None; Secure` in production and on any other deployment the
 * browser reaches over HTTPS (staging, previews). Only plain-HTTP local
 * development, where browsers reject `SameSite=None` without `Secure`, falls
 * back to `SameSite=Lax`. It is scoped to the SSO routes only.
 */
export function ssoBrowserBindingCookieOptions(request: Request) {
  const secure = process.env.NODE_ENV === 'production' || isSecureRequest(request);
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? ('none' as const) : ('lax' as const),
    path: '/api/sso',
    maxAge: SSO_TRANSACTION_TTL_MS / 1000,
  };
}

/** Whether the browser reached this request over HTTPS (proxy-aware). */
function isSecureRequest(request: Request): boolean {
  try {
    return publicRequestOrigin(request).startsWith('https://');
  } catch {
    return new URL(request.url).protocol === 'https:';
  }
}

/** The binding value this browser presented, or null when it holds none. */
export function readSsoBrowserBinding(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== SSO_BROWSER_BINDING_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return value || null;
  }
  return null;
}

function matchesBrowserBinding(expectedHash: unknown, presented: string | null): boolean {
  if (typeof expectedHash !== 'string' || !expectedHash || !presented) return false;
  const actual = Buffer.from(hashSsoBrowserBinding(presented));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export type ActiveIdentityConnection = OrganizationIdentityConnection & {
  organization: { id: string; slug: string; status: string };
};

export async function requireIdentityConnection(
  request: Request,
  connectionId: string,
  protocol: 'OIDC' | 'SAML'
): Promise<ActiveIdentityConnection> {
  const organization = await requireOrganizationForRequest(request);
  return identityConnectionForOrganization(organization.id, connectionId, protocol);
}

export async function identityConnectionForOrganization(
  organizationId: string,
  connectionId: string,
  protocol: 'OIDC' | 'SAML'
): Promise<ActiveIdentityConnection> {
  return withTenantDb(organizationId, async (db) => {
    const entitlements = await resolveOrganizationEntitlements(organizationId, db);
    if (!hasModule(entitlements, 'identity')) {
      throw new Error('Enterprise identity is not licensed for this organization.');
    }
    const connection = await db.organizationIdentityConnection.findFirst({
      where: {
        id: connectionId,
        organizationId,
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
    const create = () =>
      db.user.create({
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
    if (!(await isPharmacyOrganization(db, connection.organizationId))) return create();
    // DEV-959B: in a pharmacy, sign-in provisioning passes the access guard like every other
    // path that sets a role: it never makes an administrator or gives a weighty sub-role.
    const { value } = await guardPharmacyAccessChanges(
      db,
      {
        organizationId: connection.organizationId,
        actor: { kind: 'system', source: 'SSO' },
        targetIds: null,
        pinVerified: false,
        mode: 'role',
        action: 'sso.provisionUser',
        describe: (person) => `Single sign-on provisioned ${person}`,
      },
      async () => {
        const user = await create();
        return { targetIds: [user.id], value: user };
      }
    );
    return value;
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
      expiresAt: new Date(Date.now() + (input.ttlMs ?? SSO_TRANSACTION_TTL_MS)),
    },
  });
  return key;
}

export async function consumeAuthorizationState(
  db: ScopedDb,
  connectionId: string,
  key: string,
  kind: string,
  browserBinding: string | null
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
  const payload = state.payload as Record<string, unknown>;
  // F10: the transaction must belong to the browser that started it. Checked
  // before the state is consumed so a transferred callback changes nothing.
  if (!matchesBrowserBinding(payload.browserBindingHash, browserBinding)) {
    throw new Error('The identity authorization state was started in a different browser.');
  }
  const consumed = await db.organizationSsoState.updateMany({
    where: { id: state.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (consumed.count !== 1) throw new Error('The identity authorization state was already used.');
  return payload;
}

export function oidcClientSecret(connection: OrganizationIdentityConnection): string | undefined {
  return connection.encryptedClientSecret
    ? decryptSecret(connection.encryptedClientSecret)
    : undefined;
}

/**
 * node-saml's InResponseTo cache. `browserBinding` (F10) is the start
 * browser's binding hash when saving, and the callback browser's presented
 * binding value when reading: an AuthnRequest ID is only "known" to the browser
 * that issued it, so a response transferred to another browser fails
 * InResponseTo validation.
 */
export class PrismaSamlCache implements CacheProvider {
  constructor(
    private readonly db: ScopedDb,
    private readonly organizationId: string,
    private readonly connectionId: string,
    private readonly browserBinding: { hash: string } | { presented: string | null } | null = null
  ) {}

  async saveAsync(key: string, value: string) {
    if (!this.browserBinding || !('hash' in this.browserBinding)) {
      throw new Error('A SAML request must be bound to the browser that starts it.');
    }
    await this.db.organizationSsoState.create({
      data: {
        organizationId: this.organizationId,
        identityConnectionId: this.connectionId,
        key,
        kind: 'SAML_REQUEST',
        payload: { value, browserBindingHash: this.browserBinding.hash },
        expiresAt: new Date(Date.now() + SSO_TRANSACTION_TTL_MS),
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
    if (!state) return null;
    const payload = state.payload as Record<string, unknown>;
    const presented =
      this.browserBinding && 'presented' in this.browserBinding
        ? this.browserBinding.presented
        : null;
    if (!matchesBrowserBinding(payload.browserBindingHash, presented)) return null;
    return claimString(payload.value);
  }

  async removeAsync(key: string | null) {
    if (!key) return null;
    const value = await this.getAsync(key);
    // A request this browser cannot see is left untouched.
    if (value === null) return null;
    await this.db.organizationSsoState.updateMany({
      where: { key, identityConnectionId: this.connectionId, usedAt: null },
      data: { usedAt: new Date() },
    });
    return value;
  }
}
