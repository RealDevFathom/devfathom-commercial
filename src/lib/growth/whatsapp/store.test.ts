import { describe, expect, it } from 'vitest';

import { growthStore } from './store';

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
            if (op === 'findFirst' && model === 'customer') {
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
      model: 'messageLog',
      op: 'findMany',
      args: {
        where: { organizationId: 'org_1', status: 'queued', direction: 'out' },
        take: 2,
      },
    });
    expect(calls[1]).toMatchObject({
      model: 'messageLog',
      op: 'count',
      args: { where: expect.objectContaining({ organizationId: 'org_1', direction: 'out' }) },
    });
    expect(calls[2]).toMatchObject({
      model: 'customer',
      op: 'updateMany',
      args: {
        where: { id: 'c1', organizationId: 'org_1' },
        data: expect.objectContaining({ whatsappOptIn: true, whatsappE164: '+923001234567' }),
      },
    });
  });
});
