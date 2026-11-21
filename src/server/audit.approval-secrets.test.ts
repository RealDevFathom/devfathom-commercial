import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn(),
  withPlatformDb: vi.fn(),
  createTenantDb: vi.fn(),
}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { recordTrpcAudit } from './audit';

/**
 * DEV-961: the request audit records a call's input even when it is refused before its
 * resolver runs (a rate limit, the set-up gate, input validation). A recovery code or an
 * authenticator code sits under a key (`code`) the general redaction does not cover, so the
 * approval-authenticator procedures that carry a secret never record their input at all.
 */
async function record(path: string, input: unknown) {
  const create = vi.fn(async () => ({ id: 'audit_1' }));
  const db = { auditLog: { create } } as unknown as ScopedDb;
  await recordTrpcAudit({
    ctx: {
      session: { user: { id: 'owner_1', organizationId: 'org_p', role: 'ADMIN', name: 'Owner' } },
      audit: { detail: {}, db },
    },
    path,
    type: 'mutation',
    input,
    outcome: 'FAILURE',
    error: Object.assign(new Error('Too many attempts. Wait a few minutes and try again.'), {
      code: 'TOO_MANY_REQUESTS',
    }),
  });
  return (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
}

describe('DEV-961 approval secrets never reach the request audit', () => {
  it.each([
    ['approvalAuthenticator.useRecoveryCode', { code: 'K7Q2-9WXM-4TPA' }, 'K7Q2-9WXM-4TPA'],
    ['approvalAuthenticator.setRequired', { required: false, code: '482913' }, '482913'],
    ['approvalAuthenticator.confirmEnrollment', { token: '615204' }, '615204'],
  ])('records %s refused before its resolver without its input', async (path, input, secret) => {
    const data = await record(path, input);
    expect(data).toMatchObject({ action: path, outcome: 'FAILURE', input: '[skipped]' });
    expect(JSON.stringify(data)).not.toContain(secret);
  });

  it('still records the input of other procedures, with the general redaction', async () => {
    const data = await record('pharmacyMarketing.createVoucher', { code: 'EID-SALE' });
    expect(data.input).toEqual({ code: 'EID-SALE' });
  });
});
