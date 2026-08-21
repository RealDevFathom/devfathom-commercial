import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type {
  CustomerConsentChannel,
  CustomerIdentifierKind,
} from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type CustomerErrorReason =
  | 'NOT_FOUND'
  | 'DUPLICATE_IDENTIFIER'
  | 'DUPLICATE_TAG'
  | 'INVALID_IDENTIFIER'
  | 'ANONYMIZED'
  | 'INVALID_STATE';

export class CustomerError extends Error {
  constructor(
    message: string,
    readonly reason: CustomerErrorReason
  ) {
    super(message);
    this.name = 'CustomerError';
  }
}

const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;
const CONSENT_CHANNELS: readonly CustomerConsentChannel[] = [
  'EMAIL',
  'SMS',
  'PHONE',
  'WHATSAPP',
  'PUSH',
];

function runInTransaction<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

function isUniqueError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new CustomerError(`${field} is required.`, 'INVALID_STATE');
  return normalized;
}

export type CustomerIdentifierInput = {
  kind: CustomerIdentifierKind;
  value: string;
  verifiedAt?: Date | null;
};

export function normalizeCustomerIdentifier(input: CustomerIdentifierInput): string {
  if (input.kind === 'EMAIL') {
    const normalized = input.value.trim().toLowerCase();
    if (!normalized) throw new CustomerError('Email identifier is empty.', 'INVALID_IDENTIFIER');
    return normalized;
  }
  if (input.kind === 'PHONE' && PHONE_PATTERN.test(input.value)) return input.value;
  throw new CustomerError('Phone identifier must use canonical E.164 format.', 'INVALID_IDENTIFIER');
}

type CustomerProfileInput = {
  displayName?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  birthDate?: Date | null;
  notes?: string | null;
};

function profileData(input: CustomerProfileInput) {
  return {
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    ...(input.givenName !== undefined ? { givenName: input.givenName } : {}),
    ...(input.familyName !== undefined ? { familyName: input.familyName } : {}),
    ...(input.birthDate !== undefined ? { birthDate: input.birthDate } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  };
}

const CUSTOMER_SELECT = {
  id: true,
  displayName: true,
  givenName: true,
  familyName: true,
  birthDate: true,
  notes: true,
  anonymizedAt: true,
  createdAt: true,
  updatedAt: true,
  identifiers: {
    orderBy: [{ kind: 'asc' }, { normalizedValue: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      kind: true,
      normalizedValue: true,
      verifiedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  interactions: {
    orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      branchId: true,
      branch: { select: { id: true, name: true } },
      orderId: true,
      order: { select: { id: true, branchId: true, orderNumber: true, status: true } },
      type: true,
      payload: true,
      occurredAt: true,
      idempotencyKey: true,
      createdAt: true,
    },
  },
  orders: {
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      branchId: true,
      branch: { select: { id: true, name: true } },
      orderNumber: true,
      status: true,
      createdAt: true,
    },
  },
  tagAssignments: {
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, tag: { select: { id: true, name: true, color: true } } },
  },
  consentEvents: {
    orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      channel: true,
      granted: true,
      source: true,
      actorId: true,
      policyVersion: true,
      occurredAt: true,
      idempotencyKey: true,
      createdAt: true,
    },
  },
  loyaltyAccount: {
    select: {
      id: true,
      active: true,
      enrolledAt: true,
      deactivatedAt: true,
      pointsEntries: { select: { points: true } },
    },
  },
} satisfies Prisma.RestaurantCustomerSelect;

type LoadedCustomer = Prisma.RestaurantCustomerGetPayload<{ select: typeof CUSTOMER_SELECT }>;

const CUSTOMER_LIST_SELECT = {
  id: true,
  displayName: true,
  givenName: true,
  familyName: true,
  birthDate: true,
  notes: true,
  anonymizedAt: true,
  createdAt: true,
  updatedAt: true,
  identifiers: CUSTOMER_SELECT.identifiers,
  interactions: {
    orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    take: 5,
    select: {
      id: true,
      branchId: true,
      branch: { select: { id: true, name: true } },
      type: true,
      occurredAt: true,
    },
  },
  tagAssignments: CUSTOMER_SELECT.tagAssignments,
} satisfies Prisma.RestaurantCustomerSelect;

type ListedCustomer = Prisma.RestaurantCustomerGetPayload<{
  select: typeof CUSTOMER_LIST_SELECT;
}>;

