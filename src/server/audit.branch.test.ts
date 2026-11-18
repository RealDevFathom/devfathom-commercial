import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn(),
  withPlatformDb: vi.fn(),
  createTenantDb: vi.fn(),
}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { auditBranchId, recordTrpcAudit } from './audit';

// DEV-913: every tRPC audit entry carries the branch the action was taken at,
// so the audit log can be filtered and limited by branch.

describe('auditBranchId', () => {
  it('reads the annotated branch first, then the request, then its scope', () => {
    expect(auditBranchId({ branchId: 'from_input' }, { metadata: { branchId: 'annotated' } })).toBe(
      'annotated'
    );
    expect(auditBranchId({ branchId: 'branch_1', saleId: 's' })).toBe('branch_1');
    expect(auditBranchId({ scope: { branchId: 'branch_2' } })).toBe('branch_2');
    expect(auditBranchId({ pharmacyBranchId: 'branch_3', occurrenceId: 'o' })).toBe('branch_3');
  });

  it('records no branch when none was given, or when the value is not an identifier', () => {
    expect(auditBranchId(undefined)).toBeNull();
    expect(auditBranchId('[skipped]')).toBeNull();
    expect(auditBranchId([{ branchId: 'x' }])).toBeNull();
    expect(auditBranchId({ saleId: 'sale_1' })).toBeNull();
    expect(auditBranchId({ branchId: 42 })).toBeNull();
    expect(auditBranchId({ branchId: 'a b; drop' })).toBeNull();
    expect(auditBranchId({ branchId: 'x'.repeat(65) })).toBeNull();
  });
});

describe('recordTrpcAudit branch', () => {
  async function record(input: unknown) {
    const create = vi.fn(async () => ({ id: 'audit_1' }));
    const db = { auditLog: { create } } as unknown as ScopedDb;
    await recordTrpcAudit({
      ctx: {
        session: {
          user: { id: 'cashier_1', organizationId: 'org_p', role: 'EMPLOYEE', name: 'Cashier' },
        },
        audit: { detail: {}, db },
      },
      path: 'pharmacySales.returnAndRefund',
      type: 'mutation',
      input,
      outcome: 'SUCCESS',
    });
    return (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
  }

  it('stores the branch on the entry with the person', async () => {
    const data = await record({ branchId: 'branch_north', managerPin: '1234' });
    expect(data).toMatchObject({
      actorId: 'cashier_1',
      actorRole: 'EMPLOYEE',
      metadata: { branchId: 'branch_north' },
      input: { branchId: 'branch_north', managerPin: '[REDACTED]' },
    });
    expect(JSON.stringify(data)).not.toContain('1234');
  });

  it('leaves an entry without a branch workspace-wide', async () => {
    const data = await record({ name: 'New role' });
    expect(data.metadata).toEqual({});
  });
});

// DEV-937: a refused request that names another branch must not plant an entry
// in that branch's log. The branch stays only when the person really works there.
describe('recordTrpcAudit branch of a refused request', () => {
  const BRANCHES = ['branch_north', 'branch_south'];
  const PEOPLE: Record<string, { owner: boolean; admin?: boolean; branches: string[] }> = {
    north_cashier: { owner: false, branches: ['branch_north'] },
    owner_1: { owner: true, branches: [] },
    // An ADMIN without `*`: the counter lets them act at every branch.
    north_admin: { owner: false, admin: true, branches: ['branch_north'] },
  };

  async function record(args: {
    actorId: string | null;
    input: unknown;
    outcome: 'SUCCESS' | 'FAILURE';
    metadata?: Record<string, unknown>;
  }) {
    const create = vi.fn(async () => ({ id: 'audit_1' }));
    const db = {
      auditLog: { create },
      pharmacyBranch: {
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          BRANCHES.filter((id) => where.id.in.includes(id)).map((id) => ({ id }))
        ),
      },
      user: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
          const person = PEOPLE[where.id];
          if (!person) return null;
          return {
            status: 'ACTIVE',
            role: person.owner || person.admin ? 'ADMIN' : 'EMPLOYEE',
            organizationRole: person.owner
              ? { key: 'owner', isSystem: true, permissions: [] }
              : { key: person.admin ? 'manager' : 'cashier', isSystem: true, permissions: [] },
            permissionOverrides: [],
          };
        }),
      },
      pharmacyBranchAssignment: {
        findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
          (PEOPLE[where.userId]?.branches ?? []).map((branchId) => ({ branchId }))
        ),
      },
    } as unknown as ScopedDb;
    await recordTrpcAudit({
      ctx: {
        session: {
          user: { ...(args.actorId ? { id: args.actorId } : {}), organizationId: 'org_p' },
        },
        audit: { detail: args.metadata ? { metadata: args.metadata } : {}, db },
      },
      path: 'pharmacySales.returnAndRefund',
      type: 'mutation',
      input: args.input,
      outcome: args.outcome,
      error: args.outcome === 'FAILURE' ? new Error('Branch is outside your scope.') : undefined,
    });
    return (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
  }

  it('places a refusal naming another branch at the branch the person works at', async () => {
    const data = await record({
      actorId: 'north_cashier',
      input: { branchId: 'branch_south', saleId: 'sale_1' },
      outcome: 'FAILURE',
    });
    expect(data.outcome).toBe('FAILURE');
    expect(data.metadata).toEqual({
      requestedBranchId: 'branch_south',
      actorBranchIds: ['branch_north'],
    });
    expect(data.input).toMatchObject({ branchId: 'branch_south' });
  });

  it('does not trust a branch a handler noted before refusing', async () => {
    const data = await record({
      actorId: 'north_cashier',
      input: { saleId: 'sale_1' },
      outcome: 'FAILURE',
      metadata: { branchId: 'branch_south', fileName: 'stock.csv' },
    });
    expect(data.metadata).toEqual({
      fileName: 'stock.csv',
      requestedBranchId: 'branch_south',
      actorBranchIds: ['branch_north'],
    });
  });

  it('keeps a refusal at the branch the person works at', async () => {
    const data = await record({
      actorId: 'north_cashier',
      input: { branchId: 'branch_north' },
      outcome: 'FAILURE',
    });
    expect(data.metadata).toEqual({ branchId: 'branch_north' });
  });

  it("keeps the owner's refusal at the branch named", async () => {
    const data = await record({
      actorId: 'owner_1',
      input: { branchId: 'branch_south' },
      outcome: 'FAILURE',
    });
    expect(data.metadata).toEqual({ branchId: 'branch_south' });
  });

  it('places a refusal with no person at no branch', async () => {
    const data = await record({
      actorId: null,
      input: { branchId: 'branch_south' },
      outcome: 'FAILURE',
    });
    expect(data.metadata).toEqual({ requestedBranchId: 'branch_south', actorBranchIds: [] });
  });

  it("keeps an ADMIN's refusal at the branch they acted at, as the counter lets them", async () => {
    const data = await record({
      actorId: 'north_admin',
      input: { branchId: 'branch_south' },
      outcome: 'FAILURE',
    });
    expect(data.metadata).toEqual({ branchId: 'branch_south' });
  });

  it('leaves branches outside the pharmacy as they were', async () => {
    const other = await record({
      actorId: 'north_cashier',
      input: { branchId: 'restaurant_branch_1' },
      outcome: 'FAILURE',
    });
    expect(other.metadata).toEqual({ branchId: 'restaurant_branch_1' });
  });
});

