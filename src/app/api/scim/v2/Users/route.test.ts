/**
 * D20 — a directory that provisions a differently-cased address must get SCIM
 * `uniqueness` (409), never a 500 from the composite unique index.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
  recordScimEvent: vi.fn(),
  // WHA-290: the route resolves the department from the tenant's own catalog
  // instead of hardcoding an agency-era key.
  organizationFindUnique: vi.fn(async () => ({ vertical: 'AGENCY' })),
  departmentFindMany: vi.fn(async () => [{ key: 'LEADERSHIP' }, { key: 'ENGINEERING' }]),
  // DEV-1004: outside a pharmacy the write takes the organisation row lock.
  queryRaw: vi.fn<(sql: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>(
    async () => []
  ),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: vi.fn(async () => ({ activeSeats: 1, seatLimit: 50 })),
}));
vi.mock('@/lib/scim', async () => {
  const actual = await vi.importActual<typeof import('@/lib/scim')>('@/lib/scim');
  return {
    ...actual,
    recordScimEvent: mocks.recordScimEvent,
    withScimAuth: async (
      _request: Request,
      run: (ctx: { organizationId: string; tokenId: string; db: unknown }) => Promise<Response>
    ) =>
      run({
        organizationId: 'org_devfathom',
        tokenId: 'tok_1',
        db: {
          user: { findFirst: mocks.findFirst, create: mocks.create },
          organization: { findUnique: mocks.organizationFindUnique },
          organizationDepartment: { findMany: mocks.departmentFindMany },
          $queryRaw: mocks.queryRaw,
        },
      }),
  };
});

import { POST } from './route';

function scimRequest(userName: string) {
  return new Request('https://devfathom.localhost/api/scim/v2/Users', {
    method: 'POST',
    headers: { 'content-type': 'application/scim+json' },
    body: JSON.stringify({ userName, displayName: 'Alex Carter', active: true }),
  });
}

describe('SCIM Users POST', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` clears calls, not implementations — restore the catalog
    // fakes so each case starts from the same tenant.
    mocks.organizationFindUnique.mockResolvedValue({ vertical: 'AGENCY' });
    mocks.departmentFindMany.mockResolvedValue([{ key: 'LEADERSHIP' }, { key: 'ENGINEERING' }]);
  });

  it.each([['ALEX@COMPANY.COM'], ['Alex@Company.com'], ['  alex@company.com  ']])(
    'returns 409 uniqueness when %j already exists as alex@company.com',
    async (userName) => {
      mocks.findFirst.mockResolvedValue({ id: 'user_1' });

      const response = await POST(scimRequest(userName));
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.scimType).toBe('uniqueness');
      expect(body.detail).toBe('A user with this userName already exists.');
      // The lookup used the canonical form — this is what made the guard fire.
      expect(mocks.findFirst).toHaveBeenCalledWith({
        where: { email: 'alex@company.com' },
        select: { id: true },
      });
      expect(mocks.create).not.toHaveBeenCalled();
    }
  );

  it('stores the canonical form when the address is new', async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.create.mockResolvedValue({
      id: 'user_2',
      name: 'Alex Carter',
      email: 'new.person@company.com',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await POST(scimRequest('New.Person@Company.COM'));

    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'new.person@company.com' }),
      })
    );
    // DEV-1004: the organisation row is locked before the member is written.
    expect(String(mocks.queryRaw.mock.calls[0]?.[0])).toMatch(/FROM "organizations".*FOR UPDATE/);
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.create.mock.invocationCallOrder[0]!
    );
  });

  // WHA-290 — `department` is a composite foreign key onto the tenant's own
  // catalog, so SCIM cannot assert an agency-era key into every tenant.
  it('files the new user under a department the tenant actually has', async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.departmentFindMany.mockResolvedValue([{ key: 'OPERATIONS' }, { key: 'DESIGN' }]);
    mocks.create.mockResolvedValue({
      id: 'user_3',
      name: 'Alex Carter',
      email: 'new.person@company.com',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await POST(scimRequest('New.Person@Company.COM'));

    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ department: 'OPERATIONS' }),
      })
    );
  });

  it('answers 409 instead of a 500 when the tenant deactivated every department', async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.departmentFindMany.mockResolvedValue([]);

    const response = await POST(scimRequest('New.Person@Company.COM'));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      detail: expect.stringContaining('no active department'),
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
