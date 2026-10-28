// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { createDraftAction } from './stock-signals-operations';

const scope = { organizationId: 'org_owner', branchId: 'branch_owner', actorId: 'user_owner' };
const input = {
  kind: 'DRAFT_REQUISITION' as const,
  signalId: 'signal_owner',
  reference: 'owner-draft',
  medicineId: 'medicine',
  packLevelId: 'pack',
  canonicalUnitsPerPack: 10,
  quantityPacks: 1,
};
const previous = {
  id: 'existing_draft',
  signalId: input.signalId,
  payloadHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
};
function fixture(
  key: string,
  isSystem = true,
  roleOrganizationId = scope.organizationId,
  denied = false
) {
  const user = {
    organizationId: scope.organizationId,
    role: 'EMPLOYEE',
    status: 'ACTIVE',
    organization: { status: 'ACTIVE', vertical: 'PHARMACY' },
    organizationRole: {
      organizationId: roleOrganizationId,
      key,
      isSystem,
      permissions: denied ? [{ capability: 'pharmacy:*', effect: 'DENY' }] : [],
    },
    permissionOverrides: denied ? [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }] : [],
  };
  const db = {
    user: { findFirst: vi.fn(async () => user) },
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ organizationId: scope.organizationId, branchId: null }])
      .mockResolvedValueOnce([previous]),
    pharmacyBranch: { findFirst: vi.fn(async () => ({ id: scope.branchId })) },
    pharmacyStockSignal: { findFirst: vi.fn(async () => ({ id: input.signalId })) },
  };
  return { db, user, run: () => createDraftAction(db as unknown as ScopedDb, scope, input) };
}
describe('shared owner authority for direct draft capability checks', () => {
  it.each(['owner', 'admin'])(
    'allows an existing system %s to replay a native draft without backfilled grants',
    async (key) => {
      const f = fixture(key);
      await expect(f.run()).resolves.toEqual(previous);
      expect(f.db.pharmacyStockSignal.findFirst).toHaveBeenCalledWith({
        where: {
          id: input.signalId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
        },
      });
    }
  );
  it('allows a persisted tenant ADMIN without role grants', async () => {
    const f = fixture('member', false);
    f.user.role = 'ADMIN';
    await expect(f.run()).resolves.toEqual(previous);
  });
  it.each([
    ['custom owner', 'owner', false, scope.organizationId, false],
    ['foreign owner', 'owner', true, 'foreign_org', false],
    ['explicit owner deny', 'owner', true, scope.organizationId, true],
  ] as const)(
    'rejects %s before reading the draft or signal',
    async (_label, key, system, org, deny) => {
      const f = fixture(key, system, org, deny);
      await expect(f.run()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.pharmacyStockSignal.findFirst).not.toHaveBeenCalled();
    }
  );
});