// DEV-937: a successful request is read before its schema drops unknown keys,
// so a branch it names is checked as well; a record's own tag stands.
describe('recordTrpcAudit branch of a successful request', () => {
  const BRANCHES = ['branch_north', 'branch_south'];
  async function record(
    input: unknown,
    metadata?: Record<string, unknown>,
    role: 'EMPLOYEE' | 'ADMIN' = 'EMPLOYEE'
  ) {
    const create = vi.fn(async () => ({ id: 'audit_1' }));
    const findMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      BRANCHES.filter((id) => where.id.in.includes(id)).map((id) => ({ id }))
    );
    const db = {
      auditLog: { create },
      pharmacyBranch: { findMany },
      user: {
        findFirst: vi.fn(async () => ({
          status: 'ACTIVE',
          role,
          organizationRole: { key: 'cashier', isSystem: true, permissions: [] },
          permissionOverrides: [],
        })),
      },
      pharmacyBranchAssignment: { findMany: vi.fn(async () => [{ branchId: 'branch_north' }]) },
    } as unknown as ScopedDb;
    await recordTrpcAudit({
      ctx: {
        session: { user: { id: 'north_cashier', organizationId: 'org_p' } },
        audit: { detail: metadata ? { metadata } : {}, db },
      },
      path: 'notes.create',
      type: 'mutation',
      input,
      outcome: 'SUCCESS',
    });
    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    return { metadata: data.metadata, lookedUp: findMany.mock.calls.length > 0 };
  }

  it('does not place an entry at a branch the request merely named', async () => {
    const { metadata } = await record({ title: 'Note', branchId: 'branch_south' });
    expect(metadata).toEqual({
      requestedBranchId: 'branch_south',
      actorBranchIds: ['branch_north'],
    });
  });

  it('does not let an extra branchId override a real pharmacyBranchId or scope', async () => {
    expect(
      (await record({ branchId: 'branch_south', pharmacyBranchId: 'branch_north' })).metadata
    ).toEqual({ branchId: 'branch_north' });
    expect(
      (await record({ branchId: 'branch_south', scope: { branchId: 'branch_north' } })).metadata
    ).toEqual({ branchId: 'branch_north' });
  });

  it('prefers the declared pharmacyBranchId or scope over a bare branchId, deterministically', async () => {
    // An ADMIN may act at both branches, so only the order decides.
    expect(
      (
        await record(
          { branchId: 'branch_south', pharmacyBranchId: 'branch_north' },
          undefined,
          'ADMIN'
        )
      ).metadata
    ).toEqual({ branchId: 'branch_north' });
    expect(
      (
        await record(
          { branchId: 'branch_south', scope: { branchId: 'branch_north' } },
          undefined,
          'ADMIN'
        )
      ).metadata
    ).toEqual({ branchId: 'branch_north' });
    // A record's own tag wins over every request field.
    expect(
      (
        await record(
          { branchId: 'branch_south', pharmacyBranchId: 'branch_south' },
          { branchId: 'branch_north' },
          'ADMIN'
        )
      ).metadata
    ).toEqual({ branchId: 'branch_north' });
  });

  it('keeps a request at the branch the person works at', async () => {
    expect((await record({ branchId: 'branch_north' })).metadata).toEqual({
      branchId: 'branch_north',
    });
  });

  it("keeps the record's own tag without looking it up again", async () => {
    const result = await record({ branchId: 'branch_south' }, { branchId: 'branch_south' });
    expect(result.metadata).toEqual({ branchId: 'branch_south' });
    expect(result.lookedUp).toBe(false);
  });
});
