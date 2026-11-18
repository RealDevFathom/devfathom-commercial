import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-631: reopening a closed day re-authenticates the owner with their own PIN, in
// its own transaction, so a refusal commits its lockout strike and a FAILURE audit row.
vi.mock('server-only', () => ({}));
const db = vi.hoisted(() => ({ auditLog: { create: vi.fn() } }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn(async (_org: string, run: (tx: unknown) => unknown) => run(db)),
}));
vi.mock('./refund-authorization', () => ({ verifyRefundPin: vi.fn() }));

import { withTenantDb } from '@/lib/tenancy/scoped-db';
import {
  authenticateDayReopenPin,
  DAY_REOPEN_PIN_BLOCKED,
  DAY_REOPEN_PIN_POLICY,
} from './day-reopen-authorization';
import { verifyRefundPin } from './refund-authorization';

const input = { organizationId: 'org-1', actorId: 'owner-1', pin: '4321' };

beforeEach(() => {
  vi.mocked(verifyRefundPin).mockReset();
  db.auditLog.create.mockReset();
});

describe('authenticateDayReopenPin', () => {
  it("verifies the signed-in owner's own PIN in its own tenant transaction", async () => {
    vi.mocked(verifyRefundPin).mockResolvedValue({ verified: true });
    await expect(authenticateDayReopenPin(input)).resolves.toEqual({ verified: true });
    expect(withTenantDb).toHaveBeenCalledWith('org-1', expect.any(Function), { skipDrain: true });
    expect(verifyRefundPin).toHaveBeenCalledWith(db, input);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('refuses a wrong PIN with the reopen message and a FAILURE audit row', async () => {
    vi.mocked(verifyRefundPin).mockResolvedValue({ blocked: 'Refund not recorded.' });
    await expect(authenticateDayReopenPin(input)).resolves.toEqual({
      blocked: DAY_REOPEN_PIN_BLOCKED,
    });
    expect(db.auditLog.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        organizationId: 'org-1',
        actorId: 'owner-1',
        action: 'pharmacySales.reopenDay',
        outcome: 'FAILURE',
        errorCode: 'DAY_REOPEN_PIN_REFUSED',
        metadata: { policy: DAY_REOPEN_PIN_POLICY, pinVerified: false },
      }),
    });
    // The PIN itself is never written to the audit row.
    expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toContain('4321');
  });
});
