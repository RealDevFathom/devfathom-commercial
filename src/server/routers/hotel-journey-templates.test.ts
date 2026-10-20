/**
 * UPS-04 — `hotelProperty.journeyTemplates.*`: its gates, its conditional
 * writes and its refusals.
 *
 * Pinned here:
 *
 * - every procedure needs the `hotel-upsell` module and resolves the selected
 *   property through the scope — property administration first, marketing as
 *   the fallback for the board, a draft and a preview, never for an approval or
 *   a retirement; a denied scope reads and writes nothing;
 * - every write locks the property first, re-checks access, then writes, scoped
 *   by `(organizationId, branchId)` and the exact state the caller read, so a
 *   stale save, a raced approval and a competing approval of another version
 *   are conflicts that change nothing and keep the winner's facts;
 * - a lib rule lands on its field as BAD_REQUEST and a lost race is a CONFLICT;
 * - two journey mutations in one HTTP batch run one after the other, and a
 *   refused one releases the queue for the next.
 *
 * The database is a bounded in-memory model of conditional writes (rows, a
 * `matches` predicate, the approved unique index), without nested rollback.
 * The `beforeWrite` hook runs a competing request after the first request's
 * reads and before its first write, with timestamps deliberately left equal so
 * the copy comparison is what decides. This is source regression evidence, not
 * PostgreSQL concurrency evidence; the DB suite holds the latter.
 */
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import type { HotelJourneyTemplateShape } from '@/lib/hotel/journey-templates';

const mocks = vi.hoisted(() => ({ scope: vi.fn(), audit: vi.fn(), databaseTransaction: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/hotel-property-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/hotel-property-scope')>()),
  requireHotelPropertyScope: mocks.scope,
}));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  annotateAudit: mocks.audit,
}));
vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.databaseTransaction } }));
vi.mock('../trpc', async () => {
  const { initTRPC, TRPCError } = await import('@trpc/server');
  const t = initTRPC.context<{ denied?: boolean }>().create();
  const protectedProcedure = t.procedure.use(({ ctx, next }) => {
    if (ctx.denied) throw new TRPCError({ code: 'FORBIDDEN' });
    return next();
  });
  return {
    router: t.router,
    protectedProcedure,
    adminProcedure: protectedProcedure,
    capabilityProcedure: () => protectedProcedure,
    auditedProtectedProcedure: protectedProcedure,
  };
});
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { router } from '../trpc';
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

const ORG = 'org_1';
const BRANCH = 'property_1';
const instant = new Date('2026-09-14T00:00:00.000Z');
const property = {
  branchId: BRANCH,
  organizationId: ORG,
  name: 'Synthetic',
  timezone: 'Asia/Karachi',
  journeySettings: {},
  mode: 'HOTEL',
  modeOverrides: null,
  active: true,
};
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
  branchId: BRANCH,
  moment: draft.moment,
  channel: draft.channel,
  language: draft.language,
  subject: draft.subject!,
  body: draft.body,
};

let rows: Row[];
let beforeWrite: (() => Promise<void>) | null;
let writeFailure: string | null;
let held: Set<string>;

function matches(row: Row, where: Partial<Row>) {
  return Object.entries(where).every(([key, value]) => {
    const actual = row[key as keyof Row];
    return actual instanceof Date && value instanceof Date
      ? actual.getTime() === value.getTime()
      : actual === value;
  });
}

function knownError(code: string) {
  return new Prisma.PrismaClientKnownRequestError('synthetic', { code, clientVersion: 'test' });
}

/** A write under the hook: the competitor runs once, then the write proceeds. */
async function raced() {
  const competing = beforeWrite;
  beforeWrite = null;
  await competing?.();
  if (writeFailure) {
    const code = writeFailure;
    writeFailure = null;
    throw knownError(code);
  }
}

