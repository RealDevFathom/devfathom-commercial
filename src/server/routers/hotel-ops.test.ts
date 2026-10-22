/**
 * OPS-01 — the hotel audit timeline's authorization boundary and its paging.
 *
 * Source-level proof, against mocked Prisma: what this file pins is the code's
 * own decisions — which capabilities admit a reader, which predicates reach the
 * query, which columns are asked for, and which row becomes the cursor. Cursor
 * SEMANTICS (Prisma's inclusive cursor, an ordering tie split across a page
 * boundary) and row-level security are decided by PostgreSQL, not by this file,
 * and a mock would only ever agree with itself about them. They are named in the
 * handoff as an open database gate; `audit-cursor.test.ts` is the shape that
 * settles them for the platform list, and the timeline needs its own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => false),
  propertyFindFirst: vi.fn(),
  auditFindMany: vi.fn(async () => [] as unknown[]),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));

import type { TRPCContext } from '../trpc';
import type { EntitlementSnapshot } from '@/lib/module-catalog';
import { hotelOpsRouter } from './hotel-ops';

const ORG = 'org_hotel_ops';
const BRANCH = 'branch_hotel_ops';

/** The session's own property. `branchId` is the primary key (H1-01). */
const property = {
  branchId: BRANCH,
  organizationId: ORG,
  name: 'Serena Gulberg',
  active: true,
  createdAt: new Date('2026-09-08T00:00:00.000Z'),
};

/** Grant exactly the named capabilities for the next call. */
function grant(...actions: string[]) {
  const held = new Set(actions);
  mocks.can.mockImplementation((async (_subject: unknown, action: string) =>
    held.has(action)) as unknown as typeof mocks.can);
}

function caller(
  entitlements: EntitlementSnapshot = { enabledModules: ['hotel-core'], limits: {} }
) {
  return hotelOpsRouter.createCaller({
    db: {
      hotelProperty: { findFirst: mocks.propertyFindFirst },
      auditLog: { findMany: mocks.auditFindMany },
    },
    entitlements: { organizationId: ORG, ...entitlements },
    session: {
      expires: 'later',
      user: { id: 'ops-user', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: ORG },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

/** Newest-first rows as the resolver would receive them from Prisma. */
const row = (n: number) => ({
  id: `audit_${String(n).padStart(3, '0')}`,
  createdAt: new Date(`2026-09-08T0${n}:00:00.000Z`),
  action: 'hotel.property.update',
  category: 'HOTEL',
  operation: 'UPDATE',
  outcome: 'SUCCESS',
  actorType: 'USER',
  actorId: 'ops-user',
  actorName: 'Ops User',
  actorEmail: 'ops@example.com',
  actorRole: 'EMPLOYEE',
  targetType: 'HotelProperty',
  targetId: BRANCH,
  targetLabel: 'Serena Gulberg',
  changes: { name: { before: 'Old', after: 'New' } },
});

const timelineArgs = { entityType: 'HotelProperty' as const, entityId: BRANCH };

beforeEach(() => {
  vi.clearAllMocks();
  grant();
  mocks.propertyFindFirst.mockResolvedValue(property);
  mocks.auditFindMany.mockResolvedValue([]);
});

describe('hotelOps.timeline authorization', () => {
  it('refuses a hotel user holding neither capability, and reads nothing', async () => {
    await expect(caller().timeline(timelineArgs)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.auditFindMany).not.toHaveBeenCalled();
    expect(mocks.propertyFindFirst).not.toHaveBeenCalled();
  });

  it.each([['hotel:property-admin'], ['hotel:reports-financial']])(
    'admits a reader holding %s alone',
    async (action) => {
      grant(action);
      mocks.auditFindMany.mockResolvedValue([row(1)]);
      await expect(caller().timeline(timelineArgs)).resolves.toMatchObject({
        items: [{ id: 'audit_001' }],
      });
    }
  );

  it('asks the ABAC engine for both capabilities by name', async () => {
    grant('hotel:property-admin');
    await caller().timeline(timelineArgs);
    const asked = mocks.can.mock.calls.map((call) => call[1]);
    expect(asked).toContain('hotel:property-admin');
    expect(asked).toContain('hotel:reports-financial');
  });

  it("refuses an entity id that is not this session's property, and reads no audit rows", async () => {
    grant('hotel:property-admin');
    await expect(
      caller().timeline({ entityType: 'HotelProperty', entityId: 'branch_someone_else' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.auditFindMany).not.toHaveBeenCalled();
  });

  it('refuses an entity type outside the allowlist, before any query runs', async () => {
    grant('hotel:property-admin');
    await expect(
      caller().timeline({
        entityType: 'User',
        entityId: BRANCH,
      } as unknown as typeof timelineArgs)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.auditFindMany).not.toHaveBeenCalled();
    expect(mocks.propertyFindFirst).not.toHaveBeenCalled();
  });

  it('refuses when the workspace has no property yet', async () => {
    grant('hotel:reports-financial');
    mocks.propertyFindFirst.mockResolvedValue(null);
    await expect(caller().timeline(timelineArgs)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.auditFindMany).not.toHaveBeenCalled();
  });

  it('scopes the property lookup and the audit read to the session organization', async () => {
    grant('hotel:property-admin');
    await caller().timeline(timelineArgs);

    expect(mocks.propertyFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, active: true } })
    );
    expect(mocks.auditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, targetType: 'HotelProperty', targetId: BRANCH },
      })
    );
  });
});