function projectCustomer(customer: LoadedCustomer) {
  const currentConsent: Partial<Record<CustomerConsentChannel, LoadedCustomer['consentEvents'][number]>> = {};
  for (const event of customer.consentEvents) currentConsent[event.channel] ??= event;
  const { tagAssignments, loyaltyAccount, ...rest } = customer;
  return {
    ...rest,
    tags: tagAssignments.map(({ tag, createdAt }) => ({ ...tag, assignedAt: createdAt })),
    currentConsent,
    loyaltySummary: loyaltyAccount
      ? {
          id: loyaltyAccount.id,
          active: loyaltyAccount.active,
          enrolledAt: loyaltyAccount.enrolledAt,
          deactivatedAt: loyaltyAccount.deactivatedAt,
          balance: loyaltyAccount.pointsEntries.reduce((sum, entry) => sum + entry.points, 0),
        }
      : null,
  };
}

function projectListedCustomer(customer: ListedCustomer) {
  const { tagAssignments, ...profile } = customer;
  return {
    ...profile,
    tags: tagAssignments.map(({ tag, createdAt }) => ({ ...tag, assignedAt: createdAt })),
  };
}

export async function lockCustomer(db: ScopedDb, customerId: string) {
  const [customer] = await db.$queryRaw<Array<{ id: string; anonymizedAt: Date | null }>>(
    Prisma.sql`
      SELECT "id", "anonymizedAt"
      FROM "restaurant_customers"
      WHERE "id" = ${customerId}
      FOR UPDATE
    `
  );
  if (!customer) throw new CustomerError('Customer does not exist.', 'NOT_FOUND');
  return customer;
}

async function requireActiveCustomer(db: ScopedDb, customerId: string) {
  const customer = await lockCustomer(db, customerId);
  if (customer.anonymizedAt) throw new CustomerError('Customer is anonymized.', 'ANONYMIZED');
  return customer;
}

export type CreateCustomerInput = CustomerProfileInput & {
  identifiers?: CustomerIdentifierInput[];
};

export async function createCustomer(db: ScopedDb, input: CreateCustomerInput) {
  const identifiers = (input.identifiers ?? []).map((identifier) => ({
    kind: identifier.kind,
    normalizedValue: normalizeCustomerIdentifier(identifier),
    verifiedAt: identifier.verifiedAt,
  }));
  if (new Set(identifiers.map(({ kind, normalizedValue }) => `${kind}:${normalizedValue}`)).size !== identifiers.length) {
    throw new CustomerError('Identifier is duplicated.', 'DUPLICATE_IDENTIFIER');
  }
  try {
    return await runInTransaction(db, async (tx) => {
      const customer = await tx.restaurantCustomer.create({ data: profileData(input) });
      if (identifiers.length) {
        await tx.customerIdentifier.createMany({
          data: identifiers.map((identifier) => ({ ...identifier, customerId: customer.id })),
        });
      }
      return getCustomer(tx, customer.id);
    });
  } catch (error) {
    if (isUniqueError(error)) {
      throw new CustomerError('Identifier already belongs to a customer.', 'DUPLICATE_IDENTIFIER');
    }
    throw error;
  }
}

export type CustomerIdentifierCorrection = CustomerIdentifierInput & { id?: string };
export type CorrectCustomerInput = CustomerProfileInput & {
  customerId: string;
  identifiers?: CustomerIdentifierCorrection[];
};

export async function correctCustomer(db: ScopedDb, input: CorrectCustomerInput) {
  const identifiers = (input.identifiers ?? []).map((identifier) => ({
    ...identifier,
    normalizedValue: normalizeCustomerIdentifier(identifier),
  }));
  try {
    return await runInTransaction(db, async (tx) => {
      await requireActiveCustomer(tx, input.customerId);
      await tx.restaurantCustomer.update({
        where: { id: input.customerId },
        data: profileData(input),
      });
      for (const identifier of identifiers) {
        if (identifier.id) {
          const existing = await tx.customerIdentifier.findFirst({
            where: { id: identifier.id, customerId: input.customerId },
            select: { id: true },
          });
          if (!existing) throw new CustomerError('Identifier does not exist.', 'NOT_FOUND');
          await tx.customerIdentifier.update({
            where: { id: identifier.id },
            data: {
              kind: identifier.kind,
              normalizedValue: identifier.normalizedValue,
              verifiedAt: identifier.verifiedAt,
            },
          });
        } else {
          await tx.customerIdentifier.create({
            data: {
              customerId: input.customerId,
              kind: identifier.kind,
              normalizedValue: identifier.normalizedValue,
              verifiedAt: identifier.verifiedAt,
            },
          });
        }
      }
      return getCustomer(tx, input.customerId);
    });
  } catch (error) {
    if (isUniqueError(error)) {
      throw new CustomerError('Identifier already belongs to a customer.', 'DUPLICATE_IDENTIFIER');
    }
    throw error;
  }
}

