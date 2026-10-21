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

/**
 * Maps the growth store onto Prisma delegates named for the WP-G1 models:
 * `growthSettings`, `customer`, `messageLog`, `messageTemplate`.
 */
export function growthStore(db: object): GrowthWhatsAppStore {
  const organizations = db as OrganizationReader;
  const settingsModel = () => model(db, 'growthSettings');
  const customers = () => model(db, 'customer');
  const messages = () => model(db, 'messageLog');
  const templates = () => model(db, 'messageTemplate');

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
    async markMessage(id, patch) {
      await call(messages().update, { where: { id }, data: patch });
    },
    async insertMessage(input: NewMessage) {
      const created = await call(messages().create, { data: input });
      const message = asMessage(created);
      if (!message) throw new Error('Message log row was not created.');
      return message;
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
        where: { organizationId, customerId, direction: 'out', status: 'queued' },
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
