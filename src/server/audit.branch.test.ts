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
