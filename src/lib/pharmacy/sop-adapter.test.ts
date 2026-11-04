import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** ABAC stand-in: every user may dispense unless listed here. */
const abac = vi.hoisted(() => ({ nonDispensers: new Set<string>() }));
const can = vi.hoisted(() =>
  vi.fn(async (user: { id: string }, action: string) => {
    return action === 'pharmacy:dispense' && !abac.nonDispensers.has(user.id);
  })
);
vi.mock('@/lib/abac', () => ({ can }));

beforeEach(() => {
  abac.nonDispensers.clear();
  can.mockClear();
});

import {
  PHARMACY_SOP_RECORD_LOOKBACK_MS,
  PharmacySopAccessError,
  assertIndependentPharmacyVerifier,
  assertOccurrenceAtSite,
  enablePharmacySopSite,
  ensurePharmacySopJobRoles,
  ensurePharmacySopStaffProfile,
  linkPharmacySopRecord,
  listPharmacySopBranches,
  pharmacySopRecordTimeBounds,
  pharmacySopRolesAt,
  resolvePharmacySopActor,
  resolvePharmacySopSite,
  setPharmacySopRoleHolding,
  validatePharmacySopSiteClock,
  type PharmacySopSiteRef,
} from './sop-adapter';

/**
 * An in-memory, tenant-aware stand-in for the handful of tables the adapter
 * touches. Every finder honours the organizationId it is given and the rows it
 * holds, so a cross-tenant or cross-branch id simply is not found — the same
 * observable behaviour as RLS plus the adapter's own where-clauses.
 */
type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined, tables: Tables): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (condition === undefined) return true;
    if (key === 'user') {
      const user = tables.users.find((candidate) => candidate.id === row.userId);
      return Boolean(user) && matches(user!, condition as Row, tables);
    }
    if (key === 'jobRole') {
      const role = tables.jobRoles.find((candidate) => candidate.id === row.jobRoleId);
      return Boolean(role) && matches(role!, condition as Row, tables);
    }
    if (key === 'lots') {
      const some = (condition as { some: Row }).some;
      return tables.lots.some(
        (lot) => lot.manufacturingBatchId === row.id && matches(lot, some, tables)
      );
    }
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      const op = condition as { in?: unknown[]; not?: unknown };
      if (op.in) return op.in.includes(row[key]);
      if ('not' in op) return row[key] !== op.not;
    }
    return row[key] === condition;
  });
}

type Tables = {
  users: Row[];
  assignments: Row[];
  pharmacyBranches: Row[];
  sites: Row[];
  engineBranches: Row[];
  profiles: Row[];
  jobRoles: Row[];
  holdings: Row[];
  holdingAudits: Row[];
  occurrences: Row[];
  occurrenceSteps: Row[];
  evidence: Row[];
  versions: Row[];
  links: Row[];
  temperatureLogs: Row[];
  registerEntries: Row[];
  goodsReceipts: Row[];
  batches: Row[];
  lots: Row[];
  recalls: Row[];
};

let sequence = 0;
const nextId = (prefix: string) => `${prefix}_${++sequence}`;

function select(row: Row, shape: Row | undefined, tables: Tables): Row {
  if (!shape) return { ...row };
  const out: Row = {};
  for (const [key, value] of Object.entries(shape)) {
    if (!value) continue;
    if (key === 'jobRole') {
      const role = tables.jobRoles.find((candidate) => candidate.id === row.jobRoleId)!;
      out.jobRole = select(role, (value as { select: Row }).select, tables);
    } else if (key === 'user') {
      const user = tables.users.find((candidate) => candidate.id === row.userId);
      out.user = user ? { ...user } : null;
    } else if (key === 'template') {
      out.template = { name: row.templateName };
    } else out[key] = row[key];
  }
  return out;
}