const templates = {
  findFirst: vi.fn(async ({ where, orderBy }: { where: Partial<Row>; orderBy?: unknown }) => {
    const found = rows.filter((row) => matches(row, where));
    if (orderBy) found.sort((a, b) => b.version - a.version);
    return found[0] ? { ...found[0] } : null;
  }),
  findMany: vi.fn(async ({ where }: { where: Partial<Row> }) =>
    rows.filter((row) => matches(row, where)).map((row) => ({ ...row }))
  ),
  updateMany: vi.fn(async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
    await raced();
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
        throw knownError('P2002');
      Object.assign(row, data);
    }
    return { count: found.length };
  }),
  create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
    await raced();
    if (
      rows.some((row) =>
        matches(row, {
          organizationId: data.organizationId,
          branchId: data.branchId,
          moment: data.moment,
          channel: data.channel,
          language: data.language,
          version: data.version,
        })
      )
    )
      throw knownError('P2002');
    const created: Row = {
      ...draft,
      ...data,
      id: `created_${data.version}`,
      status: 'DRAFT',
      approvedByUserId: null,
      approvedAt: null,
      updatedAt: instant,
      createdAt: instant,
    } as Row;
    rows.push(created);
    return { ...created };
  }),
};
const db = {
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  hotelProperty: { findFirst: vi.fn() },
  hotelJourneyTemplate: templates,
};

function context(actor = 'current_approver', denied = false, database?: unknown) {
  return {
    denied,
    session: { user: { id: actor, organizationId: ORG, role: 'EMPLOYEE' } },
    entitlements: {
      organizationId: ORG,
      enabledModules: ['hotel-core', 'hotel-upsell'],
      limits: {},
    },
    // Every direct call is its own request: the mutation queue is keyed by the
    // request's transaction, so a competitor must not queue behind the call it
    // races. The batch tests hand in the one facade a real batch shares.
    db: database ?? { ...db },
    requestMeta: { ip: null },
    audit: { detail: {} },
  };
}
const caller = (actor = 'current_approver', denied = false) =>
  hotelPropertyRouter.createCaller(context(actor, denied) as never).journeyTemplates;
const row = (id = draft.id) => rows.find((entry) => entry.id === id)!;
const first = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];
const writes = () => [...templates.updateMany.mock.calls, ...templates.create.mock.calls];

beforeEach(() => {
  vi.clearAllMocks();
  rows = [{ ...previous }, { ...draft }];
  beforeWrite = null;
  writeFailure = null;
  held = new Set(['hotel:property-admin']);
  mocks.scope.mockImplementation(async (_ctx: unknown, branchId: string, capability: string) => {
    if (branchId === BRANCH && held.has(capability)) return property;
    throw new TRPCError({ code: 'FORBIDDEN' });
  });
  db.$transaction.mockImplementation(async (run: (value: typeof db) => Promise<unknown>) =>
    run(db)
  );
  db.$queryRaw.mockResolvedValue([{ branchId: BRANCH }]);
  db.hotelProperty.findFirst.mockResolvedValue(property);
});

