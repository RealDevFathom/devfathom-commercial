/**
 * D20 — platform operator onboarding had no duplicate guard at all. A repeat or
 * differently-cased admin email would have surfaced a raw Prisma unique-index
 * error in the control plane instead of a stated conflict.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

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
  // Seat lock: `FOR UPDATE` row read + occupied-seat count on the shared helper.
  $queryRaw: vi.fn(async () => []),
  platformPackage: {
    findUnique: vi.fn(async () => ({
      id: 'pkg_1',
      active: true,
      name: 'Growth',
      defaultSeats: 42,
      moduleLinks: [],
    })),
  },
  organization: { create: vi.fn(async () => ({ id: 'org_new', slug: 'acme' })) },
  organizationRole: { create: vi.fn(async () => ({ id: 'role_admin' })) },
  organizationDepartment: { createMany: vi.fn(async () => ({ count: 6 })) },
  user: { count: vi.fn(async () => 0), findFirst: mocks.userFindFirst, create: mocks.userCreate },
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

  it('canonicalizes the administrator email and requires a password change', async () => {
    mocks.userFindFirst.mockResolvedValue(null);

    await executePlatformCommand(actor, 'organization.create', payload('Admin@Acme.COM'), request);

    expect(mocks.userCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'admin@acme.com', mustChangePassword: true }),
      })
    );
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('organization.create dedicated provisioning preflight', () => {
  it('rejects unavailable dedicated provisioning before writing an organization', async () => {
    vi.clearAllMocks();
    vi.stubEnv('VERCEL_ACCESS_TOKEN', undefined);
    vi.stubEnv('VERCEL_TEAM_ID', undefined);
    vi.stubEnv('VERCEL_ORG_ID', undefined);

    const error = await executePlatformCommand(
      actor,
      'organization.create',
      { ...payload('admin@acme.com'), deploymentMode: 'DEDICATED' },
      request
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({
      status: 400,
      message:
        'Dedicated provisioning is unavailable because Vercel provisioning is not configured for this environment. Choose Shared platform or ask a platform administrator to configure Vercel.',
    });
    expect(platformDb.organization.create).not.toHaveBeenCalled();
    expect(platformDb.platformPackage.findUnique).not.toHaveBeenCalled();
  });
});

describe('organization.create duplicate slug', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: 'user_new' });
  });

  it('maps a slug unique violation to a conflict and does not continue onboarding', async () => {
    platformDb.organization.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`slug`)', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { modelName: 'Organization', target: ['slug'] },
      })
    );

    const error = await executePlatformCommand(
      actor,
      'organization.create',
      payload('admin@acme.com'),
      request
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({
      status: 409,
      message: 'That organization slug is already taken.',
    });
    expect(platformDb.organizationRole.create).not.toHaveBeenCalled();
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('leaves a non-slug unique violation as an internal error', async () => {
    platformDb.organization.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`id`)', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { modelName: 'Organization', target: ['id'] },
      })
    );

    const error = await executePlatformCommand(
      actor,
      'organization.create',
      payload('admin@acme.com'),
      request
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(error).toMatchObject({ code: 'P2002' });
    expect(error).not.toBeInstanceOf(PlatformSecurityError);
  });

  it('maps the Prisma driver-adapter slug constraint to a conflict', async () => {
    platformDb.organization.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the constraint: `organizations_slug_key`',
        {
          code: 'P2002',
          clientVersion: '7.9.1',
          meta: {
            modelName: 'Organization',
            driverAdapterError: {
              cause: {
                originalCode: '23505',
                originalMessage:
                  'duplicate key value violates unique constraint "organizations_slug_key"',
                kind: 'UniqueConstraintViolation',
                constraint: { index: 'organizations_slug_key' },
                table: 'organizations',
              },
            },
          },
        }
      )
    );

    const error = await executePlatformCommand(
      actor,
      'organization.create',
      payload('admin@acme.com'),
      request
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({
      status: 409,
      message: 'That organization slug is already taken.',
    });
    expect(platformDb.organizationRole.create).not.toHaveBeenCalled();
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('maps a pg adapter unique violation that omitted the constraint', async () => {
    platformDb.organization.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the (not available)',
        {
          code: 'P2002',
          clientVersion: '7.9.1',
          meta: {
            modelName: 'Organization',
            driverAdapterError: {
              name: 'DriverAdapterError',
              cause: {
                originalCode: '23505',
                originalMessage:
                  'duplicate key value violates unique constraint "organizations_slug_key"',
                kind: 'UniqueConstraintViolation',
              },
            },
          },
        }
      )
    );

    const error = await executePlatformCommand(
      actor,
      'organization.create',
      payload('admin@acme.com'),
      request
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({
      status: 409,
      message: 'That organization slug is already taken.',
    });
    expect(platformDb.organizationRole.create).not.toHaveBeenCalled();
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('rethrows a unique violation for a different constraint named only in the cause', async () => {
    platformDb.organization.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the (not available)', {
        code: 'P2002',
        clientVersion: '7.9.1',
        meta: {
          modelName: 'Organization',
          driverAdapterError: {
            cause: {
              originalCode: '23505',
              originalMessage: 'duplicate key value violates unique constraint "organizations_pkey"',
              kind: 'UniqueConstraintViolation',
            },
          },
        },
      })
    );

    const error = await executePlatformCommand(
      actor,
      'organization.create',
      payload('admin@acme.com'),
      request
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(error).toMatchObject({ code: 'P2002' });
    expect(error).not.toBeInstanceOf(PlatformSecurityError);
  });

  it('does not treat a slug mentioned only in the error message as a slug conflict', async () => {
    platformDb.organization.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the constraint: `organizations_slug_key`',
        {
          code: 'P2002',
          clientVersion: '7.9.1',
          meta: {
            modelName: 'Organization',
            driverAdapterError: {
              cause: {
                originalCode: '23505',
                originalMessage:
                  'duplicate key value violates unique constraint "organizations_slug_key"',
                kind: 'UniqueConstraintViolation',
                constraint: { index: 'organizations_pkey' },
                table: 'organizations',
              },
            },
          },
        }
      )
    );

    const error = await executePlatformCommand(
      actor,
      'organization.create',
      payload('admin@acme.com'),
      request
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(error).toMatchObject({ code: 'P2002' });
    expect(error).not.toBeInstanceOf(PlatformSecurityError);
  });
});

describe('organization.create package seat fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: 'user_new' });
  });

  it.each([1, 25, 100000, 0, -1, 'invalid'])('ignores a submitted seat limit of %j', async (seatLimit) => {
    await executePlatformCommand(
      { id: 'op_sales', role: 'SALES' } as never,
      'organization.create',
      { ...payload('admin@acme.com'), seatLimit },
      request
    );
    expect(platformDb.organization.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ seatLimit: 42 }) })
    );
  });

  it.each([1, 25, 42])('accepts a super admin override of %j', async (seatLimit) => {
    await executePlatformCommand(actor, 'organization.create',
      { ...payload('admin@acme.com'), seatLimit }, request);
    expect(platformDb.organization.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ seatLimit }) })
    );
  });

  it.each([0, -1, 43, 100000, 'invalid', 1.5])('rejects a super admin override of %j', async (seatLimit) => {
    await expect(executePlatformCommand(actor, 'organization.create',
      { ...payload('admin@acme.com'), seatLimit }, request)).rejects.toThrow();
    expect(platformDb.organization.create).not.toHaveBeenCalled();
  });

  it('inherits package default seats when a legacy payload omits seatLimit', async () => {
    const { seatLimit: _omitted, ...legacyPayload } = payload('admin@acme.com');
    expect(_omitted).toBe(25);

    await executePlatformCommand(actor, 'organization.create', legacyPayload, request);

    expect(platformDb.organization.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ seatLimit: 42 }) })
    );
  });
});

// D3 — a slug becomes `<slug>.<baseDomain>`, so a reserved label would shadow
// the control plane or the shared application host.
describe('organization.create reserved slugs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: 'user_new' });
  });

  it.each([
    ['www'],
    ['admin'],
    ['app'],
    ['api'],
    ['staging'],
    ['meet'],
    ['meet-staging'],
    ['turn'],
    ['turn-staging'],
    ['WWW'],
    ['  Admin  '],
    ['  Meet-Staging  '],
  ])('refuses the reserved slug %j', async (reserved) => {
    await expect(
      executePlatformCommand(
        actor,
        'organization.create',
        { ...payload('admin@acme.com'), slug: reserved },
        request
      )
    ).rejects.toThrow(/Reserved slug/);
    expect(platformDb.organization.create).not.toHaveBeenCalled();
  });

  it('still accepts an ordinary slug', async () => {
    await expect(
      executePlatformCommand(
        actor,
        'organization.create',
        { ...payload('admin@acme.com'), slug: 'Acme-Group' },
        request
      )
    ).resolves.toBeDefined();
    expect(platformDb.organization.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ slug: 'acme-group' }) })
    );
  });
});