function delegate(tables: Tables, name: keyof Tables, uniqueKeys?: (row: Row) => string) {
  const rows = () => tables[name];
  const find = (args: { where?: Row; select?: Row; take?: number } = {}) =>
    rows()
      .filter((row) => matches(row, args.where, tables))
      .slice(0, args.take ?? Infinity)
      .map((row) => select(row, args.select, tables));
  return {
    findMany: vi.fn(async (args?: { where?: Row; select?: Row; take?: number }) => find(args)),
    findFirst: vi.fn(async (args?: { where?: Row; select?: Row }) => find(args)[0] ?? null),
    findUnique: vi.fn(async (args: { where: Row; select?: Row }) => {
      const where = Object.values(args.where).every((value) => typeof value === 'object')
        ? (Object.values(args.where)[0] as Row)
        : args.where;
      return find({ where, select: args.select })[0] ?? null;
    }),
    create: vi.fn(async (args: { data: Row; select?: Row }) => {
      const row = { id: nextId(String(name)), ...args.data };
      rows().push(row);
      return select(row, args.select, tables);
    }),
    createMany: vi.fn(async (args: { data: Row[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const data of args.data) {
        const key = uniqueKeys?.(data);
        if (key && rows().some((row) => uniqueKeys!(row) === key)) {
          if (args.skipDuplicates) continue;
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        rows().push({ id: nextId(String(name)), ...data });
        count += 1;
      }
      return { count };
    }),
    delete: vi.fn(async (args: { where: { id: string } }) => {
      const index = rows().findIndex((row) => row.id === args.where.id);
      const [removed] = rows().splice(index, 1);
      return removed;
    }),
  };
}

const ORG = 'org_a';
const OTHER_ORG = 'org_b';
const at = (iso: string) => new Date(iso);

function fixture() {
  const tables: Tables = {
    users: [
      { id: 'u_manager', organizationId: ORG, status: 'ACTIVE', name: 'Mona Manager' },
      { id: 'u_pharmacist', organizationId: ORG, status: 'ACTIVE', name: 'Paul Pharmacist' },
      { id: 'u_new', organizationId: ORG, status: 'ACTIVE', name: '  Nadia New ' },
      { id: 'u_inactive', organizationId: ORG, status: 'INACTIVE', name: 'Ivan Inactive' },
      { id: 'u_unassigned', organizationId: ORG, status: 'ACTIVE', name: 'Una Unassigned' },
      { id: 'u_other', organizationId: OTHER_ORG, status: 'ACTIVE', name: 'Olga Other' },
    ],
    assignments: [
      { organizationId: ORG, userId: 'u_manager', branchId: 'pb_main', active: true },
      { organizationId: ORG, userId: 'u_manager', branchId: 'pb_closed', active: true },
      { organizationId: ORG, userId: 'u_manager', branchId: 'pb_plain', active: true },
      { organizationId: ORG, userId: 'u_pharmacist', branchId: 'pb_main', active: true },
      { organizationId: ORG, userId: 'u_new', branchId: 'pb_main', active: true },
      { organizationId: ORG, userId: 'u_inactive', branchId: 'pb_main', active: true },
      { organizationId: ORG, userId: 'u_manager', branchId: 'pb_old', active: false },
      { organizationId: OTHER_ORG, userId: 'u_other', branchId: 'pb_other', active: true },
    ],
    pharmacyBranches: [
      { id: 'pb_main', organizationId: ORG, name: 'Main Street', active: true },
      { id: 'pb_plain', organizationId: ORG, name: 'Plain Road', active: true },
      { id: 'pb_closed', organizationId: ORG, name: 'Closed Branch', active: false },
      { id: 'pb_old', organizationId: ORG, name: 'Old Branch', active: true },
      { id: 'pb_other', organizationId: OTHER_ORG, name: 'Other Tenant', active: true },
    ],
    sites: [
      { id: 'site_main', organizationId: ORG, pharmacyBranchId: 'pb_main', sopBranchId: 'rb_main' },
      {
        id: 'site_other',
        organizationId: OTHER_ORG,
        pharmacyBranchId: 'pb_other',
        sopBranchId: 'rb_other',
      },
    ],
    engineBranches: [
      { id: 'rb_main', organizationId: ORG, timezone: 'Asia/Karachi', businessDayCutoff: '04:00' },
      { id: 'rb_other', organizationId: OTHER_ORG, timezone: 'UTC', businessDayCutoff: '00:00' },
    ],
    profiles: [
      {
        id: 'sp_manager',
        organizationId: ORG,
        userId: 'u_manager',
        status: 'ACTIVE',
        displayName: 'Mona',
      },
      {
        id: 'sp_pharmacist',
        organizationId: ORG,
        userId: 'u_pharmacist',
        status: 'ACTIVE',
        displayName: 'Paul',
      },
    ],
    jobRoles: [],
    holdings: [],
    holdingAudits: [],
    occurrences: [
      {
        id: 'occ_main',
        organizationId: ORG,
        branchId: 'rb_main',
        status: 'SUBMITTED',
        resolvedAt: null,
        templateVersionId: 'ver_opening',
        assignedStaffProfileId: null,
        claimedByStaffProfileId: 'sp_claimer',
        poolJobRoleId: 'role_pool',
      },
      {
        id: 'occ_counts',
        organizationId: ORG,
        branchId: 'rb_main',
        status: 'SUBMITTED',
        resolvedAt: null,
        templateVersionId: 'ver_counts',
        assignedStaffProfileId: 'sp_assignee',
        claimedByStaffProfileId: null,
        poolJobRoleId: null,
      },
      {
        id: 'occ_verified',
        organizationId: ORG,
        branchId: 'rb_main',
        status: 'VERIFIED',
        resolvedAt: new Date('2026-11-03T10:00:00Z'),
        templateVersionId: 'ver_opening',
        assignedStaffProfileId: null,
        claimedByStaffProfileId: null,
        poolJobRoleId: null,
      },
      {
        id: 'occ_waived',
        organizationId: ORG,
        branchId: 'rb_main',
        status: 'WAIVED',
        resolvedAt: null,
        templateVersionId: 'ver_opening',
        assignedStaffProfileId: null,
        claimedByStaffProfileId: null,
        poolJobRoleId: null,
      },
      {
        id: 'occ_live',
        organizationId: ORG,
        branchId: 'rb_main',
        status: 'IN_PROGRESS',
        resolvedAt: null,
        templateVersionId: 'ver_opening',
        dueAt: new Date('2026-11-04T08:00:00Z'),
        windowEndsAt: new Date('2026-11-04T12:00:00Z'),
        assignedStaffProfileId: null,
        claimedByStaffProfileId: 'sp_manager',
        poolJobRoleId: 'role_pool',
      },
      {
        id: 'occ_submitted_own',
        organizationId: ORG,
        branchId: 'rb_main',
        status: 'SUBMITTED',
        resolvedAt: null,
        templateVersionId: 'ver_opening',
        dueAt: new Date('2026-11-04T08:00:00Z'),
        windowEndsAt: new Date('2026-11-04T12:00:00Z'),
        assignedStaffProfileId: null,
        claimedByStaffProfileId: 'sp_manager',
        poolJobRoleId: 'role_pool',
      },
      {
        id: 'occ_assigned_elsewhere',
        organizationId: ORG,
        branchId: 'rb_main',
        status: 'IN_PROGRESS',
        resolvedAt: null,
        templateVersionId: 'ver_opening',
        dueAt: new Date('2026-11-04T08:00:00Z'),
        windowEndsAt: new Date('2026-11-04T12:00:00Z'),
        // The assignee owns the work even when someone else claimed it.
        assignedStaffProfileId: 'sp_pharmacist',
        claimedByStaffProfileId: 'sp_manager',
        poolJobRoleId: null,
      },
      {
        id: 'occ_restaurant',
        organizationId: ORG,
        branchId: 'rb_restaurant',
        status: 'SUBMITTED',
        resolvedAt: null,
        templateVersionId: 'ver_opening',
        assignedStaffProfileId: null,
        claimedByStaffProfileId: null,
        poolJobRoleId: null,
      },
    ],
    occurrenceSteps: [
      {
        id: 'step_1',
        organizationId: ORG,
        occurrenceId: 'occ_main',
        completedByStaffProfileId: 'sp_completer',
      },
      { id: 'step_counts', organizationId: ORG, occurrenceId: 'occ_counts' },
      { id: 'step_live', organizationId: ORG, occurrenceId: 'occ_live' },
    ],
    evidence: [
      {
        id: 'ev_1',
        organizationId: ORG,
        occurrenceId: 'occ_main',
        uploaderStaffProfileId: 'sp_uploader',
      },
    ],
    versions: [
      { id: 'ver_opening', templateName: 'Pharmacy — opening' },
      { id: 'ver_counts', templateName: 'Pharmacy — controlled counts' },
      { id: 'ver_custom', templateName: 'Custom checklist' },
    ],
    links: [],
    temperatureLogs: [
      {
        id: 'temp_main',
        organizationId: ORG,
        branchId: 'pb_main',
        outOfRange: true,
        recordedAt: at('2026-11-04T07:00:00Z'),
      },
      // Exactly on the bounds: dueAt − 24h and windowEndsAt.
      {
        id: 'temp_earliest',
        organizationId: ORG,
        branchId: 'pb_main',
        outOfRange: false,
        recordedAt: at('2026-11-03T08:00:00Z'),
      },
      {
        id: 'temp_latest',
        organizationId: ORG,
        branchId: 'pb_main',
        outOfRange: false,
        recordedAt: at('2026-11-04T12:00:00Z'),
      },
      {
        id: 'temp_stale',
        organizationId: ORG,
        branchId: 'pb_main',
        outOfRange: false,
        recordedAt: at('2026-11-03T07:59:59Z'),
      },
      {
        id: 'temp_after',
        organizationId: ORG,
        branchId: 'pb_main',
        outOfRange: false,
        recordedAt: at('2026-11-04T12:00:01Z'),
      },
      {
        id: 'temp_plain',
        organizationId: ORG,
        branchId: 'pb_plain',
        outOfRange: false,
        recordedAt: at('2026-11-04T07:00:00Z'),
      },
      {
        id: 'temp_other',
        organizationId: OTHER_ORG,
        branchId: 'pb_other',
        outOfRange: false,
        recordedAt: at('2026-11-04T07:00:00Z'),
      },
    ],
    // Register entries are not time-bounded: the balance checked may be old.
    registerEntries: [
      {
        id: 'reg_main',
        organizationId: ORG,
        branchId: 'pb_main',
        createdAt: at('2026-09-01T00:00:00Z'),
      },
    ],
    goodsReceipts: [
      {
        id: 'grn_main',
        organizationId: ORG,
        branchId: 'pb_main',
        receivedAt: at('2026-11-04T09:00:00Z'),
      },
      {
        id: 'grn_old',
        organizationId: ORG,
        branchId: 'pb_main',
        receivedAt: at('2026-10-01T09:00:00Z'),
      },
      {
        id: 'grn_plain',
        organizationId: ORG,
        branchId: 'pb_plain',
        receivedAt: at('2026-11-04T09:00:00Z'),
      },
    ],
    batches: [
      { id: 'batch_main', organizationId: ORG },
      { id: 'batch_elsewhere', organizationId: ORG },
    ],
    lots: [
      { id: 'lot_1', organizationId: ORG, branchId: 'pb_main', manufacturingBatchId: 'batch_main' },
      {
        id: 'lot_2',
        organizationId: ORG,
        branchId: 'pb_plain',
        manufacturingBatchId: 'batch_elsewhere',
      },
    ],
    recalls: [
      { id: 'recall_a', organizationId: ORG },
      { id: 'recall_b', organizationId: OTHER_ORG },
    ],
  };

  const lockKeys: string[] = [];
  const shareLocks: string[] = [];
  const db = {
    $queryRaw: vi.fn(async (sql: { strings?: readonly string[]; values?: unknown[] }) => {
      const text = (sql.strings ?? []).join('?');
      if (text.includes('pg_advisory_xact_lock')) lockKeys.push(String(sql.values?.[0]));
      else if (text.includes('FOR SHARE')) shareLocks.push(String(sql.values?.[0]));
      else throw new Error(`unexpected raw query: ${text}`);
      return [];
    }),
    pharmacyBranchAssignment: delegate(tables, 'assignments'),
    pharmacyBranch: delegate(tables, 'pharmacyBranches'),
    pharmacySopSite: delegate(tables, 'sites'),
    restaurantBranch: delegate(tables, 'engineBranches'),
    restaurantStaffProfile: delegate(tables, 'profiles'),
    user: delegate(tables, 'users'),
    restaurantJobRole: delegate(tables, 'jobRoles', (row) => `${row.organizationId}:${row.key}`),
    restaurantStaffJobRole: delegate(tables, 'holdings'),
    restaurantStaffJobRoleAudit: delegate(tables, 'holdingAudits'),
    restaurantSopOccurrence: delegate(tables, 'occurrences'),
    restaurantSopOccurrenceStep: delegate(tables, 'occurrenceSteps'),
    restaurantSopEvidence: delegate(tables, 'evidence'),
    restaurantSopTemplateVersion: delegate(tables, 'versions'),
    pharmacySopRecordLink: delegate(
      tables,
      'links',
      (row) => `${row.organizationId}:${row.occurrenceId}:${row.recordType}:${row.recordId}`
    ),
    pharmacyTemperatureLog: delegate(tables, 'temperatureLogs'),
    pharmacyControlledRegisterEntry: delegate(tables, 'registerEntries'),
    pharmacyGoodsReceipt: delegate(tables, 'goodsReceipts'),
    pharmacyManufacturingBatch: delegate(tables, 'batches'),
    pharmacyRecallNotice: delegate(tables, 'recalls'),
  } as Record<string, unknown>;
  db.$transaction = vi.fn(async (work: (tx: ScopedDb) => Promise<unknown>) =>
    work(db as unknown as ScopedDb)
  );
  return { db: db as unknown as ScopedDb, tables, lockKeys, shareLocks, raw: db };
}

const mainSite: PharmacySopSiteRef = {
  pharmacyBranchId: 'pb_main',
  sopBranchId: 'rb_main',
  timezone: 'Asia/Karachi',
  businessDayCutoff: '04:00',
};

async function reason(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PharmacySopAccessError) return error.reason;
    throw error;
  }
  return 'RESOLVED';
}

