import { describe, expect, it } from 'vitest';

import { DuplicateInboundMessage } from './duplicate';
import { growthStore as inboundStore, outboundGrowthStore as growthStore } from './store';

type Call = { model: string; op: string; args: unknown };

function recordingDb() {
  const calls: Call[] = [];
  function delegate(model: string) {
    return new Proxy(
      {},
      {
        get(_target, op: string) {
          return async (args: unknown) => {
            calls.push({ model, op, args });
            if (op === 'findMany' || op === 'count') return op === 'count' ? 0 : [];
            if (op === 'updateMany') return { count: 1 };
            if (op === 'findFirst' && model === 'growthWaCustomer') {
              return {
                id: 'c1',
                organizationId: 'org_1',
                displayName: 'Ayesha',
                whatsappE164: '+923001234567',
                whatsappOptIn: true,
              };
            }
            if (op === 'findFirst' || op === 'findUnique') return null;
            return { id: 'created', organizationId: 'org_1', ...(args as { data?: object }).data };
          };
        },
      }
    );
  }
  const db = new Proxy(
    {
      organization: {
        findUnique: async () => ({ timezone: 'Asia/Karachi', displayName: 'Sehat Pharmacy' }),
      },
    },
    {
      get(target, key: string, receiver) {
        if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
        return delegate(key);
      },
    }
  );
  return { db, calls };
}

