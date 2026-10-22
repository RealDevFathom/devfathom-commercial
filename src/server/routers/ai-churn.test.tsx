import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ can: vi.fn(), recordTrpcAudit: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: mocks.recordTrpcAudit,
}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));

import { ChurnRiskList } from '@/components/ai/churn-risk-list';
import type { ChurnScorePort } from '@/lib/ai/shared/churn-score.types';
import type { TRPCContext } from '../trpc';
import { createAIChurnRouter } from './ai-churn';

const port: ChurnScorePort = {
  isAIConfigured: vi.fn(),
  listChurnRisks: vi.fn(),
};

function caller() {
  return createAIChurnRouter(port).createCaller({
    db: {} as TRPCContext['db'],
    entitlements: { enabledModules: [], activeSeats: 1, seatLimit: 1, modules: [] },
    session: {
      expires: 'later',
      user: { id: 'user_1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_1' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as TRPCContext);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('AI churn read router', () => {
  it('honours central can() DENY before configuration or tenant reads', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'reports:operational',
      undefined,
      expect.anything()
    );
    expect(port.isAIConfigured).not.toHaveBeenCalled();
    expect(port.listChurnRisks).not.toHaveBeenCalled();
  });

  it('is off by default and checks provider configuration on the server', async () => {
    mocks.can.mockResolvedValue(true);
    vi.mocked(port.isAIConfigured).mockResolvedValue(false);
    await expect(caller().list({ limit: 10 })).resolves.toEqual({ status: 'AI_OFF' });
    expect(port.isAIConfigured).toHaveBeenCalledWith('org_1');
    expect(port.listChurnRisks).not.toHaveBeenCalled();
  });

  it('passes the authenticated tenant to every churn query', async () => {
    mocks.can.mockResolvedValue(true);
    vi.mocked(port.isAIConfigured).mockResolvedValue(true);
    vi.mocked(port.listChurnRisks).mockResolvedValue([]);
    await caller().list({ limit: 12 });
    expect(port.listChurnRisks).toHaveBeenCalledWith({ organizationId: 'org_1', limit: 12 });
  });

  it('returns the scored customers on the happy path', async () => {
    const customers = [
      {
        customerId: 'customer_1',
        displayName: 'Fixture Customer',
        risk: 'HIGH' as const,
        score: 91,
        reason: 'No recent visit',
        lastActivityAt: null,
      },
    ];
    mocks.can.mockResolvedValue(true);
    vi.mocked(port.isAIConfigured).mockResolvedValue(true);
    vi.mocked(port.listChurnRisks).mockResolvedValue(customers);

    await expect(caller().list({ limit: 10 })).resolves.toEqual({
      status: 'AVAILABLE',
      customers,
    });
  });

  it('rejects a caller-supplied tenant instead of weakening the scoped predicate', async () => {
    mocks.can.mockResolvedValue(true);

    await expect(
      caller().list({ limit: 10, organizationId: 'org_foreign' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(port.isAIConfigured).not.toHaveBeenCalled();
    expect(port.listChurnRisks).not.toHaveBeenCalled();
  });

  it('is idempotent when an identical read is retried', async () => {
    mocks.can.mockResolvedValue(true);
    vi.mocked(port.isAIConfigured).mockResolvedValue(true);
    vi.mocked(port.listChurnRisks).mockResolvedValue([]);

    const first = await caller().list({ limit: 25 });
    const retry = await caller().list({ limit: 25 });

    expect(retry).toEqual(first);
    expect(port.listChurnRisks).toHaveBeenCalledTimes(2);
    expect(port.listChurnRisks).toHaveBeenNthCalledWith(1, {
      organizationId: 'org_1',
      limit: 25,
    });
    expect(port.listChurnRisks).toHaveBeenNthCalledWith(2, {
      organizationId: 'org_1',
      limit: 25,
    });
  });

  it('audits successful and denied AI reads', async () => {
    mocks.can.mockResolvedValue(true);
    vi.mocked(port.isAIConfigured).mockResolvedValue(false);
    await caller().list({ limit: 10 });
    expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'list', type: 'query', outcome: 'SUCCESS' })
    );

    mocks.recordTrpcAudit.mockClear();
    mocks.can.mockResolvedValue(false);
    await expect(caller().list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'list', type: 'query', outcome: 'FAILURE' })
    );
  });
});

it('labels the read-only list DevFathom AI and renders risk badges', () => {
  render(
    <ChurnRiskList
      result={{
        status: 'AVAILABLE',
        customers: [
          {
            customerId: 'c1',
            displayName: 'Ada',
            risk: 'HIGH',
            score: 91,
            reason: 'No recent visit',
            lastActivityAt: null,
          },
        ],
      }}
    />
  );
  expect(screen.getByText('DevFathom AI')).toBeTruthy();
  expect(screen.getByText('HIGH risk')).toHaveAttribute('data-tone', 'danger');
  expect(screen.queryByRole('button')).toBeNull();
});
