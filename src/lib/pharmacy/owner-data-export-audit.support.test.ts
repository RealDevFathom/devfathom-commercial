/**
 * DEV-1053: whole-business data export is refused for a support session by the export route.
 * The audit row for that attempt names the platform operator, not only the member acted as.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ recordAudit: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({ recordAudit: mocks.recordAudit }));

import { auditOwnerDataExport } from './owner-data-export-audit';

type Ctx = Parameters<typeof auditOwnerDataExport>[0];

const ctx = (user: Record<string, unknown>) =>
  ({
    organization: { id: 'org_1' },
    entitlements: { organizationId: 'org_1' },
    session: { user: { id: 'owner_1', role: 'ADMIN', ...user } },
    requestMeta: { ip: '203.0.113.9', userAgent: 'vitest' },
    db: {},
  }) as unknown as Ctx;

const refusedRequest = {
  path: '/api/pharmacy/data-export',
  method: 'POST',
  action: 'pharmacy.dataExport.request',
  operation: 'CREATE',
  status: 403,
  metadata: { from: null },
} as const;

beforeEach(() => mocks.recordAudit.mockReset());

describe('DEV-1053 data export audit', () => {
  it('names the platform operator on a support session attempt', async () => {
    await auditOwnerDataExport(
      ctx({
        isSupportSession: true,
        supportSessionId: 'support_session_1',
        platformUserId: 'platform_operator_1',
      }),
      refusedRequest
    );
    expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
    expect(mocks.recordAudit.mock.calls[0][0]).toMatchObject({
      actorId: 'owner_1',
      outcome: 'FAILURE',
      statusCode: 403,
      metadata: {
        supportSessionId: 'support_session_1',
        platformUserId: 'platform_operator_1',
        actingAsTenantUserId: 'owner_1',
      },
    });
  });

  it('adds nothing for the owner themselves', async () => {
    await auditOwnerDataExport(ctx({}), { ...refusedRequest, status: 202 });
    const metadata = mocks.recordAudit.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(metadata).not.toHaveProperty('platformUserId');
    expect(metadata).not.toHaveProperty('supportSessionId');
    expect(metadata).not.toHaveProperty('actingAsTenantUserId');
  });
});
