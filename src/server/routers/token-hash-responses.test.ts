import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DEV-848: the admin screens for API tokens, SCIM tokens and supplier links returned
 * whole credential rows, `tokenHash` included. The fake delegates below behave like
 * Prisma: without a `select` they return every stored column, with one they return
 * only the selected columns. Each response must come back without the hash.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(() => ({})),
  withPlatformDb: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  assertSeatAvailable: vi.fn(),
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});
vi.mock('../pharmacy-procurement-scope', () => ({
  assertProcurementBranch: vi.fn(async () => undefined),
}));

import type { TRPCContext } from '../trpc';
import { apiTokensRouter } from './api-tokens';
import { organizationAdminRouter } from './organization-admin';
import { pharmacySupplierLinksRouter } from './pharmacy-supplier-links';

type Row = Record<string, unknown>;
type Selection = Record<string, unknown>;

/** Prisma's projection: `select` keeps only the named columns, `include` adds relations. */
function project(row: Row, args: { select?: Selection; include?: Selection } = {}): Row {
  const relation = (key: string, value: unknown) =>
    value === true ? row[key] : project(row[key] as Row, value as Selection);
  if (args.select) {
    return Object.fromEntries(
      Object.entries(args.select)
        .filter(([, value]) => value)
        .map(([key, value]) => [key, relation(key, value)])
    );
  }
  const scalars = Object.fromEntries(
    Object.entries(row).filter(([, value]) => !value || typeof value !== 'object')
  );
  for (const [key, value] of Object.entries(args.include ?? {})) {
    if (value) scalars[key] = relation(key, value);
  }
  return scalars;
}

function delegate(row: Row) {
  const one = vi.fn(async (args?: { select?: Selection; include?: Selection }) =>
    project(row, args)
  );
  return {
    findFirst: one,
    findUnique: one,
    update: one,
    delete: one,
    findMany: vi.fn(async (args?: { select?: Selection; include?: Selection }) => [
      project(row, args),
    ]),
  };
}

const HASH = 'stored-verifier-hash';
const created = new Date('2026-11-01T00:00:00.000Z');

const apiToken: Row = {
  id: 'token_1',
  organizationId: 'org_a',
  name: 'CI token',
  prefix: 'df_existing',
  tokenHash: HASH,
  scopes: ['*'],
  userId: 'admin_a',
  lastUsedAt: null,
  expiresAt: null,
  createdAt: created,
  user: {
    id: 'admin_a',
    name: 'Admin',
    email: 'admin@example.test',
    avatar: null,
    role: 'ADMIN',
    password: 'stored-password-hash',
    twoFactorSecret: 'BASE32SEED',
  },
};
const scimToken: Row = {
  id: 'scim_1',
  organizationId: 'org_a',
  name: 'Directory sync',
  prefix: 'scim_abcdefghijk',
  tokenHash: HASH,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  createdAt: created,
};
const supplierLink: Row = {
  id: 'link_a',
  organizationId: 'org_a',
  branchId: 'branch_a',
  supplierRelationshipId: 'rel_a',
  purchaseOrderId: 'po_a',
  tokenHash: HASH,
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  revokedAt: null,
  createdByUserId: 'admin_a',
  createdAt: created,
};

let db: Record<string, ReturnType<typeof delegate>>;

function context() {
  return {
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules: ['identity', 'pharmacy-procurement'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: {
        id: 'admin_a',
        organizationId: 'org_a',
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

/** Every key at any depth of a response, so a nested hash is caught too. */
function keys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keys);
  if (!value || typeof value !== 'object' || value instanceof Date) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keys(child)]);
}

const SECRET_KEYS = ['tokenHash', 'password', 'twoFactorSecret'] as const;

beforeEach(() => {
  db = {
    apiToken: delegate(apiToken),
    organizationScimToken: delegate(scimToken),
    pharmacySupplierActionLink: delegate(supplierLink),
    user: delegate({
      id: 'admin_a',
      organizationId: 'org_a',
      role: 'ADMIN',
      status: 'ACTIVE',
      permissionOverrides: [],
    }),
  };
});

describe('admin token screens never return a token hash (DEV-848)', () => {
  it('apiTokens.list returns the safe columns and the bound user summary', async () => {
    const result = await apiTokensRouter.createCaller(context()).list();
    for (const secret of SECRET_KEYS) expect(keys(result)).not.toContain(secret);
    expect(result[0]).toMatchObject({
      id: 'token_1',
      name: 'CI token',
      prefix: 'df_existing',
      scopes: ['*'],
      user: { id: 'admin_a', name: 'Admin' },
    });
  });

  it('apiTokens.revoke returns the revoked token without its hash', async () => {
    const result = await apiTokensRouter.createCaller(context()).revoke({ id: 'token_1' });
    expect(keys(result)).not.toContain('tokenHash');
    expect(result).toMatchObject({ id: 'token_1', prefix: 'df_existing' });
    expect(db.apiToken.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'token_1' } })
    );
  });

  it('organizationAdmin.revokeScimToken returns the revoked token without its hash', async () => {
    const result = await organizationAdminRouter
      .createCaller(context())
      .revokeScimToken({ id: 'scim_1' });
    expect(keys(result)).not.toContain('tokenHash');
    expect(result).toMatchObject({ id: 'scim_1', prefix: 'scim_abcdefghijk' });
  });

  it('pharmacySupplierLinks.revoke returns the revoked link without its hash', async () => {
    const result = await pharmacySupplierLinksRouter
      .createCaller(context())
      .revoke({ linkId: 'link_a' });
    expect(keys(result)).not.toContain('tokenHash');
    expect(result).toMatchObject({ id: 'link_a', branchId: 'branch_a' });
  });
});
