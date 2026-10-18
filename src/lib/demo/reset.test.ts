import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rebuild: vi.fn() }));

vi.mock('@/lib/demo/seed-seat', () => ({
  rebuildDemoRestaurantSeatInTransaction: mocks.rebuild,
}));

import { resetDemoSeatInTransaction } from '@/lib/demo/reset';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { DEMO_PERSONA_KEYS, demoPersonaEmail, demoPersonaUserId } from './personas';

const ORGANIZATION_ID = 'org_demo_restaurant_seat_1';
const MANAGER_STAFF_ID = 'manager_staff_actual';
const APPROVER_STAFF_ID = 'approver_staff_actual';
const NOW = new Date('2026-09-04T12:00:00.000Z');
const RESET_POLICY_MIGRATION = resolve(
  process.cwd(),
  'prisma/migrations/20260905090000_restaurant_demo_reset_append_only_rls/migration.sql'
);
const RESET_POLICY_FOLLOWUP_MIGRATION = resolve(
  process.cwd(),
  'prisma/migrations/20260905100000_restaurant_demo_reset_delete_rls/migration.sql'
);
const RESET_COMPATIBILITY_MIGRATION = resolve(
  process.cwd(),
  'prisma/migrations/20261018000000_restaurant_demo_reset_compatibility/migration.sql'
);
const REMAINING_DELETE_POLICY_TABLES = [
  'restaurant_daily_close_tender_totals',
  'restaurant_daily_closes',
  'restaurant_drawer_movements',
  'restaurant_job_executions',
  'restaurant_notification_deliveries',
  'restaurant_order_events',
  'restaurant_payment_events',
  'restaurant_refunds',
  'restaurant_sop_escalation_events',
  'restaurant_sop_evidence',
  'restaurant_sop_verifications',
  'restaurant_staff_capability_audits',
  'restaurant_stock_movements',
  'restaurant_tax_refund_allocations',
  'restaurant_tenders',
  'restaurant_terminal_reconciliations',
] as const;
const RESET_CYCLE_FOREIGN_KEYS = [
  {
    constraintName: 'catering_approved_quote_fk',
    tableName: 'restaurant_catering_orders',
    parentTable: 'restaurant_catering_quote_revisions',
    columns: ['organizationId', 'id', 'approvedQuoteRevisionId'],
    parentColumns: ['organizationId', 'orderId', 'id'],
    deleteAction: 'r',
    deferrable: false,
    initiallyDeferred: false,
  },
  {
    constraintName: 'catering_confirmed_quote_fk',
    tableName: 'restaurant_catering_orders',
    parentTable: 'restaurant_catering_quote_revisions',
    columns: ['organizationId', 'id', 'confirmedQuoteRevisionId'],
    parentColumns: ['organizationId', 'orderId', 'id'],
    deleteAction: 'r',
    deferrable: false,
    initiallyDeferred: false,
  },
  {
    constraintName: 'restaurant_growth_draft_fk',
    tableName: 'restaurant_growth_reviews',
    parentTable: 'restaurant_growth_drafts',
    columns: ['organizationId', 'branchId', 'draftId'],
    parentColumns: ['organizationId', 'branchId', 'id'],
    deleteAction: 'a',
    deferrable: true,
    initiallyDeferred: true,
  },
] as const;

