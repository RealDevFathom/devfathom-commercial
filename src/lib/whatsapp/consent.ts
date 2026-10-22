import 'server-only';

import type { Action, Subject } from '@/lib/abac';
import { getTierForFeature, type AITier } from '@/lib/ai/tiers';
import type {
  WhatsAppAdapterPort,
  WhatsAppOutboundMessage,
  WhatsAppSendReceipt,
} from '@/lib/ai/shared/wa-adapter.types';

export const WHATSAPP_AI_LABEL = 'DevFathom AI';
export type WhatsAppConsentSource = 'OWNER' | 'CUSTOMER' | 'WEBHOOK' | 'IMPORT';
export type WhatsAppConsentActor = { id: string; type: 'USER' | 'CUSTOMER' | 'SYSTEM' };
export type WhatsAppConsentEvent = {
  organizationId: string;
  customerId: string;
  optedIn: boolean;
  occurredAt: Date;
  source: WhatsAppConsentSource;
  actor: WhatsAppConsentActor;
};
export type WhatsAppAISettings = { organizationId: string; ownerEnabled: boolean };
export type WhatsAppAudit = {
  organizationId: string;
  actor: WhatsAppConsentActor;
  action: 'OPT_IN' | 'OPT_OUT' | 'OWNER_TOGGLE' | 'AI_ACTION' | 'AI_DRAFT' | 'AI_APPROVAL' | 'AI_SEND';
  oldValue: unknown;
  newValue: unknown;
  occurredAt: Date;
  model: string | null;
  tier: AITier | null;
};

/** All persistence methods receive organizationId so adapters remain RLS/tenant-scope safe. */
export interface WhatsAppConsentStore {
  latestConsent(organizationId: string, customerId: string): Promise<WhatsAppConsentEvent | null>;
  appendConsent(event: WhatsAppConsentEvent): Promise<void>;
  settings(organizationId: string): Promise<WhatsAppAISettings | null>;
  setOwnerEnabled(organizationId: string, enabled: boolean): Promise<void>;
  appendAudit(entry: WhatsAppAudit): Promise<void>;
}

/** Read helper shared by all outbound paths; absence and tenant mismatches deny. */
export async function isOptedIn(
  store: Pick<WhatsAppConsentStore, 'latestConsent'>,
  organizationId: string,
  customerId: string
): Promise<boolean> {
  const event = await store.latestConsent(organizationId, customerId);
  return Boolean(
    event?.organizationId === organizationId &&
      event.customerId === customerId &&
      event.optedIn
  );
}

type Can = (subject: Subject, action: Action) => Promise<boolean>;
export type AITrace = { model: string; tier?: AITier };

const STOP = new Set(['stop', 'stopall', 'stop all', 'unsubscribe', 'opt out', 'optout']);
export function isStopKeyword(text: string): boolean {
  return STOP.has(text.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' '));
}

export class WhatsAppConsentService {
  constructor(
    private readonly store: WhatsAppConsentStore,
    private readonly adapter: WhatsAppAdapterPort,
    private readonly can: Can,
    private readonly now: () => Date = () => new Date()
  ) {}

  async isOptedIn(organizationId: string, customerId: string): Promise<boolean> {
    return isOptedIn(this.store, organizationId, customerId);
  }

  async recordOwnerConsent(input: {
    organizationId: string;
    customerId: string;
    actor: Subject;
    optedIn: boolean;
  }): Promise<void> {
    if (!(await this.can(input.actor, 'customers:manage'))) throw new Error('FORBIDDEN');
    await this.recordConsent({
      organizationId: input.organizationId,
      customerId: input.customerId,
      optedIn: input.optedIn,
      source: 'OWNER',
      actor: { id: input.actor.id, type: 'USER' },
    });
  }

