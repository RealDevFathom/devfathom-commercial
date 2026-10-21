import { describe, expect, it, vi } from 'vitest';

import { handleInboundText, setCustomerOptIn } from './consent';
import { createMemoryStore } from './whatsapp/memory-store';
import type { GrowthCustomer } from './whatsapp/types';
import type { WhatsAppProvider } from './whatsapp/provider';

const now = new Date('2026-10-21T05:00:00.000Z');
const from = '+923001234567';

function customer(overrides: Partial<GrowthCustomer> = {}): GrowthCustomer {
  return {
    id: 'c1',
    organizationId: 'org_1',
    displayName: 'Ayesha',
    whatsappE164: from,
    whatsappOptIn: true,
    whatsappOptInAt: now,
    whatsappOptOutAt: null,
    ...overrides,
  };
}

function harness(existing?: GrowthCustomer) {
  const store = createMemoryStore({ now: () => now });
  if (existing) store.putCustomer(existing);
  const sendText = vi.fn(async () => ({ providerMessageId: 'ack-1' }));
  const provider: WhatsAppProvider = { sendText, getStatus: async () => 'connected' };
  return { store, provider, sendText };
}

async function inbound(text: string, existing?: GrowthCustomer, waMessageId = 'in-1') {
  const { store, provider, sendText } = harness(existing);
  const result = await handleInboundText({
    store,
    provider,
    organizationId: 'org_1',
    fromE164: from,
    text,
    waMessageId,
    businessName: 'Sehat Pharmacy',
    now,
  });
  return { store, sendText, result };
}

describe('STOP and START', () => {
  it.each(['STOP', 'stop', 'unsubscribe', 'band karo', 'بند'])(
    'opts out and replies once for %s',
    async (text) => {
      const { store, sendText, result } = await inbound(text, customer());
      expect(result).toBe('opt_out');
      const saved = await store.customer('org_1', 'c1');
      expect(saved?.whatsappOptIn).toBe(false);
      expect(saved?.whatsappOptOutAt).toEqual(now);
      expect(sendText).toHaveBeenCalledOnce();
      expect(sendText).toHaveBeenCalledWith(from, expect.stringContaining('STOP'));
    }
  );

  it('cancels queued rows when the customer replies STOP', async () => {
    const { store, provider } = harness(customer());
    await store.insertMessage({
      organizationId: 'org_1',
      customerId: 'c1',
      direction: 'out',
      waMessageId: null,
      body: 'Offer. Reply STOP to opt out.',
      status: 'queued',
      campaignId: null,
      recipientId: null,
      error: null,
    });
    await handleInboundText({
      store,
      provider,
      organizationId: 'org_1',
      fromE164: from,
      text: 'STOP',
      waMessageId: 'in-stop',
      businessName: 'Sehat Pharmacy',
      now,
    });
    expect(store.messages.find((row) => row.body.startsWith('Offer'))).toMatchObject({
      status: 'failed',
      error: 'cancelled:opt_out',
    });
  });

  it('replies to STOP only once when the webhook is delivered twice', async () => {
    const { store, provider, sendText } = harness(customer());
    const input = {
      store,
      provider,
      organizationId: 'org_1',
      fromE164: from,
      text: 'STOP',
      waMessageId: 'in-once',
      businessName: 'Sehat Pharmacy',
      now,
    };
    await handleInboundText(input);
    await handleInboundText(input);
    expect(sendText).toHaveBeenCalledOnce();
  });

  it.each(['START', 'yes', 'haan', 'ہاں'])('opts in for %s', async (text) => {
    const { store, sendText, result } = await inbound(text, customer({ whatsappOptIn: false }));
    expect(result).toBe('opt_in');
    expect((await store.customer('org_1', 'c1'))?.whatsappOptIn).toBe(true);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('records an unknown number without creating an opted-in customer', async () => {
    const { store, sendText, result } = await inbound('who is this?');
    expect(result).toBe('logged');
    expect(await store.customerByPhone('org_1', from)).toBeNull();
    expect(store.messages).toEqual([
      expect.objectContaining({
        direction: 'in',
        status: 'received',
        customerId: null,
        body: 'who is this?',
      }),
    ]);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('opts in an unknown number only when the text is START', async () => {
    const { store, result } = await inbound('START');
    expect(result).toBe('opt_in');
    expect(await store.customerByPhone('org_1', from)).toMatchObject({
      whatsappOptIn: true,
      whatsappE164: from,
      whatsappOptInAt: now,
    });
  });

  it('does not opt in a known customer who sends an ordinary message', async () => {
    const { store, result } = await inbound('Salaam', customer({ whatsappOptIn: false }));
    expect(result).toBe('logged');
    expect((await store.customer('org_1', 'c1'))?.whatsappOptIn).toBe(false);
  });
});

describe('POS opt-in', () => {
  it('persists the checkbox as whatsappOptIn and whatsappOptInAt', async () => {
    const store = createMemoryStore();
    store.putCustomer(
      customer({ whatsappOptIn: false, whatsappOptInAt: null, whatsappE164: null })
    );
    const saved = await setCustomerOptIn(store, {
      organizationId: 'org_1',
      customerId: 'c1',
      whatsappOptIn: true,
      phone: '03001234567',
      now,
    });
    expect(saved).toMatchObject({
      whatsappOptIn: true,
      whatsappOptInAt: now,
      whatsappE164: '+923001234567',
    });
  });
});