function fakeDb(
  organization: Partial<{
    isDemo: boolean;
    currentOrganizationId: string;
    isPlatformAdmin: string;
  }> = {},
  foreignKeys: Array<{ tableName: string; parentTable: string; deleteAction: string }> = [],
  staffRows: Array<{
    id: string;
    userId: string | null;
    email: string | null;
    status: string;
  }> = [
    {
      id: MANAGER_STAFF_ID,
      userId: 'user_demo_restaurant_seat_1_manager',
      email: null,
      status: 'ACTIVE',
    },
    {
      id: APPROVER_STAFF_ID,
      userId: 'user_demo_restaurant_seat_1_approver',
      email: 'approver.seat1@demo.devfathom.invalid',
      status: 'ACTIVE',
    },
  ]
) {
  const events: string[] = [];
  const deletes: Array<{ sql: string; parameters: unknown[] }> = [];
  const locked = {
    id: ORGANIZATION_ID,
    slug: 'demo-restaurant-seat-1',
    isDemo: true,
    vertical: 'RESTAURANT',
    deploymentMode: 'SHARED',
    currentOrganizationId: ORGANIZATION_ID,
    isPlatformAdmin: 'false',
    ...organization,
  };

  const query = vi.fn(async (sql: string, ...parameters: unknown[]) => {
    if (sql.includes('FOR UPDATE OF organization')) return [locked];
    if (sql.includes('SELECT id, email FROM users')) {
      return [
        {
          id: 'user_demo_restaurant_seat_1_manager',
          email: 'manager.seat1@demo.devfathom.invalid',
        },
        {
          id: 'user_demo_restaurant_seat_1_approver',
          email: 'approver.seat1@demo.devfathom.invalid',
        },
      ];
    }
    if (sql.includes('FROM restaurant_staff_profiles') && sql.includes('status::text')) {
      return staffRows;
    }
    if (sql.includes('WITH allowed("tableName")')) {
      return [
        ...[...sql.matchAll(/\('([^']+)'\)/g)].map((match) => ({
          tableName: match[1],
          parentTable: null,
          deleteAction: null,
        })),
        ...RESET_CYCLE_FOREIGN_KEYS,
        ...foreignKeys,
      ];
    }
    if (sql.includes("current_setting('app.current_branch_id'")) {
      return [{ currentBranchId: 'branch_original', compatibilityReady: true }];
    }
    if (sql.includes('SELECT id FROM restaurant_branches')) return [{ id: 'branch_demo_1' }];
    if (sql.includes("set_config('app.current_branch_id'")) {
      events.push(parameters[0] === 'branch_original' ? 'branch:restore' : 'branch:set');
      return [{}];
    }
    if (sql.includes('count(*)') && sql.includes('FROM restaurant_catering_orders')) {
      return [{ count: 0 }];
    }
    if (sql.includes('count(*)') && sql.includes('restaurant_growth_')) return [{ count: 0 }];
    if (sql.includes('SELECT COALESCE(')) return [{ allowed: true }];
    if (sql.includes("set_config('app.demo_reset_organization_id', $1")) {
      events.push('guc:set');
      return [{}];
    }
    if (sql.includes("set_config('app.demo_reset_organization_id', '', true)")) {
      events.push('guc:clear');
      return [{}];
    }
    if (sql.includes(' UNION ALL ')) {
      return [...sql.matchAll(/SELECT '([^']+)' AS "tableName"/g)].map((match) => ({
        tableName: match[1],
        count: 0,
      }));
    }
    if (sql.includes('AS credentials') && sql.includes('AS executions')) {
      return [{ staff: 0, credentials: 0, jobs: 0, executions: 0 }];
    }
    throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
  });
  const execute = vi.fn(async (sql: string, ...parameters: unknown[]) => {
    if (sql.startsWith('SET CONSTRAINTS')) return 0;
    if (sql.startsWith('UPDATE restaurant_catering_orders')) return 0;
    if (sql.startsWith('DELETE')) {
      events.push('delete');
      deletes.push({ sql, parameters });
      return 0;
    }
    if (sql.startsWith('UPDATE organizations')) {
      events.push('last-reset');
      return 1;
    }
    throw new Error(`Unexpected execute: ${sql.slice(0, 80)}`);
  });
  return {
    db: { $queryRawUnsafe: query, $executeRawUnsafe: execute } as unknown as ScopedDb,
    deletes,
    events,
    execute,
    query,
  };
}

beforeEach(() => {
  mocks.rebuild.mockReset().mockImplementation(async () => ({
    organizationId: ORGANIZATION_ID,
    seatNumber: 1,
    managerUserId: 'user_demo_restaurant_seat_1_manager',
    managerEmail: 'manager.seat1@demo.devfathom.invalid',
    counts: {},
  }));
});

