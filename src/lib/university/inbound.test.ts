import { readFileSync } from 'node:fs';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApiContext } from '@/lib/api-auth';
import { roleTemplatesForVertical } from '@/lib/vertical-catalog';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { runUniversityCommand, universityCommandSchema } from './inbound';

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (e: { enabledModules: string[] }, key: string) => e.enabledModules.includes(key),
}));
vi.mock('@/lib/api-auth', () => ({
  ApiRequestError: class extends Error {
    constructor(
      public status: number,
      message: string
    ) {
      super(message);
    }
  },
}));
const pg = new PGlite();
const staffRoles: Record<string, string> = {
  teacher: 'university-instructor',
  stranger: 'university-instructor',
  clerk: 'university-bursar',
  finance: 'university-finance-approver',
};
function adapter(tx: Transaction, failReceipt: boolean) {
  const sql = (s: TemplateStringsArray) =>
    s.reduce((out, part, i) => out + (i ? '$' + i : '') + part, '');
  return {
    user: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; organizationId: string; status: string };
      }) => {
        const rows = await tx.query(
          'SELECT id FROM users WHERE id=$1 AND "organizationId"=$2 AND status=$3',
          [where.id, where.organizationId, where.status]
        );
        return rows.rows.length
          ? {
              role: 'EMPLOYEE',
              organizationRole: {
                organizationId: where.organizationId,
                key: staffRoles[where.id],
                isSystem: true,
                permissions: roleTemplatesForVertical('UNIVERSITY')
                  .find((template) => template.key === staffRoles[where.id])!
                  .capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
              },
              permissionOverrides: [],
            }
          : null;
      },
    },
    $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
      (await tx.query(sql(parts), values)).rows,
    $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      if (failReceipt && sql(parts).includes('INSERT INTO university_command_inbox'))
        throw new Error('simulated receipt store outage');
      return (await tx.query(sql(parts), values)).affectedRows;
    },
  } as unknown as ScopedDb;
}
function command(kind: string, externalId: string, payload: Record<string, unknown>) {
  return universityCommandSchema.parse({ version: 1, kind, externalId, payload });
}
type Command = ReturnType<typeof command>;
async function invoke(
  c: Command,
  userId: string,
  tokenId = 'token',
  org = 'uni',
  failReceipt = false,
  modules = ['university-core', 'university-finance', 'university-academics']
) {
  return pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE inbound_runtime');
    await tx.query("SELECT set_config('app.current_organization_id',$1,true)", [org]);
    const ctx: ApiContext = {
      organizationId: org,
      userId,
      userRole: 'EMPLOYEE',
      tokenId,
      scopes: ['university:integrations:write'],
      db: adapter(tx, failReceipt),
      entitlements: {
        organizationId: org,
        seatLimit: 100,
        activeSeats: 3,
        vertical: 'UNIVERSITY',
        enabledModules: modules,
        modules: [],
        limits: {},
      },
    };
    return runUniversityCommand(ctx, c);
  });
}
beforeAll(async () => {
  await pg.exec(`CREATE TABLE organizations(id text PRIMARY KEY);CREATE TABLE users("organizationId" text,id text,status text,PRIMARY KEY("organizationId",id));
 CREATE TABLE api_tokens("organizationId" text,id text PRIMARY KEY);
 CREATE TABLE university_people(organization_id text,id text,PRIMARY KEY(organization_id,id));
 CREATE TABLE university_staff_scopes(organization_id text,user_id text,level text);
 CREATE TABLE university_sections(organization_id text,id text,instructor_id text,PRIMARY KEY(organization_id,id));
 CREATE TABLE university_enrollments(organization_id text,id text,section_id text,status text,PRIMARY KEY(organization_id,id));
 CREATE TABLE university_grades(organization_id text,id text DEFAULT gen_random_uuid()::text,enrollment_id text,revision int,mark int,status text DEFAULT 'DRAFT',submitted_by text, PRIMARY KEY(organization_id,enrollment_id,revision));
 INSERT INTO organizations VALUES('uni'),('other');
 INSERT INTO users VALUES('uni','teacher','ACTIVE'),('uni','stranger','ACTIVE'),('uni','clerk','ACTIVE'),('uni','finance','ACTIVE'),('other','clerk','ACTIVE');
 INSERT INTO university_people VALUES('uni','s');
 INSERT INTO api_tokens VALUES('uni','token'),('uni','foreign-token'),('other','other-token');
 INSERT INTO university_staff_scopes VALUES('uni','teacher','CAMPUS'),('uni','stranger','CAMPUS'),('uni','clerk','INSTITUTION'),('uni','finance','INSTITUTION');
 INSERT INTO university_sections VALUES('uni','section','teacher');INSERT INTO university_enrollments VALUES('uni','enrolled','section','ENROLLED');`);
  for (const migration of [
    '20261125090050_university_events',
    '20261125090055_university_connectors',
    '20261125090056_university_inbox',
    '20261125090300_university_finance',
  ])
    await pg.exec(readFileSync('prisma/migrations/' + migration + '/migration.sql', 'utf8'));
  await pg.exec(`INSERT INTO university_connector_topics VALUES('uni','grade.draft','token'),('uni','bank.collection','token'),('uni','bank.settlement','token'),('uni','finance.gl-acknowledgment','token');
 INSERT INTO university_challans(organization_id,reference,person_id,fee_head,amount_paisa,commencement_date,due_date) VALUES('uni','CH-1','s','TUITION',2000,'2025-01-01','2025-01-02');
 INSERT INTO university_finance_entries(organization_id,entry_key,reference,kind,debit_account,credit_account,amount_paisa,actor_id,reason)
 VALUES('uni','opening-charge','CH-1','CHARGE','STUDENT_RECEIVABLE','FEES_TUITION',2000,'clerk','Assessment');
 CREATE ROLE inbound_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO inbound_runtime;`);
}, 30000);
afterAll(() => pg.close());
describe('versioned university provider commands', () => {
  it('allows only four typed commands and never exposes grade publication', () => {
    const grade = {
      version: 1,
      kind: 'grade.draft',
      externalId: 'grade-a',
      payload: { enrollmentId: 'enrolled', mark: 75 },
    };
    expect(universityCommandSchema.safeParse(grade).success).toBe(true);
    expect(universityCommandSchema.safeParse({ ...grade, version: 2 }).success).toBe(false);
    expect(universityCommandSchema.safeParse({ ...grade, kind: 'grade.published' }).success).toBe(
      false
    );
    expect(
      universityCommandSchema.safeParse({ ...grade, payload: { ...grade.payload, publish: true } })
        .success
    ).toBe(false);
  });
  it('checks live topic, tenant, entitlement and instructor assignment before replaying a grade draft', async () => {
    const grade = command('grade.draft', 'grade-a', { enrollmentId: 'enrolled', mark: 75 });
    await expect(invoke(grade, 'teacher', 'foreign-token')).rejects.toMatchObject({ status: 403 });
    await expect(invoke(grade, 'teacher', 'token', 'other')).rejects.toMatchObject({ status: 403 });
    await expect(
      invoke(grade, 'teacher', 'token', 'uni', false, ['university-core'])
    ).rejects.toMatchObject({ status: 403 });
    await expect(invoke(grade, 'stranger')).rejects.toMatchObject({ status: 403 });
    expect((await invoke(grade, 'teacher')).result).toMatchObject({ status: 'DRAFT' });
    expect(
      (
        await invoke(
          command('grade.draft', 'grade-a', { mark: 75, enrollmentId: 'enrolled' }),
          'teacher'
        )
      ).replayed
    ).toBe(true);
    await expect(
      invoke(command('grade.draft', 'grade-a', { mark: 90, enrollmentId: 'enrolled' }), 'teacher')
    ).rejects.toMatchObject({ status: 409 });
    expect((await pg.query('SELECT mark,status FROM university_grades')).rows).toEqual([
      { mark: 75, status: 'DRAFT' },
    ]);
    await pg.exec("UPDATE university_sections SET instructor_id='stranger'");
    await expect(invoke(grade, 'teacher')).rejects.toMatchObject({ status: 403 });
  });
  it('rolls back a payment on lost receipt persistence and reconciles bank and GL through independent staff permissions', async () => {
    const collection = command('bank.collection', 'provider-line-1', {
      provider: 'bank',
      transactionId: 'txn1',
      reference: 'CH-1',
      amountPaisa: 1000,
      valueDate: '2025-02-01',
    });
    await expect(invoke(collection, 'clerk', 'token', 'uni', true)).rejects.toThrow('outage');
    expect((await pg.query('SELECT transaction_id FROM university_bank_receipts')).rows).toEqual(
      []
    );
    expect((await invoke(collection, 'clerk')).replayed).toBe(false);
    expect((await invoke(collection, 'clerk')).replayed).toBe(true);
    const settle = command('bank.settlement', 'settlement-1', {
      provider: 'bank',
      transactionId: 'txn1',
      settlement: 'statement',
      date: '2025-02-02',
      amountPaisa: 1000,
    });
    await expect(
      invoke(
        command('bank.settlement', 'bad-settle', { ...settle.payload, amountPaisa: 900 }),
        'clerk'
      )
    ).rejects.toMatchObject({ status: 422 });
    await invoke(settle, 'clerk');
    const [{ entry_key }] = (
      await pg.query<{ entry_key: string }>(
        "SELECT entry_key FROM university_finance_entries WHERE kind='PAYMENT'"
      )
    ).rows;
    const ack = command('finance.gl-acknowledgment', 'journal-1', {
      entry: entry_key,
      journal: 'GL-001',
      amountPaisa: 1000,
    });
    await expect(invoke(ack, 'clerk')).rejects.toMatchObject({ status: 403 });
    await invoke(ack, 'finance');
    expect((await pg.query('SELECT status FROM university_bank_receipts')).rows).toEqual([
      { status: 'SETTLED' },
    ]);
    expect(
      (await pg.query('SELECT journal_reference FROM university_finance_gl_acknowledgments')).rows
    ).toEqual([{ journal_reference: 'GL-001' }]);
    expect(
      (
        await pg.query(
          "SELECT count(*)::int n FROM university_command_inbox WHERE kind!='grade.draft'"
        )
      ).rows[0]
    ).toEqual({ n: 3 });
  });
});
