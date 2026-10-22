import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ can: vi.fn(), annotateAudit: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/ai/provider', () => ({
  readAIConfig: () => ({ provider: 'google', model: 'model' }),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: mocks.annotateAudit,
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
}));

import type {
  DiscountSchedulerPort,
  ScheduledDiscountDraft,
} from '@/lib/ai/shared/discount-scheduler.types';
import type { TRPCContext } from '../trpc';
import { createAIDiscountApprovalRouter } from './ai-discount-approval';

const scheduled = (): ScheduledDiscountDraft => ({
  id: 'draft-1',
  orgId: 'org-a',
  name: 'Quiet lunch',
  percentage: 10,
  startsAt: new Date('2026-10-22T10:00:00Z'),
  endsAt: new Date('2026-10-22T14:00:00Z'),
  status: 'SCHEDULED',
  model: 'growth-model',
  tier: 'standard',
});

function setup() {
  let draft = scheduled();
  const port: DiscountSchedulerPort = {
    isAIEnabled: vi.fn(async () => true),
    listDrafts: vi.fn(async () => [draft]),
    getDraft: vi.fn(async (_org, id) => (id === draft.id ? draft : null)),
    updateDraft: vi.fn(async (_org, _id, patch) => (draft = { ...draft, ...patch })),
    transitionDraft: vi.fn(async (_org, _id, status) => (draft = { ...draft, status })),
  };
  const ctx = {
    db: {},
    entitlements: { enabledModules: [], modules: [], limits: {}, activeSeats: 1, seatLimit: 1 },
    session: {
      expires: 'later',
      user: { id: 'owner-a', organizationId: 'org-a', role: 'OWNER', status: 'ACTIVE' },
    },
    organization: { id: 'org-a', vertical: 'RESTAURANT', isDemo: false },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { caller: createAIDiscountApprovalRouter(port).createCaller(ctx), port };
}

describe('AI discount approval router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
  });

  it('routes permission through can() and an explicit deny prevents tenant reads', async () => {
    mocks.can.mockResolvedValue(false);
    const { caller, port } = setup();
    await expect(caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'restaurant:configure',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
    expect(port.listDrafts).not.toHaveBeenCalled();
  });

  it('passes the authenticated org on every query and edit', async () => {
    const { caller, port } = setup();
    await caller.list();
    await caller.edit({ id: 'draft-1', percentage: 15 });
    expect(port.listDrafts).toHaveBeenCalledWith('org-a');
    expect(port.getDraft).toHaveBeenCalledWith('org-a', 'draft-1');
    expect(port.updateDraft).toHaveBeenCalledWith('org-a', 'draft-1', { percentage: 15 });
  });

  it('approves without activation before the scheduled window and audits old/new AI details', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-10-22T09:00:00Z');
    const { caller, port } = setup();
    await expect(caller.decide({ id: 'draft-1', decision: 'APPROVE' })).resolves.toMatchObject({
      status: 'APPROVED',
    });
    expect(port.transitionDraft).toHaveBeenCalledTimes(1);
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        changes: expect.anything(),
        metadata: { aiModel: 'growth-model', aiTier: 'standard' },
      })
    );
    vi.useRealTimers();
  });

  it('activates an approved draft only while inside its window and rejects terminal drafts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-10-22T11:00:00Z');
    const { caller, port } = setup();
    await expect(caller.decide({ id: 'draft-1', decision: 'APPROVE' })).resolves.toMatchObject({
      status: 'ACTIVE',
    });
    expect(port.transitionDraft).toHaveBeenNthCalledWith(
      1,
      'org-a',
      'draft-1',
      'APPROVED',
      expect.any(Date)
    );
    expect(port.transitionDraft).toHaveBeenNthCalledWith(
      2,
      'org-a',
      'draft-1',
      'ACTIVE',
      expect.any(Date)
    );
    await expect(caller.decide({ id: 'draft-1', decision: 'REJECT' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    vi.useRealTimers();
  });
});
