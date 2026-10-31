import { beforeEach, describe, expect, it, vi } from 'vitest';

const tenancy = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => tenancy);

import {
  deliverBackInStockNotification,
  reconcileRestockNotification,
  reviewRestockNotifications,
} from './back-in-stock-worker';
import {
  MockWhatsAppProvider,
  readWhatsAppConfig,
  WhatsAppProviderError,
} from './whatsapp/provider';

const scope = { organizationId: 'org-a', branchId: 'branch01' };
const now = new Date('2026-10-29');

function fixture() {
  const row = {
    id: 'notice01',
    interestId: 'interest01',
    channel: 'WHATSAPP',
    queuedAt: new Date('2026-10-28'),
    branchId: scope.branchId,
    destination: '923001234567',
    status: 'CAPTURED',
    interest: {
      id: 'interest01',
      patientId: 'patient01',
      createdAt: new Date('2026-10-20'),
      status: 'OPEN',
    },
  };
  let transactionOpen = false;
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'patient01' }]),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({
        name: 'Main Branch', addressLine: '10 Market Road', city: 'Lahore',
      }),
    },
    pharmacyRestockNotification: {
      findFirst: vi.fn().mockImplementation(async ({ where }) =>
        row.status === where.status ? row : null
      ),
      findMany: vi.fn().mockImplementation(async () => [{ ...row }]),
      updateMany: vi.fn().mockImplementation(async ({ where, data }) => {
        if (
          where.status !== row.status ||
          (where.interest && row.interest.status !== where.interest.status)
        )
          return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    patientConsent: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ granted: true, revokedAt: null, recordedAt: new Date('2026-10-01') }),
    },
    pharmacyCustomer: {
      findFirst: vi
        .fn()
        .mockResolvedValue({
          active: true,
          whatsappOptIn: true,
          patient: { phone: '03001234567' },
        }),
    },
    pharmacyRestockInterest: {
      updateMany: vi.fn().mockImplementation(async ({ where, data }) => {
        if (row.interest.status !== where.status) return { count: 0 };
        Object.assign(row.interest, data);
        return { count: 1 };
      }),
    },
  };
  tenancy.withTenantDb.mockImplementation(async (_org, run) => {
    transactionOpen = true;
    try {
      return await run(db);
    } finally {
      transactionOpen = false;
    }
  });
  const provider = new MockWhatsAppProvider(
    readWhatsAppConfig({ PHARMACY_WHATSAPP_TEMPLATE_BACK_IN_STOCK: 'stock_available_v1' })
  );
  provider.sendTemplate = vi.fn().mockImplementation(async () => {
    expect(transactionOpen).toBe(false);
    expect(row.status).toBe('PROCESSING');
    return { providerMessageId: 'wamid.1', acceptedByProvider: true };
  });
  return {
    row,
    db,
    provider,
    send: () => deliverBackInStockNotification(scope, row.id, { provider, now }),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('back-in-stock durable delivery worker', () => {
  it('cancels a notice that expires while queued and never claims or sends it', async () => {
    const f = fixture();
    f.row.interest.createdAt = new Date('2026-10-14T23:59:59.999Z');

    await expect(f.send()).resolves.toBe('SKIPPED');
    expect(f.row).toMatchObject({
      status: 'CANCELLED',
      cancelledAt: now,
      lastError: 'INTEREST_EXPIRED',
      interest: { status: 'OPEN' },
    });
    expect(f.db.pharmacyRestockNotification.updateMany).toHaveBeenCalledTimes(1);
    expect(f.provider.sendTemplate).not.toHaveBeenCalled();
    await expect(f.send()).resolves.toBe('SKIPPED');
    expect(f.provider.sendTemplate).not.toHaveBeenCalled();
  });

  it.each(['2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.001Z'])(
    'allows a request within the inclusive 14-day window (%s)',
    async (createdAt) => {
      const f = fixture();
      f.row.interest.createdAt = new Date(createdAt);

      await expect(f.send()).resolves.toBe('SENT');
      expect(f.provider.sendTemplate).toHaveBeenCalledTimes(1);
      expect(f.db.pharmacyRestockNotification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            interest: {
              status: 'OPEN',
              createdAt: { gte: new Date('2026-10-15T00:00:00.000Z') },
            },
          }),
          data: { status: 'PROCESSING', lastError: null },
        })
      );
    }
  );

  it('commits its claim before sending, records acknowledgement, and sends only once', async () => {
    const f = fixture();
    await expect(f.send()).resolves.toBe('SENT');
    expect(f.row).toMatchObject({
      status: 'SENT',
      providerMessageId: 'wamid.1',
      sentAt: now,
      interest: { status: 'NOTIFIED' },
    });
    expect(f.db.pharmacyRestockNotification.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ...scope, id: 'notice01', status: 'CAPTURED' },
      })
    );
    expect(f.db.pharmacyRestockInterest.updateMany).toHaveBeenCalledWith({
      where: { ...scope, id: 'interest01', status: 'OPEN' },
      data: { status: 'NOTIFIED' },
    });
    await expect(f.send()).resolves.toBe('SKIPPED');
    expect(f.provider.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it.each(['NOTIFIED', 'OPTED_OUT', 'RECOVERED'])(
    'does not send for an interest already %s',
    async (status) => {
      const f = fixture();
      f.row.interest.status = status;
      await expect(f.send()).resolves.toBe('SKIPPED');
      expect(f.provider.sendTemplate).not.toHaveBeenCalled();
    }
  );

  it.each([
    { granted: false, revokedAt: null },
    { granted: true, revokedAt: now },
    { granted: true, revokedAt: null, recordedAt: new Date('2099-01-01') },
    null,
  ])('cancels delivery without current reminders consent: %j', async (consent) => {
    const f = fixture();
    f.db.patientConsent.findFirst.mockResolvedValue(consent);
    await expect(f.send()).resolves.toBe('SKIPPED');
    expect(f.row.status).toBe('CANCELLED');
    expect(f.provider.sendTemplate).not.toHaveBeenCalled();
  });

  it.each([false, null])('respects WhatsApp STOP or absent opt-in (%s)', async (optIn) => {
    const f = fixture();
    f.db.pharmacyCustomer.findFirst.mockResolvedValue({
      active: true,
      whatsappOptIn: optIn,
      patient: { phone: '03001234567' },
    });
    await expect(f.send()).resolves.toBe('SKIPPED');
    expect(f.provider.sendTemplate).not.toHaveBeenCalled();
  });

  it('does not overwrite opt-out committed during a provider call', async () => {
    const f = fixture();
    f.provider.sendTemplate = vi.fn().mockImplementation(async () => {
      f.row.interest.status = 'OPTED_OUT';
      return { providerMessageId: 'ack', acceptedByProvider: true };
    });
    await expect(f.send()).resolves.toBe('SENT');
    expect(f.row.interest.status).toBe('OPTED_OUT');
  });

  it('retains the claim on an unknown provider outcome and never resends', async () => {
    const f = fixture();
    f.provider.sendTemplate = vi.fn().mockRejectedValue(new Error('private transport details'));
    await expect(f.send()).resolves.toBe('UNKNOWN');
    expect(f.row).toMatchObject({ status: 'PROCESSING', lastError: 'UNKNOWN_PROVIDER_OUTCOME' });
    await expect(f.send()).resolves.toBe('SKIPPED');
    expect(f.provider.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('audits definitive configuration failures', async () => {
    const f = fixture();
    f.provider.sendTemplate = vi
      .fn()
      .mockRejectedValue(new WhatsAppProviderError('TEMPLATE_NOT_CONFIGURED'));
    await expect(f.send()).resolves.toBe('FAILED');
    expect(f.row).toMatchObject({ status: 'FAILED', lastError: 'TEMPLATE_NOT_CONFIGURED' });
  });

  it('keeps a committed claim if persistence fails after acceptance', async () => {
    const f = fixture();
    const update = f.db.pharmacyRestockNotification.updateMany.getMockImplementation()!;
    f.db.pharmacyRestockNotification.updateMany.mockImplementation(async (args) => {
      if (args.data.status === 'SENT') throw new Error('database unavailable');
      return update(args);
    });
    await expect(f.send()).rejects.toThrow('database unavailable');
    expect(f.row.status).toBe('PROCESSING');
    await expect(f.send()).resolves.toBe('SKIPPED');
    expect(f.provider.sendTemplate).toHaveBeenCalledTimes(1);
  });
});

it('finishes unsupported SMS deliveries with an actionable outcome', async () => {
  const f = fixture();
  f.row.channel = 'SMS';
  await expect(f.send()).resolves.toBe('SKIPPED');
  expect(f.row).toMatchObject({ status: 'FAILED', lastError: 'UNSUPPORTED_CHANNEL' });
  expect(f.provider.sendTemplate).not.toHaveBeenCalled();
});

it('finishes notices owned by another configured Meta organization', async () => {
  const f = fixture();
  vi.stubEnv('PHARMACY_WHATSAPP_PROVIDER', 'meta');
  vi.stubEnv('PHARMACY_WHATSAPP_ORGANIZATION_ID', 'other-org');
  try {
    await expect(deliverBackInStockNotification(scope, f.row.id)).resolves.toBe('SKIPPED');
    expect(f.row).toMatchObject({ status: 'FAILED', lastError: 'PROVIDER_ORGANIZATION_MISMATCH' });
    expect(f.provider.sendTemplate).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('settles mock preparation without leaving a live delivery claim', async () => {
  const f = fixture();
  f.provider.sendTemplate = vi.fn().mockResolvedValue({
    providerMessageId: 'mock-1', acceptedByProvider: false,
  });
  await expect(f.send()).resolves.toBe('PREPARED');
  expect(f.row).toMatchObject({ status: 'FAILED', lastError: 'MOCK_PREPARED' });
  await expect(f.send()).resolves.toBe('SKIPPED');
  expect(f.provider.sendTemplate).toHaveBeenCalledTimes(1);
});

it('uses stored branch location in the customer message', async () => {
  const f = fixture();
  await f.send();
  expect(f.provider.sendTemplate).toHaveBeenCalledWith(
    expect.objectContaining({
      parameters: [
        expect.stringContaining('Main Branch, 10 Market Road, Lahore'),
        '2026-10-20',
        expect.stringMatching(/^R-/),
      ],
    })
  );
});

it('supports scoped reference lookup and operator review of unknown outcomes', async () => {
  const f = fixture();
  f.provider.sendTemplate = vi.fn().mockRejectedValue(new Error('unknown'));
  await f.send();
  const operatorScope = { ...scope, actorId: 'staff' };
  const queue = await reviewRestockNotifications(f.db as never, operatorScope);
  expect(queue).toMatchObject([
    { id: f.row.id, status: 'PROCESSING', lastError: 'UNKNOWN_PROVIDER_OUTCOME' },
  ]);
  await expect(
    reviewRestockNotifications(f.db as never, scope, queue[0].reference)
  ).resolves.toHaveLength(1);
  await expect(
    reviewRestockNotifications(f.db as never, scope, 'R-0000000')
  ).resolves.toEqual([]);
  expect(f.db.pharmacyRestockNotification.findMany).toHaveBeenLastCalledWith(
    expect.objectContaining({ where: scope })
  );
});

it.each(['SENT', 'FAILED'] as const)('reconciles an unknown delivery as %s without resending', async (outcome) => {
  const f = fixture();
  f.provider.sendTemplate = vi.fn().mockRejectedValue(new Error('unknown'));
  await f.send();
  await expect(reconcileRestockNotification(f.db as never, scope, {
    notificationId: f.row.id, outcome,
    ...(outcome === 'SENT' ? { sentAt: now, providerMessageId: 'confirmed-by-provider' } : {}),
  }, now)).resolves.toEqual({ count: 1 });
  expect(f.row.status).toBe(outcome);
  expect(f.row.interest.status).toBe(outcome === 'SENT' ? 'NOTIFIED' : 'OPEN');
  await expect(f.send()).resolves.toBe('SKIPPED');
  expect(f.provider.sendTemplate).toHaveBeenCalledTimes(1);
});

it.each([
  {},
  { sentAt: now },
  { sentAt: new Date('2026-10-01'), providerMessageId: 'ack' },
  { sentAt: new Date('2099-01-01'), providerMessageId: 'ack' },
  { sentAt: new Date('invalid'), providerMessageId: 'ack' },
])('requires valid provider evidence before reconciling as sent (%j)', async (evidence) => {
  const f = fixture();
  f.row.status = 'PROCESSING';
  await expect(reconcileRestockNotification(f.db as never, scope, {
    notificationId: f.row.id, outcome: 'SENT', ...evidence,
  }, now)).rejects.toThrow('valid provider acknowledgement');
  expect(f.db.pharmacyRestockNotification.updateMany).not.toHaveBeenCalled();
});

it('cannot reconcile a notice outside the tenant or branch scope', async () => {
  const f = fixture();
  f.db.pharmacyRestockNotification.findFirst.mockResolvedValue(null);
  await expect(reconcileRestockNotification(f.db as never, scope, {
    notificationId: 'other-notice', outcome: 'FAILED',
  }, now)).rejects.toThrow('not awaiting reconciliation');
  expect(f.db.pharmacyRestockNotification.findFirst).toHaveBeenCalledWith({
    where: { id: 'other-notice', ...scope, status: 'PROCESSING' },
  });
  expect(f.db.pharmacyRestockNotification.updateMany).not.toHaveBeenCalled();
});
