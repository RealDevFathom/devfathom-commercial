/**
 * The workspace profile's time zone is the zone every pharmacy day-close and
 * counter screen formats in, and Intl throws on a zone such as "PKT". The
 * profile therefore stores only a zone Intl accepts, with the platform's own
 * check, and refuses anything else with a field error the form can show.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import superjson from 'superjson';

const mocks = vi.hoisted(() => ({ update: vi.fn(), annotateAudit: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  assertSeatAvailable: vi.fn(),
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: mocks.annotateAudit,
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});

import { router, type TRPCContext } from '../trpc';
import { organizationAdminRouter } from './organization-admin';

const app = router({ organizationAdmin: organizationAdminRouter });
const profile = {
  displayName: 'Synthetic Pharmacy',
  timezone: 'Asia/Karachi',
  locale: 'en-PK',
  primaryContactName: null,
  primaryContactEmail: '',
};

function context(): TRPCContext {
  return {
    db: { organization: { update: mocks.update } },
    entitlements: { enabledModules: [], activeSeats: 1, seatLimit: 50 },
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

/** The mutation as the settings form sends it, answered by the real transport and formatter. */
async function save(input: unknown) {
  const response = await fetchRequestHandler({
    endpoint: '/api/trpc',
    req: new Request('http://localhost/api/trpc/organizationAdmin.updateProfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(superjson.serialize(input)),
    }),
    router: app,
    createContext: async () => context(),
  });
  return (await response.json()) as {
    error?: { json: { message: string; data: { code: string; validation: unknown } } };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockImplementation(async ({ data }) => ({ id: 'org_a', ...data }));
});

describe('organizationAdmin.updateProfile time zone', () => {
  it.each(['PKT', 'UTC+5', 'Mars/Olympus'])(
    'refuses %s with a field error on the time zone, writing nothing',
    async (timezone) => {
      const { error } = await save({ ...profile, timezone });
      expect(error?.json.data.code).toBe('BAD_REQUEST');
      expect(error?.json.message).toBe('Timezone: Choose a valid IANA timezone.');
      expect(error?.json.data.validation).toEqual({ timezone: ['Choose a valid IANA timezone.'] });
      expect(mocks.update).not.toHaveBeenCalled();
    }
  );

  it('saves an IANA zone, trimmed', async () => {
    const { error } = await save({ ...profile, timezone: '  America/Chicago ' });
    expect(error).toBeUndefined();
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'org_a' },
      data: expect.objectContaining({ timezone: 'America/Chicago' }),
    });
  });
});

describe('organizationAdmin.updateProfile invoice seller details (#458)', () => {
  it('stores the invoice address with its line breaks and the tax ID, trimmed', async () => {
    const { error } = await save({
      ...profile,
      invoiceAddress: '  42 Market Street\nSeattle, WA 98101 ',
      invoiceTaxId: ' US-12-3456789 ',
    });

    expect(error).toBeUndefined();
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'org_a' },
      data: expect.objectContaining({
        invoiceAddress: '42 Market Street\nSeattle, WA 98101',
        invoiceTaxId: 'US-12-3456789',
      }),
    });
  });

  it('clears a blank address or tax ID to null', async () => {
    await save({ ...profile, invoiceAddress: '   ', invoiceTaxId: null });

    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'org_a' },
      data: expect.objectContaining({ invoiceAddress: null, invoiceTaxId: null }),
    });
  });

  it('leaves both untouched when a caller omits them', async () => {
    await save(profile);

    const { data } = mocks.update.mock.calls[0][0];
    expect(data).not.toHaveProperty('invoiceAddress');
    expect(data).not.toHaveProperty('invoiceTaxId');
  });

  it('refuses an over-long tax ID, writing nothing', async () => {
    const { error } = await save({ ...profile, invoiceTaxId: 'x'.repeat(101) });

    expect(error?.json.data.code).toBe('BAD_REQUEST');
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
