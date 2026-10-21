import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

const mocks = vi.hoisted(() => ({ deliver: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (entitlements: EntitlementView, key: string) =>
    entitlements.enabledModules.includes(key),
}));
vi.mock('@/lib/webhooks/safe-url', () => ({
  deliverWebhookRequest: mocks.deliver,
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
  const updateDelivery = vi.fn();
  const db = {
    organization: { findUnique: findOrganization },
    webhook: { findMany },
    webhookDelivery: { create: createDelivery, update: updateDelivery },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    demo = false;
    mocks.deliver.mockResolvedValue({ statusCode: 200, success: true, error: null });
    createDelivery.mockResolvedValue({ id: 'delivery_1' });
    updateDelivery.mockResolvedValue({});
  });

  it('does no lookup, network call, or delivery write when webhooks are disabled', () => {
    emitEvent(db as never, entitlements(false), 'task.created', { taskId: 'task_1' });

    expect(findMany).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(createDelivery).not.toHaveBeenCalled();
  });

  it('keeps enabled dispatch behavior', async () => {
    findMany.mockResolvedValue([
      { id: 'webhook_1', url: 'https://example.com/hook', secret: 'secret' },
    ]);

    emitEvent(db as never, entitlements(true), 'task.created', { taskId: 'task_1' });

    await vi.waitFor(() => expect(findMany).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mocks.deliver).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(createDelivery).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(updateDelivery).toHaveBeenCalledOnce());
    expect(createDelivery.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deliver.mock.invocationCallOrder[0]
    );
    expect(mocks.deliver).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({
        body: expect.any(String),
        timeoutMs: 5_000,
        headers: expect.objectContaining({
          'X-DevFathom-Delivery-Id': 'delivery_1',
        }),
      })
    );
    expect(updateDelivery).toHaveBeenCalledWith({
      where: { id: 'delivery_1' },
      data: { statusCode: 200, success: true, error: null },
    });
  });

  it('stores the sanitized delivery error, not the poster exception', async () => {
    findMany.mockResolvedValue([
      { id: 'webhook_1', url: 'https://example.com/hook', secret: 'secret' },
    ]);
    mocks.deliver.mockResolvedValue({
      statusCode: null,
      success: false,
      error: 'Delivery failed',
    });

    emitEvent(db as never, entitlements(true), 'task.created', { taskId: 'task_1' });

    await vi.waitFor(() => expect(updateDelivery).toHaveBeenCalledOnce());
    expect(updateDelivery.mock.calls[0]?.[0].data.error).toBe('Delivery failed');
    expect(mocks.deliver.mock.calls[0]?.[1].headers['X-DevFathom-Delivery-Id']).toBe('delivery_1');
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
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(createDelivery).not.toHaveBeenCalled();
  });
});
