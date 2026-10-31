import { beforeEach, describe, expect, it, vi } from 'vitest';

const tenancy = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => tenancy);

import { deliverBackInStockNotification } from './back-in-stock-worker';
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
    pharmacyRestockNotification: {
      findFirst: vi.fn().mockImplementation(async () => (row.status === 'CAPTURED' ? row : null)),
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
        where: { ...scope, id: 'notice01', status: 'CAPTURED', channel: 'WHATSAPP' },
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
