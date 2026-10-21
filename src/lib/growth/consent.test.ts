import { describe, expect, it, vi } from 'vitest';

import { handleInboundText, RecordedOptOut, setCustomerOptIn } from './consent';
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
  it.each([
    'STOP',
    'stop',
    'unsubscribe',
    'band karo',
    'بند',
    'STOP.',
    'stop please',
    'STOP ALL',
    'Unsubscribe',
    'Band Karo!',
    ...['رک جاؤ', 'ruk jao', 'ruk jaao', 'band kar do'].flatMap((phrase) => [
      phrase,
      phrase.replace(/ /g, ''),
      phrase.replace(/ /g, '  \t'),
      [...phrase].join(' '),
      phrase.replace(/ /g, '\u200c'),
      [...phrase].map((letter) => (letter === ' ' ? letter : `${letter}\u064e`)).join(''),
    ]),
  ])('opts out and replies once for %s', async (text) => {
    const { store, sendText, result } = await inbound(text, customer());
    expect(result).toBe('opt_out');
    const saved = await store.customer('org_1', 'c1');
    expect(saved?.whatsappOptIn).toBe(false);
    expect(saved?.whatsappOptOutAt).toEqual(now);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith(from, expect.stringContaining('START / شروع'));
    expect(sendText).toHaveBeenCalledWith(from, expect.stringContaining('STOP'));
    expect(sendText).toHaveBeenCalledWith(from, expect.stringContaining('آپ کو'));
  });

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

  it('drops a duplicate inbound when the first lookup misses the row', async () => {
    const { store, provider, sendText } = harness(customer());
    store.findInbound = async () => null;
    const input = {
      store,
      provider,
      organizationId: 'org_1',
      fromE164: from,
      text: 'hello',
      waMessageId: 'in-race',
      businessName: 'Sehat Pharmacy',
      now,
    };
    expect(await handleInboundText(input)).toBe('logged');
    expect(await handleInboundText(input)).toBe('duplicate');
    expect(store.messages.filter((row) => row.direction === 'in')).toHaveLength(1);
    expect(sendText).not.toHaveBeenCalled();
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
    expect(sendText).toHaveBeenCalledWith(from, expect.stringContaining('START / شروع'));
  });

  it.each(['START', 'start ', 'شروع', '  START \t', ' شروع '])('opts in for %s', async (text) => {
    const { store, sendText, result } = await inbound(
      text,
      customer({ whatsappOptIn: false, whatsappOptOutAt: now })
    );
    expect(result).toBe('opt_in');
    expect((await store.customer('org_1', 'c1'))?.whatsappOptIn).toBe(true);
    expect(sendText).not.toHaveBeenCalled();
  });

  it.each([
    'yes',
    'haan',
    'ہاں',
    ' ہاں ',
    "Yes, I'll pick it up tomorrow",
    'yes please',
    'START offers',
    'haan kal',
    'ہاں کل',
    'START.',
    'yes!',
    `START${' '.repeat(1000)}tomorrow`,
  ])('does not re-subscribe for %s', async (text) => {
    const { store, result } = await inbound(
      text,
      customer({ whatsappOptIn: false, whatsappOptOutAt: now })
    );
    expect(result).toBe('logged');
    expect(await store.customer('org_1', 'c1')).toMatchObject({
      whatsappOptIn: false,
      whatsappOptOutAt: now,
    });
    expect(await (await inbound(text)).store.customerByPhone('org_1', from)).toBeNull();
  });

  it('does not treat stopwatch as an opt-out', async () => {
    const { store, result } = await inbound('stopwatch', customer());
    expect(result).toBe('logged');
    expect((await store.customer('org_1', 'c1'))?.whatsappOptIn).toBe(true);
  });

  it('records STOP from an unknown number so a later till opt-in cannot reverse it', async () => {
    const { store, sendText, result } = await inbound('STOP.');
    expect(result).toBe('opt_out');
    const saved = await store.customerByPhone('org_1', from);
    expect(saved).toMatchObject({
      whatsappOptIn: false,
      whatsappOptOutAt: now,
      whatsappE164: from,
    });
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith(from, expect.stringContaining('START / شروع'));
    await expect(
      setCustomerOptIn(store, {
        organizationId: 'org_1',
        customerId: saved!.id,
        whatsappOptIn: true,
        now,
      })
    ).rejects.toBeInstanceOf(RecordedOptOut);
    expect((await store.customer('org_1', saved!.id))?.whatsappOptIn).toBe(false);
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
    const { store, result } = await inbound(
      'Salaam',
      customer({ whatsappOptIn: false, whatsappOptOutAt: now })
    );
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