  async recordConsent(input: Omit<WhatsAppConsentEvent, 'occurredAt'>): Promise<void> {
    const latest = await this.store.latestConsent(input.organizationId, input.customerId);
    const tenantLatest =
      latest?.organizationId === input.organizationId && latest.customerId === input.customerId
        ? latest
        : null;
    if (tenantLatest?.optedIn === input.optedIn) return;
    const oldValue = tenantLatest?.optedIn ?? false;
    const occurredAt = this.now();
    await this.store.appendConsent({ ...input, occurredAt });
    await this.store.appendAudit({
      organizationId: input.organizationId,
      actor: input.actor,
      action: input.optedIn ? 'OPT_IN' : 'OPT_OUT',
      oldValue,
      newValue: input.optedIn,
      occurredAt,
      model: null,
      tier: null,
    });
  }

  /** Webhooks should call this before any other message handling. */
  async handleWebhookText(input: {
    organizationId: string;
    customerId: string;
    text: string;
  }): Promise<'OPTED_OUT' | 'IGNORED'> {
    if (!isStopKeyword(input.text)) return 'IGNORED';
    await this.recordConsent({
      organizationId: input.organizationId,
      customerId: input.customerId,
      optedIn: false,
      source: 'WEBHOOK',
      actor: { id: input.customerId, type: 'CUSTOMER' },
    });
    return 'OPTED_OUT';
  }

  async setOwnerEnabled(input: {
    organizationId: string;
    actor: Subject;
    enabled: boolean;
  }): Promise<void> {
    // customers:manage has no default policy: only an explicit central grant allows it,
    // while the central engine gives any explicit DENY precedence.
    if (!(await this.can(input.actor, 'customers:manage'))) throw new Error('FORBIDDEN');
    if (input.enabled && !(await this.adapter.isProviderConfigured(input.organizationId))) {
      throw new Error('AI_PROVIDER_NOT_CONFIGURED');
    }
    const settings = await this.store.settings(input.organizationId);
    const oldValue =
      settings?.organizationId === input.organizationId ? settings.ownerEnabled : false;
    await this.store.setOwnerEnabled(input.organizationId, input.enabled);
    await this.store.appendAudit({
      organizationId: input.organizationId,
      actor: { id: input.actor.id, type: 'USER' },
      action: 'OWNER_TOGGLE', oldValue, newValue: input.enabled, occurredAt: this.now(),
      model: null, tier: null,
    });
  }

  async aiEnabled(organizationId: string): Promise<boolean> {
    const settings = await this.store.settings(organizationId);
    const enabled = settings?.organizationId === organizationId && settings.ownerEnabled;
    return enabled && this.adapter.isProviderConfigured(organizationId);
  }

  async auditAI(input: { organizationId: string; actor: WhatsAppConsentActor; action: 'AI_ACTION' | 'AI_DRAFT' | 'AI_APPROVAL'; oldValue: unknown; newValue: unknown; trace: AITrace }): Promise<void> {
    const { trace, ...entry } = input;
    await this.store.appendAudit({ ...entry, occurredAt: this.now(), tier: trace.tier ?? getTierForFeature('whatsapp'), model: trace.model });
  }

  /** The only outbound entry point: consent and org/provider gates are checked for every send. */
  async send(input: WhatsAppOutboundMessage & { actor: WhatsAppConsentActor; trace: AITrace }): Promise<WhatsAppSendReceipt> {
    if (!(await this.isOptedIn(input.organizationId, input.customerId))) throw new Error('WHATSAPP_NOT_OPTED_IN');
    if (!(await this.aiEnabled(input.organizationId))) throw new Error('WHATSAPP_AI_DISABLED');
    const receipt = await this.adapter.send(input);
    await this.store.appendAudit({
      organizationId: input.organizationId, actor: input.actor, action: 'AI_SEND',
      oldValue: null, newValue: { customerId: input.customerId, providerMessageId: receipt.providerMessageId },
      occurredAt: this.now(), model: input.trace.model,
      tier: input.trace.tier ?? getTierForFeature('whatsapp'),
    });
    return receipt;
  }
}
