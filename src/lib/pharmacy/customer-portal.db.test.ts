// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  consumePortalOtp,
  createPortalRequest,
  customerPortalScope,
  issuePortalOtp,
  portalHash,
  portalSettings,
} from './customer-portal';

vi.mock('./counter', () => ({ readCounterReceipt: vi.fn() }));
vi.mock('./family-khata', () => ({ readKhataBalance: vi.fn() }));
vi.mock('./prescription-files', () => ({ persistPrescriptionFile: vi.fn() }));

const databaseUrl = process.env.TEST_DATABASE_URL;
const suffix = randomBytes(6).toString('hex');
const schema = `portal_${suffix}`;
const role = `portal_role_${suffix}`;
let pool: Pool;
let useRole = false;

/** Execute the real SQL policy/functions with FORCE RLS; no migrations of the shared test DB. */
async function transaction<T>(org: string, fn: (db: ScopedDb, client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    if (useRole) await client.query(`SET LOCAL ROLE "${role}"`);
    await client.query("SELECT set_config('app.current_organization_id', $1, true)", [org]);
    const query = async (sql: Prisma.Sql) =>
      client.query(
        sql.text,
        sql.values.map((v) => (v instanceof Uint8Array ? Buffer.from(v) : v))
      );
    const db = {
      $queryRaw: async (sql: Prisma.Sql) => (await query(sql)).rows,
      $executeRaw: async (sql: Prisma.Sql) => (await query(sql)).rowCount,
      pharmacyBranch: {
        findFirst: async ({ where }: { where: { id: string; organizationId: string } }) =>
          (
            await client.query(
              'SELECT id, name FROM pharmacy_branches WHERE id=$1 AND "organizationId"=$2 AND active',
              [where.id, where.organizationId]
            )
          ).rows[0] ?? null,
      },
      pharmacyCustomer: {
        findFirst: async ({ where }: { where: { id: string; organizationId: string } }) => {
          const result = await client.query(
            'SELECT c.*, p.phone FROM pharmacy_customers c JOIN pharmacy_patients p ON p.id=c."patientId" AND p."organizationId"=c."organizationId" WHERE c.id=$1 AND c."organizationId"=$2 AND c.active',
            [where.id, where.organizationId]
          );
          return result.rows[0]
            ? { ...result.rows[0], patient: { phone: result.rows[0].phone } }
            : null;
        },
      },
      pharmacySale: {
        findFirst: async ({
          where,
        }: {
          where: {
            id: string;
            organizationId: string;
            customerId: string;
            branchId: string;
            status: string;
          };
        }) =>
          (
            await client.query(
              'SELECT id FROM pharmacy_sales WHERE id=$1 AND "organizationId"=$2 AND "branchId"=$3 AND "customerId"=$4 AND status=$5',
              [where.id, where.organizationId, where.branchId, where.customerId, where.status]
            )
          ).rows[0] ?? null,
      },
    } as unknown as ScopedDb;
    const result = await fn(db, client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

(databaseUrl ? describe : describe.skip)('customer portal persisted authentication and RLS', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE organizations(id TEXT PRIMARY KEY);
        CREATE TABLE users(id TEXT, "organizationId" TEXT, UNIQUE ("organizationId", id));
        CREATE TABLE pharmacy_branches(id TEXT, "organizationId" TEXT, name TEXT, active BOOLEAN, UNIQUE ("organizationId", id));
        CREATE TABLE pharmacy_patients(id TEXT, "organizationId" TEXT, phone TEXT, UNIQUE ("organizationId", id));
        CREATE TABLE pharmacy_customers(id TEXT, "organizationId" TEXT, "patientId" TEXT, active BOOLEAN DEFAULT true, UNIQUE ("organizationId", id));
        CREATE TABLE pharmacy_sales(id TEXT, "organizationId" TEXT, "branchId" TEXT, "customerId" TEXT, status TEXT, UNIQUE ("organizationId", "branchId", id));
      `);
      await client.query(
        await readFile(
          new URL(
            '../../../prisma/migrations/20261031000000_pharmacy_customer_portal/migration.sql',
            import.meta.url
          ),
          'utf8'
        )
      );
      await client.query(
        await readFile(
          new URL(
            '../../../prisma/migrations/20261101000000_customer_portal_review_guards/migration.sql',
            import.meta.url
          ),
          'utf8'
        )
      );
      await client.query(`INSERT INTO organizations VALUES ('org-a'), ('org-b');
        INSERT INTO users VALUES ('owner-a','org-a'), ('owner-b','org-b');
        INSERT INTO pharmacy_branches VALUES ('branch-a','org-a','A',true), ('branch-b','org-b','B',true);
        INSERT INTO pharmacy_patients VALUES ('patient-a','org-a','03001234567'), ('patient-b','org-b','03001234567');
        INSERT INTO pharmacy_customers VALUES ('customer-a','org-a','patient-a',true), ('customer-b','org-b','patient-b',true);
        INSERT INTO pharmacy_sales VALUES ('sale-a','org-a','branch-a','customer-a','COMPLETED'), ('sale-b','org-b','branch-b','customer-b','COMPLETED'), ('sale-fulfil','org-a','branch-a','customer-a','COMPLETED');`);
      const user = await client.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user');
      if (user.rows[0].rolsuper) {
        await client.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
        await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
        await client.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`
        );
        await client.query(`GRANT TRUNCATE ON pharmacy_customer_portal_events TO "${role}"`);
        useRole = true;
      }
    } finally {
      client.release();
    }
    for (const org of ['a', 'b'])
      await transaction(`org-${org}`, async (_db, c) => {
        await c.query('INSERT INTO pharmacy_customer_portal_settings VALUES ($1,$2,$3,$4)', [
          `org-${org}`,
          `branch-${org}`,
          { enabled: true, otpMaxAttempts: 2 },
          `owner-${org}`,
        ]);
      });
  });
  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (useRole) await pool.query(`DROP ROLE "${role}"`);
    await pool.end();
  });

  async function issue() {
    const id = randomUUID();
    const delivery = await transaction('org-a', (db) =>
      issuePortalOtp(db, 'org-a', 'branch-a', '03001234567', id)
    );
    expect(delivery).not.toBeNull();
    return { id, code: delivery!.code };
  }

  it('persists failed attempts, locks at the configured limit, and never authenticates a wrong code', async () => {
    const { id, code } = await issue();
    const wrong = code === '000000' ? '999999' : '000000';
    for (let i = 0; i < 2; i++)
      expect(
        await transaction('org-a', (db) => consumePortalOtp(db, 'org-a', id, wrong))
      ).toBeNull();
    expect(await transaction('org-a', (db) => consumePortalOtp(db, 'org-a', id, code))).toBeNull();
    const rows = await transaction('org-a', (_db, c) =>
      c.query('SELECT attempts, audit FROM pharmacy_customer_otp_challenges WHERE id=$1', [id])
    );
    expect(rows.rows[0].attempts).toBe(2);
    expect(rows.rows[0].audit.at(-1).kind).toBe('LOCKED');
  });
  it('makes simultaneous correct verifications single-use and stores only a session hash', async () => {
    const { id, code } = await issue();
    const results = await Promise.all([
      transaction('org-a', (db) => consumePortalOtp(db, 'org-a', id, code)),
      transaction('org-a', (db) => consumePortalOtp(db, 'org-a', id, code)),
    ]);
    const sessions = results.filter((result) => result !== null);
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    const rows = await transaction('org-a', (_db, c) =>
      c.query('SELECT "tokenHash" FROM pharmacy_customer_sessions WHERE "tokenHash"=$1', [
        portalHash(session.token),
      ])
    );
    expect(rows.rows[0].tokenHash).not.toBe(session.token);
    await expect(
      transaction('org-a', (db) => customerPortalScope(db, 'org-a', session.token))
    ).resolves.toMatchObject({
      customerId: 'customer-a',
      branchId: 'branch-a',
      patientId: 'patient-a',
    });
    await expect(
      transaction('org-b', (db) => customerPortalScope(db, 'org-b', session.token))
    ).rejects.toMatchObject({ status: 401 });
    await transaction('org-a', (_db, c) =>
      c.query('UPDATE pharmacy_customer_sessions SET "revokedAt"=now() WHERE "tokenHash"=$1', [
        portalHash(session.token),
      ])
    );
    await expect(
      transaction('org-a', (db) => customerPortalScope(db, 'org-a', session.token))
    ).rejects.toMatchObject({ status: 401 });
  });
  it('rejects expired codes and replays after a resend', async () => {
    const old = await issue();
    await issue();
    expect(
      await transaction('org-a', (db) => consumePortalOtp(db, 'org-a', old.id, old.code))
    ).toBeNull();
    const current = await issue();
    expect(
      await transaction('org-a', (db) =>
        consumePortalOtp(db, 'org-a', current.id, current.code, new Date(Date.now() + 31 * 60_000))
      )
    ).toBeNull();
  });
  it('serializes a resend racing verification without reversing the customer/challenge lock order', async () => {
    const old = await issue();
    const outcomes = await Promise.allSettled([
      transaction('org-a', (db) => consumePortalOtp(db, 'org-a', old.id, old.code)),
      transaction('org-a', (db) =>
        issuePortalOtp(db, 'org-a', 'branch-a', '03001234567', randomUUID())
      ),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
  });
  it('retries concurrent refill submission exactly once and refuses foreign purchases', async () => {
    const scope = {
      organizationId: 'org-a',
      branchId: 'branch-a',
      customerId: 'customer-a',
      patientId: 'patient-a',
    };
    const input = { action: 'refill' as const, saleId: 'sale-a', idempotencyKey: randomUUID() };
    const result = await Promise.all([
      transaction('org-a', (db) => createPortalRequest(db, scope, input)),
      transaction('org-a', (db) => createPortalRequest(db, scope, input)),
    ]);
    expect(result[0].id).toBe(result[1].id);
    await expect(
      transaction('org-a', (db) =>
        createPortalRequest(db, scope, { ...input, saleId: 'sale-b', idempotencyKey: randomUUID() })
      )
    ).rejects.toMatchObject({ status: 404 });
  });
  it('enforces tenant isolation, composite FKs, request checks, and append-only audit in PostgreSQL', async () => {
    await transaction('org-b', async (db, c) => {
      expect((await c.query('SELECT * FROM pharmacy_customer_otp_challenges')).rows).toHaveLength(
        0
      );
      expect((await c.query('SELECT * FROM pharmacy_customer_requests')).rows).toHaveLength(0);
      expect((await portalSettings(db, 'org-a', 'branch-a')).enabled).toBe(false);
    });
    await expect(
      transaction('org-a', (_db, c) =>
        c.query(
          'INSERT INTO pharmacy_customer_requests (id,"organizationId","branchId","customerId",kind,"sourceSaleId","idempotencyKey","payloadHash") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            randomUUID(),
            'org-a',
            'branch-b',
            'customer-a',
            'REFILL',
            'sale-b',
            randomUUID(),
            'test-payload',
          ]
        )
      )
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      transaction('org-a', (_db, c) =>
        c.query("UPDATE pharmacy_customer_portal_events SET kind='tampered'")
      )
    ).rejects.toThrow('append-only');
    await expect(
      transaction('org-a', (_db, c) => c.query('TRUNCATE pharmacy_customer_portal_events'))
    ).rejects.toThrow('append-only');
    await expect(
      transaction('org-a', (_db, c) =>
        c.query("UPDATE pharmacy_customer_requests SET status='FULFILLED'")
      )
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('prevents concurrent requests from reusing one fulfilment sale', async () => {
    const insert = () =>
      transaction('org-a', (_db, c) =>
        c.query(
          `
      INSERT INTO pharmacy_customer_requests
        (id,"organizationId","branchId","customerId",kind,status,"sourceSaleId","fulfilledSaleId","idempotencyKey","payloadHash")
      VALUES ($1,'org-a','branch-a','customer-a','REFILL','FULFILLED','sale-a','sale-fulfil',$2,'test')`,
          [randomUUID(), randomUUID()]
        )
      );
    const results = await Promise.allSettled([insert(), insert()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: '23505' },
    });
  });
});