describe('hotelProperty.journeyTemplates authorization', () => {
  const procedures: Array<[string, (c: ReturnType<typeof caller>) => Promise<unknown>]> = [
    ['list', (c) => c.list({ branchId: BRANCH })],
    ['save', (c) => c.save(input)],
    ['approve', (c) => c.approve({ branchId: BRANCH, id: draft.id })],
    ['retire', (c) => c.retire({ branchId: BRANCH, id: previous.id })],
    [
      'preview',
      (c) =>
        c.preview({
          branchId: BRANCH,
          id: draft.id,
          context: { guest_name: 'Sara', room_number: 12 },
        }),
    ],
  ];
  it.each(procedures)(
    '%s refuses a workspace without Guest Journey and Upsell before the scope and any read',
    async (_name, run) => {
      const unlicensed = hotelPropertyRouter.createCaller({
        ...context(),
        entitlements: { organizationId: ORG, enabledModules: ['hotel-core'], limits: {} },
      } as never).journeyTemplates;
      await expect(run(unlicensed)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringContaining('Guest Journey and Upsell'),
      });
      expect(mocks.scope).not.toHaveBeenCalled();
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(templates.findFirst).not.toHaveBeenCalled();
      expect(templates.findMany).not.toHaveBeenCalled();
      expect(writes()).toEqual([]);
    }
  );
  it.each(procedures)(
    '%s refuses without a usable session before anything else',
    async (_n, run) => {
      await expect(run(caller('actor', true))).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.scope).not.toHaveBeenCalled();
      expect(writes()).toEqual([]);
    }
  );
  it.each(procedures)(
    '%s touches nothing when neither property administration nor marketing resolves',
    async (_name, run) => {
      held = new Set();
      await expect(run(caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.scope).toHaveBeenCalledWith(expect.anything(), BRANCH, 'hotel:property-admin');
      expect(db.hotelProperty.findFirst).not.toHaveBeenCalled();
      expect(templates.findFirst).not.toHaveBeenCalled();
      expect(templates.findMany).not.toHaveBeenCalled();
      expect(writes()).toEqual([]);
    }
  );
  it('resolves the board, a draft and a preview for marketing when property administration is denied', async () => {
    held = new Set(['hotel:marketing']);
    const board = await caller('marketer').list({ branchId: BRANCH });
    expect(board.canApprove).toBe(false);
    expect(mocks.scope.mock.calls.map((call) => call[2])).toEqual([
      'hotel:property-admin',
      'hotel:marketing',
    ]);
    await expect(caller('marketer').save({ ...input, body: 'Draft copy' })).resolves.toMatchObject({
      status: 'DRAFT',
      body: 'Draft copy',
    });
    await expect(
      caller('marketer').preview({
        branchId: BRANCH,
        id: draft.id,
        context: { guest_name: 'Sara', room_number: 12 },
      })
    ).resolves.toMatchObject({ rendered: { body: 'Draft copy' } });
  });
  it.each(['approve', 'retire'] as const)(
    'tells marketing that %s is the administrator’s decision, before reading any template',
    async (name) => {
      held = new Set(['hotel:marketing']);
      await expect(
        caller('marketer')[name]({ branchId: BRANCH, id: draft.id })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Approving a guest message is the property administrator’s decision.',
      });
      expect(templates.findFirst).not.toHaveBeenCalled();
      expect(writes()).toEqual([]);
      expect(row()).toMatchObject({ status: 'DRAFT', approvedByUserId: null });
    }
  );
  it('reports the board for property administration without asking about marketing', async () => {
    const board = await caller().list({ branchId: BRANCH });
    expect(board.canApprove).toBe(true);
    expect(mocks.scope.mock.calls.map((call) => call[2])).toEqual(['hotel:property-admin']);
    expect(templates.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, branchId: BRANCH } })
    );
    expect(board.templates.map((entry) => entry.id)).toEqual([previous.id, draft.id]);
    expect(board.quietHours).toEqual({ startMinute: 21 * 60, endMinute: 8 * 60 });
    expect(board.propertyTimezone).toBe('Asia/Karachi');
    expect(board.moments.find((moment) => moment.value === 'WELCOME')).toMatchObject({
      label: 'Welcome',
      kind: 'TRANSACTIONAL',
      placeholders: expect.arrayContaining(['guest_name', 'room_number', 'wifi_password']),
    });
    expect(board.channels.map((channel) => channel.label)).toEqual(['WhatsApp', 'E-mail', 'SMS']);
    expect(board.languages.map((language) => language.label)).toEqual(['English', 'Urdu']);
    expect(board.statusLabels.APPROVED).toBe('Approved');
  });
  it('refuses a request that names no property before reaching the scope', async () => {
    await expect(caller().list({ branchId: '' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.scope).not.toHaveBeenCalled();
  });
  it('locks the property, then re-checks access, then writes', async () => {
    await caller().approve({ branchId: BRANCH, id: draft.id });
    expect(first(db.$queryRaw)).toBeLessThan(first(mocks.scope)!);
    expect(first(mocks.scope)).toBeLessThan(first(templates.updateMany)!);
    expect(db.$queryRaw.mock.calls[0]!.slice(1)).toEqual([ORG, BRANCH]);
  });
});

