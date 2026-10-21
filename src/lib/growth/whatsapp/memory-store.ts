import { DuplicateInboundMessage } from './duplicate';
import type {
  GrowthCustomer,
  GrowthSettings,
  GrowthWhatsAppStore,
  MessageLogRow,
  MessageTemplateRow,
} from './types';

export type MemoryStore = GrowthWhatsAppStore & {
  putSettings(row: GrowthSettings): void;
  putCustomer(row: GrowthCustomer): void;
  messages: MessageLogRow[];
};

/** In-memory store for unit tests. Not used by the webhook or the tick. */
export function createMemoryStore(options?: { now?: () => Date }): MemoryStore {
  const now = options?.now ?? (() => new Date());
  const settings = new Map<string, GrowthSettings>();
  const customers: GrowthCustomer[] = [];
  const messages: MessageLogRow[] = [];
  const templates: MessageTemplateRow[] = [];
  let sequence = 0;

  function nextId(prefix: string) {
    sequence += 1;
    return `${prefix}_${sequence}`;
  }

  const store: GrowthWhatsAppStore = {
    async settings(organizationId) {
      return settings.get(organizationId) ?? null;
    },
    async organizationIdForInstance(instance) {
      const matches = [...settings.values()].filter(
        (row) => row.waInstanceName === instance || row.organizationId === instance
      );
      return matches.length === 1 ? matches[0]!.organizationId : null;
    },
    async organizationForWebhookSecret(secretHash) {
      const matches = [...settings.values()].filter(
        (row) => row.waWebhookSecretHash === secretHash
      );
      if (matches.length !== 1 || !matches[0]?.waWebhookSecretHash) return null;
      return {
        organizationId: matches[0].organizationId,
        waWebhookSecretHash: matches[0].waWebhookSecretHash,
      };
    },
    async organization() {
      return { timezone: 'Asia/Karachi', displayName: 'Demo Pharmacy' };
    },
    async customer(organizationId, customerId) {
      return (
        customers.find((row) => row.organizationId === organizationId && row.id === customerId) ??
        null
      );
    },
    async customerByPhone(organizationId, whatsappE164) {
      return (
        customers.find(
          (row) => row.organizationId === organizationId && row.whatsappE164 === whatsappE164
        ) ?? null
      );
    },
    async saveCustomer(input) {
      const index = customers.findIndex(
        (row) => row.id === input.id && row.organizationId === input.organizationId
      );
      if (index < 0) throw new Error('Customer not found.');
      const current = customers[index]!;
      const saved = { ...current, ...input };
      customers[index] = saved;
      return saved;
    },
    async createCustomer(input) {
      const created: GrowthCustomer = {
        id: nextId('cus'),
        organizationId: input.organizationId,
        displayName: input.displayName,
        whatsappE164: input.whatsappE164,
        whatsappOptIn: input.whatsappOptIn,
        whatsappOptInAt: input.whatsappOptInAt,
        whatsappOptOutAt: input.whatsappOptOutAt,
      };
      customers.push(created);
      return created;
    },
    async upsertOptOutByPhone(input) {
      const existing = customers.find(
        (row) =>
          row.organizationId === input.organizationId && row.whatsappE164 === input.whatsappE164
      );
      if (existing) {
        existing.whatsappOptIn = false;
        existing.whatsappOptOutAt = input.whatsappOptOutAt;
        return { ...existing };
      }
      const created: GrowthCustomer = {
        id: nextId('cus'),
        organizationId: input.organizationId,
        displayName: input.displayName,
        whatsappE164: input.whatsappE164,
        whatsappOptIn: false,
        whatsappOptInAt: null,
        whatsappOptOutAt: input.whatsappOptOutAt,
      };
      customers.push(created);
      return created;
    },
    async claimQueued(organizationId, id) {
      const row = messages.find(
        (item) =>
          item.id === id &&
          item.organizationId === organizationId &&
          item.direction === 'out' &&
          item.status === 'queued'
      );
      if (!row) return null;
      row.status = 'sending';
      row.updatedAt = now();
      return { ...row };
    },
    async queuedMessages(organizationId, limit) {
      return messages
        .filter(
          (row) =>
            row.organizationId === organizationId &&
            row.direction === 'out' &&
            row.status === 'queued'
        )
        .sort(
          (left, right) =>
            left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)
        )
        .slice(0, limit);
    },
    async countSentToday(organizationId, since) {
      return messages.filter(
        (row) =>
          row.organizationId === organizationId &&
          row.direction === 'out' &&
          (row.status === 'sent' || row.status === 'delivered' || row.status === 'read') &&
          row.updatedAt >= since
      ).length;
    },
    async countMarketingSince(organizationId, customerId, since) {
      return messages.filter(
        (row) =>
          row.organizationId === organizationId &&
          row.customerId === customerId &&
          row.direction === 'out' &&
          row.campaignId != null &&
          row.status !== 'failed' &&
          row.createdAt >= since
      ).length;
    },
    async saveWebhookSecret(organizationId, secret) {
      const current = settings.get(organizationId);
      settings.set(organizationId, {
        organizationId,
        monthlyBudgetMinor: current?.monthlyBudgetMinor ?? 0,
        autoApproveUnderMinor: current?.autoApproveUnderMinor ?? 0,
        quietHoursStart: current?.quietHoursStart ?? 21,
        quietHoursEnd: current?.quietHoursEnd ?? 9,
        maxMsgsPerDay: current?.maxMsgsPerDay ?? 200,
        minSecondsBetweenMsgs: current?.minSecondsBetweenMsgs ?? 4,
        waInstanceName: current?.waInstanceName ?? null,
        waApiUrl: current?.waApiUrl ?? null,
        waApiKeyEnc: current?.waApiKeyEnc ?? null,
        waWebhookSecretHash: secret.waWebhookSecretHash,
        waWebhookSecretEnc: secret.waWebhookSecretEnc,
        churnThreshold: current?.churnThreshold ?? 60,
        createdAt: current?.createdAt ?? now(),
      });
    },
    async markMessage(id, patch) {
      const row = messages.find((item) => item.id === id);
      if (!row) return;
      if (patch.status) row.status = patch.status;
      if ('waMessageId' in patch) row.waMessageId = patch.waMessageId ?? null;
      if ('error' in patch) row.error = patch.error ?? null;
      row.updatedAt = now();
    },
    async insertMessage(input) {
      if (
        input.waMessageId &&
        messages.some(
          (row) =>
            row.organizationId === input.organizationId && row.waMessageId === input.waMessageId
        )
      ) {
        throw new DuplicateInboundMessage();
      }
      const stamp = now();
      const row: MessageLogRow = {
        id: nextId('msg'),
        ...input,
        createdAt: stamp,
        updatedAt: stamp,
      };
      messages.push(row);
      return row;
    },
    async findInbound(organizationId, waMessageId) {
      return (
        messages.find(
          (row) =>
            row.organizationId === organizationId &&
            row.direction === 'in' &&
            row.waMessageId === waMessageId
        ) ?? null
      );
    },
    async findOutboundByProviderId(organizationId, waMessageId) {
      return (
        messages.find(
          (row) =>
            row.organizationId === organizationId &&
            row.direction === 'out' &&
            row.waMessageId === waMessageId
        ) ?? null
      );
    },
    async cancelQueued(organizationId, customerId) {
      let count = 0;
      for (const row of messages) {
        if (
          row.organizationId === organizationId &&
          row.customerId === customerId &&
          row.direction === 'out' &&
          ['queued', 'sending'].includes(row.status)
        ) {
          row.status = 'failed';
          row.error = 'cancelled:opt_out';
          row.updatedAt = now();
          count += 1;
        }
      }
      return count;
    },
    async templates(organizationId) {
      return templates.filter((row) => row.organizationId === organizationId);
    },
    async saveTemplate(input) {
      const existing = templates.find(
        (row) =>
          row.organizationId === input.organizationId &&
          row.key === input.key &&
          row.language === input.language
      );
      if (existing) {
        existing.body = input.body;
        return existing;
      }
      const created: MessageTemplateRow = { id: nextId('tpl'), ...input };
      templates.push(created);
      return created;
    },
  };

  return Object.assign(store, {
    putSettings(row: GrowthSettings) {
      settings.set(row.organizationId, row);
    },
    putCustomer(row: GrowthCustomer) {
      customers.push(row);
    },
    messages,
  });
}