async function grantRole(
  db: ScopedDb,
  staffProfileId: string,
  roleKey: 'pharmacy-manager' | 'pharmacy-qualified-person' | 'pharmacy-assistant',
  tables: Tables
) {
  const roles = await ensurePharmacySopJobRoles(db, ORG);
  tables.holdings.push({
    id: nextId('holding'),
    organizationId: ORG,
    staffProfileId,
    jobRoleId: roles[roleKey],
    branchId: 'rb_main',
  });
}

describe('pharmacy SOP branch scope', () => {
  it('lists only active, actively assigned branches of the tenant with their SOP status', async () => {
    const { db } = fixture();
    await expect(
      listPharmacySopBranches(db, { organizationId: ORG, userId: 'u_manager' })
    ).resolves.toEqual([
      {
        pharmacyBranchId: 'pb_main',
        name: 'Main Street',
        sopBranchId: 'rb_main',
        timezone: 'Asia/Karachi',
      },
      { pharmacyBranchId: 'pb_plain', name: 'Plain Road', sopBranchId: null, timezone: null },
    ]);
    await expect(
      listPharmacySopBranches(db, { organizationId: ORG, userId: 'u_unassigned' })
    ).resolves.toEqual([]);
  });

  it('resolves an enabled site and refuses out-of-scope, inactive, other-tenant and disabled branches', async () => {
    const { db } = fixture();
    const scope = { organizationId: ORG, userId: 'u_manager' };
    await expect(
      resolvePharmacySopSite(db, { ...scope, pharmacyBranchId: 'pb_main' })
    ).resolves.toEqual(mainSite);
    expect(
      await reason(resolvePharmacySopSite(db, { ...scope, pharmacyBranchId: 'pb_plain' }))
    ).toBe('SITE_NOT_ENABLED');
    // inactive branch, inactive assignment, another tenant's branch, unknown id
    for (const pharmacyBranchId of ['pb_closed', 'pb_old', 'pb_other', 'pb_missing']) {
      expect(await reason(resolvePharmacySopSite(db, { ...scope, pharmacyBranchId }))).toBe(
        'BRANCH_OUT_OF_SCOPE'
      );
    }
    expect(
      await reason(
        resolvePharmacySopSite(db, { organizationId: ORG, userId: '', pharmacyBranchId: 'pb_main' })
      )
    ).toBe('UNAUTHENTICATED');
  });
});

