import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (entitlements: EntitlementView, key: string) =>
    entitlements.enabledModules.includes(key),
}));

import { emitEvent } from './webhooks';

const entitlements = (enabled: boolean): EntitlementView => ({
  organizationId: 'org_1',
  seatLimit: 10,
  activeSeats: 1,
  enabledModules: enabled ? ['webhooks'] : [],
  modules: [
    {
      key: 'webhooks',
      name: 'Webhooks',
      enabled,
      source: 'OVERRIDE',
      seatLimit: null,
      expiresAt: null,
    },
  ],
  limits: {},
});

describe('emitEvent entitlement enforcement', () => {
  let demo = false;
  const findOrganization = vi.fn(async () => ({ isDemo: demo }));
  const findMany = vi.fn();
  const createDelivery = vi.fn();
  const db = {
    organization: { findUnique: findOrganization },
    webhook: { findMany },
    webhookDelivery: { create: createDelivery },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    demo = false;
    vi.stubGlobal('fetch', vi.fn());
    createDelivery.mockResolvedValue({});
  });

  it('does no lookup, network call, or delivery write when webhooks are disabled', () => {
    emitEvent(db as never, entitlements(false), 'task.created', { taskId: 'task_1' });

    expect(findMany).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(createDelivery).not.toHaveBeenCalled();
  });

  it('keeps enabled dispatch behavior', async () => {
    findMany.mockResolvedValue([
      { id: 'webhook_1', url: 'https://example.com/hook', secret: 'secret' },
    ]);
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));

    emitEvent(db as never, entitlements(true), 'task.created', { taskId: 'task_1' });

    await vi.waitFor(() => expect(findMany).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(createDelivery).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('sinks enabled outbound webhooks for a demo organization', async () => {
    demo = true;
    emitEvent(db as never, entitlements(true), 'task.created', { taskId: 'task_1' });

    await vi.waitFor(() => expect(findOrganization).toHaveBeenCalledOnce());
    expect(findOrganization).toHaveBeenCalledWith({
      where: { id: 'org_1' },
      select: { isDemo: true },
    });
    expect(findMany).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(createDelivery).not.toHaveBeenCalled();
  });
});
