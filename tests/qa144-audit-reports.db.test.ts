// @vitest-environment node
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

// Prefer dedicated overrides, but use the QA gate's restricted runtime/owner pair.
const runtimeUrl = process.env.QA144_DATABASE_URL ?? process.env.DATABASE_URL;
const ownerUrl = process.env.QA144_OWNER_DATABASE_URL ?? process.env.OWNER_DATABASE_URL;
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;
const suite = runtimeUrl && ownerUrl ? describe : describe.skip;
const prefix = `qa144_${randomUUID().replaceAll('-', '')}`;
const org = `${prefix}_org`;
const branch = `${prefix}_branch`;
const staff = `${prefix}_staff`;
const actor = `${prefix}_actor`;
const device = `${prefix}_device`;
const day = '2026-10-20';

suite('QA #144 real PostgreSQL audits and reports (migrated disposable database)', () => {
  let owner: pg.Client;
  let tenancy: typeof import('@/lib/tenancy/scoped-db');
  let audit: typeof import('@/server/audit');
  let reports: typeof import('@/lib/restaurant/reports');
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    // Keep platform scope on this dedicated fixture connection across autocommitted seed queries.
    await owner.query("SELECT set_config('app.is_platform_admin', 'true', false)");
    tenancy = await import('@/lib/tenancy/scoped-db');
    audit = await import('@/server/audit');
    reports = await import('@/lib/restaurant/reports');
    await owner.query(
      `INSERT INTO organizations (id,slug,"legalName","displayName","updatedAt") VALUES ($1,$1,$1,$1,now())`,
      [org]
    );
    await owner.query(
      `INSERT INTO restaurant_branches (id,"organizationId",name,"updatedAt") VALUES ($1,$2,'Report seed',now())`,
      [branch, org]
    );
    await owner.query(
      `INSERT INTO restaurant_staff_profiles (id,"organizationId","displayName","updatedAt") VALUES ($1,$2,'Seed staff',now())`,
      [staff, org]
    );
    await owner.query(
      `INSERT INTO restaurant_registered_devices (id,"organizationId","branchId",name,"deviceSecretHash","updatedAt") VALUES ($1,$2,$3,'Seed device',$4,now())`,
      [device, org, branch, `${prefix}_secret`]
    );
    await owner.query(
      `INSERT INTO restaurant_drawer_sessions (id,"organizationId","branchId","deviceId","staffProfileId","businessDate","openingFloat",status,"countedCash","closedAt","updatedAt","createdAt") SELECT $1 || '_' || lpad(n::text,5,'0'),$2,$3,$4,$5,$6::date,0,'CLOSED',1,$6::date + interval '20 hours',now(),$6::date FROM generate_series(1,1201) n`,
      [prefix, org, branch, device, staff, day]
    );
    await owner.query(
      `INSERT INTO restaurant_daily_closes (id,"organizationId","branchId","businessDate","cutByStaffProfileId","cashCounted","cashExpected","createdAt") VALUES ($1,$2,$3,$4,$5,1201,1201,$4::date + interval '23 hours')`,
      [`${prefix}_close`, org, branch, day, staff]
    );
  }, 30000);
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM restaurant_daily_closes WHERE "organizationId"=$1', [org]);
      await owner.query('DELETE FROM restaurant_drawer_sessions WHERE "organizationId"=$1', [org]);
      await owner.query('DELETE FROM users WHERE "organizationId"=$1', [org]);
      await owner.query('DELETE FROM organizations WHERE id=$1', [org]);
      // audit_logs is append-only while its organization exists (DEV-155).
      await owner.query('DELETE FROM audit_logs WHERE "organizationId"=$1', [org]);
      await owner.end();
    }
    const { db } = await import('@/lib/db');
    await db.$disconnect();
  });

  it('runs under a restricted role and keeps FORCE RLS and tenant isolation', async () => {
    const client = new pg.Client({ connectionString: runtimeUrl });
    await client.connect();
    try {
      const role = await client.query(
        'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const flags = await client.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='audit_logs'::regclass"
      );
      expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    } finally {
      await client.end();
    }
    const hidden = await tenancy.withTenantDb(`${prefix}_other`, (tx) =>
      tx.restaurantBranch.findMany({ where: { id: branch } })
    );
    expect(hidden).toEqual([]);
  });

  it('reproduces the pre-commit audit FK lock, then writes after commit without holding the action open', async () => {
    await owner.query(
      `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'QA144','QA144',now())`,
      [`${prefix}_dept`, org]
    );
    await owner.query(
      `INSERT INTO users (id,"organizationId",name,email,department,title,"updatedAt") VALUES ($1,$2,'Audit actor',$3,'QA144','Fixture',now())`,
      [actor, org, `${actor}@example.test`]
    );
    await owner.query('BEGIN');
    try {
      await owner.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [actor]);
      const contender = new pg.Client({ connectionString: runtimeUrl });
      await contender.connect();
      try {
        await contender.query('BEGIN');
        await contender.query(
          "SELECT set_config('app.current_organization_id',$1,true), set_config('lock_timeout','100ms',true)",
          [org]
        );
        await expect(
          contender.query(
            `INSERT INTO audit_logs (id,"organizationId","actorId",source,category,action) VALUES ($1,$2,$3,'TRPC','SYSTEM','before-commit')`,
            [`${prefix}_blocked`, org, actor]
          )
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await contender.query('ROLLBACK');
        await contender.end();
      }
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
    await tenancy.withTenantDb(org, async (tx) => {
      await tx.user.update({ where: { id: actor }, data: { name: 'Committed action' } });
      audit.recordTrpcAudit({
        ctx: { session: { user: { id: actor, organizationId: org } }, audit: { detail: {} } },
        path: 'payments',
        type: 'query',
        input: {},
        outcome: 'SUCCESS',
      });
      const rows = await tx.auditLog.findMany({ where: { action: 'payments' } });
      expect(rows).toEqual([]);
    });
    await audit.flushAuditWritesForTest();
    const rows = await tenancy.withTenantDb(org, (tx) =>
      tx.auditLog.findMany({ where: { actorId: actor } })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBe(org);
  });

  it('persists failure audits after rollback without committing the action', async () => {
    await expect(
      tenancy.withTenantDb(org, async (tx) => {
        await tx.user.update({ where: { id: actor }, data: { name: 'Rolled back' } });
        audit.recordTrpcAudit({
          ctx: { session: { user: { id: actor, organizationId: org } } },
          path: 'rollback-probe',
          type: 'mutation',
          input: {},
          outcome: 'FAILURE',
        });
        throw new Error('action failed');
      })
    ).rejects.toThrow('action failed');
    await audit.flushAuditWritesForTest();
    const result = await tenancy.withTenantDb(org, async (tx) => ({
      user: await tx.user.findUniqueOrThrow({ where: { id: actor } }),
      rows: await tx.auditLog.findMany({ where: { action: 'rollback-probe' } }),
    }));
    expect(result.user.name).toBe('Committed action');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].outcome).toBe('FAILURE');
  });

  it('keeps the action committed when independent audit persistence fails', async () => {
    await expect(
      tenancy.withTenantDb(org, async (tx) => {
        await tx.user.update({ where: { id: actor }, data: { name: 'Survives audit failure' } });
        audit.recordTrpcAudit({
          ctx: { session: { user: { id: `${prefix}_missing`, organizationId: org } } },
          path: 'audit-failure-probe',
          type: 'mutation',
          input: {},
          outcome: 'SUCCESS',
        });
        return 'committed';
      })
    ).resolves.toBe('committed');
    // Test mode exposes audit failures through the explicit flush hook.
    await expect(audit.flushAuditWritesForTest()).rejects.toThrow();
    const user = await tenancy.withTenantDb(org, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: actor } })
    );
    expect(user.name).toBe('Survives audit failure');
  });

  it('streams all 1201 drawer rows without dropping totals and finishes affected report reads within five seconds', async () => {
    const db = tenancy.createTenantDb(org);
    const range = { branchIds: [branch], from: day, to: day };
    const timings: Record<string, number> = {};
    const start = performance.now();
    const payments = await reports.readPaymentsReport(db, range);
    timings.payments = performance.now() - start;
    expect(payments.cashCountCoverage).toMatchObject({
      status: 'COMPLETE',
      drawerSessionCount: 1201,
    });
    for (const read of [
      reports.readOverviewReport,
      reports.readInventoryReport,
      reports.readWastageReport,
      reports.readCateringReport,
      reports.readSopReport,
      reports.readFoodCostReport,
      reports.readDishProfitabilityReport,
      reports.readStockMovementReport,
      reports.readPurchasingReport,
    ]) {
      const at = performance.now();
      await read(db, range);
      timings[read.name] = performance.now() - at;
    }
    const workforceStart = performance.now();
    await reports.readWorkforceReport(db, range, { includeLabourCosts: true });
    timings.workforceFinancial = performance.now() - workforceStart;
    const elapsed = performance.now() - start;
    timings.batch = elapsed;
    writeFileSync('/tmp/qa144-report-timings.json', JSON.stringify(timings, null, 2));
    expect(elapsed).toBeLessThan(5000);
  }, 10000);
});
