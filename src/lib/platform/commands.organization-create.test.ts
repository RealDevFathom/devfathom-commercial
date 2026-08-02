/**
 * D20 — platform operator onboarding had no duplicate guard at all. A repeat or
 * differently-cased admin email would have surfaced a raw Prisma unique-index
 * error in the control plane instead of a stated conflict.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ userFindFirst: vi.fn(), userCreate: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed'), compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({ assertPlatformCapability: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) => run(platformDb)),
}));

const created: Record<string, unknown[]> = {};
function record(model: string) {
  return vi.fn(async (args: { data?: unknown }) => {
    (created[model] ??= []).push(args?.data);
    return { id: `${model}_1`, ...(args?.data as object) };
  });
}

const platformDb = {
  platformPackage: {
    findUnique: vi.fn(async () => ({ id: 'pkg_1', active: true, name: 'Growth', moduleLinks: [] })),
  },
  organization: { create: vi.fn(async () => ({ id: 'org_new', slug: 'acme' })) },
  organizationRole: { create: vi.fn(async () => ({ id: 'role_admin' })) },
  user: { findFirst: mocks.userFindFirst, create: mocks.userCreate },
  organizationBrand: { create: record('brand') },
  organizationEmailSettings: { create: record('emailSettings') },
  organizationDeployment: { create: record('deployment') },
  platformJob: { create: record('job') },
  organizationLifecycleEvent: { create: record('lifecycle') },
  platformAuditLog: { create: record('audit') },
};

import { executePlatformCommand } from './commands';
import { PlatformSecurityError } from './security';

const actor = { id: 'op_1', role: 'SUPER_ADMIN' } as never;
const request = new Request('https://admin.devfathom.com/api/platform/control', { method: 'POST' });

function payload(adminEmail: string) {
  return {
    slug: 'acme',
    legalName: 'Acme Inc',
    displayName: 'Acme',
    deploymentMode: 'SHARED',
    packageId: 'pkg_1',
    timezone: 'UTC',
    locale: 'en-US',
    currency: 'usd',
    seatLimit: 25,
    primaryContactName: 'Ops',
    primaryContactEmail: 'ops@acme.com',
    adminName: 'Acme Admin',
    adminEmail,
    adminPassword: 'a-strong-password',
  };
}

describe('organization.create admin email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userCreate.mockResolvedValue({ id: 'user_new' });
  });

  it.each([['Admin@Acme.com'], ['ADMIN@ACME.COM'], ['  admin@acme.com  ']])(
    'reports a conflict for %j rather than a constraint violation',
    async (adminEmail) => {
      mocks.userFindFirst.mockResolvedValue({ id: 'user_existing' });

      const error = await executePlatformCommand(
        actor,
        'organization.create',
        payload(adminEmail),
        request
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PlatformSecurityError);
      expect(error).toMatchObject({
        status: 409,
        message: 'A user with this email already exists.',
      });
      expect(mocks.userFindFirst).toHaveBeenCalledWith({
        where: { organizationId: 'org_new', email: 'admin@acme.com' },
        select: { id: true },
      });
      expect(mocks.userCreate).not.toHaveBeenCalled();
    }
  );

  it('stores the canonical form for a new administrator', async () => {
    mocks.userFindFirst.mockResolvedValue(null);

    await executePlatformCommand(actor, 'organization.create', payload('Admin@Acme.COM'), request);

    expect(mocks.userCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'admin@acme.com' }),
      })
    );
  });
});
