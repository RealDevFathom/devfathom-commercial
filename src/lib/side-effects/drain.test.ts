import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  deliver: vi.fn(),
  restock: vi.fn(),
}));

vi.mock('@/lib/pharmacy/back-in-stock-worker', () => ({
  deliverBackInStockNotification: mocks.restock,
}));

vi.mock('@/lib/email', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('@/lib/webhooks/safe-url', () => ({
  deliverWebhookRequest: mocks.deliver,
}));

import {
  CLAIM_SQL,
  DELIVERED_RETENTION_MS,
  DRAIN_ORG_LIMIT,
  DRAIN_TIME_BUDGET_MS,
  DUE_ORGANIZATIONS_SQL,
  MAX_ATTEMPTS,
  SCRUB_DEAD_EMAIL_SQL,
  STALE_CLAIM_MS,
  claimEffects,
  drainDueOrganizations,
  failureDisposition,
  listDueOrganizationIds,
  recordOutcome,
  retainDelivered,
  requeueStale,
  runEffect,
  scrubDeadEmailPayload,
} from './drain';

const tenancy = vi.hoisted(() => ({
  withPlatformDb: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock('@/lib/tenancy/scoped-db', () => tenancy);

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
    const cutoff = new Date(now - DELIVERED_RETENTION_MS);
    expect(deleteMany).toHaveBeenNthCalledWith(1, {
      where: { status: 'DONE', updatedAt: { lt: cutoff } },
    });
    expect(deleteMany).toHaveBeenNthCalledWith(2, {
      where: { status: 'DEAD', updatedAt: { lt: cutoff } },
    });
    expect(deleteMany).toHaveBeenNthCalledWith(3, {
      where: { status: 'FAILED', updatedAt: { lt: cutoff } },
    });
  });

  it('scrubs the recipient email, name, and HTML when an email is dead-lettered', async () => {
    const now = Date.parse('2026-10-21T00:00:00Z');
    const update = vi.fn(async () => ({}));
    const payload = {
      to: { email: 'person@example.com', name: 'Person' },
      subject: 'Assigned',
      html: '<p>secret</p>',
      text: 'hi',
    };
    await recordOutcome(
      { outboundEffect: { update } } as never,
      { id: 'effect_email_dead', attempts: MAX_ATTEMPTS, kind: 'email', payload },
      { ok: false, error: 'Delivery failed' },
      now
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: 'effect_email_dead' },
      data: {
        status: 'DEAD',
        lastError: 'Delivery failed',
        availableAt: new Date(now),
        payload: scrubDeadEmailPayload(payload),
      },
    });
    expect(JSON.stringify(scrubDeadEmailPayload(payload))).not.toMatch(
      /person@example.com|Person|<p>secret<\/p>/
    );
  });

  it('returns a stale claim to the queue until the attempt cap', async () => {
    const now = Date.parse('2026-10-21T00:00:00Z');
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const execute = vi.fn(async () => 0);
    await requeueStale(
      { outboundEffect: { updateMany }, $executeRawUnsafe: execute } as never,
      now
    );
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        status: 'PROCESSING',
        updatedAt: { lt: new Date(now - STALE_CLAIM_MS) },
        attempts: { gte: MAX_ATTEMPTS },
      },
      data: { status: 'DEAD' },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        status: 'PROCESSING',
        updatedAt: { lt: new Date(now - STALE_CLAIM_MS) },
        attempts: { lt: MAX_ATTEMPTS },
      },
      data: { status: 'PENDING', availableAt: new Date(now) },
    });
    expect(STALE_CLAIM_MS).toBe(5 * 60 * 1000);
    expect(execute).toHaveBeenCalledWith(SCRUB_DEAD_EMAIL_SQL);
  });

  it('lists due organizations and drains each one under tenant scope', async () => {
    const query = vi.fn(async () => [{ organizationId: 'org_a' }, { organizationId: 'org_b' }]);
    await expect(listDueOrganizationIds(query)).resolves.toEqual(['org_a', 'org_b']);
    expect(query).toHaveBeenCalledWith(DUE_ORGANIZATIONS_SQL, STALE_CLAIM_MS, DRAIN_ORG_LIMIT);
    expect(DRAIN_ORG_LIMIT).toBe(50);
    expect(DUE_ORGANIZATIONS_SQL).toContain('LIMIT $2');
    expect(DUE_ORGANIZATIONS_SQL).toContain('ORDER BY MIN("createdAt")');
    expect(DUE_ORGANIZATIONS_SQL).toContain(`status = 'PENDING'`);
    expect(DUE_ORGANIZATIONS_SQL).toContain(`status = 'PROCESSING'`);

    tenancy.withPlatformDb.mockImplementation(async (run: (db: unknown) => Promise<unknown>) =>
      run({ $queryRawUnsafe: query })
    );
    tenancy.withTenantDb.mockImplementation(
      async (_org: string, run: (db: unknown) => Promise<unknown>) =>
        run({
          outboundEffect: {
            updateMany: async () => ({ count: 0 }),
            deleteMany: async () => ({ count: 0 }),
          },
          $executeRawUnsafe: async () => 0,
          $queryRawUnsafe: async () => [],
        })
    );
    await expect(drainDueOrganizations()).resolves.toEqual({ organizations: 2 });
    expect(tenancy.withTenantDb).toHaveBeenCalledWith(
      'org_a',
      expect.any(Function),
      expect.objectContaining({ skipDrain: true })
    );
    expect(tenancy.withTenantDb).toHaveBeenCalledWith(
      'org_b',
      expect.any(Function),
      expect.objectContaining({ skipDrain: true })
    );
  });

  it('stops before the next organization once the time budget is spent', async () => {
    const seen: string[] = [];
    let clock = 1_000;
    tenancy.withPlatformDb.mockImplementation(async (run: (db: unknown) => Promise<unknown>) =>
      run({
        $queryRawUnsafe: async () => [
          { organizationId: 'org_a' },
          { organizationId: 'org_b' },
          { organizationId: 'org_c' },
        ],
      })
    );
    tenancy.withTenantDb.mockImplementation(
      async (organizationId: string, run: (db: unknown) => Promise<unknown>) => {
        seen.push(organizationId);
        clock += DRAIN_TIME_BUDGET_MS;
        return run({
          outboundEffect: {
            updateMany: async () => ({ count: 0 }),
            deleteMany: async () => ({ count: 0 }),
          },
          $executeRawUnsafe: async () => 0,
          $queryRawUnsafe: async () => [],
        });
      }
    );
    await expect(
      drainDueOrganizations({ now: () => clock, budgetMs: DRAIN_TIME_BUDGET_MS })
    ).resolves.toEqual({ organizations: 1 });
    expect(seen).toEqual(['org_a']);
    expect(DRAIN_TIME_BUDGET_MS).toBe(240_000);
  });
});

it('dispatches a restock notice with the trusted outbox tenant, ignoring payload tenant IDs', async () => {
  mocks.restock.mockResolvedValue('UNKNOWN');
  await expect(
    runEffect(
      {
        id: 'effect_1',
        kind: 'pharmacy-back-in-stock',
        payload: { organizationId: 'untrusted', branchId: 'branch_1', notificationId: 'notice_1' },
      },
      undefined,
      'org_1'
    )
  ).resolves.toEqual({ ok: true, error: null });
  expect(mocks.restock).toHaveBeenCalledWith(
    { organizationId: 'org_1', branchId: 'branch_1' },
    'notice_1'
  );
});

it('rejects restock delivery without a trusted tenant', async () => {
  mocks.restock.mockClear();
  await expect(
    runEffect({
      id: 'effect_1',
      kind: 'pharmacy-back-in-stock',
      payload: { organizationId: 'untrusted', branchId: 'branch_1', notificationId: 'notice_1' },
    })
  ).resolves.toEqual({ ok: false, error: 'Delivery failed' });
  expect(mocks.restock).not.toHaveBeenCalled();
});
