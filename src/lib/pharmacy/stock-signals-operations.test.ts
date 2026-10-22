import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { authorizeDraftIntent, type DraftActionInput } from './stock-signals-operations';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const input = {
  kind: 'DRAFT_REQUISITION',
  signalId: 'signal-1',
  lines: [],
} as unknown as DraftActionInput;
const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'user-1' };

function fixture(overrides: Rule[], role: Rule[]) {
  const actor = {
    id: 'user-1', role: 'EMPLOYEE', department: null, status: 'ACTIVE',
    organization: { status: 'ACTIVE', vertical: 'PHARMACY' },
  };
  return {
    $queryRaw: vi.fn(async () => [{ organizationId: 'org-1', branchId: 'branch-1' }]),
    user: {
      findFirst: vi.fn(async () => actor),
      findUnique: vi.fn(async () => ({
        organizationRole: { permissions: role }, permissionOverrides: overrides,
      })),
    },
    pharmacyBranch: { findFirst: vi.fn(async () => ({ id: 'branch-1' })) },
  } as unknown as ScopedDb;
}

describe('authorizeDraftIntent', () => {
  it.each([
    { overrides: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }], role: [{ capability: 'pharmacy:procurement', effect: 'DENY' }] },
    { overrides: [{ capability: 'pharmacy:procurement', effect: 'DENY' }], role: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }] },
    { overrides: [{ capability: 'pharmacy:*', effect: 'DENY' }], role: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }] },
  ] as const)('rejects a draft when any matching rule denies', async ({ overrides, role }) => {
    await expect(authorizeDraftIntent(fixture(overrides, role), scope, input, new Date()))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
