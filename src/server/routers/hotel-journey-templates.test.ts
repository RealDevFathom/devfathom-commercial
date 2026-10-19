import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import superjson from 'superjson';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HotelJourneyTemplateShape } from '@/lib/hotel/journey-templates';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async (_subject: unknown, action: string) => action === 'hotel:property-admin'),
  databaseTransaction: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.databaseTransaction } }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: unknown) => user,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { withTenantDb } from '@/lib/tenancy/scoped-db';

import { router, type TRPCContext } from '../trpc';
import { hotelPropertyRouter } from './hotel-property';

type Row = HotelJourneyTemplateShape & {
  id: string;
  organizationId: string;
  branchId: string;
  version: number;
  status: 'DRAFT' | 'APPROVED' | 'RETIRED';
  updatedAt: Date;
  createdAt: Date;
  createdByUserId: string;
  approvedByUserId: string | null;
  approvedAt: Date | null;
};

const ORG = 'org_journey';
const BRANCH = 'property_journey';
const instant = new Date('2026-09-14T00:00:00.000Z');
const draft: Row = {
  id: 'draft_2',
  organizationId: ORG,
  branchId: BRANCH,
  moment: 'WELCOME',
  channel: 'EMAIL',
  language: 'UR',
  subject: 'خوش آمدید {{guest_name}}',
  body: 'محترم {{guest_name}}، کمرہ {{room_number}}۔',
  version: 2,
  status: 'DRAFT',
  updatedAt: instant,
  createdAt: instant,
  createdByUserId: 'author',
  approvedByUserId: null,
  approvedAt: null,
};
const previous: Row = {
  ...draft,
  id: 'approved_1',
  version: 1,
  status: 'APPROVED',
  approvedByUserId: 'previous_approver',
  approvedAt: instant,
};
const input = {
  moment: draft.moment,
  channel: draft.channel,
  language: draft.language,
  subject: draft.subject!,
  body: draft.body,
};

let rows: Row[];
let beforeTransaction: (() => Promise<void>) | null;
let transactionFailure: string | null;
let beforeWrite: (() => Promise<void>) | null;

function matches(row: Row, where: Partial<Row>) {
  return Object.entries(where).every(([key, value]) => {
    const actual = row[key as keyof Row];
    return actual instanceof Date && value instanceof Date
      ? actual.getTime() === value.getTime()
      : actual === value;
  });
}

// A bounded model of conditional writes, without nested rollback. The hook
// runs a competing router request after the first request's reads, before its
// transaction. It deliberately keeps timestamps equal to exercise copy checks.
// This is source regression evidence, not PostgreSQL/RLS concurrency evidence.
const templates = {
  findFirst: vi.fn(async ({ where, orderBy }: { where: Partial<Row>; orderBy?: unknown }) => {
    const found = rows.filter((row) => matches(row, where));
    if (orderBy) found.sort((a, b) => b.version - a.version);
    return found[0] ? { ...found[0] } : null;
  }),
  updateMany: vi.fn(async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
    const competing = beforeWrite;
    beforeWrite = null;
    await competing?.();
    const found = rows.filter((row) => matches(row, where));
    for (const row of found) {
      if (
        data.status === 'APPROVED' &&
        rows.some(
          (other) =>
            other.id !== row.id &&
            other.status === 'APPROVED' &&
            matches(other, {
              organizationId: row.organizationId,
              branchId: row.branchId,
              moment: row.moment,
              channel: row.channel,
              language: row.language,
            })
        )
      )
        throw Object.assign(new Error('approved unique index'), { code: 'P2002' });
      Object.assign(row, data);
    }
    return { count: found.length };
  }),
  create: vi.fn(),
};
const propertyFind = vi.fn(async () => ({ organizationId: ORG, branchId: BRANCH }));
const transaction = vi.fn(
  async (run: (tx: { hotelJourneyTemplate: typeof templates }) => unknown) => {
    const competing = beforeTransaction;
    beforeTransaction = null;
    await competing?.();
    if (transactionFailure)
      throw Object.assign(new Error('transaction failed'), { code: transactionFailure });
    return run({ hotelJourneyTemplate: templates });
  }
);