describe('enablePharmacySopSite', () => {
  it('validates the IANA timezone and HH:MM cutoff before touching the database', async () => {
    const { db, raw } = fixture();
    const scope = { organizationId: ORG, userId: 'u_manager', pharmacyBranchId: 'pb_plain' };
    expect(await reason(enablePharmacySopSite(db, { ...scope, timezone: 'PKT' }))).toBe(
      'INVALID_INPUT'
    );
    expect(
      await reason(
        enablePharmacySopSite(db, {
          ...scope,
          timezone: 'Asia/Karachi',
          businessDayCutoff: '24:00',
        })
      )
    ).toBe('INVALID_INPUT');
    expect(raw.$transaction).not.toHaveBeenCalled();
    expect(validatePharmacySopSiteClock({ timezone: ' Asia/Karachi ' })).toEqual({
      timezone: 'Asia/Karachi',
      businessDayCutoff: '00:00',
    });
  });

  it('creates the engine branch, site link and roles once, under a per-branch lock', async () => {
    const { db, tables, lockKeys } = fixture();
    const scope = {
      organizationId: ORG,
      userId: 'u_manager',
      pharmacyBranchId: 'pb_plain',
      timezone: 'Asia/Karachi',
      businessDayCutoff: '03:30',
    };
    const first = await enablePharmacySopSite(db, scope);
    const again = await enablePharmacySopSite(db, { ...scope, timezone: 'UTC' });

    expect(first.created).toBe(true);
    expect(first.site).toMatchObject({
      pharmacyBranchId: 'pb_plain',
      timezone: 'Asia/Karachi',
      businessDayCutoff: '03:30',
    });
    expect(again).toEqual({ site: first.site, created: false });
    const engine = tables.engineBranches.filter((row) => row.id === first.site.sopBranchId);
    expect(engine).toEqual([
      expect.objectContaining({
        organizationId: ORG,
        name: 'Plain Road · SOP',
        isDefault: false,
        timezone: 'Asia/Karachi',
      }),
    ]);
    expect(tables.sites.filter((row) => row.pharmacyBranchId === 'pb_plain')).toEqual([
      expect.objectContaining({
        enabledByUserId: 'u_manager',
        sopBranchId: first.site.sopBranchId,
      }),
    ]);
    expect(tables.jobRoles.map((role) => role.key).sort()).toEqual([
      'pharmacy-assistant',
      'pharmacy-manager',
      'pharmacy-qualified-person',
    ]);
    expect(tables.jobRoles.every((role) => role.isSystem === true)).toBe(true);
    expect(lockKeys).toEqual([
      'pharmacy-sop-site:org_a:pb_plain',
      'pharmacy-sop-site:org_a:pb_plain',
    ]);
  });

  it('refuses a branch outside the user scope', async () => {
    const { db, tables } = fixture();
    expect(
      await reason(
        enablePharmacySopSite(db, {
          organizationId: ORG,
          userId: 'u_manager',
          pharmacyBranchId: 'pb_other',
          timezone: 'UTC',
        })
      )
    ).toBe('BRANCH_OUT_OF_SCOPE');
    expect(tables.engineBranches).toHaveLength(2);
  });
});

describe('resolvePharmacySopActor', () => {
  it('derives exactly one ACTIVE profile for an ACTIVE user', async () => {
    const { db } = fixture();
    await expect(
      resolvePharmacySopActor(db, { organizationId: ORG, userId: 'u_manager' })
    ).resolves.toEqual({
      staffProfileId: 'sp_manager',
      displayName: 'Mona',
      userId: 'u_manager',
    });
  });

  it('fails closed on zero profiles, an inactive user, and several profiles', async () => {
    const { db, tables } = fixture();
    expect(
      await reason(resolvePharmacySopActor(db, { organizationId: ORG, userId: 'u_new' }))
    ).toBe('NO_STAFF_PROFILE');
    tables.profiles.push({
      id: 'sp_inactive_user',
      organizationId: ORG,
      userId: 'u_inactive',
      status: 'ACTIVE',
      displayName: 'Ivan',
    });
    expect(
      await reason(resolvePharmacySopActor(db, { organizationId: ORG, userId: 'u_inactive' }))
    ).toBe('NO_STAFF_PROFILE');
    tables.profiles.push({
      id: 'sp_manager_2',
      organizationId: ORG,
      userId: 'u_manager',
      status: 'ACTIVE',
      displayName: 'Mona again',
    });
    expect(
      await reason(resolvePharmacySopActor(db, { organizationId: ORG, userId: 'u_manager' }))
    ).toBe('AMBIGUOUS_STAFF_PROFILE');
  });
});

