import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown> & { id: string };

const store = vi.hoisted(() => ({
  customers: [] as Row[],
  logs: [] as Row[],
  consents: [] as Row[],
  catalog: [] as Row[],
  placed: [] as unknown[],
  failConsent: false,
  failCommit: false,
  failOrder: false,
}));

vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    $queryRaw: async () => [{ id: 'patient-a', patientId: 'patient-a' }],
    pharmacyCustomer: {
      findFirst: async () => ({
        ...store.customers[0],
        patientId: 'patient-a',
        patient: { dateOfBirth: null },
      }),
      findMany: async () =>
        store.customers.map((customer) => ({
          ...customer,
          patientId: 'patient-a',
          patient: { phone: customer.phone },
        })),
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          organizationId: string;
          id: string;
          OR: Array<{ whatsappOptInChangedAt: null | Date | { lt: Date } }>;
        };
        data: object;
      }) => {
        if (store.failConsent) throw new Error('consent write failed');
        const customer = store.customers.find(
          (row) => row.id === where.id && row.organizationId === where.organizationId
        );
        if (!customer) return { count: 0 };
        const previous = customer.whatsappOptInChangedAt as Date | null;
        const eligible = where.OR.some(({ whatsappOptInChangedAt: condition }) =>
          condition === null
            ? previous == null
            : previous != null &&
              (condition instanceof Date
                ? previous.getTime() === condition.getTime()
                : previous < condition.lt)
        );
        if (eligible) Object.assign(customer, data);
        return { count: Number(eligible) };
      },
    },
    patientConsent: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        store.consents
          .filter((row) => Object.entries(where).every(([key, value]) => row[key] === value))
          .sort((a, b) => Number(b.version) - Number(a.version))[0] ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `consent-${store.consents.length + 1}`, ...data } as Row;
        store.consents.push(row);
        return row;
      },
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
  return {
    withTenantDb: async (_organizationId: string, run: (tx: unknown) => unknown) => {
      const customers = store.customers.map((row) => ({ ...row }));
      const logs = store.logs.map((row) => ({ ...row }));
      const consents = store.consents.map((row) => ({ ...row }));
      const placed = [...store.placed];
      try {
        const result = await run(db);
        if (store.failCommit) throw new Error('transaction commit failed');
        return result;
      } catch (error) {
        store.customers = customers;
        store.logs = logs;
        store.consents = consents;
        store.placed = placed;
        throw error;
      }
    },
  };
});

vi.mock('@/lib/pharmacy/customer-ordering', () => ({
  PharmacyCustomerOrderError: class extends Error {},
  listStorefrontCatalog: async () => store.catalog,
  placeCustomerOrder: async (_db: unknown, scope: unknown, input: unknown) => {
    if (store.failOrder) throw new Error('transient order failure');
    store.placed.push({ scope, input });
    return { id: 'order_abc123' };
  },
}));

import { handleInboundWhatsAppMessage } from './inbound';
import { MockWhatsAppProvider, readWhatsAppConfig } from './provider';
import { marketingConsent } from '../marketing-service';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

const FROM = '923001234567';
let sequence = 0;

function message(text: string, from = FROM) {
  sequence += 1;
  return {
    providerMessageId: `wamid.${sequence}`,
    from,
    text,
    receivedAt: new Date(Date.UTC(2026, 9, 6, 12, 0, sequence)),
    phoneNumberId: null,
  };
}

function knownCustomer(whatsappOptIn: boolean | null) {
  store.customers = [
    {
      id: 'customer-1',
      organizationId: 'org_a',
      userId: 'user-1',
      active: true,
      whatsappOptIn,
      whatsappOptInChangedAt: null,
      phone: '0300-1234567',
    },
  ];
}

let provider: MockWhatsAppProvider;

function recordedConsent(
  purpose: 'MARKETING' | 'REMINDERS',
  granted: boolean,
  recordedAt: Date,
  source: 'COUNTER_TABLET' | 'QR' = 'COUNTER_TABLET'
) {
  return {
    id: 'existing-consent',
    organizationId: 'org_a',
    patientId: 'patient-a',
    purpose,
    channel: 'WHATSAPP',
    version: 1,
    granted,
    revokedAt: granted ? null : recordedAt,
    recordedAt,
    source,
  };
}

function marketingEligibility() {
  return withTenantDb('org_a', (db) =>
    marketingConsent(
      db,
      { organizationId: 'org_a', branchId: 'branch-1', actorId: 'staff-1', timezone: 'UTC' },
      'customer-1',
      new Date()
    )
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-06T13:00:00Z'));
  store.customers = [];
  store.logs = [];
  store.consents = [];
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
  store.failConsent = false;
  store.failCommit = false;
  store.failOrder = false;
  provider = new MockWhatsAppProvider(readWhatsAppConfig({}));
});
afterEach(() => vi.useRealTimers());

