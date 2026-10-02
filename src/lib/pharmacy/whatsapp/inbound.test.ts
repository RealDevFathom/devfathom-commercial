import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown> & { id: string };

const store = vi.hoisted(() => ({
  customers: [] as Row[],
  logs: [] as Row[],
  catalog: [] as Row[],
  placed: [] as unknown[],
}));

vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    pharmacyCustomer: {
      findMany: async () =>
        store.customers.map((customer) => ({ ...customer, patient: { phone: customer.phone } })),
      update: async ({ where, data }: { where: { id: string }; data: object }) =>
        Object.assign(
          store.customers.find((customer) => customer.id === where.id)!,
          data
        ),
    },
    pharmacyCustomerOrder: { findFirst: async () => null },
    pharmacyBranch: { findMany: async () => [{ id: 'branch-1', name: 'Gulberg' }] },
    pharmacyMessageLog: {
      createManyAndReturn: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        const row = data[0]!;
        if (store.logs.some((log) => log.dedupeKey === row.dedupeKey)) return [];
        const created = { ...row, id: `log-${store.logs.length + 1}` };
        store.logs.push(created);
        return [{ id: created.id }];
      },
      update: async ({ where, data }: { where: { id: string }; data: object }) =>
        Object.assign(
          store.logs.find((log) => log.id === where.id)!,
          data
        ),
    },
  };
  return { withTenantDb: (_organizationId: string, run: (tx: unknown) => unknown) => run(db) };
});

vi.mock('@/lib/pharmacy/customer-ordering', () => ({
  PharmacyCustomerOrderError: class extends Error {},
  listStorefrontCatalog: async () => store.catalog,
  placeCustomerOrder: async (_db: unknown, scope: unknown, input: unknown) => {
    store.placed.push({ scope, input });
    return { id: 'order_abc123' };
  },
}));

import { handleInboundWhatsAppMessage } from './inbound';
import { MockWhatsAppProvider, readWhatsAppConfig } from './provider';

const FROM = '923001234567';
let sequence = 0;

function message(text: string, from = FROM) {
  sequence += 1;
  return {
    providerMessageId: `wamid.${sequence}`,
    from,
    text,
    receivedAt: new Date(),
    phoneNumberId: null,
  };
}

function knownCustomer(whatsappOptIn: boolean | null) {
  store.customers = [
    {
      id: 'customer-1',
      userId: 'user-1',
      active: true,
      whatsappOptIn,
      phone: '0300-1234567',
    },
  ];
}

let provider: MockWhatsAppProvider;

beforeEach(() => {
  store.customers = [];
  store.logs = [];
  store.placed = [];
  store.catalog = [
    {
      id: 'row',
      medicineId: 'medicine-1',
      productName: 'Panadol',
      presentationId: 'presentation-1',
      packLevelId: 'pack-1',
      availablePacks: 10,
    },
  ];
  provider = new MockWhatsAppProvider(readWhatsAppConfig({}));
});

describe('handleInboundWhatsAppMessage consent gate', () => {
  it('places an order and confirms for a consented, known customer', async () => {
    knownCustomer(true);
    await expect(
      handleInboundWhatsAppMessage('org_a', provider, message('Panadol 2 packs'))
    ).resolves.toBe('ORDER_PLACED');
    expect(store.placed).toEqual([
      {
        scope: { organizationId: 'org_a', branchId: 'branch-1', actorId: 'user-1' },
        input: expect.objectContaining({
          staff: false,
          fulfillment: 'COLLECT',
          lines: [expect.objectContaining({ medicineId: 'medicine-1', quantity: 2 })],
        }),
      },
    ]);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({ kind: 'text', to: FROM });
    expect(store.logs.map((log) => [log.kind, log.status])).toEqual([
      ['ORDER_REQUEST', 'RECEIVED'],
      ['ORDER_CONFIRMATION', 'SENT'],
    ]);
  });

  it('falls back to a pharmacist call when the message cannot be matched', async () => {
    knownCustomer(true);
    await expect(
      handleInboundWhatsAppMessage('org_a', provider, message('پیناڈول کی ۲ گولیاں'))
    ).resolves.toBe('PHARMACIST_CALLBACK');
    expect(store.placed).toEqual([]);
    expect(provider.calls).toEqual([
      expect.objectContaining({ body: expect.stringContaining('A pharmacist will call you') }),
    ]);
  });

  it.each([null, false])('never messages or orders for opt-in %s', async (optIn) => {
    knownCustomer(optIn);
    await expect(
      handleInboundWhatsAppMessage('org_a', provider, message('Panadol 2 packs'))
    ).resolves.toBe('NO_CONSENT');
    expect(provider.calls).toEqual([]);
    expect(store.placed).toEqual([]);
    expect(store.logs[0]).toMatchObject({ status: 'IGNORED' });
  });

  it('ignores unknown senders without replying', async () => {
    knownCustomer(true);
    await expect(
      handleInboundWhatsAppMessage('org_a', provider, message('Panadol 2 packs', '923009999999'))
    ).resolves.toBe('UNKNOWN_SENDER');
    expect(provider.calls).toEqual([]);
  });

  it('STOP opts the customer out and later orders are not answered', async () => {
    knownCustomer(true);
    await expect(handleInboundWhatsAppMessage('org_a', provider, message('STOP'))).resolves.toBe(
      'OPTED_OUT'
    );
    expect(store.customers[0]).toMatchObject({ whatsappOptIn: false });
    expect(provider.calls).toHaveLength(1);
    await expect(
      handleInboundWhatsAppMessage('org_a', provider, message('Panadol 2 packs'))
    ).resolves.toBe('NO_CONSENT');
    expect(provider.calls).toHaveLength(1);
  });

  it('Urdu STOP and START toggle the flag', async () => {
    knownCustomer(null);
    await handleInboundWhatsAppMessage('org_a', provider, message('بند کریں'));
    expect(store.customers[0]).toMatchObject({ whatsappOptIn: false });
    await handleInboundWhatsAppMessage('org_a', provider, message('START'));
    expect(store.customers[0]).toMatchObject({ whatsappOptIn: true });
  });

  it('processes a retried webhook message only once', async () => {
    knownCustomer(true);
    const retried = message('Panadol 2 packs');
    await handleInboundWhatsAppMessage('org_a', provider, retried);
    await expect(handleInboundWhatsAppMessage('org_a', provider, retried)).resolves.toBe(
      'DUPLICATE'
    );
    expect(store.placed).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
  });
});