describe('ensurePharmacySopStaffProfile', () => {
  const scope = { organizationId: ORG, pharmacyBranchId: 'pb_main' };

  it('creates and links the session user’s own profile once, through the serialized path', async () => {
    const { db, tables, lockKeys } = fixture();
    const first = await ensurePharmacySopStaffProfile(db, { ...scope, userId: 'u_new' });
    const repeat = await ensurePharmacySopStaffProfile(db, { ...scope, userId: 'u_new' });
    expect(first).toMatchObject({ userId: 'u_new', displayName: 'Nadia New', created: true });
    expect(repeat).toEqual({ ...first, created: false });
    expect(tables.profiles.filter((profile) => profile.userId === 'u_new')).toEqual([
      expect.objectContaining({
        id: first.staffProfileId,
        primaryBranchId: 'rb_main',
        status: 'ACTIVE',
      }),
    ]);
    expect(lockKeys).toEqual([
      `pharmacy-sop-staff:${ORG}:u_new`,
      `pharmacy-sop-staff:${ORG}:u_new`,
    ]);
    // It writes no role holding.
    expect(tables.holdings).toHaveLength(0);
    // The actor resolver now finds exactly that profile.
    await expect(
      resolvePharmacySopActor(db, { organizationId: ORG, userId: 'u_new' })
    ).resolves.toMatchObject({ staffProfileId: first.staffProfileId });
  });

  it('returns an existing ACTIVE profile unchanged', async () => {
    const { db, tables } = fixture();
    await expect(
      ensurePharmacySopStaffProfile(db, { ...scope, userId: 'u_manager' })
    ).resolves.toEqual({
      staffProfileId: 'sp_manager',
      displayName: 'Mona',
      userId: 'u_manager',
      created: false,
    });
    expect(tables.profiles).toHaveLength(2);
  });

  it.each(['SUSPENDED', 'ARCHIVED'])('never re-activates a %s profile', async (status) => {
    const { db, tables } = fixture();
    tables.profiles.push({
      id: 'sp_old',
      organizationId: ORG,
      userId: 'u_new',
      status,
      displayName: 'Nadia',
    });
    expect(await reason(ensurePharmacySopStaffProfile(db, { ...scope, userId: 'u_new' }))).toBe(
      'NO_STAFF_PROFILE'
    );
    expect(tables.profiles.filter((profile) => profile.userId === 'u_new')).toHaveLength(1);
  });

  it('fails closed on several active profiles, an unassigned user and a branch not enabled', async () => {
    const { db, tables } = fixture();
    tables.profiles.push({
      id: 'sp_manager_2',
      organizationId: ORG,
      userId: 'u_manager',
      status: 'ACTIVE',
      displayName: 'Mona again',
    });
    expect(await reason(ensurePharmacySopStaffProfile(db, { ...scope, userId: 'u_manager' }))).toBe(
      'AMBIGUOUS_STAFF_PROFILE'
    );
    expect(
      await reason(ensurePharmacySopStaffProfile(db, { ...scope, userId: 'u_unassigned' }))
    ).toBe('BRANCH_OUT_OF_SCOPE');
    expect(
      await reason(
        ensurePharmacySopStaffProfile(db, {
          ...scope,
          pharmacyBranchId: 'pb_plain',
          userId: 'u_manager',
        })
      )
    ).toBe('SITE_NOT_ENABLED');
    expect(
      await reason(
        ensurePharmacySopStaffProfile(db, {
          organizationId: ORG,
          pharmacyBranchId: 'pb_other',
          userId: 'u_other',
        })
      )
    ).toBe('BRANCH_OUT_OF_SCOPE');
  });
});

describe('ensurePharmacySopJobRoles', () => {
  it('is idempotent and writes no capability rows', async () => {
    const { db, tables, raw } = fixture();
    const first = await ensurePharmacySopJobRoles(db, ORG);
    const second = await ensurePharmacySopJobRoles(db, ORG);
    expect(second).toEqual(first);
    expect(tables.jobRoles).toHaveLength(3);
    expect(raw).not.toHaveProperty('restaurantJobRoleCapability');
  });
});

