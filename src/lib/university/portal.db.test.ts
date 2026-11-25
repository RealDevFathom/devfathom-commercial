// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { UniversityContext } from './office-types';

const doubles = vi.hoisted(() => ({
  deliver: vi.fn(),
  transaction: vi.fn(),
  staff: vi.fn(),
  licensed: true,
}));
vi.mock('@/lib/email', () => ({ sendEmail: doubles.deliver }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: doubles.transaction }));
vi.mock('@/lib/university/academics', () => ({ admissionsOffice: {} }));
vi.mock('@/lib/university/access', () => ({
  withUniversityStaff: doubles.staff,
  canAccessOffice: () => true,
  UniversityAccessError: class extends Error {},
}));
import { reviewIdentity } from '@/app/(app)/university/admissions/documents/identity/[person]/actions';
import { encryptSecret } from '@/lib/secret-crypto';
vi.mock('@/lib/university/finance', () => ({}));
vi.mock('@/lib/university/community', () => ({}));
vi.mock('@/lib/university/academic-support', () => ({}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => doubles.licensed,
  resolveOrganizationEntitlements: () => ({ vertical: 'UNIVERSITY' }),
}));
vi.mock('@/lib/tenancy/host', () => ({
  requestHost: (r: Request) => new URL(r.url).hostname,
  resolveExplicitOrganizationByHost: async (host: string) =>
    host === 'university.example'
      ? { id: 'university', vertical: 'UNIVERSITY', status: 'ACTIVE' }
      : null,
  isTenantLifecycleAccessible: () => true,
}));
import { portalHash, readPerson, saveProfile, sendPortalCode, verifyPortalCode } from './portal';
import {
  beginDocument,
  downloadDocument,
  finishDocument,
  storeDocumentPart,
} from './portal-documents';

