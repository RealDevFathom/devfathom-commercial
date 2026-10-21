import { describe, expect, it, vi } from 'vitest';

const tx = vi.hoisted(() => ({
  depth: 0,
  max: 0,
  httpInside: false,
  store: null as null | ReturnType<typeof import('./memory-store').createMemoryStore>,
}));

vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: async (_organizationId: string, run: (db: object) => Promise<unknown>) => {
    tx.depth += 1;
    tx.max = Math.max(tx.max, tx.depth);
    try {
      return await run({});
    } finally {
      tx.depth -= 1;
    }
  },
}));

vi.mock('./store', () => ({
  outboundGrowthStore: () => {
    if (!tx.store) throw new Error('store missing');
    return tx.store;
  },
}));

import { DrugCategoryInPromo, ProhibitedDrugInCopy } from '@/lib/growth/templates';

import { EvolutionWhatsAppProvider } from './evolution';
import { createMemoryStore } from './memory-store';
import {
  CustomerDailyCap,
  drainQueue,
  drainOrganizationQueue,
  enqueueMarketing,
  enqueueOrderReady,
  type StoreUnit,
} from './queue';
import { effectiveDailyCap, isQuietHours, zonedDayStart } from './time';
import { NotOptedIn, type GrowthCustomer, type GrowthSettings } from './types';

const day = new Date('2026-10-21T05:00:00.000Z');