describe('setPharmacySopRoleHolding', () => {
  const base = {
    organizationId: ORG,
    site: mainSite,
    roleKey: 'pharmacy-assistant' as const,
    grantedByStaffProfileId: 'sp_manager',
  };

  it('creates and links a profile when none exists, grants once and audits once', async () => {
    const { db, tables } = fixture();
    const first = await setPharmacySopRoleHolding(db, {
      ...base,
      targetUserId: 'u_new',
      held: true,
    });
    const repeat = await setPharmacySopRoleHolding(db, {
      ...base,
      targetUserId: 'u_new',
      held: true,
    });

    expect(first.changed).toBe(true);
    expect(repeat).toEqual({ staffProfileId: first.staffProfileId, changed: false });
    expect(tables.profiles.filter((profile) => profile.userId === 'u_new')).toEqual([
      expect.objectContaining({
        id: first.staffProfileId,
        displayName: 'Nadia New',
        primaryBranchId: 'rb_main',
        status: 'ACTIVE',
      }),
    ]);
    expect(tables.holdings).toEqual([
      expect.objectContaining({
        staffProfileId: first.staffProfileId,
        branchId: 'rb_main',
        grantedByStaffId: 'sp_manager',
      }),
    ]);
    expect(tables.holdingAudits).toEqual([
      expect.objectContaining({
        change: 'GRANTED',
        jobRoleKey: 'pharmacy-assistant',
        branchId: 'rb_main',
      }),
    ]);

    const revoked = await setPharmacySopRoleHolding(db, {
      ...base,
      targetUserId: 'u_new',
      held: false,
    });
    expect(revoked).toEqual({ staffProfileId: first.staffProfileId, changed: true });
    expect(tables.holdings).toHaveLength(0);
    expect(tables.holdingAudits.map((audit) => audit.change)).toEqual(['GRANTED', 'REVOKED']);
  });

  it('reuses an existing profile and refuses ambiguous or inactive profiles', async () => {
    const { db, tables } = fixture();
    const result = await setPharmacySopRoleHolding(db, {
      ...base,
      targetUserId: 'u_pharmacist',
      held: true,
    });
    expect(result.staffProfileId).toBe('sp_pharmacist');
    tables.profiles.push({
      id: 'sp_pharmacist_2',
      organizationId: ORG,
      userId: 'u_pharmacist',
      status: 'ACTIVE',
      displayName: 'Paul 2',
    });
    expect(
      await reason(
        setPharmacySopRoleHolding(db, { ...base, targetUserId: 'u_pharmacist', held: true })
      )
    ).toBe('AMBIGUOUS_STAFF_PROFILE');

    tables.profiles.push({
      id: 'sp_suspended',
      organizationId: ORG,
      userId: 'u_new',
      status: 'SUSPENDED',
      displayName: 'Nadia',
    });
    expect(
      await reason(setPharmacySopRoleHolding(db, { ...base, targetUserId: 'u_new', held: true }))
    ).toBe('NO_STAFF_PROFILE');
  });

  it('refuses inactive, unassigned and other-tenant users', async () => {
    const { db, tables } = fixture();
    for (const targetUserId of ['u_inactive', 'u_unassigned', 'u_other', 'u_missing']) {
      expect(
        await reason(setPharmacySopRoleHolding(db, { ...base, targetUserId, held: true }))
      ).toBe('BRANCH_OUT_OF_SCOPE');
    }
    expect(tables.holdings).toHaveLength(0);
  });

  it('refuses a site that is not enabled for this tenant', async () => {
    const { db } = fixture();
    expect(
      await reason(
        setPharmacySopRoleHolding(db, {
          ...base,
          site: { ...mainSite, pharmacyBranchId: 'pb_other', sopBranchId: 'rb_other' },
          targetUserId: 'u_new',
          held: true,
        })
      )
    ).toBe('SITE_NOT_ENABLED');
  });

  it.each(['pharmacy-qualified-person', 'pharmacy-manager'] as const)(
    'refuses a self-grant of the %s verifier role',
    async (roleKey) => {
      const { db, tables } = fixture();
      expect(
        await reason(
          setPharmacySopRoleHolding(db, { ...base, roleKey, targetUserId: 'u_manager', held: true })
        )
      ).toBe('NOT_INDEPENDENT');
      expect(tables.holdings).toHaveLength(0);
      expect(tables.holdingAudits).toHaveLength(0);
    }
  );

  it('still lets a manager revoke their own verifier role, and grant a non-verifier role', async () => {
    const { db, tables } = fixture();
    await grantRole(db, 'sp_manager', 'pharmacy-manager', tables);
    await expect(
      setPharmacySopRoleHolding(db, {
        ...base,
        roleKey: 'pharmacy-manager',
        targetUserId: 'u_manager',
        held: false,
      })
    ).resolves.toEqual({ staffProfileId: 'sp_manager', changed: true });
    await expect(
      setPharmacySopRoleHolding(db, { ...base, targetUserId: 'u_manager', held: true })
    ).resolves.toEqual({ staffProfileId: 'sp_manager', changed: true });
  });

  it('refuses a grant from a grantor with no staff profile in the tenant', async () => {
    const { db } = fixture();
    expect(
      await reason(
        setPharmacySopRoleHolding(db, {
          ...base,
          roleKey: 'pharmacy-manager',
          grantedByStaffProfileId: 'sp_missing',
          targetUserId: 'u_pharmacist',
          held: true,
        })
      )
    ).toBe('NO_STAFF_PROFILE');
  });

  it('grants the qualified-person role only to a user the ABAC engine lets dispense', async () => {
    const { db, tables } = fixture();
    const grant = {
      ...base,
      roleKey: 'pharmacy-qualified-person' as const,
      targetUserId: 'u_pharmacist',
      held: true,
    };
    abac.nonDispensers.add('u_pharmacist');
    expect(await reason(setPharmacySopRoleHolding(db, grant))).toBe('ROLE_REQUIRED');
    expect(tables.holdings).toHaveLength(0);
    expect(can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u_pharmacist', organizationId: ORG, status: 'ACTIVE' }),
      'pharmacy:dispense',
      undefined,
      { db }
    );

    // The manager role is not gated on dispensing, and revoking never is.
    await expect(
      setPharmacySopRoleHolding(db, { ...grant, roleKey: 'pharmacy-manager' })
    ).resolves.toMatchObject({ changed: true });

    abac.nonDispensers.clear();
    await expect(setPharmacySopRoleHolding(db, grant)).resolves.toEqual({
      staffProfileId: 'sp_pharmacist',
      changed: true,
    });
    abac.nonDispensers.add('u_pharmacist');
    await expect(setPharmacySopRoleHolding(db, { ...grant, held: false })).resolves.toEqual({
      staffProfileId: 'sp_pharmacist',
      changed: true,
    });
  });
});