const run = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const schema = 'university_portal_' + randomUUID().replaceAll('-', '');
let pool: Pool;
function database(c: PoolClient): ScopedDb {
  async function query(parts: TemplateStringsArray, values: unknown[]) {
    const query = parts.reduce((sql, chunk, index) => sql + (index ? '$' + index : '') + chunk, '');
    return c.query(query, values);
  }
  return {
    $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
      (await query(parts, values)).rows,
    $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
      (await query(parts, values)).rowCount,
  } as ScopedDb;
}
async function transaction<T>(org: string, f: (db: ScopedDb) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL search_path TO ' + schema);
    await c.query("SELECT set_config('app.current_organization_id',$1,true)", [org]);
    const result = await f(database(c));
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}
function context(db: ScopedDb, userId: string): UniversityContext {
  return { db, userId, organizationId: 'university', roleKey: 'university-learner', admin: false };
}
run('learner account and private documents on PostgreSQL', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const c = await pool.connect();
    try {
      await c.query('CREATE SCHEMA ' + schema);
      await c.query('SET search_path TO ' + schema);
      await c.query(
        'CREATE TABLE organizations(id text PRIMARY KEY); CREATE TABLE users("organizationId" text,id text,PRIMARY KEY("organizationId",id));'
      );
      await c.query(
        await readFile('prisma/migrations/20261125090100_university_people/migration.sql', 'utf8')
      );
      await c.query(
        await readFile(
          'prisma/migrations/20261125100300_university_identity_review/migration.sql',
          'utf8'
        )
      );
      await c.query("INSERT INTO organizations VALUES('university'),('other')");
    } finally {
      c.release();
    }
    vi.stubEnv('AUTH_SECRET', 'disposable-learner-account-secret');
    vi.stubEnv('PLATFORM_ENCRYPTION_KEY', 'disposable-document-secret');
    doubles.transaction.mockImplementation(transaction);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (pool) {
      await pool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
      await pool.end();
    }
  });
  it('verifies a single-use code, bounds wrong attempts and derives the person from the tenant session', async () => {
    const request = new Request('https://university.example/apply');
    const data = await sendPortalCode(request, ' APPLICANT@example.org ');
    const text = String(doubles.deliver.mock.calls.at(-1)?.[0]?.text),
      code = text.match(/\b\d{8}\b/)![0];
    const wrong = code === '00000000' ? '99999999' : '00000000';
    expect(await verifyPortalCode(request, { challenge: data.challenge, code: wrong })).toBeNull();
    const token = await verifyPortalCode(request, { challenge: data.challenge, code });
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(await verifyPortalCode(request, { challenge: data.challenge, code })).toBeNull();
    const person = await transaction('university', (db) => readPerson(db, 'university', token!));
    expect(person?.email).toBe('applicant@example.org');
    expect(await transaction('other', (db) => readPerson(db, 'other', token!))).toBeNull();
    expect(
      await transaction('university', (db) =>
        saveProfile(context(db, person!.id), person!, {
          name: 'طالب علم',
          nationality: 'Pakistan',
          kind: 'CRC',
          number: '12345-1234567-1',
        })
      )
    ).toBeUndefined();
    await expect(
      transaction('university', (db) =>
        saveProfile(
          context(db, person!.id),
          { ...person!, identity_kind: 'CNIC' },
          {
            name: 'طالب علم',
            nationality: 'Pakistan',
            kind: 'CNIC',
            number: '',
          }
        )
      )
    ).rejects.toThrow('Enter the identification number');
    const locked = await sendPortalCode(request, 'other@example.org');
    const real = String(doubles.deliver.mock.calls.at(-1)?.[0]?.text).match(/\b\d{8}\b/)![0];
    for (let i = 0; i < 5; i++)
      expect(
        await verifyPortalCode(request, {
          ...locked,
          code: real === '00000000' ? '99999999' : '00000000',
        })
      ).toBeNull();
    expect(await verifyPortalCode(request, { ...locked, code: real })).toBeNull();
    await expect(
      sendPortalCode(new Request('https://unrecognized.example'), 'another@example.org')
    ).rejects.toThrow('unavailable');
    doubles.licensed = false;
    try {
      await expect(sendPortalCode(request, 'another@example.org')).rejects.toThrow('unavailable');
    } finally {
      doubles.licensed = true;
    }
  });
  it('audits sensitive staff reads and binds a verification decision to the evidence revision and reviewer', async () => {
    const person = randomUUID(),
      staff = randomUUID();
    await transaction('university', async (db) => {
      await db.$executeRaw`INSERT INTO users("organizationId",id) VALUES('university',${staff})`;
      await db.$executeRaw`INSERT INTO university_people(organization_id,id,email,full_name,nationality,identity_kind,identity_ciphertext) VALUES('university',${person},'evidence@example.org','Test Applicant','Pakistan','CNIC',${encryptSecret('1234512345671')})`;
    });
    doubles.staff.mockImplementation((fn: (ctx: UniversityContext) => Promise<unknown>) =>
      transaction('university', async (db) => {
        await db.$queryRaw`SELECT set_config('app.current_user_id',${staff},true)`;
        return fn({ ...context(db, staff), roleKey: 'university-admissions-officer' });
      })
    );
    const form = (action: string, id?: string) => {
      const f = new FormData();
      f.set('reason', 'Document reviewed');
      f.set('action', action);
      if (id) f.set('reviewId', id);
      return f;
    };
    const first = await reviewIdentity(person, { message: '' }, form('open'));
    expect(first.review?.number).toBe('1234512345671');
    await transaction(
      'university',
      (db) =>
        db.$executeRaw`UPDATE university_people SET identity_revision=2 WHERE id=${person} AND organization_id='university'`
    );
    expect(
      (await reviewIdentity(person, { message: '' }, form('verify', first.review!.id))).message
    ).toContain('current evidence');
    const reopened = await reviewIdentity(person, { message: '' }, form('open'));
    expect(
      (await reviewIdentity(person, { message: '' }, form('verify', reopened.review!.id))).message
    ).toBe('Decision recorded.');
    expect(
      (await reviewIdentity(person, { message: '' }, form('correct', reopened.review!.id))).message
    ).toContain('current evidence');
    const rows = await transaction(
      'university',
      (db) =>
        db.$queryRaw<
          { kind: string }[]
        >`SELECT kind FROM university_identity_reviews WHERE person_id=${person} ORDER BY occurred_at`
    );
    expect(rows.map((r) => r.kind)).toEqual(['OPENED', 'OPENED', 'VERIFIED']);
  });
  it('resumes an interrupted encrypted upload and refuses access by another learner', async () => {
    const [p] = await transaction(
      'university',
      (db) =>
        db.$queryRaw<
          { id: string }[]
        >`INSERT INTO university_people(organization_id,email) VALUES('university','file-owner@example.org') RETURNING id`
    );
    const file = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(300000, 48)]);
    const meta = {
      label: 'Qualification',
      filename: 'result.pdf',
      mime: 'application/pdf',
      size: file.length,
      hash: portalHash(file),
    };
    const own = <T>(f: (ctx: UniversityContext) => Promise<T>) =>
      transaction('university', (db) => f(context(db, p.id)));
    const start = await own((ctx) => beginDocument(ctx, meta));
    const part0 = file.subarray(0, 256 * 1024).toString('base64');
    await own((ctx) => storeDocumentPart(ctx, { id: start.id, part: 0, base64: part0 }));
    expect((await own((ctx) => beginDocument(ctx, meta))).received).toEqual([0]);
    await expect(own((ctx) => finishDocument(ctx, start.id))).rejects.toThrow('verification');
    await own((ctx) =>
      storeDocumentPart(ctx, {
        id: start.id,
        part: 1,
        base64: file.subarray(256 * 1024).toString('base64'),
      })
    );
    await own((ctx) => finishDocument(ctx, start.id));
    const [part] = await own(
      (ctx) =>
        ctx.db.$queryRaw<
          { ciphertext: string }[]
        >`SELECT ciphertext FROM university_document_parts WHERE document_id=${start.id} AND part=0`
    );
    expect(part.ciphertext).toMatch(/^v1\./);
    expect(part.ciphertext).not.toContain(part0);
    const response = await own((ctx) => downloadDocument(ctx, start.id, p.id, 'learner'));
    expect(Buffer.from(await response.arrayBuffer()).equals(file)).toBe(true);
    await expect(
      own((ctx) => downloadDocument(ctx, start.id, 'different-person', 'learner'))
    ).rejects.toThrow('unavailable');
    expect((await own((ctx) => beginDocument(ctx, meta))).complete).toBe(true);
  }, 30_000);
});