describe('hotelProperty.journeyTemplates drafts', () => {
  it('edits the current draft in place, scoped by organization, property and the state it read', async () => {
    const saved = await caller('editor').save({ ...input, body: 'Replacement {{guest_name}}' });
    expect(saved).toMatchObject({ id: draft.id, version: 2, body: 'Replacement {{guest_name}}' });
    expect(templates.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        branchId: BRANCH,
        moment: 'WELCOME',
        channel: 'EMAIL',
        language: 'UR',
        id: draft.id,
        version: 2,
        status: 'DRAFT',
        updatedAt: instant,
        subject: draft.subject,
        body: draft.body,
      },
      data: { subject: draft.subject, body: 'Replacement {{guest_name}}' },
    });
    expect(templates.create).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetType: 'HotelJourneyTemplate',
        targetId: draft.id,
        action: 'hotel.journey.template.save',
      })
    );
  });
  it('supersedes approved or retired wording with the next version, attributed to the author', async () => {
    rows = [{ ...previous }];
    const created = await caller('editor').save({ ...input, body: 'Third wording' });
    expect(created).toMatchObject({
      id: 'created_2',
      version: 2,
      status: 'DRAFT',
      body: 'Third wording',
      createdByUserId: 'editor',
    });
    expect(templates.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          organizationId: ORG,
          branchId: BRANCH,
          moment: 'WELCOME',
          channel: 'EMAIL',
          language: 'UR',
          subject: draft.subject,
          body: 'Third wording',
          version: 2,
          createdByUserId: 'editor',
        },
      })
    );
    expect(row(previous.id)).toEqual(previous);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'hotel.journey.template.draft', operation: 'CREATE' })
    );
  });
  it.each([
    ['an unknown placeholder', { body: '{{room_numbr}}' }, 'body'],
    ['a broken placeholder', { body: 'Hello {{guest_name' }, 'body'],
    ['a subject on WhatsApp', { channel: 'WHATSAPP' as const, subject: 'Welcome' }, 'subject'],
    ['no subject on an e-mail', { subject: null }, 'subject'],
  ])('refuses %s on its field before the lock', async (_label, change, field) => {
    const error = await caller()
      .save({ ...input, ...change })
      .catch((caught: TRPCError) => caught);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((error as TRPCError).cause).toMatchObject({
      issues: [expect.objectContaining({ path: [field] })],
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(mocks.scope).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
  it('reports a raced version collision as a conflict, not a success', async () => {
    rows = [{ ...previous }];
    beforeWrite = async () => {
      rows.push({ ...draft, id: 'raced_2', version: 2 });
    };
    await expect(caller().save({ ...input, body: 'Mine' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(rows.map((entry) => entry.id)).toEqual([previous.id, 'raced_2']);
  });
});

describe('hotelProperty.journeyTemplates atomic save and approval', () => {
  it('refuses a stale save after approval without changing approved copy or actor', async () => {
    beforeWrite = async () => {
      await caller('winning_approver').approve({ branchId: BRANCH, id: draft.id });
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
    beforeWrite = async () => {
      await caller().retire({ branchId: BRANCH, id: draft.id });
    };
    await expect(caller().save({ ...input, body: 'Replacement' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(row()).toMatchObject({ body: draft.body, status: 'RETIRED' });
  });

  it('preserves the winning draft edit even when timestamp and version are unchanged', async () => {
    beforeWrite = async () => {
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
      beforeWrite = async () => {
        await caller().save({ ...input, [field]: 'New wording' });
      };
      await expect(caller().approve({ branchId: BRANCH, id: draft.id })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
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
      beforeWrite = async () => {
        await caller('winner').approve({ branchId: BRANCH, id: draft.id });
      };
      await expect(
        caller('loser').approve({ branchId: BRANCH, id: draft.id })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(row()).toMatchObject({ status: 'APPROVED', approvedByUserId: 'winner' });
      expect(rows.filter((entry) => entry.status === 'APPROVED')).toHaveLength(1);
    }
  );

  it.each([true, false])(
    'refuses competing different-version approval with prior approval: %s',
    async (hasPrevious) => {
      if (!hasPrevious) rows = [{ ...draft }];
      rows.push({ ...draft, id: 'draft_3', version: 3 });
      beforeWrite = async () => {
        await caller('winner').approve({ branchId: BRANCH, id: 'draft_3' });
      };
      await expect(
        caller('loser').approve({ branchId: BRANCH, id: draft.id })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(row('draft_3')).toMatchObject({ status: 'APPROVED', approvedByUserId: 'winner' });
      expect(row()).toMatchObject({ status: 'DRAFT', approvedByUserId: null });
      expect(rows.filter((entry) => entry.status === 'APPROVED')).toHaveLength(1);
    }
  );

  it.each(['version', 'updatedAt'] as const)(
    'refuses a stale %s even when wording is unchanged',
    async (field) => {
      beforeWrite = async () => {
        if (field === 'version') row().version += 1;
        else row().updatedAt = new Date(instant.getTime() + 1);
      };
      await expect(caller().approve({ branchId: BRANCH, id: draft.id })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(row().status).toBe('DRAFT');
      expect(row(previous.id)).toEqual(previous);
    }
  );

  it('reports a serialization failure on the write as a conflict, without retrying', async () => {
    writeFailure = 'P2034';
    await expect(caller().approve({ branchId: BRANCH, id: draft.id })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(templates.updateMany).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([previous, draft]);
  });

  it('saves and approves Urdu e-mail within tenant and property scope, preserving actor history', async () => {
    const foreign = [
      { ...previous, id: 'foreign_org', organizationId: 'another_org' },
      { ...previous, id: 'foreign_property', branchId: 'another_property' },
    ];
    rows.push(...foreign);
    await expect(
      caller('editor').save({ ...input, body: 'خوش آمدید {{guest_name}}' })
    ).resolves.toMatchObject({ status: 'DRAFT', version: 2, createdByUserId: 'author' });
    await expect(
      caller('approver').approve({ branchId: BRANCH, id: draft.id })
    ).resolves.toMatchObject({
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
    expect(mocks.scope).toHaveBeenCalledWith(expect.anything(), BRANCH, 'hotel:property-admin');
    expect(mocks.audit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetType: 'HotelJourneyTemplate',
        targetId: draft.id,
        action: 'hotel.journey.template.approve',
        metadata: expect.objectContaining({ branchId: BRANCH, retired: previous.id }),
      })
    );
  });

  it.each(['organizationId', 'branchId'] as const)(
    'refuses approval across %s before any write',
    async (field) => {
      row()[field] = 'outside_scope';
      await expect(caller().approve({ branchId: BRANCH, id: draft.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(writes()).toEqual([]);
    }
  );

  it('retires an approved version keeping its approval facts, and refuses retiring it twice', async () => {
    const retired = await caller().retire({ branchId: BRANCH, id: previous.id });
    expect(retired).toMatchObject({
      status: 'RETIRED',
      approvedByUserId: 'previous_approver',
      approvedAt: instant,
    });
    expect(templates.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ organizationId: ORG, branchId: BRANCH, id: previous.id }),
      data: { status: 'RETIRED', approvedByUserId: 'previous_approver', approvedAt: instant },
    });
    expect(mocks.audit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'hotel.journey.template.retire', targetId: previous.id })
    );
    const error = await caller()
      .retire({ branchId: BRANCH, id: previous.id })
      .catch((caught: TRPCError) => caught);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((error as TRPCError).cause).toMatchObject({
      issues: [expect.objectContaining({ path: ['status'] })],
    });
  });

  it('refuses approving an approved version on the status field without a write', async () => {
    const error = await caller()
      .approve({ branchId: BRANCH, id: previous.id })
      .catch((caught: TRPCError) => caught);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((error as TRPCError).cause).toMatchObject({
      issues: [expect.objectContaining({ path: ['status'] })],
    });
    expect(writes()).toEqual([]);
  });
});

describe('hotelProperty.journeyTemplates preview', () => {
  it('renders a version against sample values and reports the property-side send gates', async () => {
    const result = await caller().preview({
      branchId: BRANCH,
      id: draft.id,
      context: { guest_name: 'Sara', room_number: 12 },
    });
    expect(result.rendered).toEqual({
      subject: 'خوش آمدید Sara',
      body: 'محترم Sara، کمرہ 12۔',
      placeholders: ['guest_name', 'room_number'],
    });
    expect(result.propertySideCheck).toMatchObject({ ok: false, reason: 'TEMPLATE_NOT_APPROVED' });
    const approved = await caller().preview({
      branchId: BRANCH,
      id: previous.id,
      context: { guest_name: 'Sara', room_number: 12 },
    });
    // A transactional moment is never held for quiet hours.
    expect(approved.propertySideCheck).toEqual({ ok: true });
  });
  it('refuses a preview missing a value on the context field', async () => {
    const error = await caller()
      .preview({ branchId: BRANCH, id: draft.id, context: { guest_name: 'Sara' } })
      .catch((caught: TRPCError) => caught);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((error as TRPCError).cause).toMatchObject({
      issues: [expect.objectContaining({ path: ['context'] })],
    });
  });
  it('reports a version of another property as not found', async () => {
    await expect(
      caller().preview({ branchId: BRANCH, id: 'elsewhere', context: {} })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('hotelProperty.journeyTemplates through one HTTP batch transaction', () => {
  const httpRouter = router({ hotelProperty: hotelPropertyRouter });

  beforeEach(() => {
    // The real request facade over the fake transaction: `withTenantDb` sets
    // the GUCs, then serialises every statement through one queue, exactly as
    // the route does for a batch.
    mocks.databaseTransaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        $queryRawUnsafe: vi.fn(async () => []),
        $queryRaw: db.$queryRaw,
        hotelProperty: db.hotelProperty,
        hotelJourneyTemplate: templates,
      })
    );
  });

  async function request(calls: { method: 'approve' | 'save'; input: unknown }[]) {
    const batch = calls.length > 1;
    const paths = calls.map((call) => `hotelProperty.journeyTemplates.${call.method}`).join(',');
    const body = batch
      ? Object.fromEntries(calls.map((call, index) => [index, call.input]))
      : calls[0]!.input;
    const req = new Request(`http://localhost/api/trpc/${paths}${batch ? '?batch=1' : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return withTenantDb(
      ORG,
      (facade) =>
        fetchRequestHandler({
          endpoint: '/api/trpc',
          req,
          router: httpRouter,
          createContext: () => context('http_approver', false, facade) as never,
        }),
      { userId: 'http_approver' }
    );
  }
  type Envelope = { error?: { data?: { code?: string } }; result?: unknown };

  it('keeps an approval and a following save in one HTTP batch from interleaving', async () => {
    const response = await request([
      { method: 'approve', input: { branchId: BRANCH, id: draft.id } },
      { method: 'save', input: { ...input, body: 'Next draft' } },
    ]);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Envelope[];
    expect(payload).toHaveLength(2);
    expect(payload.every((entry) => !entry.error)).toBe(true);
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
    // The save's reads began only after the approval's last write.
    const approvalLastWrite = Math.max(
      ...templates.updateMany.mock.invocationCallOrder.slice(0, 3)
    );
    expect(first(templates.create)).toBeGreaterThan(approvalLastWrite);
  });

  it('releases the batch queue after a refused save so the following approval can finish', async () => {
    const response = await request([
      { method: 'save', input: { ...input, body: '{{unknown_placeholder}}' } },
      { method: 'approve', input: { branchId: BRANCH, id: draft.id } },
    ]);
    expect(response.status).toBe(207);
    const payload = (await response.json()) as Envelope[];
    expect(payload[0]!.error?.data?.code).toBe('BAD_REQUEST');
    expect(payload[1]!.error).toBeUndefined();
    expect(row()).toMatchObject({
      status: 'APPROVED',
      body: draft.body,
      approvedByUserId: 'http_approver',
    });
  });

  it('answers a competing approval that committed first with 409 and keeps the winner', async () => {
    beforeWrite = async () => {
      await caller('winning_approver').approve({ branchId: BRANCH, id: draft.id });
    };
    const response = await request([
      { method: 'approve', input: { branchId: BRANCH, id: draft.id } },
    ]);
    expect(response.status).toBe(409);
    const payload = (await response.json()) as Envelope;
    expect(payload.error?.data?.code).toBe('CONFLICT');
    expect(row()).toMatchObject({
      body: draft.body,
      status: 'APPROVED',
      approvedByUserId: 'winning_approver',
    });
    expect(row(previous.id)).toMatchObject({
      status: 'RETIRED',
      approvedByUserId: previous.approvedByUserId,
    });
  });
});
