/**
 * D20 — platform operator onboarding had no duplicate guard at all. A repeat or
 * differently-cased admin email would have surfaced a raw Prisma unique-index
 * error in the control plane instead of a stated conflict.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

const mocks = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  userCreate: vi.fn(),
  opportunityFindUnique: vi.fn(),
  opportunityUpdateMany: vi.fn(),
  opportunityForUpdate: vi.fn(),
  accountForUpdate: vi.fn(),
}));

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

// Conversion locks the opportunity row first and, once it is claimed, the
// account row. Route each raw lock to its own mock.
function lockRow(
  query: TemplateStringsArray | { strings: readonly string[] },
  ...values: unknown[]
) {
  const text = 'strings' in query ? query.strings.join('?') : Array.from(query).join('?');
  return text.includes('platform_opportunities')
    ? mocks.opportunityForUpdate(query, ...values)
    : mocks.accountForUpdate(query, ...values);
}

type OpportunityRow = {
  id: string;
  accountId: string;
  stage: string;
  convertedOrganizationId: string | null;
};

// The row lock and the eligibility read observe the same committed row.
function givenOpportunity(row: OpportunityRow | null) {
  mocks.opportunityForUpdate.mockResolvedValue(
    row ? [{ id: row.id, convertedOrganizationId: row.convertedOrganizationId }] : []
  );
  mocks.opportunityFindUnique.mockResolvedValue(row);
}

const platformDb = {
  $queryRaw: lockRow,
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
  user: { findFirst: mocks.userFindFirst, create: mocks.userCreate },
  organizationBrand: { create: record('brand') },
  organizationEmailSettings: { create: record('emailSettings') },
  organizationDeployment: { create: record('deployment') },
  platformJob: { create: record('job') },
  organizationLifecycleEvent: { create: record('lifecycle') },
  platformOpportunity: {
    findUnique: mocks.opportunityFindUnique,
    updateMany: mocks.opportunityUpdateMany,
    update: record('opportunityUpdate'),
  },
  platformOpportunityStageEvent: { create: record('opportunityStageEvent') },
  platformAccount: { update: record('accountUpdate') },
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

describe('crm.opportunity.convert eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(created)) delete created[key];
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: 'user_new' });
    mocks.accountForUpdate.mockResolvedValue([{ organizationId: null }]);
  });

  it.each([
    ['WON', 'org_existing', 'Opportunity has already been converted.'],
    ['LOST', null, 'Opportunity is not eligible for conversion.'],
    ['QUALIFIED', 'org_existing', 'Opportunity has already been converted.'],
  ])(
    'rejects an ineligible opportunity before provisioning',
    async (stage, convertedOrganizationId, message) => {
      givenOpportunity({
        id: 'opp_1',
        accountId: 'account_1',
        stage,
        convertedOrganizationId,
      });

      const error = await executePlatformCommand(
        actor,
        'crm.opportunity.convert',
        { ...payload('admin@acme.com'), opportunityId: 'opp_1' },
        request
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PlatformSecurityError);
      expect(error).toMatchObject({ status: 409, message });
      expect(mocks.opportunityForUpdate).toHaveBeenCalledOnce();
      expect(mocks.opportunityUpdateMany).not.toHaveBeenCalled();
      expect(mocks.accountForUpdate).not.toHaveBeenCalled();
      expect(platformDb.organization.create).not.toHaveBeenCalled();
    }
  );

  it('rejects a missing opportunity before provisioning', async () => {
    givenOpportunity(null);

    const error = await executePlatformCommand(
      actor,
      'crm.opportunity.convert',
      { ...payload('admin@acme.com'), opportunityId: 'opp_missing' },
      request
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400, message: 'Opportunity not found.' });
    expect(mocks.opportunityForUpdate).toHaveBeenCalledOnce();
    expect(mocks.opportunityFindUnique).not.toHaveBeenCalled();
    expect(mocks.opportunityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.accountForUpdate).not.toHaveBeenCalled();
    expect(platformDb.organization.create).not.toHaveBeenCalled();
  });

  it.each(['PROPOSAL', 'WON'])('loses a concurrent %s conversion claim before provisioning', async (stage) => {
    givenOpportunity({
      id: 'opp_1', accountId: 'account_1', stage, convertedOrganizationId: null,
    });
    mocks.opportunityUpdateMany.mockResolvedValue({ count: 0 });

    const error = await executePlatformCommand(actor, 'crm.opportunity.convert',
      { ...payload('admin@acme.com'), opportunityId: 'opp_1' }, request
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 409 });
    expect(mocks.opportunityUpdateMany).toHaveBeenCalledWith({
      where: { id: 'opp_1', stage, convertedOrganizationId: null },
      data: { stage: 'WON', wonAt: expect.any(Date) },
    });
    expect(mocks.accountForUpdate).not.toHaveBeenCalled();
    expect(platformDb.organization.create).not.toHaveBeenCalled();
  });

  it.each(['DISCOVERY', 'WON'])('rejects a %s opportunity when its account is already linked', async (stage) => {
    givenOpportunity({
      id: 'opp_2', accountId: 'account_1', stage, convertedOrganizationId: null,
    });
    mocks.opportunityUpdateMany.mockResolvedValue({ count: 1 });
    mocks.accountForUpdate.mockResolvedValue([{ organizationId: 'org_existing' }]);

    const error = await executePlatformCommand(actor, 'crm.opportunity.convert',
      { ...payload('admin@acme.com'), opportunityId: 'opp_2' }, request
    ).catch((caught: unknown) => caught);

    expect(mocks.accountForUpdate).toHaveBeenCalledOnce();
    const accountLock = mocks.accountForUpdate.mock.calls[0]?.[0] as {
      strings: string[];
      values: unknown[];
    };
    expect(accountLock.values).toEqual(['account_1']);
    expect(accountLock.strings.join('?')).toContain('FOR UPDATE');
    expect(error).toMatchObject({
      status: 409,
      message: 'Account is already linked to an organization.',
    });
    expect(platformDb.organization.create).not.toHaveBeenCalled();
  });

  it('applies the same replay guard to opportunity-linked organization onboarding', async () => {
    givenOpportunity({
      id: 'opp_1', accountId: 'account_1', stage: 'WON', convertedOrganizationId: 'org_existing',
    });

    const error = await executePlatformCommand(actor, 'organization.create',
      { ...payload('admin@acme.com'), opportunityId: 'opp_1' }, request
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status: 409,
      message: 'Opportunity has already been converted.',
    });
    expect(mocks.opportunityFindUnique).not.toHaveBeenCalled();
    expect(platformDb.organization.create).not.toHaveBeenCalled();
  });

  it.each([
    ['crm.opportunity.convert', 'NEGOTIATION'],
    ['crm.opportunity.convert', 'WON'],
    ['organization.create', 'NEGOTIATION'],
    ['organization.create', 'WON'],
  ])('%s claims an unlinked %s opportunity and preserves its original stage in the event', async (command, stage) => {
    givenOpportunity({
      id: 'opp_1', accountId: 'account_1', stage, convertedOrganizationId: null,
    });
    mocks.opportunityUpdateMany.mockResolvedValue({ count: 1 });

    await executePlatformCommand(
      actor,
      command,
      { ...payload('admin@acme.com'), opportunityId: 'opp_1' },
      request
    );

    expect(mocks.opportunityUpdateMany).toHaveBeenCalledWith({
      where: { id: 'opp_1', stage, convertedOrganizationId: null },
      data: { stage: 'WON', wonAt: expect.any(Date) },
    });
    expect(mocks.opportunityForUpdate).toHaveBeenCalledOnce();
    expect(mocks.opportunityForUpdate).toHaveBeenCalledBefore(mocks.opportunityFindUnique);
    expect(mocks.accountForUpdate).toHaveBeenCalledOnce();
    expect(mocks.accountForUpdate).toHaveBeenCalledBefore(platformDb.organization.create);
    expect(created.opportunityUpdate).toContainEqual({ convertedOrganizationId: 'org_new' });
    expect(created.opportunityStageEvent).toContainEqual(
      expect.objectContaining({
        opportunityId: 'opp_1',
        fromStage: stage,
        toStage: 'WON',
      })
    );
    expect(created.accountUpdate).toContainEqual({
      organizationId: 'org_new',
      status: 'CUSTOMER',
    });
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
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the (not available)', {
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
              originalMessage:
                'duplicate key value violates unique constraint "organizations_pkey"',
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

  it.each([1, 25, 100000, 0, -1, 'invalid'])(
    'ignores a submitted seat limit of %j',
    async (seatLimit) => {
      await executePlatformCommand(
        { id: 'op_sales', role: 'SALES' } as never,
        'organization.create',
        { ...payload('admin@acme.com'), seatLimit },
        request
      );
      expect(platformDb.organization.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ seatLimit: 42 }) })
      );
    }
  );

  it.each([1, 25, 42])('accepts a super admin override of %j', async (seatLimit) => {
    await executePlatformCommand(
      actor,
      'organization.create',
      { ...payload('admin@acme.com'), seatLimit },
      request
    );
    expect(platformDb.organization.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ seatLimit }) })
    );
  });

  it.each([0, -1, 43, 100000, 'invalid', 1.5])(
    'rejects a super admin override of %j',
    async (seatLimit) => {
      await expect(
        executePlatformCommand(
          actor,
          'organization.create',
          { ...payload('admin@acme.com'), seatLimit },
          request
        )
      ).rejects.toThrow();
      expect(platformDb.organization.create).not.toHaveBeenCalled();
    }
  );

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
