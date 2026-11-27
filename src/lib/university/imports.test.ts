import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { UniversityContext } from './office-types';
import { importsOffice, reconcileHistoricalManifest } from './imports';

const state = vi.hoisted(() => ({
  studentLimit: 2,
  modules: [
    'university-core',
    'university-admissions',
    'university-academics',
    'university-finance',
  ],
}));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: async () => ({
    vertical: 'UNIVERSITY',
    enabledModules: state.modules,
    limits: { 'university.activeStudents.max': state.studentLimit },
  }),
  hasModule: (view: { enabledModules: string[] }, key: string) => view.enabledModules.includes(key),
}));
const pg = new PGlite();
function context(tx: Transaction, userId: string, org: string): UniversityContext {
  const sql = (s: TemplateStringsArray) =>
    s.reduce((out, part, i) => out + (i ? '$' + i : '') + part, '');
  return {
    organizationId: org,
    userId,
    admin: false,
    roleKey: userId === 'finance' ? 'university-finance-approver' : 'university-registrar',
    db: {
      $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
        (await tx.query(sql(parts), values)).rows,
      $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
        (await tx.query(sql(parts), values)).affectedRows,
    } as unknown as ScopedDb,
  };
}
async function act(
  action: string,
  input: Record<string, string>,
  user = 'maker',
  org = 'uni',
  level = 'institution'
) {
  return await pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE university_import_test_runtime');
    await tx.query(
      "SELECT set_config('app.current_organization_id',$1,true),set_config('app.university_staff_scope',$2,true)",
      [org, level]
    );
    return (await importsOffice.actions
      .find((item) => item.key === action)!
      .run(context(tx, user, org), input)) as Record<string, string>;
  });
}
function sample(id: string, balance = 1000) {
  return {
    format: 1,
    controls: {
      students: 1,
      activeStudents: 1,
      enrollments: 1,
      transcripts: 1,
      openingDebitPaisa: Math.max(0, balance),
      openingCreditPaisa: Math.max(0, -balance),
    },
    students: [
      {
        legacyId: id,
        email: id + '@example.edu.pk',
        fullName: 'Historic Student',
        intakeId: 'intake',
        matriculatedOn: '2024-08-01',
        status: 'ACTIVE',
        participation: [{ sectionId: 'section', recordedOn: '2024-12-15', mark: 79 }],
        transcript: {
          sourceReference: 'official-' + id,
          issuedOn: '2025-01-12',
          version: '1',
          documentSha256: 'b'.repeat(64),
          snapshot: { credits: 3, grade: 'B+' },
        },
        openingBalance: { reference: 'balance-' + id, signedPaisa: balance, asOf: '2025-02-01' },
      },
    ],
  };
}
function source(id: string, revision = 1, manifest = sample(id)) {
  const text = JSON.stringify(manifest);
  return {
    sourceSystem: 'legacy-registry',
    sourceBatch: id,
    revision: String(revision),
    evidence: 'signed-register-' + revision,
    manifest: text,
    digest: createHash('sha256').update(text).digest('hex'),
  };
}
beforeAll(async () => {
  await pg.exec(`CREATE TABLE organizations(id text PRIMARY KEY);
    CREATE TABLE users("organizationId" text,id text,PRIMARY KEY("organizationId",id));
    INSERT INTO organizations VALUES('uni'),('other');
    INSERT INTO users VALUES('uni','maker'),('uni','checker'),('uni','finance'),('other','maker');`);
  for (const folder of [
    '20261125090050_university_events',
    '20261125090100_university_people',
    '20261125090200_university_academics',
    '20261125090300_university_finance',
    '20261125090750_university_imports',
  ])
    await pg.exec(readFileSync('prisma/migrations/' + folder + '/migration.sql', 'utf8'));
  await pg.exec(`INSERT INTO university_campuses VALUES('uni','campus','Main campus','HEC-10');
    INSERT INTO university_programs(organization_id,id,campus_id,name,code,pqr_reference,accreditation_reference,valid_from,valid_to)
      VALUES('uni','program','campus','Computing','CS','PQR-1','ACC-1','2023-01-01','2028-12-31');
    INSERT INTO university_intakes(organization_id,id,program_id,label,curriculum_version,required_credits,pass_mark,capacity,opens_on,closes_on,starts_on,status)
      VALUES('uni','intake','program','Fall 2024','1',4,50,100,'2024-01-01','2024-07-01','2024-08-01','CLOSED');
    INSERT INTO university_courses VALUES('uni','course','intake','CS101','Computing',3,true);
    INSERT INTO university_sections VALUES('uni','section','intake','course','checker','Fall 2024','A','R-1',1,540,600,100);
    CREATE ROLE university_import_test_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO university_import_test_runtime;`);
}, 30000);
afterAll(() => pg.close());
describe('institutional historical cutover', () => {
  it('validates source controls, rejects forged or bounded batches and separates staff signatures', async () => {
    const m = sample('abc');
    m.controls.openingDebitPaisa--;
    expect(() => reconcileHistoricalManifest(m)).toThrow('openingDebitPaisa');
    const input = source('ada');
    await expect(act('stage', { ...input, digest: '0'.repeat(64) })).rejects.toThrow('checksum');
    await expect(act('stage', input, 'maker', 'uni', 'bounded')).rejects.toThrow();
    const staged = await act('stage', input);
    const confirm = { batchId: staged.id, digest: input.digest };
    expect((await act('stage', input)).id).toBe(staged.id);
    await expect(act('validate', confirm)).rejects.toThrow('independent');
    await expect(act('validate', confirm, 'maker', 'other')).rejects.toThrow('Select the batch');
    expect((await act('validate', confirm, 'checker')).state).toBe('VALIDATED');
    await expect(act('finalize', confirm)).rejects.toThrow('financial opening');
    await act('finance', confirm, 'finance');
    state.studentLimit = 0;
    await expect(act('finalize', confirm)).rejects.toThrow('active-student');
    expect((await pg.query('SELECT id FROM university_people')).rows).toHaveLength(0);
    state.studentLimit = 2;
    expect((await act('finalize', confirm)).state).toBe('FINALIZED');
    await act('finalize', confirm);
    const count =
      await pg.query(`SELECT (SELECT count(*) FROM university_student_programs)::int programs,(SELECT count(*) FROM university_enrollments)::int enrollments,
      (SELECT mark FROM university_grades) mark,(SELECT snapshot->>'version' FROM university_transcripts) version,(SELECT amount_paisa::int FROM university_finance_entries) opening,
      (SELECT debit_account FROM university_finance_entries) debit,(SELECT count(*)::int FROM university_bank_receipts) receipts`);
    expect(count.rows[0]).toMatchObject({
      programs: 1,
      enrollments: 1,
      mark: 79,
      version: '1',
      opening: 1000,
      debit: 'STUDENT_RECEIVABLE',
      receipts: 0,
    });
    await expect(act('cancel', { ...confirm, reason: 'typo' })).rejects.toThrow('finalized');
  });
  it('corrects a staged source through a new revision, and rejects lost module grants before publishing', async () => {
    const input = source('bob');
    const first = await act('stage', input);
    await act('cancel', {
      batchId: first.id,
      digest: input.digest,
      reason: 'Correct the opening credit.',
    });
    const second = source('bob', 2, sample('bob', -3000));
    const staged = await act('stage', second);
    expect(staged.id).not.toBe(first.id);
    const confirm = { batchId: staged.id, digest: second.digest };
    await act('validate', confirm, 'checker');
    await act('finance', confirm, 'finance');
    state.modules = state.modules.filter((name) => name !== 'university-finance');
    try {
      await expect(act('finalize', confirm)).rejects.toThrow('finance module');
    } finally {
      state.modules.push('university-finance');
    }
    expect((await act('finalize', confirm)).state).toBe('FINALIZED');
    expect(
      (
        await pg.query(
          "SELECT debit_account,credit_account,amount_paisa::int amount FROM university_finance_entries WHERE reference='balance-bob'"
        )
      ).rows[0]
    ).toMatchObject({
      debit_account: 'OPENING_BALANCE_CONTROL',
      credit_account: 'STUDENT_RECEIVABLE',
      amount: 3000,
    });
  });
});
