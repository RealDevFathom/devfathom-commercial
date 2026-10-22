import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  annotateAudit: vi.fn(),
  readAIConfig: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/ai/provider', () => ({ readAIConfig: mocks.readAIConfig }));
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

const scheduled = (orgId = 'org-a'): ScheduledDiscountDraft => ({
  id: 'draft-1',
  orgId,
  name: 'Quiet lunch',
  percentage: 10,
  startsAt: new Date('2026-10-22T10:00:00Z'),
  endsAt: new Date('2026-10-22T14:00:00Z'),
  status: 'SCHEDULED',
  model: 'growth-model',
  tier: 'standard',
});

function setup({ enabled = true, orgId = 'org-a' } = {}) {
  const drafts = new Map<string, ScheduledDiscountDraft>([
    [`${orgId}:draft-1`, scheduled(orgId)],
    ['org-b:draft-1', scheduled('org-b')],
  ]);
  const key = (tenant: string, id: string) => `${tenant}:${id}`;
  const port: DiscountSchedulerPort = {
    isAIEnabled: vi.fn(async tenant => enabled && tenant === orgId),
    listDrafts: vi.fn(async tenant =>
      [...drafts.values()].filter(draft => draft.orgId === tenant)
    ),
    getDraft: vi.fn(async (tenant, id) => drafts.get(key(tenant, id)) ?? null),
    updateDraft: vi.fn(async (tenant, id, patch) => {
      const current = drafts.get(key(tenant, id));
      if (!current) throw new Error('tenant-scoped draft not found');
      const next = { ...current, ...patch };
      drafts.set(key(tenant, id), next);
      return next;
    }),
    transitionDraft: vi.fn(async (tenant, id, status) => {
      const current = drafts.get(key(tenant, id));
      if (!current) throw new Error('tenant-scoped draft not found');
      const next = { ...current, status };
      drafts.set(key(tenant, id), next);
      return next;
    }),
  };
  const ctx = {
    db: {},
    entitlements: { enabledModules: [], modules: [], limits: {}, activeSeats: 1, seatLimit: 1 },
    session: {
      expires: 'later',
      user: { id: 'owner-a', organizationId: orgId, role: 'OWNER', status: 'ACTIVE' },
    },
    organization: { id: orgId, vertical: 'RESTAURANT', isDemo: false },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { caller: createAIDiscountApprovalRouter(port).createCaller(ctx), drafts, port };
}

describe('AI discount approval router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.readAIConfig.mockReturnValue({ provider: 'google', model: 'model' });
  });

  it('covers the happy path with the DevFathom AI label and tenant-scoped edit', async () => {
    const { caller, port } = setup();
    await expect(caller.list()).resolves.toMatchObject({
      label: 'DevFathom AI',
      drafts: [{ id: 'draft-1', orgId: 'org-a' }],
    });
    await expect(caller.edit({ id: 'draft-1', percentage: 15 })).resolves.toMatchObject({
      percentage: 15,
    });
    expect(port.listDrafts).toHaveBeenCalledWith('org-a');
    expect(port.getDraft).toHaveBeenCalledWith('org-a', 'draft-1');
    expect(port.updateDraft).toHaveBeenCalledWith('org-a', 'draft-1', { percentage: 15 });
  });

  it('never reads or mutates another tenant draft, even when its id collides', async () => {
    const { caller, drafts, port } = setup();
    await caller.edit({ id: 'draft-1', percentage: 15 });
    expect(drafts.get('org-a:draft-1')?.percentage).toBe(15);
    expect(drafts.get('org-b:draft-1')?.percentage).toBe(10);
    expect(port.updateDraft).toHaveBeenCalledWith('org-a', 'draft-1', expect.anything());
    expect(port.updateDraft).not.toHaveBeenCalledWith('org-b', expect.anything(), expect.anything());
  });

  it('routes permission through central can() and explicit DENY prevents all port access', async () => {
    mocks.can.mockResolvedValue(false);
    const { caller, port } = setup();
    await expect(caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'restaurant:configure',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
    expect(port.isAIEnabled).not.toHaveBeenCalled();
    expect(port.listDrafts).not.toHaveBeenCalled();
  });

  it('keeps AI off when the organization has not explicitly enabled it', async () => {
    const { caller, port } = setup({ enabled: false });
    await expect(caller.list()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'DevFathom AI is off for this organization.',
    });
    expect(port.listDrafts).not.toHaveBeenCalled();
  });

  it('keeps AI off server-side when no provider secret is configured', async () => {
    mocks.readAIConfig.mockImplementation(() => {
      throw new Error('missing provider secret');
    });
    const { caller, port } = setup();
    await expect(caller.list()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'DevFathom AI is not configured.',
    });
    expect(port.isAIEnabled).not.toHaveBeenCalled();
    expect(port.listDrafts).not.toHaveBeenCalled();
  });

  it('audits edits and approval money actions with before/after and AI attribution', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-10-22T09:00:00Z');
    try {
      const { caller } = setup();
      await caller.edit({ id: 'draft-1', percentage: 15 });
      await caller.decide({ id: 'draft-1', decision: 'APPROVE' });
      expect(mocks.annotateAudit).toHaveBeenCalledTimes(2);
      expect(mocks.annotateAudit).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.objectContaining({
          category: 'RESTAURANT_GROWTH',
          targetId: 'draft-1',
          changes: { draft: { before: expect.objectContaining({ percentage: 10 }), after: expect.objectContaining({ percentage: 15 }) } },
          metadata: { aiModel: 'growth-model', aiTier: 'standard' },
        })
      );
      expect(mocks.annotateAudit).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.objectContaining({
          changes: { draft: { before: expect.objectContaining({ status: 'SCHEDULED' }), after: expect.objectContaining({ status: 'APPROVED' }) } },
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('activates only inside the window and makes approval retries idempotent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-10-22T11:00:00Z');
    try {
      const { caller, port } = setup();
      const first = await caller.decide({ id: 'draft-1', decision: 'APPROVE' });
      const retry = await caller.decide({ id: 'draft-1', decision: 'APPROVE' });
      expect(first.status).toBe('ACTIVE');
      expect(retry).toEqual(first);
      expect(port.transitionDraft).toHaveBeenCalledTimes(2);
      expect(mocks.annotateAudit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes rejection retries idempotent but does not permit the opposite terminal decision', async () => {
    const { caller, port } = setup();
    const rejected = await caller.decide({ id: 'draft-1', decision: 'REJECT' });
    await expect(caller.decide({ id: 'draft-1', decision: 'REJECT' })).resolves.toEqual(rejected);
    await expect(caller.decide({ id: 'draft-1', decision: 'APPROVE' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(port.transitionDraft).toHaveBeenCalledTimes(1);
    expect(mocks.annotateAudit).toHaveBeenCalledTimes(1);
  });
});
