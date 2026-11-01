/**
 * In production the tRPC formatter withholds an unexpected failure's message —
 * anything a procedure throws that is not a TRPCError — and tells the client
 * only that something went wrong. A refusal the operator must read therefore
 * has to travel as a deliberate TRPCError. These were plain Errors reached from
 * procedures the browser calls; each must still reach a production client in
 * its own words, with its own code, through the real transport and formatter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import superjson from 'superjson';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import { router, type TRPCContext } from '../trpc';
import { pharmacyPurchasingRouter } from './pharmacy-purchasing';
import { pharmacySafetyRouter } from './pharmacy-safety';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({
  pharmacyPurchasing: pharmacyPurchasingRouter,
  pharmacySales: pharmacySalesRouter,
  pharmacySafety: pharmacySafetyRouter,
});
const GENERIC = 'Something went wrong on our side. Please try again.';

const db = {
  // The capability check: this member holds `pharmacy:safety`, and the
  // `pharmacy:procurement` the goods-in bench needs since PR J (#979).
  user: {
    findUnique: vi.fn(async () => ({
      organizationRole: null,
      permissionOverrides: [
        { capability: 'pharmacy:safety', effect: 'ALLOW' },
        { capability: 'pharmacy:procurement', effect: 'ALLOW' },
      ],
    })),
  },
  // The scanned branch is not an active branch of the organization: neither the
  // counter's `scopeFor` lookup nor the pack library's own finds it.
  pharmacyBranch: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
};

function context(): TRPCContext {
  return {
    db,
    entitlements: {
      organizationId: 'org-1',
      enabledModules: ['pharmacy-counter', 'pharmacy-core'],
      modules: [],
    },
    session: {
      expires: 'later',
      user: { id: 'actor-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

async function call(path: string, kind: 'query' | 'mutation', input: unknown) {
  const url = new URL(`http://localhost/api/trpc/${path}`);
  const serialized = JSON.stringify(superjson.serialize(input));
  if (kind === 'query') url.searchParams.set('input', serialized);
  const response = await fetchRequestHandler({
    endpoint: '/api/trpc',
    req: new Request(url, {
      method: kind === 'query' ? 'GET' : 'POST',
      ...(kind === 'mutation'
        ? { headers: { 'content-type': 'application/json' }, body: serialized }
        : {}),
    }),
    router: app,
    createContext: async () => context(),
  });
  const body = (await response.json()) as {
    error: { json: { message: string; data: { code: string } } };
  };
  return body.error.json;
}

beforeEach(() => vi.stubEnv('NODE_ENV', 'production'));
afterEach(() => vi.unstubAllEnvs());

describe('operator refusals in production', () => {
  it('tells the goods-in bench a scanned pack’s branch is outside its scope', async () => {
    const error = await call('pharmacyPurchasing.authenticatePack', 'mutation', {
      branchId: 'branch-retired',
      payload: ']d2010890000000000110ABC123',
    });
    expect(error.message).not.toBe(GENERIC);
    // The purchasing branch check now refuses before the pack library is reached.
    expect(error).toMatchObject({
      message: 'Branch is outside your scope.',
      data: { code: 'FORBIDDEN' },
    });
  });

  it('tells the counter, in its own words, that a scan’s branch is not in the workspace', async () => {
    // The counter's scan meets `scopeFor` before the pack library does.
    const error = await call('pharmacySales.authenticatePack', 'mutation', {
      branchId: 'branch-retired',
      payload: ']d2010890000000000110ABC123',
    });
    expect(error.message).not.toBe(GENERIC);
    expect(error).toMatchObject({
      message: 'That record is not in this workspace.',
      data: { code: 'BAD_REQUEST' },
    });
  });

  it('tells the reader an inspection pack cannot start after it ends', async () => {
    const error = await call('pharmacySafety.createInspectionPack', 'query', {
      branchId: 'branch-1',
      from: new Date('2026-10-21T00:00:00.000Z'),
      to: new Date('2026-10-20T00:00:00.000Z'),
    });
    expect(error.message).not.toBe(GENERIC);
    expect(error).toMatchObject({
      message: 'Inspection pack start must not follow its end.',
      data: { code: 'BAD_REQUEST' },
    });
  });
});
