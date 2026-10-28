import { createHash } from 'node:crypto';

import type { StoreUnit } from './whatsapp/queue';
import { assertBodyHasStop, renderTemplate } from '@/lib/growth/templates';
import { isDuplicateInbound } from '@/lib/growth/whatsapp/duplicate';

import { InvalidWhatsAppPhone, normalizeWhatsAppE164 } from './whatsapp/phone';
import type { WhatsAppProvider } from './whatsapp/provider';
import type { GrowthCustomer, GrowthWhatsAppStore } from './whatsapp/types';

const STOP_PHRASES = [
  'stop',
  'unsubscribe',
  'band karo',
  'بند',
  'رک جاؤ',
  'ruk jao',
  'ruk jaao',
  'band kar do',
];
const START_KEYWORDS = new Set(['start', 'شروع']);

export class CustomerNotFound extends Error {
  constructor() {
    super('Customer not found.');
    this.name = 'CustomerNotFound';
  }
}

/** A recorded STOP cannot be reversed from the till. The customer replies START. */
export class RecordedOptOut extends Error {
  constructor() {
    super('This number opted out. Only the customer can opt back in.');
    this.name = 'RecordedOptOut';
  }
}

function normalizeConsentText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\p{M}\p{Cf}\u0640]/gu, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function consentKeyword(text: string): 'stop' | 'start' | null {
  const normalized = normalizeConsentText(text);
  if (!normalized) return null;
  for (const phrase of STOP_PHRASES) {
    const letters = [...normalizeConsentText(phrase).replace(/ /g, '')];
    const pattern = new RegExp(`^${letters.join('\\s*')}(?: |$)`, 'u');
    if (pattern.test(normalized)) return 'stop';
  }
  if (START_KEYWORDS.has(text.trim().toLowerCase())) return 'start';
  return null;
}

export function optOutConfirmation(business: string): string {
  return renderTemplate(
    'You will no longer receive WhatsApp offers from {{business}}. Reply START / شروع to opt back in. Reply STOP to opt out.\nآپ کو اب {{business}} کی واٹس ایپ آفرز نہیں ملیں گی۔ دوبارہ شامل ہونے کے لیے START / شروع لکھیں۔',
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
  if (input.whatsappOptIn && existing.whatsappOptOutAt && !existing.whatsappOptIn) {
    throw new RecordedOptOut();
  }
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
  /** Production defers this work until the consent transaction commits. */
  afterCommit?: (send: () => Promise<void>) => void;
  confirmationUnit?: StoreUnit;
}): Promise<'duplicate' | 'opt_out' | 'opt_in' | 'logged'> {
  const text = input.text.normalize('NFKC').slice(0, 1000);
  if (await input.store.findInbound(input.organizationId, input.waMessageId)) return 'duplicate';
  const keyword = consentKeyword(input.text);
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
    let customerId = known?.id ?? null;
    if (known) {
      await setCustomerOptIn(input.store, {
        organizationId: input.organizationId,
        customerId: known.id,
        whatsappOptIn: false,
        now: input.now,
      });
    } else {
      const created = await input.store.upsertOptOutByPhone({
        organizationId: input.organizationId,
        displayName: input.fromE164,
        whatsappE164: input.fromE164,
        whatsappOptOutAt: input.now,
      });
      customerId = created.id;
    }
    const business = input.businessName.trim() || 'this shop';
    const body = optOutConfirmation(business);
    assertBodyHasStop(body);
    const send = () =>
      sendOptOutConfirmation({
        unit: input.confirmationUnit ?? (async (run) => run(input.store)),
        provider: input.provider,
        organizationId: input.organizationId,
        customerId,
        fromE164: input.fromE164,
        waMessageId: input.waMessageId,
        body,
      });
    if (input.afterCommit) input.afterCommit(send);
    else await send();
    return 'opt_out';
  }

  if (keyword === 'start') {
    await optInCustomer(input.store, input.organizationId, input.fromE164, input.now);
    return 'opt_in';
  }
  return 'logged';
}

/** A durable claim keyed by the inbound event prevents duplicate confirmations.
 * Provider HTTP runs after the claim commits; ambiguous sends are never retried. */
export async function sendOptOutConfirmation(input: {
  unit: StoreUnit;
  provider: WhatsAppProvider;
  organizationId: string;
  customerId: string | null;
  fromE164: string;
  waMessageId: string;
  body: string;
}) {
  const key = 'opt-out:' + createHash('sha256').update(input.waMessageId).digest('hex');
  const row = await input.unit(async (store) => {
    if (await store.findOutboundByProviderId(input.organizationId, key)) return null;
    try {
      return await store.insertMessage({
        organizationId: input.organizationId,
        customerId: input.customerId,
        direction: 'out',
        waMessageId: key,
        body: input.body,
        status: 'sending',
        campaignId: null,
        recipientId: null,
        error: null,
      });
    } catch (error) {
      if (isDuplicateInbound(error)) return null;
      throw error;
    }
  });
  if (!row) return;
  let patch: { status: 'sent' | 'failed'; error: string | null };
  try {
    await input.provider.sendText(input.fromE164, input.body);
    patch = { status: 'sent', error: null };
  } catch {
    patch = { status: 'failed', error: 'confirmation send failed' };
  }
  // Keep the event key even after sending so a replay cannot claim it again.
  await input.unit((store) => store.markMessage(row.id, patch));
}