describe('handleInboundWhatsAppMessage consent gate', () => {
  it('START enables utility replies without granting marketing consent', async () => {
    knownCustomer(false);
    const utility = recordedConsent('REMINDERS', true, new Date('2026-10-06T09:00:00Z'));
    store.consents = [utility];
    await expect(handleInboundWhatsAppMessage('org_a', provider, message('START'))).resolves.toBe(
      'OPTED_IN'
    );
    expect(store.customers[0].whatsappOptIn).toBe(true);
    expect(store.consents).toEqual([utility]);
    expect(await marketingEligibility()).toBe('NO_CONSENT');
    await expect(
      handleInboundWhatsAppMessage('org_a', provider, message('Panadol 2 packs'))
    ).resolves.toBe('ORDER_PLACED');
  });

  it.each(['COUNTER_TABLET', 'QR'] as const)(
    'START never supersedes a separate %s marketing refusal, regardless of delivery time',
    async (source) => {
      knownCustomer(false);
      const refusal = recordedConsent('MARKETING', false, new Date('2026-10-06T11:00:00Z'), source);
      store.consents = [refusal];
      for (const timestamp of ['2026-10-06T10:00:00Z', '2026-10-06T12:00:00Z']) {
        const start = { ...message('START'), receivedAt: new Date(timestamp) };
        await expect(handleInboundWhatsAppMessage('org_a', provider, start)).resolves.toBe(
          'OPTED_IN'
        );
        expect(store.consents).toEqual([refusal]);
        expect(await marketingEligibility()).toBe('OPTED_OUT');
      }
    }
  );

  it.each(['COUNTER_TABLET', 'QR'] as const)(
    'delayed STOP does not supersede newer %s marketing consent',
    async (source) => {
      knownCustomer(true);
      const grant = recordedConsent('MARKETING', true, new Date('2026-10-06T11:00:00Z'), source);
      store.consents = [grant];
      const stop = { ...message('STOP'), receivedAt: new Date('2026-10-06T10:00:00Z') };
      await expect(handleInboundWhatsAppMessage('org_a', provider, stop)).resolves.toBe(
        'OPTED_OUT'
      );
      expect(store.customers[0].whatsappOptIn).toBe(false);
      expect(store.consents).toEqual([grant]);
      expect(await marketingEligibility()).toBe('OPTED_OUT');
    }
  );

  it('STOP revokes marketing consent at an equal timestamp without changing utility consent', async () => {
    knownCustomer(true);
    const stop = message('STOP');
    const grant = recordedConsent('MARKETING', true, stop.receivedAt);
    const utility = recordedConsent('REMINDERS', true, stop.receivedAt);
    store.consents = [grant, utility];
    await handleInboundWhatsAppMessage('org_a', provider, stop);
    expect(store.consents).toHaveLength(3);
    expect(store.consents.at(-1)).toMatchObject({
      purpose: 'MARKETING',
      granted: false,
      version: 2,
      supersedesId: grant.id,
    });
    expect(store.consents[1]).toEqual(utility);
  });

  it('STOP revokes promotional consent across channels but keeps service consent', async () => {
    knownCustomer(true);
    const at = new Date('2026-10-06T09:00:00Z');
    const sms = { ...recordedConsent('MARKETING', true, at), id: 'sms', channel: 'SMS' };
    const email = { ...recordedConsent('MARKETING', true, at), id: 'email', channel: 'EMAIL' };
    const loyalty = {
      ...recordedConsent('MARKETING', true, at),
      id: 'loyalty',
      purpose: 'LOYALTY',
    };
    const reminders = {
      ...recordedConsent('REMINDERS', true, at),
      id: 'reminders',
      channel: 'SMS',
    };
    store.consents = [sms, email, loyalty, reminders];
    await expect(handleInboundWhatsAppMessage('org_a', provider, message('STOP'))).resolves.toBe(
      'OPTED_OUT'
    );
    const written = store.consents.slice(4);
    expect(written.map((row) => [row.purpose, row.channel, row.supersedesId ?? null])).toEqual(
      expect.arrayContaining([
        ['MARKETING', 'WHATSAPP', null],
        ['MARKETING', 'SMS', 'sms'],
        ['MARKETING', 'EMAIL', 'email'],
        ['LOYALTY', 'WHATSAPP', 'loyalty'],
      ])
    );
    expect(written).toHaveLength(4);
    for (const row of written) expect(row).toMatchObject({ granted: false, source: 'REPLY' });
    expect(store.consents[3]).toEqual(reminders);
  });

  it('a repeated STOP does not add another revocation version', async () => {
    knownCustomer(true);
    await handleInboundWhatsAppMessage('org_a', provider, message('STOP'));
    expect(store.consents).toHaveLength(1);
    await expect(handleInboundWhatsAppMessage('org_a', provider, message('STOP'))).resolves.toBe(
      'OPTED_OUT'
    );
    expect(store.consents).toHaveLength(1);
  });

  it('does not order or reply outside the 24-hour service window', async () => {
    knownCustomer(true);
    const old = { ...message('Panadol 2 packs'), receivedAt: new Date('2026-10-05T13:00:00Z') };
    await expect(handleInboundWhatsAppMessage('org_a', provider, old)).resolves.toBe(
      'EXPIRED_MESSAGE'
    );
    expect(store.placed).toEqual([]);
    expect(provider.calls).toEqual([]);
  });
  it('still applies delayed STOP without sending an expired acknowledgement', async () => {
    knownCustomer(true);
    const old = { ...message('STOP'), receivedAt: new Date('2026-10-04T13:00:00Z') };
    await expect(handleInboundWhatsAppMessage('org_a', provider, old)).resolves.toBe('OPTED_OUT');
    expect(store.customers[0].whatsappOptIn).toBe(false);
    expect(store.consents.at(-1)).toMatchObject({
      purpose: 'MARKETING',
      channel: 'WHATSAPP',
      granted: false,
      source: 'REPLY',
      staffId: null,
    });
    expect(provider.calls).toEqual([]);
  });
  it('rejects future consent without consuming its claim', async () => {
    knownCustomer(false);
    const future = { ...message('START'), receivedAt: new Date('2026-10-07T13:00:00Z') };
    await expect(handleInboundWhatsAppMessage('org_a', provider, future)).rejects.toThrow(
      'timestamp'
    );
    expect(store.customers[0].whatsappOptIn).toBe(false);
    expect(store.logs).toEqual([]);
  });
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
      ['ORDER_CONFIRMATION', 'IGNORED'],
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

  it('rolls back the inbound claim when order placement fails so Meta can retry', async () => {
    knownCustomer(true);
    const retried = message('Panadol 2 packs');
    store.failOrder = true;

    await expect(handleInboundWhatsAppMessage('org_a', provider, retried)).rejects.toThrow(
      'transient order failure'
    );
    expect(store.logs).toEqual([]);
    expect(store.placed).toEqual([]);

    store.failOrder = false;
    await expect(handleInboundWhatsAppMessage('org_a', provider, retried)).resolves.toBe(
      'ORDER_PLACED'
    );
    expect(store.placed).toHaveLength(1);
    expect(store.logs[0]).toMatchObject({
      kind: 'ORDER_REQUEST',
      orderId: 'order_abc123',
      branchId: 'branch-1',
    });
  });

  it.each(['failConsent', 'failCommit'] as const)(
    'rolls back the claim on %s, allowing STOP retry',
    async (failure) => {
      knownCustomer(true);
      const stop = message('STOP');
      store[failure] = true;
      await expect(handleInboundWhatsAppMessage('org_a', provider, stop)).rejects.toThrow();
      expect(store.logs).toEqual([]);
      expect(store.customers[0].whatsappOptIn).toBe(true);
      expect(provider.calls).toEqual([]);
      store[failure] = false;
      await expect(handleInboundWhatsAppMessage('org_a', provider, stop)).resolves.toBe(
        'OPTED_OUT'
      );
      expect(store.customers[0].whatsappOptIn).toBe(false);
    }
  );

  it('does not roll back STOP or resend when acknowledgement is ambiguous', async () => {
    knownCustomer(true);
    const stop = message('STOP');
    const send = vi.spyOn(provider, 'sendText').mockRejectedValue(new Error('timeout'));
    await expect(handleInboundWhatsAppMessage('org_a', provider, stop)).resolves.toBe('OPTED_OUT');
    expect(store.customers[0].whatsappOptIn).toBe(false);
    await expect(handleInboundWhatsAppMessage('org_a', provider, stop)).resolves.toBe('DUPLICATE');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ignores an older START delivered after STOP', async () => {
    knownCustomer(true);
    const start = message('START');
    const stop = message('STOP');
    await handleInboundWhatsAppMessage('org_a', provider, stop);
    await expect(handleInboundWhatsAppMessage('org_a', provider, start)).resolves.toBe(
      'STALE_CONSENT'
    );
    expect(store.customers[0].whatsappOptIn).toBe(false);
    expect(store.logs.at(-1)).toMatchObject({ status: 'IGNORED', error: 'STALE_CONSENT' });
    expect(provider.calls).toHaveLength(1);
  });

  it.each([true, false])(
    'STOP wins an equal timestamp regardless of order (START first: %s)',
    async (startFirst) => {
      knownCustomer(null);
      const start = message('START');
      const stop = { ...message('STOP'), receivedAt: start.receivedAt };
      for (const event of startFirst ? [start, stop] : [stop, start]) {
        await handleInboundWhatsAppMessage('org_a', provider, event);
      }
      expect(store.customers[0].whatsappOptIn).toBe(false);
    }
  );

  it.each([false, true])(
    'STOP revokes older promotional grants regardless of delivery order (START first: %s)',
    async (startFirst) => {
      knownCustomer(true);
      const at = new Date('2026-10-06T09:00:00Z');
      const whatsapp = { ...recordedConsent('MARKETING', true, at), id: 'wa' };
      const sms = { ...recordedConsent('MARKETING', true, at), id: 'sms', channel: 'SMS' };
      const email = { ...recordedConsent('MARKETING', true, at), id: 'email', channel: 'EMAIL' };
      store.consents = [whatsapp, sms, email];
      const stop = { ...message('STOP'), receivedAt: new Date('2026-10-06T10:00:00Z') };
      const start = { ...message('START'), receivedAt: new Date('2026-10-06T10:01:00Z') };
      if (startFirst) {
        await expect(handleInboundWhatsAppMessage('org_a', provider, start)).resolves.toBe(
          'OPTED_IN'
        );
        await expect(handleInboundWhatsAppMessage('org_a', provider, stop)).resolves.toBe(
          'STALE_CONSENT'
        );
        expect(store.logs.at(-1)).toMatchObject({ error: 'STALE_UTILITY_CONSENT' });
        expect(store.logs.at(-1)?.status).not.toBe('IGNORED');
      } else {
        await handleInboundWhatsAppMessage('org_a', provider, stop);
        await handleInboundWhatsAppMessage('org_a', provider, start);
      }
      expect(store.customers[0].whatsappOptIn).toBe(true);
      const written = store.consents.slice(3);
      expect(written.map((row) => [row.purpose, row.channel, row.supersedesId])).toEqual(
        expect.arrayContaining([
          ['MARKETING', 'WHATSAPP', 'wa'],
          ['MARKETING', 'SMS', 'sms'],
          ['MARKETING', 'EMAIL', 'email'],
        ])
      );
      expect(written).toHaveLength(3);
      for (const row of written)
        expect(row).toMatchObject({ granted: false, source: 'REPLY', recordedAt: stop.receivedAt });
      expect(await marketingEligibility()).toBe('OPTED_OUT');
    }
  );

  it('does not let a replayed STOP undo a later START', async () => {
    knownCustomer(true);
    const stop = message('STOP');
    await handleInboundWhatsAppMessage('org_a', provider, stop);
    await handleInboundWhatsAppMessage('org_a', provider, message('START'));
    await expect(handleInboundWhatsAppMessage('org_a', provider, stop)).resolves.toBe('DUPLICATE');
    expect(store.customers[0].whatsappOptIn).toBe(true);
    expect(provider.calls).toHaveLength(2);
    expect(store.consents).toHaveLength(1);
    expect(await marketingEligibility()).toBe('OPTED_OUT');
  });
});

it('never echoes a medicine name in outbound WhatsApp confirmation text', async () => {
  const { WHATSAPP_REPLIES } = await import('./messages');
  const body = WHATSAPP_REPLIES.confirmation({
    reference: 'ABC123',
    quantity: 2,
    branch: 'Main counter',
  });
  expect(body).not.toMatch(/panadol|medicine|drug|tablet|salt/i);
  expect(body).toContain('ABC123');
});

it('uses the matched customer language for consent replies without changing the consent effect', async () => {
  knownCustomer(true);
  store.customers[0]!.preferredLanguage = 'ur';
  await expect(handleInboundWhatsAppMessage('org_a', provider, message('STOP'))).resolves.toBe(
    'OPTED_OUT'
  );
  expect(store.customers[0]!.whatsappOptIn).toBe(false);
  expect(provider.calls).toHaveLength(1);
  const reply = provider.calls[0]!;
  expect(reply.kind).toBe('text');
  if (reply.kind !== 'text') throw new Error('Expected a text reply');
  expect(reply.body).toContain('آپ کو اب اس فارمیسی');
  expect(reply.body).not.toContain('You will no longer');
});