function settings(overrides: Partial<GrowthSettings> = {}): GrowthSettings {
  return {
    organizationId: 'org_1',
    monthlyBudgetMinor: 0,
    autoApproveUnderMinor: 0,
    quietHoursStart: 21,
    quietHoursEnd: 9,
    maxMsgsPerDay: 200,
    minSecondsBetweenMsgs: 4,
    waInstanceName: 'org_1',
    waApiUrl: 'http://evolution.test',
    waApiKeyEnc: null,
    churnThreshold: 60,
    createdAt: new Date('2020-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function customer(id: string, phone: string, whatsappOptIn = true): GrowthCustomer {
  return {
    id,
    organizationId: 'org_1',
    displayName: id,
    whatsappE164: phone,
    whatsappOptIn,
    whatsappOptInAt: whatsappOptIn ? day : null,
    whatsappOptOutAt: null,
  };
}

function medicineDb(options?: { prohibited?: unknown; failLookup?: boolean }) {
  return {
    medicine: {
      findMany: async (args: {
        where: { id?: { in: string[] }; OR?: unknown };
      }): Promise<Array<{ productFamily: string; productName?: string }>> => {
        if (args.where.OR) {
          if (options?.failLookup) throw new Error('medicine lookup failed');
          return (options?.prohibited ?? []) as Array<{
            productFamily: string;
            productName?: string;
          }>;
        }
        const ids = args.where.id?.in ?? [];
        if (ids.includes('drug')) {
          return [{ productFamily: 'PHARMACEUTICAL', productName: 'Alprazolam' }];
        }
        if (ids.includes('alt'))
          return [{ productFamily: 'ALTERNATIVE', productName: 'Herbal Mix' }];
        if (ids.length === 0) return [];
        return [{ productFamily: 'FRONT_SHOP', productName: 'Vitamin C' }];
      },
    },
  };
}

function unitFor(store: ReturnType<typeof createMemoryStore>): StoreUnit {
  return (run) => run(store);
}

function providerFor(fetchImpl: typeof fetch) {
  return new EvolutionWhatsAppProvider(
    { baseUrl: 'http://evolution.test', apiKey: 'test-key', instance: 'org_1' },
    fetchImpl
  );
}

describe('outbound queue', () => {
  it('sends two queued messages in order and leaves the third when the daily cap is 2', async () => {
    let stamp = day.getTime();
    const store = createMemoryStore({ now: () => new Date(stamp) });
    store.putCustomer(customer('c1', '+923001111111'));
    store.putCustomer(customer('c2', '+923002222222'));
    store.putCustomer(customer('c3', '+923003333333'));
    const bodies = [
      'First. Reply STOP to opt out.',
      'Second. Reply STOP to opt out.',
      'Third. Reply STOP to opt out.',
    ];
    for (const [index, body] of bodies.entries()) {
      await store.insertMessage({
        organizationId: 'org_1',
        customerId: `c${index + 1}`,
        direction: 'out',
        waMessageId: null,
        body,
        status: 'queued',
        campaignId: null,
        recipientId: null,
        error: null,
      });
      stamp += 1000;
    }
    const calls: Array<{ url: string; body: { number: string; text: string }; apikey: string }> =
      [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        body: JSON.parse(String(init?.body)) as { number: string; text: string },
        apikey: headers.get('apikey') ?? '',
      });
      return new Response(JSON.stringify({ key: { id: `wamid-${calls.length}` } }), {
        status: 200,
      });
    });
    const sleeps: number[] = [];
    const result = await drainQueue({
      checkCopy: async () => {},
      unit: unitFor(store),
      provider: providerFor(fetchImpl as typeof fetch),
      organizationId: 'org_1',
      settings: settings({ maxMsgsPerDay: 2 }),
      timeZone: 'Asia/Karachi',
      now: day,
      clock: {
        now: () => day,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 0,
      },
    });

    expect(result).toEqual({ sent: 2, reason: 'ok' });
    expect(calls.map((call) => call.body.text)).toEqual(bodies.slice(0, 2));
    expect(calls.map((call) => call.body.number)).toEqual(['923001111111', '923002222222']);
    expect(calls[0]?.url).toBe('http://evolution.test/message/sendText/org_1');
    expect(calls[0]?.apikey).toBe('test-key');
    expect(sleeps).toEqual([4000]);
    expect(store.messages.map((row) => row.status)).toEqual(['sent', 'sent', 'queued']);
    expect(store.messages[0]?.waMessageId).toBe('wamid-1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('sends nothing at 22:00 Asia/Karachi', async () => {
    const store = createMemoryStore();
    store.putCustomer(customer('c1', '+923001111111'));
    await store.insertMessage({
      organizationId: 'org_1',
      customerId: 'c1',
      direction: 'out',
      waMessageId: null,
      body: 'Night note. Reply STOP to opt out.',
      status: 'queued',
      campaignId: null,
      recipientId: null,
      error: null,
    });
    const fetchImpl = vi.fn();
    const result = await drainQueue({
      checkCopy: async () => {},
      unit: unitFor(store),
      provider: providerFor(fetchImpl as typeof fetch),
      organizationId: 'org_1',
      settings: settings(),
      timeZone: 'Asia/Karachi',
      now: new Date('2026-10-21T17:00:00.000Z'),
      clock: { now: () => day, sleep: async () => undefined, random: () => 0 },
    });
    expect(result).toEqual({ sent: 0, reason: 'quiet_hours' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.messages[0]?.status).toBe('queued');
  });

  it('stops before the next gap once 60 seconds of wall time have passed', async () => {
    let stamp = day.getTime();
    const store = createMemoryStore({ now: () => new Date(stamp) });
    store.putCustomer(customer('c1', '+923001111111'));
    store.putCustomer(customer('c2', '+923002222222'));
    for (const id of ['c1', 'c2']) {
      await store.insertMessage({
        organizationId: 'org_1',
        customerId: id,
        direction: 'out',
        waMessageId: null,
        body: `${id}. Reply STOP to opt out.`,
        status: 'queued',
        campaignId: null,
        recipientId: null,
        error: null,
      });
      stamp += 1000;
    }
    let elapsed = 0;
    const fetchImpl = vi.fn(async () => {
      elapsed += 58_000;
      return new Response(JSON.stringify({ key: { id: 'wamid' } }), { status: 200 });
    });
    const result = await drainQueue({
      checkCopy: async () => {},
      unit: unitFor(store),
      provider: providerFor(fetchImpl as typeof fetch),
      organizationId: 'org_1',
      settings: settings(),
      timeZone: 'Asia/Karachi',
      now: day,
      clock: {
        now: () => new Date(day.getTime() + elapsed),
        sleep: async (ms) => {
          elapsed += ms;
        },
        random: () => 0,
      },
    });
    expect(result.sent).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.messages.map((row) => row.status)).toEqual(['sent', 'queued']);
  });

  it('stops retrying a row after three failures', async () => {
    const store = createMemoryStore();
    store.putCustomer(customer('c1', '+923001111111'));
    await store.insertMessage({
      organizationId: 'org_1',
      customerId: 'c1',
      direction: 'out',
      waMessageId: null,
      body: 'Retry me. Reply STOP to opt out.',
      status: 'queued',
      campaignId: null,
      recipientId: null,
      error: null,
    });
    const fetchImpl = vi.fn(async () => new Response('no', { status: 500 }));
    const input = {
      checkCopy: async () => {},
      unit: unitFor(store),
      provider: providerFor(fetchImpl as typeof fetch),
      organizationId: 'org_1',
      settings: settings(),
      timeZone: 'Asia/Karachi',
      now: day,
      clock: { now: () => day, sleep: async () => undefined, random: () => 0 },
    };
    await drainQueue(input);
    await drainQueue(input);
    expect(store.messages[0]?.status).toBe('queued');
    await drainQueue(input);
    expect(store.messages[0]?.status).toBe('failed');
    expect(store.messages[0]?.error).toContain('attempts=3');
    await drainQueue(input);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('sends outside the tenant transaction and commits each row on its own', async () => {
    const store = createMemoryStore();
    store.putCustomer(customer('c1', '+923001111111'));
    store.putCustomer(customer('c2', '+923002222222'));
    for (const id of ['c1', 'c2']) {
      await store.insertMessage({
        organizationId: 'org_1',
        customerId: id,
        direction: 'out',
        waMessageId: null,
        body: `${id}. Reply STOP to opt out.`,
        status: 'queued',
        campaignId: null,
        recipientId: null,
        error: null,
      });
    }
    let open = 0;
    const fetchImpl = vi.fn(async () => {
      expect(open).toBe(0);
      expect(store.messages.find((row) => row.status === 'sending')).toBeTruthy();
      return new Response(JSON.stringify({ key: { id: `wamid-${open}` } }), { status: 200 });
    });
    const result = await drainQueue({
      checkCopy: async () => {},
      unit: async (run) => {
        open += 1;
        try {
          return await run(store);
        } finally {
          open -= 1;
        }
      },
      provider: providerFor(fetchImpl as typeof fetch),
      organizationId: 'org_1',
      settings: settings({ minSecondsBetweenMsgs: 0 }),
      timeZone: 'Asia/Karachi',
      now: day,
      clock: {
        now: () => day,
        sleep: async () => {
          expect(open).toBe(0);
        },
        random: () => 0,
      },
    });
    expect(result).toEqual({ sent: 2, reason: 'ok' });
    expect(open).toBe(0);
    expect(store.messages.map((row) => row.status)).toEqual(['sent', 'sent']);
  });

  it('leaves a claimed row sending when the sent mark rolls back', async () => {
    const store = createMemoryStore();
    store.putCustomer(customer('c1', '+923001111111'));
    await store.insertMessage({
      organizationId: 'org_1',
      customerId: 'c1',
      direction: 'out',
      waMessageId: null,
      body: 'Once. Reply STOP to opt out.',
      status: 'queued',
      campaignId: null,
      recipientId: null,
      error: null,
    });
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ key: { id: 'wamid-1' } }), { status: 200 });
    });
    const unit: StoreUnit = async (run) => {
      const before = store.messages.map((row) => ({ ...row }));
      try {
        const result = await run(store);
        const markedSent = store.messages.some(
          (row, index) => before[index]?.status !== 'sent' && row.status === 'sent'
        );
        if (markedSent) throw new Error('transaction timeout');
        return result;
      } catch (error) {
        store.messages.forEach((row, index) => Object.assign(row, before[index]));
        throw error;
      }
    };
    await expect(
      drainQueue({
        checkCopy: async () => {},
        unit,
        provider: providerFor(fetchImpl as typeof fetch),
        organizationId: 'org_1',
        settings: settings(),
        timeZone: 'Asia/Karachi',
        now: day,
        clock: { now: () => day, sleep: async () => undefined, random: () => 0 },
      })
    ).rejects.toThrow('transaction timeout');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.messages[0]?.status).toBe('sending');
    await drainQueue({
      checkCopy: async () => {},
      unit: unitFor(store),
      provider: providerFor(fetchImpl as typeof fetch),
      organizationId: 'org_1',
      settings: settings(),
      timeZone: 'Asia/Karachi',
      now: day,
      clock: { now: () => day, sleep: async () => undefined, random: () => 0 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.messages[0]?.status).toBe('sending');
  });

  it('re-checks quiet hours after the gap and does not send the next row', async () => {
    const start = new Date('2026-10-21T15:59:30.000Z');
    let elapsed = 0;
    const store = createMemoryStore();
    store.putCustomer(customer('c1', '+923001111111'));
    store.putCustomer(customer('c2', '+923002222222'));
    for (const id of ['c1', 'c2']) {
      await store.insertMessage({
        organizationId: 'org_1',
        customerId: id,
        direction: 'out',
        waMessageId: null,
        body: `${id}. Reply STOP to opt out.`,
        status: 'queued',
        campaignId: null,
        recipientId: null,
        error: null,
      });
    }
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ key: { id: 'wamid' } }), { status: 200 });
    });
    const result = await drainQueue({
      checkCopy: async () => {},
      unit: unitFor(store),
      provider: providerFor(fetchImpl as typeof fetch),
      organizationId: 'org_1',
      settings: settings(),
      timeZone: 'Asia/Karachi',
      now: start,
      clock: {
        now: () => new Date(start.getTime() + elapsed),
        sleep: async () => {
          elapsed += 40_000;
        },
        random: () => 0,
      },
    });
    expect(result).toEqual({ sent: 1, reason: 'quiet_hours' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.messages.map((row) => row.status)).toEqual(['sent', 'queued']);
  });

  it('does not hold one tenant transaction across the Evolution call', async () => {
    tx.depth = 0;
    tx.max = 0;
    tx.httpInside = false;
    const store = createMemoryStore();
    tx.store = store;
    store.putSettings(
      settings({ waApiUrl: 'http://localhost:8080', waInstanceName: 'org_1', waApiKeyEnc: null })
    );
    store.putCustomer(customer('c1', '+923001111111'));
    await store.insertMessage({
      organizationId: 'org_1',
      customerId: 'c1',
      direction: 'out',
      waMessageId: null,
      body: 'c1, your order from Demo Pharmacy is ready for pickup. Reply STOP to opt out.',
      status: 'queued',
      campaignId: null,
      recipientId: null,
      error: null,
    });
    vi.stubEnv('EVOLUTION_API_URL', 'http://localhost:8080');
    vi.stubEnv('EVOLUTION_API_KEY', 'env-key');
    vi.useFakeTimers({ now: day, toFake: ['Date'] });
    const fetchImpl = vi.fn(async () => {
      tx.httpInside = tx.depth > 0;
      return new Response(JSON.stringify({ key: { id: 'wamid-live' } }), { status: 200 });
    });
    try {
      const result = await drainOrganizationQueue('org_1', day, async () =>
        providerFor(fetchImpl as typeof fetch)
      );
      expect(result).toEqual({ sent: 1, reason: 'ok' });
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      tx.store = null;
    }
    expect(tx.httpInside).toBe(false);
    expect(tx.max).toBe(1);
    expect(store.messages[0]).toMatchObject({ status: 'sent', waMessageId: 'wamid-live' });
  });

  it('sends order_ready in English and Urdu only to an opted-in customer', async () => {
    const store = createMemoryStore();
    store.putCustomer(customer('c1', '+923001111111'));
    store.putCustomer(customer('c2', '+923002222222', false));
    const pharmacy = await enqueueOrderReady(store, {
      organizationId: 'org_1',
      customerId: 'c1',
      language: 'en',
      name: 'Ayesha',
      business: 'Sehat Pharmacy',
    });
    const restaurant = await enqueueOrderReady(store, {
      organizationId: 'org_1',
      customerId: 'c1',
      language: 'ur',
      name: 'Ayesha',
      business: 'Karachi Kitchen',
    });
    expect(pharmacy.body).toBe(
      'Ayesha, your order from Sehat Pharmacy is ready for pickup. Reply STOP to opt out.'
    );
    expect(restaurant.body).toContain('Karachi Kitchen');
    expect(restaurant.body).toContain('تیار');
    expect(restaurant.body).toContain('STOP');
    await expect(
      enqueueOrderReady(store, {
        organizationId: 'org_1',
        customerId: 'c2',
        language: 'en',
        name: 'Ayesha',
        business: 'Sehat Pharmacy',
      })
    ).rejects.toBeInstanceOf(NotOptedIn);
    expect(store.messages.map((row) => row.customerId)).toEqual(['c1', 'c1']);
  });

  it('does not enqueue a customer who has not opted in', async () => {
    const store = createMemoryStore();
    store.putCustomer(customer('c1', '+923001111111', false));
    await expect(
      enqueueMarketing(medicineDb(), store, {
        organizationId: 'org_1',
        customerId: 'c1',
        body: 'Hello. Reply STOP to opt out.',
        templateKey: 'slow_day',
        medicineIds: ['shop'],
      })
    ).rejects.toBeInstanceOf(NotOptedIn);
    expect(store.messages).toHaveLength(0);
  });

  it('queues front-shop marketing and refuses a drug family before insert', async () => {
    const store = createMemoryStore();
    store.putCustomer(customer('c1', '+923001111111'));
    const body = 'Salaam. Reply STOP to opt out.';
    const db = medicineDb();
    const queued = await enqueueMarketing(db, store, {
      organizationId: 'org_1',
      customerId: 'c1',
      body,
      templateKey: 'slow_day',
      medicineIds: ['shop'],
    });
    expect(queued.status).toBe('queued');
    await expect(
      enqueueMarketing(db, store, {
        organizationId: 'org_1',
        customerId: 'c1',
        body,
        templateKey: 'slow_day',
        medicineIds: ['drug'],
      })
    ).rejects.toBeInstanceOf(DrugCategoryInPromo);
    await expect(
      enqueueMarketing(db, store, {
        organizationId: 'org_1',
        customerId: 'c1',
        body,
        templateKey: 'slow_day',
        medicineIds: [],
      })
    ).rejects.toBeInstanceOf(DrugCategoryInPromo);
    expect(store.messages).toHaveLength(1);
  });

  it('fills {{product}} only from front-shop or device rows', async () => {
    const store = createMemoryStore();
    store.putCustomer(customer('c1', '+923001111111'));
    const queued = await enqueueMarketing(medicineDb(), store, {
      organizationId: 'org_1',
      customerId: 'c1',
      body: 'Today: {{product}}. Reply STOP to opt out.',
      templateKey: 'slow_day',
      medicineIds: ['shop'],
    });
    expect(queued.body).toBe('Today: Vitamin C. Reply STOP to opt out.');
    await expect(
      enqueueMarketing(medicineDb(), store, {
        organizationId: 'org_1',
        customerId: 'c1',
        body: 'Today: {{product}}. Reply STOP to opt out.',
        templateKey: 'slow_day',
        medicineIds: ['alt'],
      })
    ).rejects.toBeInstanceOf(DrugCategoryInPromo);
  });

  it('refuses marketing copy that names a restricted medicine and fails closed', async () => {
    const store = createMemoryStore();
    store.putCustomer(customer('c1', '+923001111111'));
    const prohibited = [
      {
        productName: 'Alprazolam',
        brandName: 'Xanax',
        aliases: [{ value: 'Alprax' }],
        strengths: [{ ingredient: { name: 'alprazolam' } }],
      },
    ];
    await expect(
      enqueueMarketing(medicineDb({ prohibited }), store, {
        organizationId: 'org_1',
        customerId: 'c1',
        body: 'Ask for xanax today. Reply STOP to opt out.',
        templateKey: 'generic',
        medicineIds: ['shop'],
      })
    ).rejects.toBeInstanceOf(ProhibitedDrugInCopy);
    await expect(
      enqueueMarketing(medicineDb({ failLookup: true }), store, {
        organizationId: 'org_1',
        customerId: 'c1',
        body: 'A note from the shop. Reply STOP to opt out.',
        templateKey: 'generic',
        medicineIds: ['shop'],
      })
    ).rejects.toBeInstanceOf(ProhibitedDrugInCopy);
    expect(store.messages).toHaveLength(0);
  });

  it('allows one marketing message per customer per day and still queues order ready', async () => {
    const store = createMemoryStore({ now: () => day });
    store.putCustomer(customer('c1', '+923001111111'));
    const input = {
      organizationId: 'org_1',
      customerId: 'c1',
      body: 'One offer. Reply STOP to opt out.',
      templateKey: 'slow_day',
      medicineIds: ['shop'],
      now: day,
    };
    await enqueueMarketing(medicineDb(), store, input);
    await expect(enqueueMarketing(medicineDb(), store, input)).rejects.toBeInstanceOf(
      CustomerDailyCap
    );
    const ready = await enqueueOrderReady(store, {
      organizationId: 'org_1',
      customerId: 'c1',
      language: 'en',
      name: 'Ayesha',
      business: 'Sehat Pharmacy',
    });
    expect(ready.campaignId).toBeNull();
    expect(store.messages.filter((row) => row.campaignId != null)).toHaveLength(1);
  });

  it('caps the first 14 days at 30 messages', () => {
    const createdAt = new Date('2026-10-10T00:00:00.000Z');
    expect(effectiveDailyCap(settings({ maxMsgsPerDay: 200, createdAt }), day)).toBe(30);
    expect(effectiveDailyCap(settings({ maxMsgsPerDay: 10, createdAt }), day)).toBe(10);
    expect(effectiveDailyCap(settings(), day)).toBe(200);
  });
});

