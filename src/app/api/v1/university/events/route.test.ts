// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApiContext } from '@/lib/api-auth';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { deliveryPolicy, eventModule } from '@/lib/university/connector-topics';
import { GET, POST } from './route';

// Only API authentication is supplied by the fixture. The route reads the live token assignment,
// active user, institution scope, role grants and outbox under a non-bypass PostgreSQL role.
vi.mock('@/lib/api-auth', () => ({ withApiAuth: (_scope: string, handler: unknown) => handler }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (view: { enabledModules: string[] }, key: string) => view.enabledModules.includes(key),
  resolveOrganizationEntitlements: vi.fn(),
}));
const pg = new PGlite();
const eventId = '11111111-1111-4111-8111-111111111111',
  kind = 'student.registered';
const sql = (s: TemplateStringsArray) =>
  s.reduce((out, part, i) => out + (i ? '$' + i : '') + part, '');
function database(tx: Transaction): ScopedDb {
  return {
    user: {
      findFirst: async ({
        where,
      }: {
        where: { organizationId: string; id: string; status: string };
      }) => {
        const [member] = (
          await tx.query<{ role_key: string; role: string }>(
            'SELECT role_key,role FROM users WHERE "organizationId"=$1 AND id=$2 AND status=$3',
            [where.organizationId, where.id, where.status]
          )
        ).rows;
        if (!member) return null;
        const { rows } = await tx.query<{ capability: string; effect: string; override: boolean }>(
          'SELECT capability,effect,override FROM pilot_permissions WHERE org=$1 AND user_id=$2',
          [where.organizationId, where.id]
        );
        return {
          role: member.role,
          organizationRole: {
            organizationId: where.organizationId,
            key: member.role_key,
            isSystem: true,
            permissions: rows.filter((r) => !r.override),
          },
          permissionOverrides: rows.filter((r) => r.override),
        };
      },
    },
    $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
      (await tx.query(sql(parts), values)).rows,
    $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
      (await tx.query(sql(parts), values)).affectedRows,
  } as unknown as ScopedDb;
}
type TestRoute = (ctx: ApiContext, req: Request) => Promise<Response>;
async function request(
  method: 'GET' | 'POST',
  topic = kind,
  token = 'roster-token',
  user = 'registry',
  modules = ['university-core', 'university-academics', 'university-services'],
  org = 'uni'
) {
  return pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE event_delivery_runtime');
    await tx.query("SELECT set_config('app.current_organization_id',$1,true)", [org]);
    const ctx: ApiContext = {
      organizationId: org,
      userId: user,
      userRole: 'EMPLOYEE',
      tokenId: token,
      scopes: ['university:integrations:read', 'university:integrations:write'],
      db: database(tx),
      entitlements: {
        organizationId: org,
        vertical: 'UNIVERSITY',
        activeSeats: 1,
        seatLimit: 2,
        limits: {},
        enabledModules: modules,
        modules: [],
      },
    };
    const body =
      method === 'POST'
        ? {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              eventId,
              kind: topic,
              status: 'ACKNOWLEDGED',
              reference: 'LMS-1',
            }),
          }
        : undefined;
    return ((method === 'GET' ? GET : POST) as unknown as TestRoute)(
      ctx,
      new Request('https://university.test/api/v1/university/events?kind=' + topic, body)
    );
  });
}
beforeAll(async () => {
  await pg.exec(`CREATE TABLE organizations(id text PRIMARY KEY);CREATE TABLE users("organizationId" text,id text,status text,role_key text,role text,PRIMARY KEY("organizationId",id));
 CREATE TABLE api_tokens("organizationId" text,id text PRIMARY KEY,"userId" text,"expiresAt" timestamptz);
 CREATE TABLE university_staff_scopes(organization_id text,user_id text,level text);
 CREATE TABLE pilot_permissions(org text,user_id text,capability text,effect text,override boolean);
 INSERT INTO organizations VALUES('uni'),('other');
 INSERT INTO users VALUES('uni','registry','ACTIVE','university-registrar','EMPLOYEE'),('uni','teacher','ACTIVE','university-instructor','EMPLOYEE'),('uni','admin','ACTIVE','university-admin','ADMIN');
 INSERT INTO api_tokens VALUES('uni','roster-token','registry',NULL),('uni','replacement-token','registry',NULL),('uni','admin-token','admin',NULL);
 INSERT INTO university_staff_scopes VALUES('uni','registry','INSTITUTION'),('uni','teacher','INSTITUTION');
 INSERT INTO pilot_permissions VALUES('uni','registry','university:academics','ALLOW',false),('uni','teacher','university:academics','ALLOW',false),('uni','admin','*','ALLOW',false);`);
  for (const migration of [
    '20261125090050_university_events',
    '20261125090055_university_connectors',
  ])
    await pg.exec(readFileSync('prisma/migrations/' + migration + '/migration.sql', 'utf8'));
  await pg.exec(`INSERT INTO university_connector_topics VALUES('uni','student.registered','roster-token'),('uni','grade.draft','roster-token'),('uni','grade.secret','roster-token'),('uni','credential.request-decided','admin-token');
 INSERT INTO university_events(organization_id,id,kind,source_key,payload) VALUES('uni','11111111-1111-4111-8111-111111111111','student.registered','seat','{"sectionId":"A"}');
 CREATE ROLE event_delivery_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO event_delivery_runtime;`);
}, 30000);
afterAll(() => pg.close());
describe('institutional university event delivery', () => {
  it('admits only exact outbound kinds, their commercial modules and their bulk register readers', async () => {
    expect(eventModule('grade.draft')).toBe('university-academics');
    expect(deliveryPolicy('grade.draft')).toBeUndefined();
    expect(eventModule('grade.secret')).toBeUndefined();
    for (const method of ['GET', 'POST'] as const) {
      expect((await request(method, 'grade.secret')).status).toBe(403);
      expect((await request(method, 'grade.draft')).status).toBe(403);
      expect((await request(method, kind, 'replacement-token')).status).toBe(403);
      expect((await request(method, kind, 'roster-token', 'teacher')).status).toBe(403);
      expect(
        (await request(method, kind, 'roster-token', 'registry', ['university-core'])).status
      ).toBe(403);
      expect(
        (await request(method, kind, 'roster-token', 'registry', undefined, 'other')).status
      ).toBe(403);
      expect(
        (await request(method, 'credential.request-decided', 'admin-token', 'admin')).status
      ).toBe(403);
    }
  });
  it('rechecks current scope, capability, token ownership and user activity on both poll and receipt', async () => {
    expect((await (await request('GET')).json()).events).toEqual([
      expect.objectContaining({ id: eventId, payload: { sectionId: 'A' } }),
    ]);
    const denied = async () => {
      expect((await request('GET')).status).toBe(403);
      expect((await request('POST')).status).toBe(403);
      expect((await pg.query('SELECT status FROM university_events')).rows).toEqual([
        { status: 'PENDING' },
      ]);
    };
    await pg.exec("UPDATE users SET role_key='university-instructor' WHERE id='registry'");
    await denied();
    await pg.exec("UPDATE users SET role_key='university-registrar' WHERE id='registry'");
    await pg.exec(
      `UPDATE api_tokens SET "expiresAt"=now()-interval '1 second' WHERE id='roster-token'`
    );
    await denied();
    await pg.exec(`UPDATE api_tokens SET "expiresAt"=NULL WHERE id='roster-token'`);
    await pg.exec("UPDATE university_staff_scopes SET level='CAMPUS' WHERE user_id='registry'");
    await denied();
    await pg.exec(
      "UPDATE university_staff_scopes SET level='INSTITUTION' WHERE user_id='registry'; DELETE FROM pilot_permissions WHERE user_id='registry'"
    );
    await denied();
    await pg.exec(
      "INSERT INTO pilot_permissions VALUES('uni','registry','university:academics','ALLOW',false),('uni','registry','university:*','DENY',true)"
    );
    await denied();
    await pg.exec(
      "DELETE FROM pilot_permissions WHERE override; UPDATE users SET status='INACTIVE' WHERE id='registry'"
    );
    await denied();
    await pg.exec(
      "UPDATE users SET status='ACTIVE' WHERE id='registry'; UPDATE university_connector_topics SET token_id='replacement-token' WHERE kind='student.registered'"
    );
    await denied();
    expect((await request('POST', kind, 'replacement-token')).status).toBe(200);
    expect((await pg.query('SELECT status,acknowledgment FROM university_events')).rows).toEqual([
      { status: 'ACKNOWLEDGED', acknowledgment: 'LMS-1' },
    ]);
  });
});
