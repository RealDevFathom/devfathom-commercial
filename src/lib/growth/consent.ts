import { assertBodyHasStop, renderTemplate } from '@/lib/growth/templates';
import { isDuplicateInbound } from '@/lib/growth/whatsapp/duplicate';

import { InvalidWhatsAppPhone, normalizeWhatsAppE164 } from './whatsapp/phone';
import type { WhatsAppProvider } from './whatsapp/provider';
import type { GrowthCustomer, GrowthWhatsAppStore } from './whatsapp/types';

const STOP_KEYWORDS = new Set(['stop', 'unsubscribe', 'band karo', 'بند']);
const START_KEYWORDS = new Set(['start', 'yes', 'haan', 'ہاں']);

export class CustomerNotFound extends Error {
  constructor() {
    super('Customer not found.');
    this.name = 'CustomerNotFound';
  }
}

export function consentKeyword(text: string): 'stop' | 'start' | null {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  if (STOP_KEYWORDS.has(normalized)) return 'stop';
  if (START_KEYWORDS.has(normalized)) return 'start';
  return null;
}

export function optOutConfirmation(business: string): string {
  return renderTemplate(
    'You will no longer receive WhatsApp offers from {{business}}. Reply START to opt back in. Reply STOP to opt out.',
    { business }
  );
}

/** POS checkbox and inbound START/STOP share this write. */
export async function setCustomerOptIn(
  store: GrowthWhatsAppStore,
  input: {
    organizationId: string;
    customerId: string;
    whatsappOptIn: boolean;
    phone?: string | null;
    now: Date;
  }
): Promise<GrowthCustomer> {
  const existing = await store.customer(input.organizationId, input.customerId);
  if (!existing) throw new CustomerNotFound();
  let whatsappE164 = existing.whatsappE164;
  if (input.phone != null && input.phone.trim() !== '') {
    const parsed = normalizeWhatsAppE164(input.phone);
    if (!parsed) throw new InvalidWhatsAppPhone();
    whatsappE164 = parsed;
  }
  if (input.whatsappOptIn && !whatsappE164) throw new InvalidWhatsAppPhone();
  if (!input.whatsappOptIn) await store.cancelQueued(input.organizationId, input.customerId);
  return store.saveCustomer({
    id: existing.id,
    organizationId: existing.organizationId,
    whatsappE164,
    whatsappOptIn: input.whatsappOptIn,
    whatsappOptInAt: input.whatsappOptIn ? input.now : existing.whatsappOptInAt,
    whatsappOptOutAt: input.whatsappOptIn ? existing.whatsappOptOutAt : input.now,
  });
}

async function optInCustomer(
  store: GrowthWhatsAppStore,
  organizationId: string,
  fromE164: string,
  now: Date
): Promise<GrowthCustomer> {
  const existing = await store.customerByPhone(organizationId, fromE164);
  if (!existing) {
    return store.createCustomer({
      organizationId,
      displayName: fromE164,
      whatsappE164: fromE164,
      whatsappOptIn: true,
      whatsappOptInAt: now,
      whatsappOptOutAt: null,
    });
  }
  return store.saveCustomer({
    id: existing.id,
    organizationId,
    whatsappE164: fromE164,
    whatsappOptIn: true,
    whatsappOptInAt: now,
    whatsappOptOutAt: existing.whatsappOptOutAt,
  });
}

/**
 * Records one inbound text and applies consent. STOP replies once through the
 * provider after the opt-out is stored. That reply cannot use `sendText`,
 * which refuses customers who are no longer opted in.
 */
export async function handleInboundText(input: {
  store: GrowthWhatsAppStore;
  provider: WhatsAppProvider;
  organizationId: string;
  fromE164: string;
  text: string;
  waMessageId: string;
  businessName: string;
  now: Date;
}): Promise<'duplicate' | 'opt_out' | 'opt_in' | 'logged'> {
  const text = input.text.normalize('NFKC').slice(0, 1000);
  if (await input.store.findInbound(input.organizationId, input.waMessageId)) return 'duplicate';
  const keyword = consentKeyword(text);
  const known = await input.store.customerByPhone(input.organizationId, input.fromE164);
  try {
    await input.store.insertMessage({
      organizationId: input.organizationId,
      customerId: known?.id ?? null,
      direction: 'in',
      waMessageId: input.waMessageId,
      body: text,
      status: 'received',
      campaignId: null,
      recipientId: null,
      error: null,
    });
  } catch (error) {
    if (isDuplicateInbound(error)) return 'duplicate';
    throw error;
  }

  if (keyword === 'stop') {
    if (known) {
      await setCustomerOptIn(input.store, {
        organizationId: input.organizationId,
        customerId: known.id,
        whatsappOptIn: false,
        now: input.now,
      });
    }
    const business = input.businessName.trim() || 'this shop';
    const body = optOutConfirmation(business);
    assertBodyHasStop(body);
    try {
      const sent = await input.provider.sendText(input.fromE164, body);
      await input.store.insertMessage({
        organizationId: input.organizationId,
        customerId: known?.id ?? null,
        direction: 'out',
        waMessageId: sent.providerMessageId,
        body,
        status: 'sent',
        campaignId: null,
        recipientId: null,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'send failed';
      await input.store.insertMessage({
        organizationId: input.organizationId,
        customerId: known?.id ?? null,
        direction: 'out',
        waMessageId: null,
        body,
        status: 'failed',
        campaignId: null,
        recipientId: null,
        error: message.slice(0, 300),
      });
    }
    return 'opt_out';
  }

  if (keyword === 'start') {
    await optInCustomer(input.store, input.organizationId, input.fromE164, input.now);
    return 'opt_in';
  }
  return 'logged';
}
