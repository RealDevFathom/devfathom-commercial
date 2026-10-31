import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  drain: vi.fn(),
  sendEmail: vi.fn(),
  deliver: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.transaction } }));
vi.mock('@/lib/side-effects/drain', () => ({ drainOrganization: mocks.drain }));
vi.mock('@/lib/email', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('@/lib/webhooks/safe-url', () => ({ deliverWebhookRequest: mocks.deliver }));

import { notify } from '@/lib/notifications';
import { emitEvent } from '@/lib/webhooks';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { issueHostedReceipt } from '@/lib/pharmacy/whatsapp/hosted-receipt';
import { persistHostedReceipt } from '@/lib/pharmacy/whatsapp/hosted-receipt-store';
import { queueHostedReceiptDelivery } from '@/lib/pharmacy/whatsapp/hosted-receipt-delivery';

const entitlements = {
  organizationId: 'org_1',
  seatLimit: 10,
  activeSeats: 1,
  enabledModules: ['webhooks'],
  modules: [],
  limits: {},
} as EntitlementView;

const recipient = {
  id: 'user_normal',
  name: 'Normal User',
  email: 'normal@example.test',
  status: 'ACTIVE',
  notificationPrefs: null,
  organization: { isDemo: false },
};

function client() {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    user: { findMany: vi.fn().mockResolvedValue([recipient]) },
    notification: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    outboundEffect: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    organization: { findUnique: vi.fn().mockResolvedValue({ isDemo: false }) },
    webhook: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: 'webhook_1', url: 'https://example.com/hook', secret: 'secret' },
        ]),
    },
  };
}

describe('tenant transaction side effects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.drain.mockResolvedValue(undefined);
    mocks.sendEmail.mockResolvedValue(undefined);
  });

  it('writes notification and webhook rows before commit and delivers after', async () => {
    const tx = client();
    mocks.transaction.mockImplementation(
      async (run: (inner: ReturnType<typeof client>) => Promise<unknown>) => run(tx)
    );

    await withTenantDb('org_1', async (db) => {
      notify(db, ['user_normal'], {
        type: 'task_assigned',
        title: 'Assigned',
        message: 'A task was assigned.',
        email: () => ({ subject: 'Assigned', html: '<p>hi</p>', text: 'hi' }),
      });
      emitEvent(db, entitlements, 'task.created', { taskId: 'task_1' });
      expect(mocks.sendEmail).not.toHaveBeenCalled();
      expect(mocks.deliver).not.toHaveBeenCalled();
      expect(mocks.drain).not.toHaveBeenCalled();
    });

    expect(tx.notification.createMany).toHaveBeenCalledOnce();
    expect(tx.outboundEffect.createMany).toHaveBeenCalledTimes(2);
    expect(tx.outboundEffect.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ kind: 'email', status: 'PENDING' })],
      })
    );
    expect(tx.outboundEffect.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            kind: 'webhook',
            status: 'PENDING',
            payload: expect.not.objectContaining({
              secret: expect.anything(),
              url: expect.anything(),
            }),
          }),
        ],
      })
    );
    const webhookWrite = tx.outboundEffect.createMany.mock.calls.find((call) =>
      JSON.stringify(call[0]).includes('"kind":"webhook"')
    );
    expect(webhookWrite?.[0].data[0].payload).toMatchObject({ webhookId: 'webhook_1' });
    expect(webhookWrite?.[0].data[0].payload).not.toHaveProperty('secret');
    expect(webhookWrite?.[0].data[0].payload).not.toHaveProperty('url');
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.drain).toHaveBeenCalledWith('org_1');
  });

  it('does not deliver when the transaction throws', async () => {
    const tx = client();
    mocks.transaction.mockImplementation(
      async (run: (inner: ReturnType<typeof client>) => Promise<unknown>) => run(tx)
    );

    await expect(
      withTenantDb('org_1', async (db) => {
        notify(db, ['user_normal'], {
          type: 'task_assigned',
          title: 'Assigned',
          message: 'A task was assigned.',
        });
        throw new Error('rolled back');
      })
    ).rejects.toThrow('rolled back');

    expect(mocks.drain).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('rolls the transaction back when the outbox write fails', async () => {
    const tx = client();
    tx.outboundEffect.createMany.mockRejectedValue(new Error('disk full'));
    mocks.transaction.mockImplementation(
      async (run: (inner: ReturnType<typeof client>) => Promise<unknown>) => run(tx)
    );

    await expect(
      withTenantDb('org_1', async (db) => {
        notify(db, ['user_normal'], {
          type: 'task_assigned',
          title: 'Assigned',
          message: 'A task was assigned.',
          email: () => ({ subject: 'Assigned', html: '<p>hi</p>', text: 'hi' }),
        });
      })
    ).rejects.toThrow('disk full');

    expect(mocks.drain).not.toHaveBeenCalled();
  });

  it.each(['commit', 'sibling failure', 'outbox failure'])(
    'commits hosted receipt and delivery intent together: %s',
    async (scenario) => {
      const secret = 'test-hosted-receipt-secret-at-least-32-characters';
      const issued = issueHostedReceipt({
        organizationId: 'org_1', branchId: 'branch_1', saleId: 'sale_1', actorId: 'actor_1',
        consent: 'CUSTOMER_REQUEST', consentedAt: new Date().toISOString(), version: 1,
        branch: 'Gulberg', receiptNumber: '42', total: 'PKR 10.00', paymentMethod: 'CASH',
        rx: false, expiryDays: 30,
      }, secret);
      const staged: string[] = [];
      const committed: string[] = [];
      const events: string[] = [];
      const tx = {
        $queryRawUnsafe: vi.fn(async () => []),
        pharmacyHostedReceipt: {
          create: vi.fn(async () => { staged.push('receipt'); return { id: 'hosted_1' }; }),
        },
        outboundEffect: {
          create: vi.fn(async (args: { data: { payload: unknown } }) => {
            expect(staged).toEqual(['receipt']);
            expect(JSON.stringify(args.data.payload)).not.toContain(issued.token);
            expect(JSON.stringify(args.data.payload)).not.toContain('923001234567');
            if (scenario === 'outbox failure') throw new Error('outbox failed');
            staged.push('delivery intent');
            return { id: 'effect_1' };
          }),
        },
      };
      mocks.transaction.mockImplementation(async (run: (db: typeof tx) => Promise<unknown>) => {
        const result = await run(tx);
        committed.push(...staged);
        events.push('commit');
        return result;
      });
      mocks.drain.mockImplementation(async () => { events.push('deliver'); });
      const request = withTenantDb('org_1', async (db) => {
        await db.$transaction(async (inner) => {
          const recordId = await persistHostedReceipt(inner as typeof db, issued.token, issued.receipt);
          await queueHostedReceiptDelivery(inner as typeof db, {
            organizationId: 'org_1', recordId, token: issued.token,
            phone: '923001234567', message: 'neutral receipt message',
          }, secret);
        });
        expect(mocks.drain).not.toHaveBeenCalled();
        if (scenario === 'sibling failure') throw new Error('sibling mutation failed');
      });
      if (scenario === 'commit') {
        await request;
        expect(committed).toEqual(['receipt', 'delivery intent']);
        expect(events).toEqual(['commit', 'deliver']);
      } else {
        await expect(request).rejects.toThrow(/failed/);
        expect(committed).toEqual([]);
        expect(mocks.drain).not.toHaveBeenCalled();
      }
    }
  );
});