describe('hotelOps.timeline disclosure contract', () => {
  beforeEach(() => grant('hotel:reports-financial'));

  it('never selects the captured request payload columns', async () => {
    await caller().timeline(timelineArgs);
    const select = mocks.auditFindMany.mock.calls[0]?.[0]?.select ?? {};
    expect(select).not.toHaveProperty('input');
    expect(select).not.toHaveProperty('result');
    expect(select).not.toHaveProperty('metadata');
    expect(select).toMatchObject({ id: true, actorId: true, changes: true });
  });

  it('re-redacts a sensitive diff on the way out', async () => {
    mocks.auditFindMany.mockResolvedValue([
      {
        ...row(1),
        changes: {
          name: { before: 'Old', after: 'New' },
          apiToken: { before: 'tok_live_before', after: 'tok_live_after' },
        },
      },
    ]);

    const { items } = await caller().timeline(timelineArgs);
    const changes = items[0]?.changes as Record<string, unknown>;
    expect(changes.apiToken).toBe('[REDACTED]');
    expect(changes.name).toEqual({ before: 'Old', after: 'New' });
    expect(JSON.stringify(items)).not.toContain('tok_live');
  });
});

describe('hotelOps.timeline paging', () => {
  beforeEach(() => grant('hotel:property-admin'));

  it('orders newest first with the id tiebreaker and over-reads by exactly one', async () => {
    await caller().timeline({ ...timelineArgs, limit: 2 });
    expect(mocks.auditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
      })
    );
  });

  it('makes the LAST RETURNED row the cursor, not the popped probe (#42)', async () => {
    mocks.auditFindMany.mockResolvedValue([row(3), row(2), row(1)]);

    const page = await caller().timeline({ ...timelineArgs, limit: 2 });

    expect(page.items.map((item) => item.id)).toEqual(['audit_003', 'audit_002']);
    // The probe is delivered to nobody and named by nothing.
    expect(page.nextCursor).toBe('audit_002');
    expect(page.nextCursor).not.toBe('audit_001');
  });

  it('reports no cursor on a short final page', async () => {
    mocks.auditFindMany.mockResolvedValue([row(2), row(1)]);
    const page = await caller().timeline({ ...timelineArgs, limit: 5 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeUndefined();
  });

  it('steps past an inclusive cursor on the follow-up page', async () => {
    await caller().timeline({ ...timelineArgs, limit: 2, cursor: 'audit_002' });
    expect(mocks.auditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: 'audit_002' }, skip: 1 })
    );
  });

  it('omits the cursor clause entirely on a first page', async () => {
    await caller().timeline({ ...timelineArgs, limit: 2 });
    const args = mocks.auditFindMany.mock.calls[0]?.[0] ?? {};
    expect(args).not.toHaveProperty('cursor');
    expect(args).not.toHaveProperty('skip');
  });

  it('refuses a page size beyond the cap', async () => {
    await expect(caller().timeline({ ...timelineArgs, limit: 500 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});