export async function getCustomer(db: ScopedDb, customerId: string) {
  const customer = await db.restaurantCustomer.findUnique({
    where: { id: customerId },
    select: CUSTOMER_SELECT,
  });
  if (!customer) throw new CustomerError('Customer does not exist.', 'NOT_FOUND');
  return projectCustomer(customer);
}

export type ListCustomersInput = {
  query?: string;
  tagId?: string;
  tagIds?: string[];
  limit?: number;
  cursor?: string;
};

export async function listCustomers(db: ScopedDb, input: ListCustomersInput = {}) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const query = input.query?.trim();
  const tagIds = [...new Set([...(input.tagIds ?? []), ...(input.tagId ? [input.tagId] : [])])];
  const rows = await db.restaurantCustomer.findMany({
    where: {
      anonymizedAt: null,
      ...(query
        ? {
            OR: [
              { displayName: { contains: query, mode: 'insensitive' } },
              { givenName: { contains: query, mode: 'insensitive' } },
              { familyName: { contains: query, mode: 'insensitive' } },
              { identifiers: { some: { normalizedValue: { contains: query.toLowerCase() } } } },
            ],
          }
        : {}),
      ...(tagIds.length ? { tagAssignments: { some: { tagId: { in: tagIds } } } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: CUSTOMER_LIST_SELECT,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    customers: page.map(projectListedCustomer),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function attachCustomerToOrder(
  db: ScopedDb,
  input: { customerId: string; orderId: string }
) {
  return runInTransaction(db, async (tx) => {
    await requireActiveCustomer(tx, input.customerId);
    const attached = await tx.restaurantOrder.updateMany({
      where: {
        id: input.orderId,
        status: 'OPEN',
        OR: [{ customerId: null }, { customerId: input.customerId }],
      },
      data: { customerId: input.customerId },
    });
    if (attached.count === 0) {
      const order = await tx.restaurantOrder.findUnique({
        where: { id: input.orderId },
        select: { customerId: true, status: true },
      });
      if (!order) throw new CustomerError('Order does not exist.', 'NOT_FOUND');
      if (order.status !== 'OPEN') {
        throw new CustomerError('Customer can only be attached to an OPEN order.', 'INVALID_STATE');
      }
      throw new CustomerError('Order already belongs to another customer.', 'INVALID_STATE');
    }
    return tx.restaurantOrder.findUniqueOrThrow({
      where: { id: input.orderId },
      select: { id: true, branchId: true, customerId: true, status: true },
    });
  });
}

export type AppendCustomerInteractionInput = {
  customerId: string;
  branchId: string;
  orderId?: string | null;
  type: string;
  occurredAt?: Date;
  idempotencyKey: string;
};

export async function appendCustomerInteraction(
  db: ScopedDb,
  input: AppendCustomerInteractionInput
) {
  return runInTransaction(db, async (tx) => {
    await requireActiveCustomer(tx, input.customerId);
    const idempotencyKey = required(input.idempotencyKey, 'Idempotency key');
    const type = required(input.type, 'Interaction type');
    const existing = await tx.customerInteraction.findFirst({
      where: { idempotencyKey },
    });
    if (existing) {
      if (
        existing.customerId !== input.customerId ||
        existing.branchId !== input.branchId ||
        existing.orderId !== (input.orderId ?? null)
      ) {
        throw new CustomerError('Idempotency key belongs to another interaction.', 'INVALID_STATE');
      }
      return existing;
    }
    const branch = await tx.restaurantBranch.findUnique({
      where: { id: input.branchId },
      select: { id: true },
    });
    if (!branch) throw new CustomerError('Branch does not exist.', 'NOT_FOUND');
    if (input.orderId) {
      const order = await tx.restaurantOrder.findUnique({
        where: { id: input.orderId },
        select: { branchId: true, customerId: true },
      });
      if (!order) throw new CustomerError('Order does not exist.', 'NOT_FOUND');
      if (order.branchId !== input.branchId || order.customerId !== input.customerId) {
        throw new CustomerError('Interaction branch, order, and customer do not match.', 'INVALID_STATE');
      }
    }
    await tx.customerInteraction.createMany({
      data: {
        customerId: input.customerId,
        branchId: input.branchId,
        orderId: input.orderId,
        type,
        occurredAt: input.occurredAt,
        idempotencyKey,
      },
      skipDuplicates: true,
    });
    const appended = await tx.customerInteraction.findFirst({ where: { idempotencyKey } });
    if (
      !appended ||
      appended.customerId !== input.customerId ||
      appended.branchId !== input.branchId ||
      appended.orderId !== (input.orderId ?? null)
    ) {
      throw new CustomerError('Idempotency key belongs to another interaction.', 'INVALID_STATE');
    }
    return appended;
  });
}

export type AppendCustomerConsentInput = {
  customerId: string;
  channel: CustomerConsentChannel;
  granted: boolean;
  source: string;
  actorId: string;
  policyVersion: string;
  occurredAt?: Date;
  idempotencyKey: string;
};

export async function appendCustomerConsent(db: ScopedDb, input: AppendCustomerConsentInput) {
  return runInTransaction(db, async (tx) => {
    await requireActiveCustomer(tx, input.customerId);
    if (!CONSENT_CHANNELS.includes(input.channel)) {
      throw new CustomerError('Consent channel is invalid.', 'INVALID_STATE');
    }
    const source = required(input.source, 'Consent source');
    const actorId = required(input.actorId, 'Consent actor');
    const policyVersion = required(input.policyVersion, 'Policy version');
    const idempotencyKey = required(input.idempotencyKey, 'Idempotency key');
    const existing = await tx.customerConsent.findFirst({ where: { idempotencyKey } });
    if (existing) {
      if (existing.customerId !== input.customerId || existing.channel !== input.channel) {
        throw new CustomerError('Idempotency key belongs to another consent event.', 'INVALID_STATE');
      }
      return existing;
    }
    await tx.customerConsent.createMany({
      data: {
        customerId: input.customerId,
        channel: input.channel,
        granted: input.granted,
        source,
        actorId,
        policyVersion,
        occurredAt: input.occurredAt,
        idempotencyKey,
      },
      skipDuplicates: true,
    });
    const appended = await tx.customerConsent.findFirst({ where: { idempotencyKey } });
    if (!appended || appended.customerId !== input.customerId || appended.channel !== input.channel) {
      throw new CustomerError('Idempotency key belongs to another consent event.', 'INVALID_STATE');
    }
    return appended;
  });
}

export async function createCustomerTag(db: ScopedDb, input: { name: string; color?: string | null }) {
  try {
    return await db.customerTag.create({
      data: { name: required(input.name, 'Tag name'), color: input.color },
      select: { id: true, name: true, color: true, createdAt: true, updatedAt: true },
    });
  } catch (error) {
    if (isUniqueError(error)) throw new CustomerError('Tag name already exists.', 'DUPLICATE_TAG');
    throw error;
  }
}

export async function listCustomerTags(db: ScopedDb) {
  return db.customerTag.findMany({
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, color: true, createdAt: true, updatedAt: true },
  });
}

export async function assignCustomerTag(
  db: ScopedDb,
  input: { customerId: string; tagId: string }
) {
  return runInTransaction(db, async (tx) => {
    await requireActiveCustomer(tx, input.customerId);
    const tag = await tx.customerTag.findUnique({ where: { id: input.tagId }, select: { id: true } });
    if (!tag) throw new CustomerError('Tag does not exist.', 'NOT_FOUND');
    return tx.customerTagAssignment.upsert({
      where: { customerId_tagId: input },
      create: input,
      update: {},
    });
  });
}

export async function unassignCustomerTag(
  db: ScopedDb,
  input: { customerId: string; tagId: string }
) {
  return runInTransaction(db, async (tx) => {
    await requireActiveCustomer(tx, input.customerId);
    const result = await tx.customerTagAssignment.deleteMany({ where: input });
    return { removed: result.count > 0 };
  });
}
