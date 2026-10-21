import { describe, expect, it, vi } from 'vitest';

import { EvolutionWhatsAppProvider } from './evolution';
import { createMemoryStore } from './memory-store';
import { drainQueue, enqueueOutbound } from './queue';
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
      store,
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
      store,
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
      store,
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
      store,
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

  it('does not enqueue a customer who has not opted in', async () => {
    const store = createMemoryStore();
    store.putCustomer(customer('c1', '+923001111111', false));
    await expect(
      enqueueOutbound(store, {
        organizationId: 'org_1',
        customerId: 'c1',
        body: 'Hello. Reply STOP to opt out.',
      })
    ).rejects.toBeInstanceOf(NotOptedIn);
    expect(store.messages).toHaveLength(0);
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