describe('business local time', () => {
  it('treats 22:00 Asia/Karachi as quiet and 10:00 as open', () => {
    expect(isQuietHours(new Date('2026-10-21T17:00:00.000Z'), 'Asia/Karachi', 21, 9)).toBe(true);
    expect(isQuietHours(day, 'Asia/Karachi', 21, 9)).toBe(false);
    expect(zonedDayStart(new Date('2026-10-21T17:00:00.000Z'), 'Asia/Karachi').toISOString()).toBe(
      '2026-10-20T19:00:00.000Z'
    );
  });
});

describe('campaign drain copy gate', () => {
  it.each(['A'.repeat(81), 'Shop\nXanax offer', 'Shop 💊'])(
    'does not exempt an order-ready body with an unsafe name: %s',
    async (name) => {
      const store = createMemoryStore();
      store.putCustomer({ ...customer('drain', '+923001234567'), displayName: name });
      await enqueueOrderReady(store, {
        organizationId: 'org_1',
        customerId: 'drain',
        language: 'en',
        name,
        business: 'Demo Pharmacy',
      });
      const sendText = vi.fn();
      const result = await drainQueue({
        unit: (run) => run(store),
        provider: { sendText, getStatus: async () => 'connected' },
        organizationId: 'org_1',
        settings: settings(),
        now: day,
        clock: { now: () => day, sleep: async () => {}, random: () => 0 },
      });
      expect(result.sent).toBe(0);
      expect(sendText).not.toHaveBeenCalled();
    }
  );
  it.each(['prohibited copy', 'catalog unavailable', 'missing gate', 'no campaign'])(
    'fails closed before provider send: %s',
    async (reason) => {
      const store = createMemoryStore();
      store.putCustomer(customer('drain', '+923001234567'));
      const row = await store.insertMessage({
        organizationId: 'org_1',
        customerId: 'drain',
        direction: 'out',
        body: 'Xаnax offer. Reply STOP',
        status: 'queued',
        campaignId: reason === 'no campaign' ? null : 'campaign',
        recipientId: null,
        waMessageId: null,
        error: null,
      });
      const sendText = vi.fn();
      const checkCopy =
        reason === 'missing gate'
          ? undefined
          : async (body: string) => {
              if (reason === 'catalog unavailable') throw new Error('catalog unavailable');
              const { assertMarketingCopyAllowed } = await import('@/lib/growth/templates');
              await assertMarketingCopyAllowed(medicineDb(), 'org_1', body);
            };
      const result = await drainQueue({
        unit: (run) => run(store),
        provider: { sendText, getStatus: async () => 'connected' },
        organizationId: 'org_1',
        settings: settings(),
        now: day,
        clock: { now: () => day, sleep: async () => {}, random: () => 0 },
        checkCopy,
      });
      expect(result.sent).toBe(0);
      expect(sendText).not.toHaveBeenCalled();
      expect(store.messages.find((message) => message.id === row.id)?.status).toBe('failed');
    }
  );
});

