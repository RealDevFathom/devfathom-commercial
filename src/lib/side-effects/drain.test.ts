import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  deliver: vi.fn(),
}));

vi.mock('@/lib/email', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('@/lib/webhooks/safe-url', () => ({
  deliverWebhookRequest: mocks.deliver,
}));

import {
  CLAIM_SQL,
  DELIVERED_RETENTION_MS,
  MAX_ATTEMPTS,
  claimEffects,
  failureDisposition,
  recordOutcome,
  retainDelivered,
  requeueStale,
  runEffect,
} from './drain';

describe('outbound effect delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a committed email outside the transaction', async () => {
    mocks.sendEmail.mockResolvedValue({ messageId: 'msg_1' });
    const outcome = await runEffect({
      id: 'effect_email',
      kind: 'email',
      payload: {
        to: { email: 'normal@example.test', name: 'Normal' },
        subject: 'Assigned',
        html: '<p>hi</p>',
        text: 'hi',
      },
    });
    expect(outcome).toEqual({ ok: true, error: null });
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: { email: 'normal@example.test', name: 'Normal' } })
    );
  });

  it('records a sanitized webhook failure and does not keep the socket error', async () => {
    mocks.deliver.mockResolvedValue({
      statusCode: null,
      success: false,
      error: 'Delivery failed',
    });
    const body = '{"event":"task.created"}';
    const outcome = await runEffect(
      {
        id: 'effect_1',
        kind: 'webhook',
        payload: {
          webhookId: 'webhook_1',
          url: 'https://stale.example/hook',
          secret: 'stored-secret',
          event: 'task.created',
          body,
          payload: { taskId: 'task_1' },
        },
      },
      async () => ({ url: 'https://example.com/hook', secret: 'live-secret', active: true })
    );
    const signature = createHmac('sha256', 'live-secret').update(body).digest('hex');
    expect(mocks.deliver).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-DevFathom-Delivery-Id': 'effect_1',
          'X-DevFathom-Signature': `sha256=${signature}`,
        }),
      })
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('Delivery failed');
    expect(outcome.delivery).toMatchObject({
      webhookId: 'webhook_1',
      success: false,
      error: 'Delivery failed',
    });
    expect(JSON.stringify(outcome)).not.toMatch(/ECONNREFUSED|169\.254|stored-secret|live-secret/);
  });

  it('does not send when the webhook can no longer be loaded', async () => {
    const outcome = await runEffect(
      {
        id: 'effect_2',
        kind: 'webhook',
        payload: {
          webhookId: 'webhook_gone',
          secret: 'stored-secret',
          event: 'task.created',
          body: '{}',
        },
      },
      async () => null
    );
    expect(outcome).toMatchObject({ ok: false, error: 'Delivery failed' });
    expect(mocks.deliver).not.toHaveBeenCalled();
  });
});

describe('outbound effect worker', () => {
  it('claims with FOR UPDATE SKIP LOCKED', async () => {
    const query = vi.fn(async () => [{ id: 'effect_1', kind: 'email', payload: {}, attempts: 1 }]);
    await expect(claimEffects({ $queryRawUnsafe: query } as never)).resolves.toEqual([
      { id: 'effect_1', kind: 'email', payload: {}, attempts: 1 },
    ]);
    expect(query).toHaveBeenCalledWith(CLAIM_SQL, 25);
    expect(CLAIM_SQL).toContain('FOR UPDATE SKIP LOCKED');
    expect(CLAIM_SQL).toContain('"availableAt" <= NOW()');
  });

  it('backs off and then dead-letters', () => {
    const now = Date.parse('2026-10-21T00:00:00Z');
    expect(failureDisposition(1, now)).toEqual({
      status: 'PENDING',
      availableAt: new Date(now + 30_000),
    });
    expect(failureDisposition(2, now).availableAt).toEqual(new Date(now + 60_000));
    expect(failureDisposition(MAX_ATTEMPTS - 1, now).status).toBe('PENDING');
    expect(failureDisposition(MAX_ATTEMPTS, now)).toEqual({
      status: 'DEAD',
      availableAt: new Date(now),
    });
  });

  it('records a retry, a dead letter, and drops delivered rows past retention', async () => {
    const now = Date.parse('2026-10-21T00:00:00Z');
    const update = vi.fn(async () => ({}));
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const db = { outboundEffect: { update, deleteMany } };

    await recordOutcome(
      db as never,
      { id: 'effect_retry', attempts: 2 },
      { ok: false, error: 'Delivery failed' },
      now
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: 'effect_retry' },
      data: {
        status: 'PENDING',
        lastError: 'Delivery failed',
        availableAt: new Date(now + 60_000),
      },
    });

    await recordOutcome(
      db as never,
      { id: 'effect_dead', attempts: MAX_ATTEMPTS },
      { ok: false, error: 'Delivery failed' },
      now
    );
    expect(update).toHaveBeenLastCalledWith({
      where: { id: 'effect_dead' },
      data: { status: 'DEAD', lastError: 'Delivery failed', availableAt: new Date(now) },
    });

    await retainDelivered(db as never, now);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { status: 'DONE', updatedAt: { lt: new Date(now - DELIVERED_RETENTION_MS) } },
    });
  });

  it('returns a stale claim to the queue until the attempt cap', async () => {
    const now = Date.parse('2026-10-21T00:00:00Z');
    const updateMany = vi.fn(async () => ({ count: 1 }));
    await requeueStale({ outboundEffect: { updateMany } } as never, now);
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        status: 'PROCESSING',
        updatedAt: { lt: new Date(now - 2 * 60 * 1000) },
        attempts: { gte: MAX_ATTEMPTS },
      },
      data: { status: 'DEAD' },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        status: 'PROCESSING',
        updatedAt: { lt: new Date(now - 2 * 60 * 1000) },
        attempts: { lt: MAX_ATTEMPTS },
      },
      data: { status: 'PENDING', availableAt: new Date(now) },
    });
  });
});
