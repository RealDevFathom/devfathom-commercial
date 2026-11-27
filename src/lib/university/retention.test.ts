// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { retentionOffice } from './retention';

const db = new PGlite();
const migration = (name: string) => readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8');
function scoped(tx: Transaction): ScopedDb {
  const sql = (parts: TemplateStringsArray) =>
    parts.reduce((s, p, i) => s + (i ? '$' + i : '') + p, '');
  return {
    $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
      (await tx.query(sql(parts), values)).rows,
    $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
      (await tx.query(sql(parts), values)).affectedRows,
  } as unknown as ScopedDb;
}
async function tenant<T>(run: (tx: Transaction) => Promise<T>, org = 'university') {
  return db.transaction(async (tx) => {
    await tx.query("SELECT set_config('app.current_organization_id',$1,true)", [org]);
    return run(tx);
  });
}
async function act(
  key: string,
  input: Record<string, string>,
  user = 'maker',
  org = 'university',
  admin = true
) {
  const action = retentionOffice.actions.find((a) => a.key === key)!;
  return tenant(
    async (tx) =>
      (await action.run(
        { db: scoped(tx), organizationId: org, userId: user, roleKey: 'university-admin', admin },
        input
      )) as Record<string, unknown>,
    org
  );
}
async function approve(kind: string, days = '30', effectiveOn = '2020-01-01') {
  const policy = await act('propose', { kind, days, effectiveOn, authority: 'Senate policy' });
  await expect(act('approve-policy', { policyId: String(policy.id) })).rejects.toThrow('different');
  await act('approve-policy', { policyId: String(policy.id) }, 'checker');
  return String(policy.id);
}
async function prepare(kind: string) {
  const policyId = await approve(kind);
  const prep = await act('preview', { policyId });
  const reviewId = String(prep.reviewId);
  await expect(act('purge', { reviewId })).rejects.toThrow('independent');
  await expect(act('approve-review', { reviewId, reference: 'Vote' })).rejects.toThrow('second');
  await act('approve-review', { reviewId, reference: 'Recorded approval' }, 'checker');
  return reviewId;
}

beforeAll(async () => {
  await db.exec(`CREATE TABLE organizations(id text PRIMARY KEY);
    CREATE TABLE users("organizationId" text,id text, PRIMARY KEY("organizationId",id));
    CREATE TABLE api_tokens("organizationId" text,id text PRIMARY KEY);
    INSERT INTO organizations VALUES ('university'),('other');
    INSERT INTO users VALUES ('university','maker'),('university','checker'),('other','maker'),('other','checker');
    INSERT INTO api_tokens VALUES ('university','provider');
  `);
  for (const name of [
    '20261125090050_university_events',
    '20261125090055_university_connectors',
    '20261125090100_university_people',
    '20261125090200_university_academics',
    '20261125100400_university_retention',
  ])
    await db.exec(migration(name));
  await db.exec(`
    INSERT INTO university_people(organization_id,id,email) VALUES ('university','a','a@example.test'),('university','b','b@example.test'),
      ('university','active','active@example.test'),('other','a','outsider@example.test');
    INSERT INTO university_application_drafts(organization_id,person_id,intake_id) VALUES ('university','active','intake');
    INSERT INTO university_documents (organization_id,id,person_id,label,filename,mime,file_hash,byte_size,complete) VALUES
      ('university','file-a','a','Qualification','personal.pdf','application/pdf','hash-a',512,true),
      ('university','file-b','b','Qualification','private.pdf','application/pdf','hash-b',512,true),
      ('university','file-draft','active','Qualification','draft.pdf','application/pdf','hash-c',512,true),
      ('university','partial','a','Identity','partial.pdf','application/pdf','hash-d',20,false),
      ('other','file-a','a','Identity','out.pdf','application/pdf','hash-e',512,true);
    INSERT INTO university_document_parts VALUES ('university','file-a',0,'encrypted-a'),('university','file-b',0,'encrypted-b'),
      ('university','file-draft',0,'encrypted-draft'),('university','partial',0,'encrypted-part'),('other','file-a',0,'encrypted-foreign');
    UPDATE university_documents SET last_activity_at=now()-interval '90 days';
    INSERT INTO university_document_reads(organization_id,document_id,actor_id,actor_realm) VALUES ('university','file-a','checker','staff');
    INSERT INTO university_portal_sessions VALUES ('university','expired-token-hash','a',now()-interval '90 days'),
      ('university','active-token-hash','a',now()+interval '1 day');
    INSERT INTO university_portal_challenges(organization_id,id,email,code_hash,expires_at) VALUES
      ('university','old-otp','a@example.test','secret-hash',now()-interval '90 days'),('university','recent-otp','a@example.test','new-secret',now()+interval '1 hour');
    INSERT INTO university_events (organization_id,kind,source_key,payload,status) VALUES
      ('university','LMS','evt-1','{}','FAILED'),('university','Unrouted','evt-2','{}','PENDING');
    INSERT INTO university_connector_topics VALUES ('university','LMS','provider');
    CREATE ROLE university_ops NOSUPERUSER NOBYPASSRLS;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO university_ops;
    SET ROLE university_ops;
  `);
}, 120000);
afterAll(async () => {
  await db.close();
});