function context(
  actor = 'current_approver',
  status = 'ACTIVE',
  db = {
    hotelProperty: { findFirst: propertyFind },
    hotelJourneyTemplate: templates,
    $transaction: transaction,
  } as unknown as TRPCContext['db']
): TRPCContext {
  return {
    db,
    entitlements: { organizationId: ORG, enabledModules: ['hotel-core'] },
    session: {
      expires: 'later',
      user: { id: actor, role: 'EMPLOYEE', status },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

function caller(actor = 'current_approver', status = 'ACTIVE') {
  return hotelPropertyRouter.createCaller(context(actor, status)).journeyTemplates;
}

function row(id = draft.id) {
  return rows.find((entry) => entry.id === id)!;
}

describe('journey atomic save and approval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockImplementation(async (_subject, action) => action === 'hotel:property-admin');
    rows = [{ ...previous }, { ...draft }];
    beforeTransaction = null;
    beforeWrite = null;
    transactionFailure = null;
  });

  it('refuses a stale save after approval without changing approved copy or actor', async () => {
    beforeTransaction = async () => {
      await caller('winning_approver').approve({ id: draft.id });
    };
    await expect(caller().save({ ...input, body: 'Replacement' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(row()).toMatchObject({
      body: draft.body,
      status: 'APPROVED',
      approvedByUserId: 'winning_approver',
    });
    expect(row(previous.id).status).toBe('RETIRED');
    expect(templates.create).not.toHaveBeenCalled();
  });

  it('refuses a stale save after retirement', async () => {
    beforeTransaction = async () => {
      await caller().retire({ id: draft.id });
    };
    await expect(caller().save({ ...input, body: 'Replacement' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(row()).toMatchObject({ body: draft.body, status: 'RETIRED' });
  });

  it('preserves the winning draft edit even when timestamp and version are unchanged', async () => {
    beforeTransaction = async () => {
      await caller().save({ ...input, body: 'Winning copy' });
    };
    await expect(caller().save({ ...input, body: 'Stale copy' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(row()).toMatchObject({
      body: 'Winning copy',
      version: 2,
      updatedAt: instant,
      status: 'DRAFT',
    });
  });

  it.each(['body', 'subject'] as const)(
    'refuses approval of changed %s before touching the prior approval',
    async (field) => {
      beforeTransaction = async () => {
        await caller().save({ ...input, [field]: 'New wording' });
      };
      await expect(caller().approve({ id: draft.id })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(row()).toMatchObject({
        [field]: 'New wording',
        status: 'DRAFT',
        approvedByUserId: null,
      });
      expect(row(previous.id)).toEqual(previous);
      expect(templates.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'RETIRED' } })
      );
    }
  );

  it.each([true, false])(
    'keeps the first approver when prior approved version exists: %s',
    async (hasPrevious) => {
      if (!hasPrevious) rows = [{ ...draft }];
      beforeTransaction = async () => {
        await caller('winner').approve({ id: draft.id });
      };
      await expect(caller('loser').approve({ id: draft.id })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(row()).toMatchObject({ status: 'APPROVED', approvedByUserId: 'winner' });
      expect(rows.filter((entry) => entry.status === 'APPROVED')).toHaveLength(1);
    }
  );

  it.each([true, false])(
    'refuses competing different-version approval with prior approval: %s',
    async (hasPrevious) => {
      if (!hasPrevious) rows = [{ ...draft }];
      rows.push({ ...draft, id: 'draft_3', version: 3 });
      beforeTransaction = async () => {
        await caller('winner').approve({ id: 'draft_3' });
      };
      await expect(caller('loser').approve({ id: draft.id })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(row('draft_3')).toMatchObject({ status: 'APPROVED', approvedByUserId: 'winner' });
      expect(row()).toMatchObject({ status: 'DRAFT', approvedByUserId: null });
      expect(rows.filter((entry) => entry.status === 'APPROVED')).toHaveLength(1);
    }
  );

  it.each(['version', 'updatedAt'] as const)(
    'refuses a stale %s even when wording is unchanged',
    async (field) => {
      beforeTransaction = async () => {
        if (field === 'version') row().version += 1;
        else row().updatedAt = new Date(instant.getTime() + 1);
      };
      await expect(caller().approve({ id: draft.id })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(row().status).toBe('DRAFT');
      expect(row(previous.id)).toEqual(previous);
    }
  );

  it('reports a transaction conflict without retrying', async () => {
    transactionFailure = 'P2034';
    await expect(caller().approve({ id: draft.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([previous, draft]);
  });

  it('saves and approves Urdu email within tenant/property scope, preserving actor history', async () => {
    const foreign = [
      { ...previous, id: 'foreign_org', organizationId: 'another_org' },
      { ...previous, id: 'foreign_property', branchId: 'another_property' },
    ];
    rows.push(...foreign);
    await expect(
      caller('editor').save({ ...input, body: 'خوش آمدید {{guest_name}}' })
    ).resolves.toMatchObject({ status: 'DRAFT', version: 2, createdByUserId: 'author' });
    await expect(caller('approver').approve({ id: draft.id })).resolves.toMatchObject({
      status: 'APPROVED',
      approvedByUserId: 'approver',
      approvedAt: expect.any(Date),
      body: 'خوش آمدید {{guest_name}}',
    });
    expect(row(previous.id)).toMatchObject({
      status: 'RETIRED',
      approvedByUserId: 'previous_approver',
      approvedAt: instant,
    });
    expect(foreign.map((entry) => row(entry.id))).toEqual(foreign);
    for (const [args] of [...templates.findFirst.mock.calls, ...templates.updateMany.mock.calls]) {
      expect(args.where).toMatchObject({ organizationId: ORG, branchId: BRANCH });
    }
    expect(propertyFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, active: true } })
    );
    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'approver' }),
      'hotel:property-admin',
      undefined,
      expect.anything()
    );
  });

  it.each(['organizationId', 'branchId'] as const)(
    'refuses approval across %s before writes',
    async (field) => {
      row()[field] = 'outside_scope';
      await expect(caller().approve({ id: draft.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(transaction).not.toHaveBeenCalled();
      expect(templates.updateMany).not.toHaveBeenCalled();
    }
  );

  it('allows marketing to save but refuses approval before template access', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'hotel:marketing');
    await expect(caller('marketer').save({ ...input, body: 'Draft copy' })).resolves.toMatchObject({
      status: 'DRAFT',
    });
    templates.findFirst.mockClear();
    templates.updateMany.mockClear();
    await expect(caller('marketer').approve({ id: draft.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(templates.findFirst).not.toHaveBeenCalled();
    expect(templates.updateMany).not.toHaveBeenCalled();
  });

  it('refuses inactive actors and missing capabilities before reading the property', async () => {
    await expect(caller('inactive', 'INACTIVE').approve({ id: draft.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    mocks.can.mockResolvedValue(false);
    await expect(caller().save(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(propertyFind).not.toHaveBeenCalled();
    expect(templates.updateMany).not.toHaveBeenCalled();
  });
});

describe('journey approval through the reused outer HTTP transaction', () => {
  let outerOutcome: 'committed' | 'rolled_back' | null;
  const httpRouter = router({ hotelProperty: hotelPropertyRouter });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockImplementation(async (_subject, action) => action === 'hotel:property-admin');
    rows = [{ ...previous }, { ...draft }];
    beforeTransaction = null;
    beforeWrite = null;
    transactionFailure = null;
    outerOutcome = null;
    templates.create.mockImplementation(async ({ data }: { data: Partial<Row> }) => {
      const created = { ...draft, ...data, id: `created_${data.version}` };
      rows.push(created);
      return { ...created };
    });
    // Only the outer database transaction can roll back. Import and exercise
    // the actual withTenantDb/exposeNestedTransaction facade, not a substitute.
    mocks.databaseTransaction.mockImplementation(async (run) => {
      const snapshot = rows.map((entry) => ({ ...entry }));
      try {
        const response = await run({
          hotelProperty: { findFirst: propertyFind },
          hotelJourneyTemplate: templates,
          $queryRawUnsafe: vi.fn(async () => []),
        });
        outerOutcome = 'committed';
        return response;
      } catch (error) {
        rows = snapshot;
        outerOutcome = 'rolled_back';
        throw error;
      }
    });
  });

  async function request(calls: { method: 'approve' | 'save'; input: unknown }[]) {
    const batch = calls.length > 1;
    const paths = calls.map((call) => `hotelProperty.journeyTemplates.${call.method}`).join(',');
    const body = batch
      ? Object.fromEntries(calls.map((call, index) => [index, superjson.serialize(call.input)]))
      : superjson.serialize(calls[0].input);
    const req = new Request(`http://localhost/api/trpc/${paths}${batch ? '?batch=1' : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return withTenantDb(
      ORG,
      (db) =>
        fetchRequestHandler({
          endpoint: '/api/trpc',
          req,
          router: httpRouter,
          createContext: () => context('http_approver', 'ACTIVE', db),
        }),
      { userId: 'http_approver' }
    );
  }

  it.each(['body', 'subject'] as const)(
    'commits the HTTP conflict response without retiring prior copy after a winning %s edit',
    async (field) => {
      beforeWrite = async () => {
        await caller('winning_editor').save({ ...input, [field]: 'Winning copy' });
      };
      const response = await request([{ method: 'approve', input: { id: draft.id } }]);
      expect(response.status).toBe(409);
      const payload = await response.json();
      expect(payload.error.json.data.code).toBe('CONFLICT');
      expect(outerOutcome).toBe('committed');
      expect(mocks.databaseTransaction).toHaveBeenCalledTimes(1);
      expect(row(previous.id)).toEqual(previous);
      expect(row()).toMatchObject({
        [field]: 'Winning copy',
        status: 'DRAFT',
        approvedByUserId: null,
        approvedAt: null,
      });
      expect(templates.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'RETIRED' } })
      );
      for (const [args] of templates.updateMany.mock.calls)
        expect(args.where).toMatchObject({ organizationId: ORG, branchId: BRANCH });
    }
  );

  it('keeps the winning approval actor when a competing approval commits first', async () => {
    beforeWrite = async () => {
      await caller('winning_approver').approve({ id: draft.id });
    };
    const response = await request([{ method: 'approve', input: { id: draft.id } }]);
    expect(response.status).toBe(409);
    expect(outerOutcome).toBe('committed');
    expect(row()).toMatchObject({
      body: draft.body,
      status: 'APPROVED',
      approvedByUserId: 'winning_approver',
      approvedAt: expect.any(Date),
    });
    expect(row(previous.id)).toMatchObject({
      status: 'RETIRED',
      approvedByUserId: previous.approvedByUserId,
    });
  });

  it('leaves the claimed draft unchanged when the previous approval was superseded', async () => {
    rows.push({ ...draft, id: 'draft_3', version: 3 });
    beforeWrite = async () => {
      await caller('winning_approver').approve({ id: 'draft_3' });
    };
    const response = await request([{ method: 'approve', input: { id: draft.id } }]);
    expect(response.status).toBe(409);
    expect(outerOutcome).toBe('committed');
    expect(row()).toEqual(draft);
    expect(row('draft_3')).toMatchObject({
      status: 'APPROVED',
      approvedByUserId: 'winning_approver',
    });
  });

  it('keeps an approval and subsequent save in one HTTP batch from interleaving', async () => {
    const response = await request([
      { method: 'approve', input: { id: draft.id } },
      { method: 'save', input: { ...input, body: 'Next draft' } },
    ]);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toHaveLength(2);
    expect(payload.every((entry: { error?: unknown }) => !entry.error)).toBe(true);
    expect(outerOutcome).toBe('committed');
    expect(mocks.databaseTransaction).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({
      status: 'APPROVED',
      body: draft.body,
      approvedByUserId: 'http_approver',
    });
    expect(row('created_3')).toMatchObject({
      status: 'DRAFT',
      body: 'Next draft',
      createdByUserId: 'http_approver',
    });
  });

  it('releases the batch queue after a refused save so the following approval can finish', async () => {
    const response = await request([
      { method: 'save', input: { ...input, body: '{{unknown_placeholder}}' } },
      { method: 'approve', input: { id: draft.id } },
    ]);
    expect(response.status).toBe(207);
    const payload = await response.json();
    expect(payload[0].error.json.data.code).toBe('BAD_REQUEST');
    expect(payload[1].error).toBeUndefined();
    expect(outerOutcome).toBe('committed');
    expect(row()).toMatchObject({
      status: 'APPROVED',
      body: draft.body,
      approvedByUserId: 'http_approver',
    });
  });
});
