// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { UniversityContext } from './office-types';
import {
  consentFeeDelegation,
  revokeFeeDelegation,
  readDelegatedFees,
  listFeeDelegations,
} from './delegation';

const pg = new PGlite();
beforeAll(async () => {
  await pg.exec(`CREATE TABLE university_people(organization_id text,id text,full_name text,email text,PRIMARY KEY(organization_id,id));
    CREATE TABLE university_student_programs(organization_id text,person_id text,status text);
    CREATE TABLE university_challans(organization_id text,reference text,person_id text,fee_head text,amount_paisa bigint,due_date date,created_at timestamptz DEFAULT now(),PRIMARY KEY(organization_id,reference));
    CREATE TABLE university_finance_entries(organization_id text,reference text,debit_account text,credit_account text,amount_paisa bigint);
    INSERT INTO university_people VALUES ('uni','s','Sam','s@example.org'),('uni','t','Tahir','t@example.org'),('uni','guard','Guardian','guard@example.org'),('uni','x','Another','x@example.org'),
      ('other','guard','Guardian','guard@example.org'),('other','s','Sana','s@example.org');
    INSERT INTO university_student_programs VALUES ('uni','s','ACTIVE'),('uni','t','ACTIVE');
    INSERT INTO university_challans VALUES('uni','A1','s','TUITION',10000,'2020-01-01',now()),('uni','A2','s','LIBRARY',1200,'2099-01-01',now()),('uni','B1','t','TUITION',11000,'2020-01-01',now());
    INSERT INTO university_finance_entries VALUES ('uni','A1','STUDENT_RECEIVABLE','FEES_TUITION',10000),('uni','A1','BANK_CLEARING','STUDENT_RECEIVABLE',3000),
      ('uni','A2','STUDENT_RECEIVABLE','FEES_LIBRARY',1200);`);
  await pg.exec(
    readFileSync('prisma/migrations/20261125090800_university_delegation/migration.sql', 'utf8')
  );
  await pg.exec(
    'CREATE ROLE delegated_portal; GRANT ALL ON ALL TABLES IN SCHEMA public TO delegated_portal; SET ROLE delegated_portal'
  );
}, 120_000);
afterAll(async () => {
  await pg.close();
});
function tags(tx: Transaction): ScopedDb {
  const query = (parts: TemplateStringsArray) =>
    parts.reduce((s, p, i) => s + (i ? '$' + i : '') + p, '');
  return {
    $executeRaw: async (p: TemplateStringsArray, ...v: unknown[]) =>
      (await tx.query(query(p), v)).affectedRows,
    $queryRaw: async (p: TemplateStringsArray, ...v: unknown[]) =>
      (await tx.query(query(p), v)).rows,
  } as unknown as ScopedDb;
}
async function as<T>(id: string, run: (c: UniversityContext) => Promise<T>, org = 'uni') {
  return pg.transaction(async (tx) => {
    await tx.query("SELECT set_config('app.current_organization_id',$1,true)", [org]);
    return run({
      db: tags(tx),
      organizationId: org,
      userId: id,
      roleKey: 'university-learner',
      admin: false,
    });
  });
}
const grant = {
  email: 'guard@example.org',
  relationship: 'GUARDIAN',
  permission: 'FINANCIAL_SUMMARY',
  endsOn: '2099-09-15',
  consent: 'yes',
};
describe('Time-limited delegated fees', () => {
  it('requires an active student, a distinct recipient, explicit consent and an owned challan', async () => {
    await expect(as('x', (ctx) => consentFeeDelegation(ctx, grant))).rejects.toThrow(
      'active student'
    );
    await expect(
      as('s', (ctx) => consentFeeDelegation(ctx, { ...grant, email: 's@example.org' }))
    ).rejects.toThrow('different recipient');
    await expect(
      as('s', (ctx) => consentFeeDelegation(ctx, { ...grant, consent: '' }))
    ).rejects.toThrow();
    await expect(
      as('s', (ctx) => consentFeeDelegation(ctx, { ...grant, endsOn: '2000-05-10' }))
    ).rejects.toThrow();
    await expect(
      as('s', (ctx) =>
        consentFeeDelegation(ctx, {
          ...grant,
          permission: 'SPECIFIC_CHALLAN',
          challanReference: 'B1',
        })
      )
    ).rejects.toThrow('own challan');
    await expect(
      as('s', (ctx) => consentFeeDelegation({ ...ctx, admin: true }, grant))
    ).rejects.toThrow('Sign in');
  });
  it('shares exactly the requested fields, checks email and tenant each time and revokes immediately', async () => {
    const g = await as('s', (ctx) => consentFeeDelegation(ctx, grant));
    expect(await as('s', (ctx) => consentFeeDelegation(ctx, grant))).toEqual(g);
    expect((await as('guard', listFeeDelegations)).incoming.map((r) => r.id)).toContain(g.id);
    expect(await as('guard', (ctx) => readDelegatedFees(ctx, g.id))).toEqual({
      permission: 'FINANCIAL_SUMMARY',
      currency: 'PKR',
      summary: { balance_paisa: '8200', overdue_paisa: '7000', open_challans: 2 },
    });
    await expect(as('x', (ctx) => readDelegatedFees(ctx, g.id))).rejects.toThrow('unavailable');
    await expect(as('guard', (ctx) => readDelegatedFees(ctx, g.id), 'other')).rejects.toThrow(
      'unavailable'
    );
    await expect(as('guard', (ctx) => revokeFeeDelegation(ctx, g.id))).rejects.toThrow(
      'unavailable'
    );
    await as('s', (ctx) => revokeFeeDelegation(ctx, g.id));
    await expect(as('guard', (ctx) => readDelegatedFees(ctx, g.id))).rejects.toThrow('unavailable');
    const g2 = await as('s', (ctx) =>
      consentFeeDelegation(ctx, {
        ...grant,
        permission: 'SPECIFIC_CHALLAN',
        challanReference: 'A1',
      })
    );
    expect(await as('guard', (ctx) => readDelegatedFees(ctx, g2.id))).toEqual({
      permission: 'SPECIFIC_CHALLAN',
      currency: 'PKR',
      challan: {
        reference: 'A1',
        fee_head: 'TUITION',
        amount_paisa: '10000',
        balance_paisa: '7000',
        due_date: '2020-01-01',
      },
    });
  });
  it('binds an initially unregistered recipient, denies expired reads and retains an append-only expiry record', async () => {
    const result = await as('s', (ctx) =>
      consentFeeDelegation(ctx, { ...grant, email: 'sponsor@example.org', relationship: 'SPONSOR' })
    );
    await pg.query(
      "INSERT INTO university_people VALUES ('uni','new','Sponsor','sponsor@example.org')"
    );
    await as('new', (ctx) => readDelegatedFees(ctx, result.id));
    await as('s', async (ctx) => {
      await ctx.db
        .$executeRaw`UPDATE university_fee_delegations SET consented_at=now()-interval '2 days', expires_at=now()-interval '1 day' WHERE organization_id=${ctx.organizationId} AND id=${result.id}`;
    });
    await expect(as('new', (ctx) => readDelegatedFees(ctx, result.id))).rejects.toThrow(
      'unavailable'
    );
    expect((await as('new', listFeeDelegations)).incoming).toHaveLength(0);
    const rows = await as(
      's',
      (ctx) =>
        ctx.db.$queryRaw<
          { event: string }[]
        >`SELECT event FROM university_fee_delegation_audit WHERE grant_id=${result.id}`
    );
    expect(rows.map((r) => r.event).sort()).toEqual([
      'CLAIMED',
      'CONSENTED',
      'EXPIRED',
      'EXPIRY_SCHEDULED',
      'VIEWED',
    ]);
    await expect(
      as(
        's',
        (ctx) =>
          ctx.db
            .$executeRaw`DELETE FROM university_fee_delegation_audit WHERE grant_id=${result.id}`
      )
    ).rejects.toThrow('append-only');
  });
});