describe('occurrence scope and independent verification', () => {
  it('finds an occurrence only at its own site', async () => {
    const { db } = fixture();
    await expect(
      assertOccurrenceAtSite(db, { occurrenceId: 'occ_main', site: mainSite })
    ).resolves.toMatchObject({
      id: 'occ_main',
      claimedByStaffProfileId: 'sp_claimer',
    });
    for (const occurrenceId of ['occ_restaurant', 'occ_missing']) {
      expect(await reason(assertOccurrenceAtSite(db, { occurrenceId, site: mainSite }))).toBe(
        'OCCURRENCE_OUT_OF_SCOPE'
      );
    }
  });

  it('accepts an independent verifier holding a verifier role', async () => {
    const { db, tables } = fixture();
    await grantRole(db, 'sp_pharmacist', 'pharmacy-qualified-person', tables);
    await expect(
      assertIndependentPharmacyVerifier(db, {
        occurrenceId: 'occ_main',
        site: mainSite,
        verifierStaffProfileId: 'sp_pharmacist',
      })
    ).resolves.toBeUndefined();
    expect(
      await pharmacySopRolesAt(db, { staffProfileId: 'sp_pharmacist', sopBranchId: 'rb_main' })
    ).toEqual(['pharmacy-qualified-person']);
    expect(
      await pharmacySopRolesAt(db, { staffProfileId: 'sp_pharmacist', sopBranchId: 'rb_other' })
    ).toEqual([]);
  });

  it('refuses a verifier without a verifier role, including an assistant', async () => {
    const { db, tables } = fixture();
    expect(
      await reason(
        assertIndependentPharmacyVerifier(db, {
          occurrenceId: 'occ_main',
          site: mainSite,
          verifierStaffProfileId: 'sp_pharmacist',
        })
      )
    ).toBe('ROLE_REQUIRED');
    await grantRole(db, 'sp_pharmacist', 'pharmacy-assistant', tables);
    expect(
      await reason(
        assertIndependentPharmacyVerifier(db, {
          occurrenceId: 'occ_main',
          site: mainSite,
          verifierStaffProfileId: 'sp_pharmacist',
        })
      )
    ).toBe('ROLE_REQUIRED');
  });

  it('re-checks the role and the dispensing permission at verification time', async () => {
    const { db, tables } = fixture();
    const input = {
      occurrenceId: 'occ_main',
      site: mainSite,
      verifierStaffProfileId: 'sp_pharmacist',
    };
    await grantRole(db, 'sp_pharmacist', 'pharmacy-qualified-person', tables);
    expect(await reason(assertIndependentPharmacyVerifier(db, input))).toBe('RESOLVED');

    // Dispensing withdrawn after the grant: a qualified-person-only verifier stops.
    abac.nonDispensers.add('u_pharmacist');
    expect(await reason(assertIndependentPharmacyVerifier(db, input))).toBe('ROLE_REQUIRED');
    // A manager role still qualifies on a pack the manager may verify.
    await grantRole(db, 'sp_pharmacist', 'pharmacy-manager', tables);
    expect(await reason(assertIndependentPharmacyVerifier(db, input))).toBe('RESOLVED');

    // Holdings are re-read: once both are revoked, verification is refused.
    abac.nonDispensers.clear();
    tables.holdings.length = 0;
    expect(await reason(assertIndependentPharmacyVerifier(db, input))).toBe('ROLE_REQUIRED');
  });

  it('lets only a qualified person verify controlled counts', async () => {
    const { db, tables } = fixture();
    await grantRole(db, 'sp_manager', 'pharmacy-manager', tables);
    const input = {
      occurrenceId: 'occ_counts',
      site: mainSite,
      verifierStaffProfileId: 'sp_manager',
    };
    expect(await reason(assertIndependentPharmacyVerifier(db, input))).toBe('ROLE_REQUIRED');
    await grantRole(db, 'sp_manager', 'pharmacy-qualified-person', tables);
    expect(await reason(assertIndependentPharmacyVerifier(db, input))).toBe('RESOLVED');
  });

  it.each([
    ['the claimer', 'occ_main', 'sp_claimer'],
    ['the assignee', 'occ_counts', 'sp_assignee'],
    ['a step completer', 'occ_main', 'sp_completer'],
    ['an evidence uploader', 'occ_main', 'sp_uploader'],
  ])('refuses %s as verifier', async (_label, occurrenceId, verifierStaffProfileId) => {
    const { db, tables } = fixture();
    await grantRole(db, verifierStaffProfileId, 'pharmacy-qualified-person', tables);
    expect(
      await reason(
        assertIndependentPharmacyVerifier(db, {
          occurrenceId,
          site: mainSite,
          verifierStaffProfileId,
        })
      )
    ).toBe('NOT_INDEPENDENT');
  });

  it('refuses whoever linked a record to the occurrence', async () => {
    const { db, tables } = fixture();
    await grantRole(db, 'sp_pharmacist', 'pharmacy-qualified-person', tables);
    tables.links.push({
      id: 'link_x',
      organizationId: ORG,
      occurrenceId: 'occ_main',
      linkedByStaffProfileId: 'sp_pharmacist',
    });
    expect(
      await reason(
        assertIndependentPharmacyVerifier(db, {
          occurrenceId: 'occ_main',
          site: mainSite,
          verifierStaffProfileId: 'sp_pharmacist',
        })
      )
    ).toBe('NOT_INDEPENDENT');
  });
});