describe('growth WhatsApp Prisma adapter', () => {
  it('scopes queue reads and consent writes by organizationId', async () => {
    const { db, calls } = recordingDb();
    const store = growthStore(db);
    await store.queuedMessages('org_1', 2);
    await store.countSentToday('org_1', new Date('2026-10-20T19:00:00.000Z'));
    await store.saveCustomer({
      id: 'c1',
      organizationId: 'org_1',
      whatsappE164: '+923001234567',
      whatsappOptIn: true,
      whatsappOptInAt: new Date('2026-10-21T05:00:00.000Z'),
      whatsappOptOutAt: null,
    });
    expect(calls.map((call) => call.model)).not.toContain('business');
    expect(calls[0]).toMatchObject({
      model: 'growthWaMessage',
      op: 'findMany',
      args: {
        where: { organizationId: 'org_1', status: 'queued', direction: 'out' },
        take: 2,
      },
    });
    expect(calls[1]).toMatchObject({
      model: 'growthWaMessage',
      op: 'count',
      args: { where: expect.objectContaining({ organizationId: 'org_1', direction: 'out' }) },
    });
    await store.claimQueued('org_1', 'msg_1');
    expect(calls.filter((call) => call.op === 'updateMany').at(-1)).toMatchObject({
      model: 'growthWaMessage',
      op: 'updateMany',
      args: {
        where: { id: 'msg_1', organizationId: 'org_1', direction: 'out', status: 'queued' },
        data: { status: 'sending' },
      },
    });
    expect(calls[2]).toMatchObject({
      model: 'growthWaCustomer',
      op: 'updateMany',
      args: {
        where: { id: 'c1', organizationId: 'org_1' },
        data: expect.objectContaining({ whatsappOptIn: true, whatsappE164: '+923001234567' }),
      },
    });
  });

  it('looks up exactly one organization by webhook secret hash', async () => {
    const { db, calls } = recordingDb();
    await expect(growthStore(db).organizationForWebhookSecret('hash-1')).resolves.toBeNull();
    expect(calls.at(-1)).toMatchObject({
      model: 'growthWaSettings',
      op: 'findMany',
      args: { where: { waWebhookSecretHash: 'hash-1' }, take: 2 },
    });

    const matched = {
      organization: { findUnique: async () => null },
      growthWaSettings: {
        findMany: async () => [
          { organizationId: 'org_1', waWebhookSecretHash: 'hash-1' },
          { organizationId: 'org_2', waWebhookSecretHash: 'hash-1' },
        ],
      },
    };
    await expect(growthStore(matched).organizationForWebhookSecret('hash-1')).resolves.toBeNull();
    matched.growthWaSettings.findMany = async () => [
      { organizationId: 'org_1', waWebhookSecretHash: 'hash-1' },
    ];
    await expect(growthStore(matched).organizationForWebhookSecret('hash-1')).resolves.toEqual({
      organizationId: 'org_1',
      waWebhookSecretHash: 'hash-1',
    });
  });

  it('maps an inbound unique conflict to a duplicate and leaves other conflicts alone', async () => {
    const conflict = Object.assign(new Error('unique'), { code: 'P2002' });
    const db = {
      organization: { findUnique: async () => null },
      growthWaMessage: { create: async () => Promise.reject(conflict) },
    };
    const message = {
      organizationId: 'org_1',
      customerId: null,
      waMessageId: 'in-1',
      body: 'hi',
      status: 'received' as const,
      campaignId: null,
      recipientId: null,
      error: null,
    };
    await expect(
      growthStore(db).insertMessage({ ...message, direction: 'in' })
    ).rejects.toBeInstanceOf(DuplicateInboundMessage);
    await expect(
      growthStore(db).insertMessage({ ...message, direction: 'out', status: 'queued' })
    ).rejects.toBe(conflict);
  });

  it('counts one customer marketing window and upserts the webhook secret', async () => {
    const { db, calls } = recordingDb();
    const since = new Date('2026-10-20T05:00:00.000Z');
    await expect(growthStore(db).countMarketingSince('org_1', 'c1', since)).resolves.toBe(0);
    expect(calls.at(-1)).toMatchObject({
      model: 'growthWaMessage',
      op: 'count',
      args: {
        where: expect.objectContaining({
          organizationId: 'org_1',
          customerId: 'c1',
          campaignId: { not: null },
          createdAt: { gte: since },
        }),
      },
    });
    await growthStore(db).saveWebhookSecret('org_1', {
      waWebhookSecretHash: 'hash-1',
      waWebhookSecretEnc: 'cipher-1',
    });
    expect(calls.at(-1)).toMatchObject({
      model: 'growthWaSettings',
      op: 'upsert',
      args: {
        where: { organizationId: 'org_1' },
        update: { waWebhookSecretHash: 'hash-1', waWebhookSecretEnc: 'cipher-1' },
      },
    });
  });

  it('upserts a STOP by phone when a concurrent insert already took the number', async () => {
    const phone = '+923001234567';
    const optedOutAt = new Date('2026-10-21T05:00:00.000Z');
    const winner = {
      id: 'c-won',
      organizationId: 'org_1',
      displayName: phone,
      whatsappE164: phone,
      whatsappOptIn: false,
      whatsappOptInAt: null,
      whatsappOptOutAt: optedOutAt,
    };
    const calls: string[] = [];
    const db = {
      organization: {
        findUnique: async () => ({ timezone: 'Asia/Karachi', displayName: 'Sehat Pharmacy' }),
      },
      growthWaCustomer: {
        upsert: async () => {
          calls.push('upsert');
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        },
        findFirst: async () => {
          calls.push('findFirst');
          return winner;
        },
        updateMany: async () => {
          calls.push('updateMany');
          return { count: 1 };
        },
      },
    };
    const saved = await growthStore(db).upsertOptOutByPhone({
      organizationId: 'org_1',
      displayName: phone,
      whatsappE164: phone,
      whatsappOptOutAt: optedOutAt,
    });
    expect(saved).toMatchObject({ id: 'c-won', whatsappOptIn: false, whatsappE164: phone });
    expect(calls).toEqual(['upsert', 'findFirst', 'updateMany', 'findFirst']);
  });
});

it('rejects outbound writes through the public store at runtime', async () => {
  const { db, calls } = recordingDb();
  await expect(inboundStore(db).insertMessage({ direction: 'out' } as never)).rejects.toThrow('only accepts inbound');
  expect(calls).toEqual([]);
});
