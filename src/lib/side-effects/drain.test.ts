import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  deliver: vi.fn(),
}));

vi.mock('@/lib/email', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('@/lib/webhooks/safe-url', () => ({
  deliverWebhookRequest: mocks.deliver,
}));

import { runEffect } from './drain';

describe('outbound effect delivery', () => {
  it('sends a committed email outside the transaction', async () => {
    mocks.sendEmail.mockResolvedValue({ messageId: 'msg_1' });
    const outcome = await runEffect({
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
    const outcome = await runEffect({
      kind: 'webhook',
      payload: {
        webhookId: 'webhook_1',
        url: 'https://example.com/hook',
        secret: 'secret',
        event: 'task.created',
        body: '{"event":"task.created"}',
        payload: { taskId: 'task_1' },
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('Delivery failed');
    expect(outcome.delivery).toMatchObject({
      webhookId: 'webhook_1',
      success: false,
      error: 'Delivery failed',
    });
    expect(JSON.stringify(outcome)).not.toMatch(/ECONNREFUSED|169\.254/);
  });
});
