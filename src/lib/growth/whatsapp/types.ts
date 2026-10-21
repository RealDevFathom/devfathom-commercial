/**
 * WhatsApp channel rows. Prisma models are `GrowthWa*` (`growth_wa_*` tables)
 * so a later G1 growth schema can use its own names. The tenant key is
 * `organizationId`.
 */

export type MessageDirection = 'out' | 'in';

export type MessageStatus =
  'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'received';

export type GrowthCustomer = {
  id: string;
  organizationId: string;
  displayName: string | null;
  whatsappE164: string | null;
  whatsappOptIn: boolean;
  whatsappOptInAt: Date | null;
  whatsappOptOutAt: Date | null;
};

export type GrowthSettings = {
  organizationId: string;
  monthlyBudgetMinor: number;
  autoApproveUnderMinor: number;
  quietHoursStart: number;
  quietHoursEnd: number;
  maxMsgsPerDay: number;
  minSecondsBetweenMsgs: number;
  waInstanceName: string | null;
  waApiUrl: string | null;
  waApiKeyEnc: string | null;
  /** SHA-256 hex of the per-instance webhook secret. The ciphertext is not required to authenticate. */
  waWebhookSecretHash?: string | null;
  waWebhookSecretEnc?: string | null;
  churnThreshold: number;
  /** Pairing proxy: the model has no pairedAt, so warm-up starts here. */
  createdAt: Date | null;
};

export type MessageLogRow = {
  id: string;
  organizationId: string;
  customerId: string | null;
  direction: MessageDirection;
  waMessageId: string | null;
  body: string;
  status: MessageStatus;
  campaignId: string | null;
  recipientId: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MessageTemplateRow = {
  id: string;
  organizationId: string;
  key: string;
  language: string;
  body: string;
};

export type NewMessage = {
  organizationId: string;
  customerId: string | null;
  direction: MessageDirection;
  waMessageId: string | null;
  body: string;
  status: MessageStatus;
  campaignId: string | null;
  recipientId: string | null;
  error: string | null;
};

export type CustomerWrite = {
  id: string;
  organizationId: string;
  whatsappE164: string | null;
  whatsappOptIn: boolean;
  whatsappOptInAt: Date | null;
  whatsappOptOutAt: Date | null;
};

export type GrowthWhatsAppStore = {
  settings(organizationId: string): Promise<GrowthSettings | null>;
  organizationIdForInstance(instance: string): Promise<string | null>;
  organizationForWebhookSecret(
    secretHash: string
  ): Promise<{ organizationId: string; waWebhookSecretHash: string } | null>;
  organization(organizationId: string): Promise<{ timezone: string; displayName: string } | null>;
  customer(organizationId: string, customerId: string): Promise<GrowthCustomer | null>;
  customerByPhone(organizationId: string, whatsappE164: string): Promise<GrowthCustomer | null>;
  saveCustomer(input: CustomerWrite): Promise<GrowthCustomer>;
  createCustomer(
    input: Omit<CustomerWrite, 'id'> & { displayName: string | null }
  ): Promise<GrowthCustomer>;
  /** Insert or update the opt-out for this phone. A concurrent STOP must not surface P2002. */
  upsertOptOutByPhone(input: {
    organizationId: string;
    displayName: string | null;
    whatsappE164: string;
    whatsappOptOutAt: Date;
  }): Promise<GrowthCustomer>;
  queuedMessages(organizationId: string, limit: number): Promise<MessageLogRow[]>;
  /** Commits a queued row to `sending` so a later rollback cannot return it to the queue. */
  claimQueued(organizationId: string, id: string): Promise<MessageLogRow | null>;
  countSentToday(organizationId: string, since: Date): Promise<number>;
  /** Outbound marketing rows for one customer since `since`. Utility sends leave `campaignId` null. */
  countMarketingSince(organizationId: string, customerId: string, since: Date): Promise<number>;
  saveWebhookSecret(
    organizationId: string,
    secret: { waWebhookSecretHash: string; waWebhookSecretEnc: string }
  ): Promise<void>;
  markMessage(
    id: string,
    patch: Partial<Pick<MessageLogRow, 'status' | 'waMessageId' | 'error'>>
  ): Promise<void>;
  insertMessage(input: NewMessage): Promise<MessageLogRow>;
  findInbound(organizationId: string, waMessageId: string): Promise<MessageLogRow | null>;
  findOutboundByProviderId(
    organizationId: string,
    waMessageId: string
  ): Promise<MessageLogRow | null>;
  cancelQueued(organizationId: string, customerId: string): Promise<number>;
  templates(organizationId: string): Promise<MessageTemplateRow[]>;
  saveTemplate(input: {
    organizationId: string;
    key: string;
    language: string;
    body: string;
  }): Promise<MessageTemplateRow>;
};

/** Thrown when a send or enqueue targets a customer who is not opted in. */
export class NotOptedIn extends Error {
  constructor() {
    super('Customer has not opted in to WhatsApp.');
    this.name = 'NotOptedIn';
  }
}