describe('pharmacySopRecordTimeBounds', () => {
  const occurrence = {
    dueAt: at('2026-11-04T08:00:00Z'),
    windowEndsAt: at('2026-11-04T12:00:00Z'),
  };

  it('bounds event records from dueAt − 24h to windowEndsAt', () => {
    for (const recordType of ['TEMPERATURE_LOG', 'GOODS_RECEIPT'] as const) {
      expect(pharmacySopRecordTimeBounds(recordType, occurrence)).toEqual({
        gte: new Date(occurrence.dueAt.getTime() - PHARMACY_SOP_RECORD_LOOKBACK_MS),
        lte: occurrence.windowEndsAt,
      });
    }
    expect(PHARMACY_SOP_RECORD_LOOKBACK_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('leaves register balances and state records unbounded', () => {
    for (const recordType of [
      'CONTROLLED_REGISTER_ENTRY',
      'MANUFACTURING_BATCH',
      'RECALL_NOTICE',
    ] as const) {
      expect(pharmacySopRecordTimeBounds(recordType, occurrence)).toBeNull();
    }
  });
});

describe('linkPharmacySopRecord', () => {
  const actor = { staffProfileId: 'sp_manager', displayName: 'Mona', userId: 'u_manager' };
  const base = { site: mainSite, occurrenceId: 'occ_live', actor };

  it('links an existing temperature log once, reports its range flag, and is idempotent', async () => {
    const { db, tables, shareLocks } = fixture();
    const first = await linkPharmacySopRecord(db, {
      ...base,
      occurrenceStepId: 'step_live',
      recordType: 'TEMPERATURE_LOG',
      recordId: ' temp_main ',
      note: '  fridge door left open  ',
    });
    const repeat = await linkPharmacySopRecord(db, {
      ...base,
      recordType: 'TEMPERATURE_LOG',
      recordId: 'temp_main',
    });
    expect(first).toEqual({ linkId: expect.any(String), created: true, outOfRange: true });
    expect(repeat).toEqual({ linkId: first.linkId, created: false, outOfRange: true });
    expect(tables.links).toEqual([
      expect.objectContaining({
        organizationId: ORG,
        pharmacyBranchId: 'pb_main',
        occurrenceStepId: 'step_live',
        recordId: 'temp_main',
        note: 'fridge door left open',
        linkedByStaffProfileId: 'sp_manager',
        linkedByUserId: 'u_manager',
      }),
    ]);
    // The occurrence row is share-locked inside the transaction before it is read.
    expect(shareLocks).toEqual(['occ_live', 'occ_live']);
  });

  it('validates each record type at the branch or, for recalls, in the tenant', async () => {
    const { db } = fixture();
    const link = (
      recordType: Parameters<typeof linkPharmacySopRecord>[1]['recordType'],
      recordId: string
    ) => reason(linkPharmacySopRecord(db, { ...base, recordType, recordId }));
    expect(await link('CONTROLLED_REGISTER_ENTRY', 'reg_main')).toBe('RESOLVED');
    expect(await link('GOODS_RECEIPT', 'grn_main')).toBe('RESOLVED');
    expect(await link('MANUFACTURING_BATCH', 'batch_main')).toBe('RESOLVED');
    expect(await link('RECALL_NOTICE', 'recall_a')).toBe('RESOLVED');

    expect(await link('TEMPERATURE_LOG', 'temp_plain')).toBe('RECORD_OUT_OF_SCOPE');
    expect(await link('TEMPERATURE_LOG', 'temp_other')).toBe('RECORD_OUT_OF_SCOPE');
    expect(await link('GOODS_RECEIPT', 'grn_plain')).toBe('RECORD_OUT_OF_SCOPE');
    expect(await link('MANUFACTURING_BATCH', 'batch_elsewhere')).toBe('RECORD_OUT_OF_SCOPE');
    expect(await link('RECALL_NOTICE', 'recall_b')).toBe('RECORD_OUT_OF_SCOPE');
    expect(await link('CONTROLLED_REGISTER_ENTRY', 'missing')).toBe('RECORD_OUT_OF_SCOPE');
  });

  it('only links temperature logs and goods receipts inside the occurrence window', async () => {
    const { db, tables } = fixture();
    const link = (
      recordType: Parameters<typeof linkPharmacySopRecord>[1]['recordType'],
      recordId: string
    ) => reason(linkPharmacySopRecord(db, { ...base, recordType, recordId }));
    // Both bounds are inclusive.
    expect(await link('TEMPERATURE_LOG', 'temp_earliest')).toBe('RESOLVED');
    expect(await link('TEMPERATURE_LOG', 'temp_latest')).toBe('RESOLVED');
    expect(await link('TEMPERATURE_LOG', 'temp_stale')).toBe('RECORD_OUT_OF_SCOPE');
    expect(await link('TEMPERATURE_LOG', 'temp_after')).toBe('RECORD_OUT_OF_SCOPE');
    expect(await link('GOODS_RECEIPT', 'grn_old')).toBe('RECORD_OUT_OF_SCOPE');
    expect(tables.links.map((row) => row.recordId).sort()).toEqual([
      'temp_earliest',
      'temp_latest',
    ]);
  });

  it('refuses an occurrence that is not IN_PROGRESS, re-read inside the transaction', async () => {
    const { db, tables } = fixture();
    const record = { recordType: 'TEMPERATURE_LOG' as const, recordId: 'temp_main' };
    expect(
      await reason(
        linkPharmacySopRecord(db, { ...base, ...record, occurrenceId: 'occ_submitted_own' })
      )
    ).toBe('INVALID_INPUT');
    // A status change between the router's check and the link is caught too.
    tables.occurrences.find((row) => row.id === 'occ_live')!.status = 'SUBMITTED';
    expect(await reason(linkPharmacySopRecord(db, { ...base, ...record }))).toBe('INVALID_INPUT');
    expect(tables.links).toHaveLength(0);
  });

  it('refuses anyone but the occurrence owner (assignee, else claimer)', async () => {
    const { db, tables } = fixture();
    const record = { recordType: 'TEMPERATURE_LOG' as const, recordId: 'temp_main' };
    const pharmacist = {
      staffProfileId: 'sp_pharmacist',
      displayName: 'Paul',
      userId: 'u_pharmacist',
    };
    expect(await reason(linkPharmacySopRecord(db, { ...base, ...record, actor: pharmacist }))).toBe(
      'INVALID_INPUT'
    );
    expect(
      await reason(
        linkPharmacySopRecord(db, { ...base, ...record, occurrenceId: 'occ_assigned_elsewhere' })
      )
    ).toBe('INVALID_INPUT');
    expect(tables.links).toHaveLength(0);
    await expect(
      linkPharmacySopRecord(db, {
        ...base,
        ...record,
        occurrenceId: 'occ_assigned_elsewhere',
        actor: pharmacist,
      })
    ).resolves.toMatchObject({ created: true });
  });

  it('refuses closed occurrences, other-branch occurrences, foreign steps and bad input', async () => {
    const { db, tables } = fixture();
    const record = { recordType: 'TEMPERATURE_LOG' as const, recordId: 'temp_main' };
    for (const occurrenceId of ['occ_verified', 'occ_waived']) {
      expect(await reason(linkPharmacySopRecord(db, { ...base, ...record, occurrenceId }))).toBe(
        'INVALID_INPUT'
      );
    }
    expect(
      await reason(
        linkPharmacySopRecord(db, { ...base, ...record, occurrenceId: 'occ_restaurant' })
      )
    ).toBe('OCCURRENCE_OUT_OF_SCOPE');
    for (const occurrenceStepId of ['step_counts', 'step_1']) {
      expect(
        await reason(linkPharmacySopRecord(db, { ...base, ...record, occurrenceStepId }))
      ).toBe('OCCURRENCE_OUT_OF_SCOPE');
    }
    expect(
      await reason(
        linkPharmacySopRecord(db, {
          ...base,
          ...record,
          site: { ...mainSite, pharmacyBranchId: 'pb_other', sopBranchId: 'rb_other' },
        })
      )
    ).toBe('SITE_NOT_ENABLED');
    expect(await reason(linkPharmacySopRecord(db, { ...base, ...record, recordId: '  ' }))).toBe(
      'INVALID_INPUT'
    );
    expect(
      await reason(linkPharmacySopRecord(db, { ...base, ...record, note: 'x'.repeat(2001) }))
    ).toBe('INVALID_INPUT');
    expect(tables.links).toHaveLength(0);
  });
});
