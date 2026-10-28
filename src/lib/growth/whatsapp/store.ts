import { DuplicateInboundMessage, isDuplicateInbound } from './duplicate';
import type {
  CustomerWrite,
  GrowthCustomer,
  GrowthSettings,
  GrowthWhatsAppStore,
  MessageLogRow,
  MessageStatus,
  MessageTemplateRow,
  NewMessage,
} from './types';

type Delegate = {
  findUnique?: (args: unknown) => Promise<unknown>;
  findFirst?: (args: unknown) => Promise<unknown>;
  findMany?: (args: unknown) => Promise<unknown>;
  create?: (args: unknown) => Promise<unknown>;
  update?: (args: unknown) => Promise<unknown>;
  updateMany?: (args: unknown) => Promise<{ count: number }>;
  upsert?: (args: unknown) => Promise<unknown>;
  count?: (args: unknown) => Promise<number>;
};

type OrganizationReader = {
  organization: {
    findUnique(args: {
      where: { id: string };
      select: { timezone: true; displayName: true };
    }): Promise<{ timezone: string; displayName: string } | null>;
  };
};

const MESSAGE_STATUSES = new Set<MessageStatus>([
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'received',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asDate(value: unknown): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function model(db: object, name: string): Delegate {
  const delegate = (db as Record<string, unknown>)[name];
  if (!delegate || typeof delegate !== 'object') {
    throw new Error(
      `Prisma model ${name} is unavailable. Apply the growth migration before using WhatsApp.`
    );
  }
  return delegate as Delegate;
}

async function call<T>(fn: ((args: unknown) => Promise<T>) | undefined, args: unknown): Promise<T> {
  if (!fn) throw new Error('Prisma model is missing the requested operation.');
  return fn(args);
}

function asCustomer(row: unknown): GrowthCustomer | null {
  const value = record(row);
  if (!value || typeof value.id !== 'string' || typeof value.organizationId !== 'string')
    return null;
  return {
    id: value.id,
    organizationId: value.organizationId,
    displayName:
      typeof value.displayName === 'string'
        ? value.displayName
        : typeof value.name === 'string'
          ? value.name
          : null,
    whatsappE164: asString(value.whatsappE164),
    whatsappOptIn: value.whatsappOptIn === true,
    whatsappOptInAt: asDate(value.whatsappOptInAt),
    whatsappOptOutAt: asDate(value.whatsappOptOutAt),
  };
}

function asSettings(row: unknown): GrowthSettings | null {
  const value = record(row);
  if (!value || typeof value.organizationId !== 'string') return null;
  return {
    organizationId: value.organizationId,
    monthlyBudgetMinor: asInt(value.monthlyBudgetMinor, 0),
    autoApproveUnderMinor: asInt(value.autoApproveUnderMinor, 0),
    quietHoursStart: asInt(value.quietHoursStart, 21),
    quietHoursEnd: asInt(value.quietHoursEnd, 9),
    maxMsgsPerDay: asInt(value.maxMsgsPerDay, 200),
    minSecondsBetweenMsgs: asInt(value.minSecondsBetweenMsgs, 4),
    waInstanceName: asString(value.waInstanceName),
    waApiUrl: asString(value.waApiUrl),
    waApiKeyEnc: asString(value.waApiKeyEnc),
    waWebhookSecretHash: asString(value.waWebhookSecretHash),
    waWebhookSecretEnc: asString(value.waWebhookSecretEnc),
    churnThreshold: asInt(value.churnThreshold, 60),
    createdAt: asDate(value.createdAt),
  };
}

function asStatus(value: unknown): MessageStatus {
  return typeof value === 'string' && MESSAGE_STATUSES.has(value as MessageStatus)
    ? (value as MessageStatus)
    : 'failed';
}

function asMessage(row: unknown): MessageLogRow | null {
  const value = record(row);
  if (!value || typeof value.id !== 'string' || typeof value.organizationId !== 'string')
    return null;
  const createdAt = asDate(value.createdAt) ?? new Date(0);
  return {
    id: value.id,
    organizationId: value.organizationId,
    customerId: asString(value.customerId),
    direction: value.direction === 'in' ? 'in' : 'out',
    waMessageId: asString(value.waMessageId),
    body: typeof value.body === 'string' ? value.body : '',
    status: asStatus(value.status),
    campaignId: asString(value.campaignId),
    recipientId: asString(value.recipientId),
    error: asString(value.error),
    createdAt,
    updatedAt: asDate(value.updatedAt) ?? createdAt,
  };
}

function asTemplate(row: unknown): MessageTemplateRow | null {
  const value = record(row);
  if (
    !value ||
    typeof value.id !== 'string' ||
    typeof value.organizationId !== 'string' ||
    typeof value.key !== 'string' ||
    typeof value.body !== 'string'
  ) {
    return null;
  }
  return {
    id: value.id,
    organizationId: value.organizationId,
    key: value.key,
    language: typeof value.language === 'string' ? value.language : 'ur-en',
    body: value.body,
  };
}

function rows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Maps the growth store onto the WhatsApp Prisma delegates:
 * `growthWaSettings`, `growthWaCustomer`, `growthWaMessage`, `growthWaTemplate`.
 * Those names stay off a future G1 `growthSettings` / `customer` / `messageLog` schema.
 */
export function outboundGrowthStore(db: object): GrowthWhatsAppStore {
  const organizations = db as OrganizationReader;
  const settingsModel = () => model(db, 'growthWaSettings');
  const customers = () => model(db, 'growthWaCustomer');
  const messages = () => model(db, 'growthWaMessage');
  const templates = () => model(db, 'growthWaTemplate');

  return {
    async settings(organizationId) {
      const row = await call(settingsModel().findUnique, { where: { organizationId } });
      return asSettings(row);
    },
    async organizationIdForInstance(instance) {
      const found = await call(settingsModel().findMany, {
        where: { OR: [{ waInstanceName: instance }, { organizationId: instance }] },
        take: 2,
      });
      const parsed = rows(found)
        .map(asSettings)
        .filter((row): row is GrowthSettings => row !== null);
      return parsed.length === 1 ? parsed[0].organizationId : null;
    },
    async organizationForWebhookSecret(secretHash) {
      const found = await call(settingsModel().findMany, {
        where: { waWebhookSecretHash: secretHash },
        take: 2,
      });
      const parsed = rows(found)
        .map((row) => {
          const value = record(row);
          const organizationId =
            value && typeof value.organizationId === 'string' ? value.organizationId : null;
          const waWebhookSecretHash =
            value && typeof value.waWebhookSecretHash === 'string'
              ? value.waWebhookSecretHash
              : null;
          return organizationId && waWebhookSecretHash
            ? { organizationId, waWebhookSecretHash }
            : null;
        })
        .filter(
          (row): row is { organizationId: string; waWebhookSecretHash: string } => row !== null
        );
      return parsed.length === 1 ? parsed[0] : null;
    },
    async organization(organizationId) {
      return organizations.organization.findUnique({
        where: { id: organizationId },
        select: { timezone: true, displayName: true },
      });
    },
    async customer(organizationId, customerId) {
      const row = await call(customers().findFirst, { where: { id: customerId, organizationId } });
      return asCustomer(row);
    },
    async customerByPhone(organizationId, whatsappE164) {
      const row = await call(customers().findFirst, { where: { organizationId, whatsappE164 } });
      return asCustomer(row);
    },
    async saveCustomer(input: CustomerWrite) {
      const result = await call(customers().updateMany, {
        where: { id: input.id, organizationId: input.organizationId },
        data: {
          whatsappE164: input.whatsappE164,
          whatsappOptIn: input.whatsappOptIn,
          whatsappOptInAt: input.whatsappOptInAt,
          whatsappOptOutAt: input.whatsappOptOutAt,
        },
      });
      if (!result || result.count !== 1) {
        throw new Error('Customer not found.');
      }
      const saved = await call(customers().findFirst, {
        where: { id: input.id, organizationId: input.organizationId },
      });
      const customer = asCustomer(saved);
      if (!customer) throw new Error('Customer not found.');
      return customer;
    },
    async createCustomer(input) {
      const created = await call(customers().create, {
        data: {
          organizationId: input.organizationId,
          displayName: input.displayName,
          whatsappE164: input.whatsappE164,
          whatsappOptIn: input.whatsappOptIn,
          whatsappOptInAt: input.whatsappOptInAt,
          whatsappOptOutAt: input.whatsappOptOutAt,
        },
      });
      const customer = asCustomer(created);
      if (!customer) throw new Error('Customer not found.');
      return customer;
    },
    async upsertOptOutByPhone(input) {
      const where = {
        organizationId_whatsappE164: {
          organizationId: input.organizationId,
          whatsappE164: input.whatsappE164,
        },
      };
      try {
        const saved = await call(customers().upsert, {
          where,
          create: {
            organizationId: input.organizationId,
            displayName: input.displayName,
            whatsappE164: input.whatsappE164,
            whatsappOptIn: false,
            whatsappOptInAt: null,
            whatsappOptOutAt: input.whatsappOptOutAt,
          },
          update: {
            whatsappOptIn: false,
            whatsappOptOutAt: input.whatsappOptOutAt,
          },
        });
        const customer = asCustomer(saved);
        if (!customer) throw new Error('Customer not found.');
        return customer;
      } catch (error) {
        if (!isUniqueConflict(error)) throw error;
        const existing = await call(customers().findFirst, {
          where: { organizationId: input.organizationId, whatsappE164: input.whatsappE164 },
        });
        const found = asCustomer(existing);
        if (!found) throw error;
        const updated = await call(customers().updateMany, {
          where: { id: found.id, organizationId: found.organizationId },
          data: { whatsappOptIn: false, whatsappOptOutAt: input.whatsappOptOutAt },
        });
        if (!updated || updated.count !== 1) throw error;
        const saved = asCustomer(
          await call(customers().findFirst, {
            where: { id: found.id, organizationId: found.organizationId },
          })
        );
        if (!saved) throw error;
        return saved;
      }
    },
    async queuedMessages(organizationId, limit) {
      const found = await call(messages().findMany, {
        where: { organizationId, status: 'queued', direction: 'out' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
      });
      return rows(found)
        .map(asMessage)
        .filter((row): row is MessageLogRow => row !== null);
    },
    async claimQueued(organizationId, id) {
      const result = await call(messages().updateMany, {
        where: { id, organizationId, direction: 'out', status: 'queued' },
        data: { status: 'sending' },
      });
      if (!result?.count) return null;
      return asMessage(
        await call(messages().findFirst, { where: { id, organizationId, status: 'sending' } })
      );
    },
    async countSentToday(organizationId, since) {
      return call(messages().count, {
        where: {
          organizationId,
          direction: 'out',
          status: { in: ['sent', 'delivered', 'read'] },
          updatedAt: { gte: since },
        },
      });
    },
    async countMarketingSince(organizationId, customerId, since) {
      return call(messages().count, {
        where: {
          organizationId,
          customerId,
          direction: 'out',
          campaignId: { not: null },
          status: { in: ['queued', 'sending', 'sent', 'delivered', 'read'] },
          createdAt: { gte: since },
        },
      });
    },
    async saveWebhookSecret(organizationId, secret) {
      await call(settingsModel().upsert, {
        where: { organizationId },
        create: { organizationId, ...secret },
        update: secret,
      });
    },
    async markMessage(id, patch) {
      await call(messages().update, { where: { id }, data: patch });
    },
    async insertMessage(input: NewMessage) {
      try {
        const created = await call(messages().create, { data: input });
        const message = asMessage(created);
        if (!message) throw new Error('Message log row was not created.');
        return message;
      } catch (error) {
        if (input.direction === 'in' && isDuplicateInbound(error))
          throw new DuplicateInboundMessage();
        throw error;
      }
    },
    async findInbound(organizationId, waMessageId) {
      const row = await call(messages().findFirst, {
        where: { organizationId, direction: 'in', waMessageId },
      });
      return asMessage(row);
    },
    async findOutboundByProviderId(organizationId, waMessageId) {
      const row = await call(messages().findFirst, {
        where: { organizationId, direction: 'out', waMessageId },
      });
      return asMessage(row);
    },
    async cancelQueued(organizationId, customerId) {
      const result = await call(messages().updateMany, {
        where: {
          organizationId,
          customerId,
          direction: 'out',
          status: { in: ['queued', 'sending'] },
        },
        data: { status: 'failed', error: 'cancelled:opt_out' },
      });
      return result?.count ?? 0;
    },
    async templates(organizationId) {
      const found = await call(templates().findMany, { where: { organizationId } });
      return rows(found)
        .map(asTemplate)
        .filter((row): row is MessageTemplateRow => row !== null);
    },
    async saveTemplate(input) {
      const existing = asTemplate(
        await call(templates().findFirst, {
          where: { organizationId: input.organizationId, key: input.key, language: input.language },
        })
      );
      if (existing) {
        const updated = asTemplate(
          await call(templates().update, { where: { id: existing.id }, data: { body: input.body } })
        );
        if (!updated) throw new Error('Message template was not saved.');
        return updated;
      }
      const created = asTemplate(
        await call(templates().create, {
          data: {
            organizationId: input.organizationId,
            key: input.key,
            language: input.language,
            body: input.body,
          },
        })
      );
      if (!created) throw new Error('Message template was not saved.');
      return created;
    },
  };
}

/** General callers can record inbound traffic only. Outbound capability is
 * restricted to queue/consent by the source enforcement test. */
export function growthStore(db: object): Omit<GrowthWhatsAppStore, 'insertMessage'> & {
  insertMessage(input: NewMessage & { direction: 'in' }): Promise<MessageLogRow>;
} {
  const store = outboundGrowthStore(db);
  return {
    ...store,
    async insertMessage(input) {
      if (input.direction !== 'in') throw new Error('growthStore only accepts inbound messages.');
      return store.insertMessage(input);
    },
  };
}
