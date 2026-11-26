import { expect, it, vi } from 'vitest';
import { manageWaha } from './waha-admin';
import type { TRPCContext } from '@/server/trpc';
const audit = vi.hoisted(() => vi.fn());
vi.mock('@/server/audit', () => ({ recordAudit: audit }));
vi.mock('@/lib/pharmacy/owner-data-export', () => ({
  isLiveOrganizationOwner: vi.fn(async () => false),
}));
it('refuses a non-owner before reading credentials or contacting WAHA and audits the denial', async () => {
  const ctx = {
    organization: { id: 'business-a', vertical: 'PHARMACY', status: 'ACTIVE' },
    session: { user: { id: 'user-a', organizationId: 'business-a' } },
    entitlements: { organizationId: 'business-a', modules: [] },
    db: {},
    requestMeta: {},
  } as unknown as TRPCContext;
  expect((await manageWaha(ctx, { action: 'refresh' })).access).toBe(false);
  expect(audit).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }), ctx.db);
});