describe('resetDemoSeatInTransaction', () => {
  it('pins exactly 34 legacy named DELETE policies and their approved predicate', () => {
    const migrations = resolve(process.cwd(), 'prisma/migrations');
    const sql = readdirSync(migrations, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name !== '20261018000000_restaurant_demo_reset_compatibility'
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => readFileSync(resolve(migrations, entry.name, 'migration.sql'), 'utf8'))
      .join('\n')
      .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '');
    const tables = [
      ...REMAINING_DELETE_POLICY_TABLES,
      'restaurant_customer_interactions',
      'restaurant_customer_consents',
      'restaurant_loyalty_points_entries',
      'restaurant_labour_cost_facts',
      'restaurant_service_charge_policy_versions',
      'restaurant_promotion_cap_reservations',
      'restaurant_promotion_evaluation_snapshots',
      'restaurant_promotion_candidate_snapshots',
      'restaurant_promotion_application_snapshots',
      'restaurant_promotion_unit_allocations',
      'restaurant_promotion_bill_application_snapshots',
      'restaurant_promotion_audit_events',
      'restaurant_staff_job_role_audits',
      'restaurant_shift_swap_requests',
      'restaurant_shift_swap_decisions',
      'restaurant_shift_events',
      'restaurant_time_adjustments',
      'restaurant_workforce_commands',
    ];
    const policies = [
      ...sql.matchAll(/CREATE\s+POLICY\s+"?restaurant_demo_reset_delete"?\b[^;]*;/gi),
    ]
      .map(([statement]) => statement.replace(/\s+/g, ' ').trim())
      .sort();

    expect(tables).toHaveLength(34);
    // Also reject later ALTER/DROP statements or a 35th named policy, even if its
    // predicate is too loose to match the approved CREATE statement below.
    expect(sql.match(/\brestaurant_demo_reset_delete\b/gi)).toHaveLength(34);
    expect(policies).toEqual(
      tables
        .map(
          (table) =>
            `CREATE POLICY "restaurant_demo_reset_delete" ON "${table}" FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));`
        )
        .sort()
    );
  });

  it('pins compatibility DELETE policies to the seven reviewed catering tables', () => {
    const sql = readFileSync(RESET_COMPATIBILITY_MIGRATION, 'utf8');
    const tableList = sql.match(/FOREACH table_name IN ARRAY ARRAY\[([\s\S]*?)\] LOOP/);
    const tables = [...(tableList?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);

    expect(tables).toEqual([
      'restaurant_catering_events',
      'restaurant_catering_branch_capacity',
      'restaurant_catering_quote_revisions',
      'restaurant_catering_quote_approvals',
      'restaurant_catering_dispositions',
      'restaurant_catering_commands',
      'restaurant_catering_money_evidence',
    ]);
    expect(sql.match(/\brestaurant_demo_reset_delete\b/g)).toHaveLength(1);
    expect(sql).toContain(
      'CREATE POLICY restaurant_demo_reset_delete ON public.%I FOR DELETE USING (public.restaurant_demo_reset_compatibility_allowed("organizationId"))'
    );
  });

  it('grants demo reset DELETE visibility to every append-only restaurant table', () => {
    const sql = readFileSync(RESET_POLICY_MIGRATION, 'utf8');
    const policyTables = [
      ...sql.matchAll(
        /CREATE POLICY "restaurant_demo_reset_delete" ON "([^"]+)"\s+FOR DELETE USING \(public\.restaurant_demo_reset_allowed\("organizationId"\)\);/g
      ),
    ].map((match) => match[1]);

    expect(policyTables).toEqual([
      'restaurant_customer_interactions',
      'restaurant_customer_consents',
      'restaurant_loyalty_points_entries',
      'restaurant_labour_cost_facts',
    ]);
  });

  it('grants demo reset DELETE visibility to every remaining reset table', () => {
    const sql = readFileSync(RESET_POLICY_FOLLOWUP_MIGRATION, 'utf8');
    const policyTables = [
      ...sql.matchAll(
        /CREATE POLICY "restaurant_demo_reset_delete" ON "([^"]+)"\s+FOR DELETE USING \(public\.restaurant_demo_reset_allowed\("organizationId"\)\);/g
      ),
    ].map((match) => match[1]);

    expect(policyTables).toEqual(REMAINING_DELETE_POLICY_TABLES);
    expect(sql.match(/CREATE POLICY/g)).toHaveLength(REMAINING_DELETE_POLICY_TABLES.length);
    expect(sql).not.toMatch(/\b(?:FUNCTION|TRIGGER)\b/);
  });

  it.each([
    ['non-demo organization', { isDemo: false }],
    ['cross-tenant scope', { currentOrganizationId: 'org_demo_restaurant_seat_2' }],
    ['platform scope', { isPlatformAdmin: 'true' }],
  ])('rejects %s before destruction', async (_name, organization) => {
    const fake = fakeDb(organization);
    await expect(
      resetDemoSeatInTransaction(fake.db, { organizationId: ORGANIZATION_ID, now: NOW })
    ).rejects.toThrow(/locked canonical SHARED restaurant tenant scope/);
    expect(fake.execute).not.toHaveBeenCalled();
    expect(mocks.rebuild).not.toHaveBeenCalled();
  });

  it('preserves identities and demo-reset jobs, clears reset scope before rebuild', async () => {
    const fake = fakeDb();
    mocks.rebuild.mockImplementationOnce(async () => {
      fake.events.push('rebuild');
      return {
        organizationId: ORGANIZATION_ID,
        seatNumber: 1,
        managerUserId: 'user_demo_restaurant_seat_1_manager',
        managerEmail: 'manager.seat1@demo.devfathom.invalid',
        counts: {},
      };
    });
    await resetDemoSeatInTransaction(fake.db, { organizationId: ORGANIZATION_ID, now: NOW });

    const jobs = fake.deletes.find(({ sql }) => sql.startsWith('DELETE FROM restaurant_jobs'))!;
    const executions = fake.deletes.find(({ sql }) =>
      sql.startsWith('DELETE FROM restaurant_job_executions')
    )!;
    const staff = fake.deletes.find(({ sql }) =>
      sql.startsWith('DELETE FROM restaurant_staff_profiles')
    )!;
    const credentials = fake.deletes.find(({ sql }) =>
      sql.startsWith('DELETE FROM restaurant_operator_credentials')
    )!;
    expect(jobs.sql).toContain('type <> $2');
    expect(jobs.parameters).toEqual([ORGANIZATION_ID, 'demo-reset']);
    expect(executions.sql).toContain('job.type <> $2');
    expect(staff.parameters).toEqual([ORGANIZATION_ID, [MANAGER_STAFF_ID, APPROVER_STAFF_ID]]);
    expect(credentials.sql).toContain('"deviceId" IS NULL');
    expect(credentials.parameters).toEqual([
      ORGANIZATION_ID,
      [MANAGER_STAFF_ID, APPROVER_STAFF_ID],
    ]);
    expect(
      fake.deletes.some(({ sql }) => sql.includes('restaurant_activation_acknowledgements'))
    ).toBe(false);
    expect(
      fake.query.mock.calls.filter(([sql]) => String(sql).includes('SELECT COALESCE('))
    ).toHaveLength(fake.deletes.length + 1);
    expect(fake.events.filter((event) => event === 'branch:set')).toHaveLength(5);
    expect(fake.events.filter((event) => event === 'branch:restore')).toHaveLength(5);
    expect(fake.events.indexOf('guc:clear')).toBeLessThan(fake.events.indexOf('rebuild'));
    expect(fake.events.indexOf('rebuild')).toBeLessThan(fake.events.indexOf('last-reset'));
  });

  it('does not stamp lastDemoResetAt when rebuild fails', async () => {
    const fake = fakeDb();
    mocks.rebuild.mockRejectedValueOnce(new Error('builder failed'));
    await expect(
      resetDemoSeatInTransaction(fake.db, { organizationId: ORGANIZATION_ID, now: NOW })
    ).rejects.toThrow('builder failed');
    expect(fake.events).toContain('guc:clear');
    expect(fake.events).not.toContain('last-reset');
  });

  it('retains all canonical persona staff and credentials, clears old sessions, and rebuilds the same seat', async () => {
    const rows = DEMO_PERSONA_KEYS.map((persona) => ({
      id: persona === 'manager' ? MANAGER_STAFF_ID : `staff_${persona}`,
      userId: demoPersonaUserId(1, persona),
      email: demoPersonaEmail(1, persona),
      status: 'ACTIVE',
    }));
    rows.push({
      id: APPROVER_STAFF_ID,
      userId: 'user_demo_restaurant_seat_1_approver',
      email: 'approver.seat1@demo.devfathom.invalid',
      status: 'ACTIVE',
    });
    const fake = fakeDb({}, [], rows);
    await resetDemoSeatInTransaction(fake.db, { organizationId: ORGANIZATION_ID, now: NOW });
    const retained = [
      MANAGER_STAFF_ID,
      APPROVER_STAFF_ID,
      ...rows
        .filter((row) => ![MANAGER_STAFF_ID, APPROVER_STAFF_ID].includes(row.id))
        .map((row) => row.id),
    ];
    for (const table of ['restaurant_staff_profiles', 'restaurant_operator_credentials']) {
      const deletion = fake.deletes.find(({ sql }) => sql.startsWith(`DELETE FROM ${table}`))!;
      expect(deletion.parameters).toEqual([ORGANIZATION_ID, retained]);
      expect(deletion.sql).toContain('ANY($2::text[])');
    }
    expect(
      fake.deletes.find(({ sql }) => sql.startsWith('DELETE FROM "restaurant_terminal_sessions"'))
        ?.parameters
    ).toEqual([ORGANIZATION_ID]);
    expect(
      fake.deletes.some(({ sql }) =>
        /DELETE FROM (users|organization_roles|user_permission_overrides)/.test(sql)
      )
    ).toBe(false);
    expect(mocks.rebuild).toHaveBeenCalledWith(
      fake.db,
      expect.objectContaining({
        identity: expect.objectContaining({ organizationId: ORGANIZATION_ID }),
        managerStaffProfileId: MANAGER_STAFF_ID,
        approverStaffProfileId: APPROVER_STAFF_ID,
      })
    );
  });

  it('rejects an approver email attached to the wrong user before destruction', async () => {
    const fake = fakeDb(
      {},
      [],
      [
        {
          id: MANAGER_STAFF_ID,
          userId: 'user_demo_restaurant_seat_1_manager',
          email: null,
          status: 'ACTIVE',
        },
        {
          id: APPROVER_STAFF_ID,
          userId: 'wrong_approver_user',
          email: 'approver.seat1@demo.devfathom.invalid',
          status: 'ACTIVE',
        },
      ]
    );
    await expect(
      resetDemoSeatInTransaction(fake.db, { organizationId: ORGANIZATION_ID, now: NOW })
    ).rejects.toThrow(/distinct active manager and approver/);
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('deletes CASCADE and SET NULL children before their parents', async () => {
    const fake = fakeDb({}, [
      {
        tableName: 'restaurant_cameras',
        parentTable: 'restaurant_camera_gateways',
        deleteAction: 'c',
      },
      {
        tableName: 'restaurant_floors',
        parentTable: 'restaurant_branches',
        deleteAction: 'n',
      },
    ]);
    await resetDemoSeatInTransaction(fake.db, { organizationId: ORGANIZATION_ID, now: NOW });
    const position = (table: string) =>
      fake.deletes.findIndex(({ sql }) => sql.startsWith(`DELETE FROM "${table}"`));
    expect(position('restaurant_cameras')).toBeLessThan(position('restaurant_camera_gateways'));
    expect(position('restaurant_floors')).toBeLessThan(position('restaurant_branches'));
  });
});
