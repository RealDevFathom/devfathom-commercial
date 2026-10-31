// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { hash } from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TRPCContext } from '@/server/trpc';
import { can } from '@/lib/abac';

vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: vi.fn(async () => true),
}));
vi.mock('@/lib/entitlements', async () => ({
  ...(await vi.importActual<typeof import('@/lib/entitlements')>('@/lib/entitlements')),
  hasModule: vi.fn(() => true),
}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const prefix = `seasonal784_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const org = `${prefix}_a`,
  other = `${prefix}_b`,
  branch = `${prefix}_branch`,
  foreign = `${prefix}_foreign`;
const user = `${prefix}_user`,
  staff = `${prefix}_staff`,
  credential = `${prefix}_credential`;
const pin = '489153';
const role = `${prefix}_runtime`;
const owner = new Client({ connectionString: TEST_DATABASE_URL });
let tenancy: typeof import('@/lib/tenancy/scoped-db');
let router: typeof import('@/server/routers/pharmacy-reports');
let audit: typeof import('@/server/audit');
let runtimeUrl: string;
let createdRuntimeRole = false;
const previousDatabaseUrl = process.env.DATABASE_URL;
const data = {
  branchId: branch,
  name: 'Season',
  startDate: '2026-07-01',
  endDate: '2026-08-31',
  enabled: true,
  confirmationPin: pin,
};

async function call(
  method: 'saveSeasonalWindow' | 'deleteSeasonalWindow' | 'seasonalCalendar',
  input: unknown,
  actorRole: 'ADMIN' | 'EMPLOYEE' = 'ADMIN'
) {
  // Match the HTTP route: any resolver failure aborts its tenant transaction.
  return tenancy.withTenantDb(org, async (db) => {
    const caller = router.pharmacyReportsRouter.createCaller({
      db,
      entitlements: { organizationId: org, enabledModules: ['pharmacy-reports'], modules: [] },
      session: {
        expires: 'later',
        user: { id: user, role: actorRole, status: 'ACTIVE', organizationId: org },
      },
      organization: { id: org },
      support: null,
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as unknown as TRPCContext);
    if (method === 'saveSeasonalWindow')
      return caller.saveSeasonalWindow(input as Parameters<typeof caller.saveSeasonalWindow>[0]);
    if (method === 'deleteSeasonalWindow')
      return caller.deleteSeasonalWindow(
        input as Parameters<typeof caller.deleteSeasonalWindow>[0]
      );
    return caller.seasonalCalendar(input as Parameters<typeof caller.seasonalCalendar>[0]);
  });
}

async function seedWindow(id: string, branchId = branch, organizationId = org) {
  await owner.query(
    `INSERT INTO pharmacy_seasonal_calendar_windows (id,"organizationId","branchId",name,"startDate","endDate","createdById","updatedById","updatedAt") VALUES ($1,$2,$3,'Seed','2026-07-01','2026-08-31',$4,$4,now())`,
    [id, organizationId, branchId, user]
  );
}

describe.skipIf(!TEST_DATABASE_URL)('seasonal calendar PostgreSQL regressions', () => {
  beforeAll(async () => {
    await owner.connect();
    await owner.query("select set_config('app.is_platform_admin','true',false)");
    const privileges = (
      await owner.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')
    ).rows[0];
    runtimeUrl = TEST_DATABASE_URL!;
    if (privileges.rolsuper || privileges.rolbypassrls) {
      const password = randomUUID();
      await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
      createdRuntimeRole = true;
      await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await owner.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`
      );
      await owner.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
      await owner.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
      const url = new URL(TEST_DATABASE_URL!);
      url.username = role;
      url.password = password;
      runtimeUrl = url.toString();
    }
    process.env.DATABASE_URL = runtimeUrl;
    for (const id of [org, other])
      await owner.query(
        `INSERT INTO organizations (id,slug,"legalName","displayName","updatedAt") VALUES ($1,$1,$1,$1,now())`,
        [id]
      );
    for (const [id, organizationId] of [
      [branch, org],
      [foreign, other],
    ])
      await owner.query(
        `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt") VALUES ($1,$2,$1,$1,'Test','Test','PB',now())`,
        [id, organizationId]
      );
    await owner.query(
      `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'REVIEW','Review',now())`,
      [`${prefix}_dept`, org]
    );
    await owner.query(
      `INSERT INTO users (id,"organizationId",name,email,department,title,role,"updatedAt") VALUES ($1,$2,'Review owner',$3,'REVIEW','Owner','ADMIN',now())`,
      [user, org, `${user}@example.test`]
    );
    await owner.query(
      `INSERT INTO restaurant_staff_profiles (id,"organizationId","userId","displayName","updatedAt") VALUES ($1,$2,$3,'Owner',now())`,
      [staff, org, user]
    );
    await owner.query(
      `INSERT INTO restaurant_operator_credentials (id,"organizationId","staffProfileId",type,"credentialHash","updatedAt") VALUES ($1,$2,$3,'PIN',$4,now())`,
      [credential, org, staff, await hash(pin, 4)]
    );
    tenancy = await import('@/lib/tenancy/scoped-db');
    router = await import('@/server/routers/pharmacy-reports');
    audit = await import('@/server/audit');
  }, 30000);

  beforeEach(async () => {
    await audit.flushAuditWritesForTest();
    await owner.query(
      'DELETE FROM pharmacy_seasonal_calendar_windows WHERE "organizationId"=ANY($1::text[])',
      [[org, other]]
    );
    await owner.query(
      'UPDATE restaurant_operator_credentials SET "failedAttempts"=0,"lockedUntil"=null WHERE id=$1',
      [credential]
    );
  });

  afterAll(async () => {
    await audit?.flushAuditWritesForTest();
    const { db } = await import('@/lib/db');
    await db.$disconnect();
    // Remove mutable fixtures; append-only audits and their actor/tenant anchors remain.
    for (const table of [
      'pharmacy_seasonal_calendar_windows',
      'restaurant_operator_credentials',
      'restaurant_staff_profiles',
    ])
      await owner.query(`DELETE FROM ${table} WHERE "organizationId"=ANY($1::text[])`, [
        [org, other],
      ]);
    if (createdRuntimeRole) {
      await owner.query(`DROP OWNED BY ${role}`);
      await owner.query(`DROP ROLE ${role}`);
    }
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await owner.end();
  }, 30000);

  it('uses a restricted role with forced RLS; hides foreign rows and denies cross-tenant INSERT', async () => {
    await seedWindow(`${prefix}_foreign_window`, foreign, other);
    const c = new Client({ connectionString: runtimeUrl });
    await c.connect();
    try {
      expect(
        (await c.query('select rolsuper,rolbypassrls from pg_roles where rolname=current_user'))
          .rows[0]
      ).toEqual({ rolsuper: false, rolbypassrls: false });
      expect(
        (
          await c.query(
            "select relrowsecurity,relforcerowsecurity from pg_class where oid='pharmacy_seasonal_calendar_windows'::regclass"
          )
        ).rows[0]
      ).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      await c.query('BEGIN');
      await c.query("select set_config('app.current_organization_id',$1,true)", [org]);
      expect(
        (
          await c.query(
            'select id from pharmacy_seasonal_calendar_windows where "organizationId"=$1',
            [other]
          )
        ).rows
      ).toEqual([]);
      await expect(
        c.query(
          `INSERT INTO pharmacy_seasonal_calendar_windows (id,"organizationId","branchId",name,"startDate","endDate","createdById","updatedById","updatedAt") VALUES ($1,$2,$3,'Bad','2026-07-01','2026-08-31',$4,$4,now())`,
          [`${prefix}_cross`, other, foreign, user]
        )
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.query('ROLLBACK');
      await c.end();
    }
  });

  it('enforces composite tenant/branch FK and date ordering', async () => {
    await expect(seedWindow(`${prefix}_bad_fk`, foreign, org)).rejects.toMatchObject({
      code: '23503',
    });
    await expect(
      owner.query(
        `INSERT INTO pharmacy_seasonal_calendar_windows (id,"organizationId","branchId",name,"startDate","endDate","createdById","updatedById","updatedAt") VALUES ($1,$2,$3,'Bad','2026-08-31','2026-07-01',$4,$4,now())`,
        [`${prefix}_bad_dates`, org, branch, user]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('fails closed without tenant context and hides foreign UPDATE/DELETE targets', async () => {
    const c = new Client({ connectionString: runtimeUrl });
    await c.connect();
    try {
      expect((await c.query('select id from pharmacy_seasonal_calendar_windows')).rows).toEqual([]);
      await c.query('BEGIN');
      await c.query("select set_config('app.current_organization_id',$1,true)", [org]);
      expect(
        (
          await c.query(
            'update pharmacy_seasonal_calendar_windows set name=$1 where "organizationId"=$2',
            ['Wrong', other]
          )
        ).rowCount
      ).toBe(0);
      expect(
        (
          await c.query(
            'delete from pharmacy_seasonal_calendar_windows where "organizationId"=$1',
            [other]
          )
        ).rowCount
      ).toBe(0);
    } finally {
      await c.query('ROLLBACK');
      await c.end();
    }
  });

  it('rolls back a successful calendar deletion when the outer transaction fails', async () => {
    const id = `${prefix}_rollback`;
    await seedWindow(id);
    await expect(
      tenancy.withTenantDb(org, async (db) => {
        await db.pharmacySeasonalCalendarWindow.delete({ where: { id } });
        throw new Error('rollback probe');
      })
    ).rejects.toThrow('rollback probe');
    expect(
      (await owner.query('select id from pharmacy_seasonal_calendar_windows where id=$1', [id]))
        .rows
    ).toEqual([{ id }]);
  });

  it('denies non-owner and foreign branch requests', async () => {
    await expect(call('seasonalCalendar', { branchId: branch }, 'EMPLOYEE')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(call('saveSeasonalWindow', { ...data, branchId: foreign })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await audit.flushAuditWritesForTest();
  });

  it('honors a denied reports capability for calendar deletion', async () => {
    const id = `${prefix}_denied`;
    await seedWindow(id);
    vi.mocked(can).mockResolvedValue(false);
    try {
      await expect(
        call('deleteSeasonalWindow', { branchId: branch, id, confirmationPin: pin })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(call('saveSeasonalWindow', data)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      vi.mocked(can).mockResolvedValue(true);
    }
  });

  it('honors an explicit financial-report denial on both mutations', async () => {
    vi.mocked(can).mockImplementation(async (_subject, action) => action !== 'reports:financial');
    try {
      await expect(call('saveSeasonalWindow', data)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        call('deleteSeasonalWindow', { branchId: branch, id: 'absent', confirmationPin: pin })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const state = (
        await owner.query(
          'select "failedAttempts" from restaurant_operator_credentials where id=$1',
          [credential]
        )
      ).rows[0];
      expect(state.failedAttempts).toBe(0);
    } finally {
      vi.mocked(can).mockResolvedValue(true);
    }
  });

  it('returns NOT_FOUND when deleting a missing window', async () => {
    await expect(
      call('deleteSeasonalWindow', {
        branchId: branch,
        id: `${prefix}_missing`,
        confirmationPin: pin,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await audit.flushAuditWritesForTest();
  });

  it('can save a valid owner window', async () => {
    const saved = (await call('saveSeasonalWindow', data)) as { id: string };
    expect(saved).toMatchObject({ branchId: branch, name: 'Season' });
    await expect(
      call('saveSeasonalWindow', { ...data, id: saved.id, name: 'Edited' })
    ).resolves.toMatchObject({ id: saved.id, name: 'Edited' });
    await audit.flushAuditWritesForTest();
    const row = (
      await owner.query(
        'select "targetId",metadata,changes from audit_logs where "organizationId"=$1 and action=$2 and outcome=$3 order by "createdAt" desc limit 1',
        [org, 'seasonal_window_save', 'SUCCESS']
      )
    ).rows[0];
    expect(row.targetId).toBe(saved.id);
    expect(row.metadata).toMatchObject({ branchId: branch });
    expect(row.changes).toMatchObject({ name: { before: 'Season', after: 'Edited' } });
  });

  it('accumulates failed PIN attempts durably and locks after five', async () => {
    await Promise.all(
      Array.from({ length: 6 }, () =>
        expect(
          call('deleteSeasonalWindow', {
            branchId: branch,
            id: 'absent',
            confirmationPin: '111111',
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      )
    );
    await expect(call('saveSeasonalWindow', data)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await audit.flushAuditWritesForTest();
    const state = (
      await owner.query(
        'select "failedAttempts","lockedUntil" from restaurant_operator_credentials where id=$1',
        [credential]
      )
    ).rows[0];
    expect(state.lockedUntil).not.toBeNull();
  });

  it('redacts the PIN when validation fails before the resolver', async () => {
    await expect(
      call('saveSeasonalWindow', { ...data, startDate: 'invalid' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await audit.flushAuditWritesForTest();
    const rows = (
      await owner.query('select input from audit_logs where "organizationId"=$1 and path=$2', [
        org,
        'saveSeasonalWindow',
      ])
    ).rows;
    expect(JSON.stringify(rows)).not.toContain(pin);
  });

  it('concurrent overlapping saves persist one winner and reject one with CONFLICT', async () => {
    const results = await Promise.allSettled([
      call('saveSeasonalWindow', data),
      call('saveSeasonalWindow', { ...data, name: 'Second' }),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(
      results
        .filter((x) => x.status === 'rejected')
        .map((x) => (x.status === 'rejected' ? x.reason.code : null))
    ).toEqual(['CONFLICT']);
  });

  it('deletes its own window and persists a useful audit target without PIN', async () => {
    const id = `${prefix}_delete`;
    await seedWindow(id);
    await expect(
      call('deleteSeasonalWindow', { branchId: branch, id, confirmationPin: pin })
    ).resolves.toMatchObject({ id });
    await audit.flushAuditWritesForTest();
    expect(
      (await owner.query('select id from pharmacy_seasonal_calendar_windows where id=$1', [id]))
        .rows
    ).toEqual([]);
    const row = (
      await owner.query(
        'select "targetId",input,metadata,changes from audit_logs where "organizationId"=$1 and action=$2 and outcome=$3 order by "createdAt" desc limit 1',
        [org, 'seasonal_window_delete', 'SUCCESS']
      )
    ).rows[0];
    expect(JSON.stringify(row)).not.toContain(pin);
    expect(row.targetId).toBe(id);
    expect(row.metadata).toMatchObject({ branchId: branch });
    expect(row.changes).toMatchObject({ name: { before: 'Seed', after: null } });
  });
});