describe('Institution-approved retention on disposable PostgreSQL', () => {
  it('requires two staff decisions, rechecks a later legal hold and preserves access evidence and tenant boundaries', async () => {
    await expect(
      act(
        'propose',
        { kind: 'APPLICATION_DOCUMENT', days: '30', effectiveOn: '2020-01-01', authority: 'Vote' },
        'maker',
        'university',
        false
      )
    ).rejects.toThrow('administrator');
    const reviewId = await prepare('APPLICATION_DOCUMENT');
    const preview = await act('inspect-review', { reviewId });
    expect(preview).toHaveLength(2);
    expect(JSON.stringify(preview)).not.toContain('file-a');
    await expect(act('purge', { reviewId }, 'checker', 'other')).rejects.toThrow();
    const hold = await act('hold', {
      scope: 'DOCUMENT',
      target: 'file-b',
      authority: 'Legal case',
    });
    const result = await act('purge', { reviewId });
    expect(result.purged).toBe(1);
    await expect(act('purge', { reviewId })).resolves.toMatchObject({ status: 'PURGED' });
    const records = await tenant((tx) =>
      tx.query<{ id: string }>('SELECT id FROM university_documents ORDER BY id')
    );
    expect(records.rows.map((r) => r.id)).toEqual(['file-b', 'file-draft', 'partial']);
    const audit = await tenant((tx) =>
      tx.query('SELECT actor_realm FROM university_retained_access_audit')
    );
    expect(audit.rows).toEqual([{ actor_realm: 'staff' }]);
    const foreign = await tenant(
      (tx) => tx.query('SELECT ciphertext FROM university_document_parts'),
      'other'
    );
    expect(foreign.rows).toEqual([{ ciphertext: 'encrypted-foreign' }]);
    await act('release-hold', { holdId: String(hold.id), reference: 'Release letter' });
  });
  it('rechecks resumed incomplete uploads at execution', async () => {
    const reviewId = await prepare('INCOMPLETE_UPLOAD');
    await tenant((tx) =>
      tx.query(
        "UPDATE university_document_parts SET ciphertext='resumed-encrypted' WHERE organization_id='university' AND document_id='partial'"
      )
    );
    expect((await act('purge', { reviewId })).purged).toBe(0);
    expect(await act('inspect-review', { reviewId })).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'SKIPPED' })])
    );
  });
  it('erases only expired credentials after the approved grace period and shields identifiers from review and monitoring', async () => {
    const sessions = await prepare('EXPIRED_SESSION');
    const inspected = await act('inspect-review', { reviewId: sessions });
    expect(JSON.stringify(inspected)).not.toContain('expired-token-hash');
    const challenge = await prepare('EXPIRED_CHALLENGE');
    const targets = (await act('inspect-review', { reviewId: challenge })) as unknown as {
      candidate_id: string;
    }[];
    await act('hold', {
      scope: 'CANDIDATE',
      target: targets[0].candidate_id,
      authority: 'Evidence preservation',
    });
    expect((await act('purge', { reviewId: challenge })).purged).toBe(0);
    expect((await act('purge', { reviewId: sessions })).purged).toBe(1);
    const sessionsLeft = await tenant((tx) =>
      tx.query('SELECT token_hash FROM university_portal_sessions')
    );
    expect(sessionsLeft.rows).toEqual([{ token_hash: 'active-token-hash' }]);
    const reports = await tenant((tx) =>
      retentionOffice.read({
        db: scoped(tx),
        organizationId: 'university',
        userId: 'maker',
        roleKey: 'university-admin',
        admin: true,
      })
    );
    expect(reports[0]).toMatchObject({
      connectors_with_failures: 1,
      failed_deliveries: 1,
      pending_deliveries: 1,
      unrouted_deliveries: 1,
      incomplete_uploads: 1,
    });
    expect(JSON.stringify(reports)).not.toMatch(
      /example\\.test|expired-token-hash|secret-hash|personal\\.pdf/
    );
  });
  it('invalidates a preview when a newer effective policy supersedes it and honours institution-wide preservation', async () => {
    const prior = await tenant((tx) =>
      tx.query<{ id: string }>(
        "SELECT id FROM university_active_retention_policies WHERE kind='APPLICATION_DOCUMENT'"
      )
    );
    const review = await act('preview', { policyId: prior.rows[0].id });
    await act(
      'approve-review',
      { reviewId: String(review.reviewId), reference: 'Second review' },
      'checker'
    );
    const nextPolicy = await approve('APPLICATION_DOCUMENT', '3650', '2021-01-01');
    expect((await act('purge', { reviewId: String(review.reviewId) })).purged).toBe(0);
    const institution = await act('hold', {
      scope: 'INSTITUTION',
      authority: 'All files preserved',
    });
    await expect(act('preview', { policyId: nextPolicy })).rejects.toThrow('No eligible');
    await act('release-hold', { holdId: String(institution.id), reference: 'Release' });
  });
});
