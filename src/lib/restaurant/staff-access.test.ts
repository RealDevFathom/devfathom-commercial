/**
 * WHA-1181 (7)/(8) — `setStaffAccess` is the console's ONE commit: role
 * membership and per-capability overrides applied together, in the order the
 * precedence rule requires.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { setStaffAccess } from './job-roles';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** Every write the module made, in the order it made them. */
let log: string[] = [];

function fakeDb(options: { held?: string[]; overrides?: Record<string, 'ALLOW' | 'DENY'> } = {}) {
  const held = new Set(options.held ?? []);
  const overrides = new Map(Object.entries(options.overrides ?? {}));
  return {
    restaurantStaffProfile: { findUnique: vi.fn(async () => ({ id: 'staff_1' })) },
    restaurantBranch: { findUnique: vi.fn(async () => ({ id: 'branch_1' })) },
    restaurantJobRole: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        key: where.id,
        active: true,
      })),
    },
    restaurantStaffJobRole: {
      findMany: vi.fn(async () => [...held].map((jobRoleId) => ({ jobRoleId }))),
      findUnique: vi.fn(async ({ where }: { where: Record<string, { jobRoleId: string }> }) => {
        const jobRoleId = where.staffProfileId_jobRoleId_branchId!.jobRoleId;
        // `revokeJobRole` audits the key before deleting the holding.
        return held.has(jobRoleId) ? { id: 'holding', jobRole: { key: jobRoleId } } : null;
      }),
      create: vi.fn(async ({ data }: { data: { jobRoleId: string } }) => {
        log.push(`grant:${data.jobRoleId}`);
        return { id: 'holding_new' };
      }),
      delete: vi.fn(async () => {
        log.push('revoke');
        return {};
      }),
    },
    restaurantStaffJobRoleAudit: { create: vi.fn(async () => ({})) },
    restaurantStaffCapabilityGrant: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, { capability: string }> }) => {
        const capability = where.staffProfileId_branchId_capability!.capability;
        const effect = overrides.get(capability);
        return effect ? { id: `grant_${capability}`, effect } : null;
      }),
      create: vi.fn(async ({ data }: { data: { capability: string; effect: string } }) => {
        log.push(`override:${data.capability}=${data.effect}`);
        return { id: 'grant_new', effect: data.effect };
      }),
      update: vi.fn(async ({ data }: { data: { effect: string } }) => {
        log.push(`override-update=${data.effect}`);
        return { id: 'grant_existing', effect: data.effect };
      }),
      delete: vi.fn(async () => {
        log.push('override-clear');
        return {};
      }),
    },
    restaurantStaffCapabilityAudit: { create: vi.fn(async () => ({})) },
  } as unknown as ScopedDb;
}

const base = { staffProfileId: 'staff_1', branchId: 'branch_1' };

beforeEach(() => {
  log = [];
});

describe('setStaffAccess', () => {
  it('applies roles before overrides so a deny saved alongside its role wins', async () => {
    const db = fakeDb();

    await setStaffAccess(db, {
      ...base,
      jobRoleIds: ['cashier'],
      overrides: [{ capability: 'payments:collect', effect: 'DENY' }],
    });

    // Precedence is `(roles ∪ ALLOW) \ DENY`, so the subtractive layer has to be
    // written last. The reverse order would leave the capability effective.
    expect(log).toEqual(['grant:cashier', 'override:payments:collect=DENY']);
  });

  it('reports only the changes it actually made', async () => {
    const db = fakeDb({ held: ['cashier'], overrides: { 'cash:open': 'ALLOW' } });

    const result = await setStaffAccess(db, {
      ...base,
      // `cashier` is already held and `cash:open` is already ALLOW: both are
      // no-ops, so neither may be reported (or audited) as a change.
      jobRoleIds: ['cashier'],
      overrides: [
        { capability: 'cash:open', effect: 'ALLOW' },
        { capability: 'orders:void', effect: 'DENY' },
      ],
    });

    expect(result).toEqual({
      granted: [],
      revoked: [],
      overrides: [{ capability: 'orders:void', effect: 'DENY' }],
    });
    expect(log).toEqual(['override:orders:void=DENY']);
  });

  it('clears an override when the staged effect is null', async () => {
    const db = fakeDb({ held: ['cashier'], overrides: { 'orders:discount': 'ALLOW' } });

    const result = await setStaffAccess(db, {
      ...base,
      jobRoleIds: ['cashier'],
      overrides: [{ capability: 'orders:discount', effect: null }],
    });

    expect(log).toEqual(['override-clear']);
    expect(result.overrides).toEqual([{ capability: 'orders:discount', effect: null }]);
  });

  it('is a no-op clear when there is nothing to clear', async () => {
    const db = fakeDb({ held: ['cashier'] });

    const result = await setStaffAccess(db, {
      ...base,
      jobRoleIds: ['cashier'],
      overrides: [{ capability: 'orders:discount', effect: null }],
    });

    expect(log).toEqual([]);
    expect(result.overrides).toEqual([]);
  });

  it('revokes roles missing from the desired set in the same commit', async () => {
    const db = fakeDb({ held: ['server'] });

    const result = await setStaffAccess(db, {
      ...base,
      jobRoleIds: ['cashier'],
      overrides: [],
    });

    expect(result.granted).toEqual(['cashier']);
    expect(result.revoked).toEqual(['server']);
  });
});