it('rechecks consent after claiming and copy checks, and cancels sending rows', async () => {
  const store = createMemoryStore({ now: () => day });
  store.putCustomer(customer('c1', '+923001234567'));
  await store.insertMessage({
    organizationId: 'org_1',
    customerId: 'c1',
    direction: 'out',
    waMessageId: null,
    body: 'Offers. Reply STOP to opt out.',
    status: 'queued',
    campaignId: 'campaign',
    recipientId: null,
    error: null,
  });
  const sendText = vi.fn(async () => ({ providerMessageId: 'should-not-send' }));
  const outcome = await drainQueue({
    unit: unitFor(store),
    organizationId: 'org_1',
    provider: { sendText, getStatus: async () => 'connected' },
    settings: settings(),
    now: day,
    clock: { now: () => day, sleep: async () => {}, random: () => 0 },
    checkCopy: async () => {
      expect(store.messages[0]?.status).toBe('sending');
      const existing = await store.customer('org_1', 'c1');
      await store.saveCustomer({ ...existing!, whatsappOptIn: false, whatsappOptOutAt: day });
      expect(await store.cancelQueued('org_1', 'c1')).toBe(1);
      expect(store.messages[0]).toMatchObject({ status: 'failed', error: 'cancelled:opt_out' });
    },
  });
  expect(outcome.sent).toBe(0);
  expect(sendText).not.toHaveBeenCalled();
});
