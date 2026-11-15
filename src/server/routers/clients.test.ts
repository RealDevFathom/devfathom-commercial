import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  groupBy: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});

import type { TRPCContext } from '../trpc';
import { clientsRouter } from './clients';

function caller(db: Record<string, unknown> = {}) {
  return clientsRouter.createCaller({
    db: {
      client: { findMany: mocks.findMany },
      invoice: { groupBy: mocks.groupBy },
      ...db,
    },
    entitlements: { enabledModules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'admin-1',
        organizationId: 'org-1',
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('clients.getAll revenue totals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([
      {
        id: 'client-1',
        name: 'Acme',
        contacts: [],
        _count: { projects: 0, invoices: 2, documents: 0 },
      },
      {
        id: 'client-2',
        name: 'Globex',
        contacts: [],
        _count: { projects: 0, invoices: 1, documents: 0 },
      },
      {
        id: 'client-3',
        name: 'Initech',
        contacts: [],
        _count: { projects: 0, invoices: 0, documents: 0 },
      },
    ]);
    mocks.groupBy.mockResolvedValue([
      { clientId: 'client-1', currency: 'PKR', _sum: { total: 100 } },
      { clientId: 'client-1', currency: 'USD', _sum: { total: 100 } },
      { clientId: 'client-2', currency: 'PKR', _sum: { total: 250 } },
    ]);
  });

  it('groups and returns paid revenue separately in deterministic currency order', async () => {
    const result = await caller().getAll();

    expect(mocks.groupBy).toHaveBeenCalledWith({
      by: ['clientId', 'currency'],
      where: { status: 'PAID' },
      _sum: { total: true },
    });
    expect(result[0].totalRevenue).toEqual([
      { currency: 'USD', amount: 100 },
      { currency: 'PKR', amount: 100 },
    ]);
    expect(result[1].totalRevenue).toEqual([{ currency: 'PKR', amount: 250 }]);
    expect(result[2].totalRevenue).toEqual([]);
  });
});

describe('clients writes against a record that no longer exists (#318)', () => {
  const missing = 'cmzzzzzzzzzzzzzzzzzzzzzzz';
  const findUnique = vi.fn();
  const write = vi.fn();
  const model = { findUnique, update: write, delete: write };

  beforeEach(() => {
    vi.clearAllMocks();
    findUnique.mockResolvedValue(null);
  });

  async function rejection(promise: Promise<unknown>) {
    const error = await promise.then(
      () => null,
      (e: unknown) => e as { code: string; message: string }
    );
    expect(error).not.toBeNull();
    expect(error!.message).not.toMatch(/prisma|invocation/i);
    return { code: error!.code, message: error!.message };
  }

  it('update returns NOT_FOUND "Client not found" without writing', async () => {
    const result = await rejection(caller({ client: model }).update({ id: missing, name: 'QA' }));

    expect(result).toEqual({ code: 'NOT_FOUND', message: 'Client not found' });
    expect(write).not.toHaveBeenCalled();
  });

  it('deleteContact, setContractStatus and deleteContract return NOT_FOUND', async () => {
    expect(
      await rejection(caller({ clientContact: model }).deleteContact({ id: missing }))
    ).toEqual({ code: 'NOT_FOUND', message: 'Contact not found' });
    expect(
      await rejection(
        caller({ contract: model }).setContractStatus({ id: missing, status: 'SIGNED' })
      )
    ).toEqual({ code: 'NOT_FOUND', message: 'Contract not found' });
    expect(await rejection(caller({ contract: model }).deleteContract({ id: missing }))).toEqual({
      code: 'NOT_FOUND',
      message: 'Contract not found',
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('maps a delete that lands between the check and the write to NOT_FOUND', async () => {
    findUnique.mockResolvedValue({ id: missing });
    write.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        '\nInvalid `prisma.client.update()` invocation:\n\nNo record was found for an update.',
        { code: 'P2025', clientVersion: 'test' }
      )
    );

    const result = await rejection(caller({ client: model }).update({ id: missing, name: 'QA' }));

    expect(result.code).toBe('NOT_FOUND');
  });
});
