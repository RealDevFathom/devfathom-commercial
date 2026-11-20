// @vitest-environment node
/**
 * DEV-974 × DEV-959B: changing a pharmacy member's sign-in email sends them back to invited
 * and issues their invitation again, to the new address. For someone holding weighty access
 * that is the owner's decision, with the owner's PIN, and that approval is what lets the
 * person confirm from the new address. Real tables, the restricted runtime role, forced
 * row-level security. Skipped (never silently passed) without the database URLs.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';
import type { TRPCContext } from '@/server/trpc';

vi.mock('server-only', () => ({}));
// Module licensing is not under test: SCIM is licensed for this pharmacy.
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  hasModule: () => true,
}));

const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL ?? '';
const runtimeUrl = process.env.TEST_DATABASE_URL ?? '';
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});
const sent: Array<{ to: string; text: string }> = [];
vi.mock('@/lib/email', async () => {
  const actual = await vi.importActual<typeof import('@/lib/email')>('@/lib/email');
  return {
    ...actual,
    appUrl: () => 'https://test.invalid',
    sendEmail: vi.fn(async (mail: { to: { email: string }; text: string }) => {
      sent.push({ to: mail.to.email, text: mail.text });
      return { ok: true };
    }),
  };
});

const prefix = `ec_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const id = (key: string) => `${prefix}_${key}`;
const org = id('org');
const PIN = '2468';
const SCIM_TOKEN = `scim_${randomBytes(24).toString('hex')}`;

const MEMBERS = [
  { key: 'owner', role: 'ADMIN', template: 'owner', pin: true },
  { key: 'manager', role: 'ADMIN', template: 'manager', pin: true },
  { key: 'pharmacist', role: 'EMPLOYEE', template: 'pharmacist', pin: false },
  { key: 'cashier', role: 'EMPLOYEE', template: 'cashier', pin: false },
  // A custom role carrying only what a manager can do themselves.
  { key: 'helper', role: 'EMPLOYEE', template: 'helper', pin: false },
] as const;
const emailOf = (key: string) => `${id(key)}@example.test`;

(ownerUrl && runtimeUrl ? describe : describe.skip)(
  'DEV-974 pharmacy email changes under the restricted PostgreSQL runtime role',
  () => {
    const c = new pg.Client({ connectionString: ownerUrl });
    let team: (
      who: string
    ) => ReturnType<(typeof import('@/server/routers/team'))['teamRouter']['createCaller']>;

    async function rows(sql: string, values: unknown[] = []) {
      await c.query("SELECT set_config('app.is_platform_admin','true',false)");
      return (await c.query(sql, values)).rows;
    }
    const userRow = async (key: string) =>
      (await rows(`SELECT email, status FROM users WHERE id=$1`, [id(key)]))[0];
    const confirmToken = (to: string) => {
      for (const mail of [...sent].reverse()) {
        if (mail.to !== to) continue;
        const match = /https:\/\/test\.invalid\/invite\/([A-Za-z0-9_-]+)/.exec(mail.text);
        if (match) return match[1]!;
      }
      return null;
    };
    async function accept(token: string) {
      const { invitationsRouter } = await import('@/server/routers/invitations');
      const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
      return invitationsRouter
        .createCaller({
          db: createTenantDb(org),
          session: null,
          requestMeta: { ip: null, userAgent: null },
          audit: { detail: {} },
        } as unknown as TRPCContext)
        .accept({ token, password: 'Accept-pass-1234', phone: '0300 0000000' });
    }
    async function mayDispense(key: string) {
      const { can } = await import('@/lib/abac');
      const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
      return can(
        { id: id(key), role: 'EMPLOYEE', department: 'Pharmacy', status: 'ACTIVE' },
        'pharmacy:dispense',
        undefined,
        { db: createTenantDb(org, id(key)) as never }
      );
    }

    beforeAll(async () => {
      assertDisposableRlsDatabase(ownerUrl);
      assertDisposableRlsDatabase(runtimeUrl);
      const { PHARMACY_ROLE_TEMPLATES } = await import('@/lib/vertical-catalog');
      const { hashOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
      await c.connect();
      await c.query("SELECT set_config('app.is_platform_admin','true',false)");
      await c.query(
        `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",vertical,"seatLimit","createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED','PHARMACY',50,now(),now())`,
        [org]
      );
      await c.query(
        `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'Pharmacy','Pharmacy',now())`,
        [`${org}_dep`, org]
      );
      for (const template of PHARMACY_ROLE_TEMPLATES) {
        const roleId = `${org}_role_${template.key}`;
        await c.query(
          `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,$3,$4,true,now())`,
          [roleId, org, template.key, template.name]
        );
        for (const [index, capability] of template.capabilities.entries())
          await c.query(
            `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,$4,'ALLOW')`,
            [`${roleId}_${index}`, org, roleId, capability]
          );
      }
      await c.query(
        `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,'helper','Helper',false,now())`,
        [`${org}_role_helper`, org]
      );
      await c.query(
        `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'pharmacy:orders','ALLOW')`,
        [`${org}_role_helper_0`, org, `${org}_role_helper`]
      );
      for (const m of MEMBERS) {
        await c.query(
          `INSERT INTO users (id,"organizationId","organizationRoleId",name,email,department,title,role,status,"updatedAt") VALUES ($1,$2,$3,$1,$4,'Pharmacy','Staff',$5,'ACTIVE',now())`,
          [id(m.key), org, `${org}_role_${m.template}`, emailOf(m.key), m.role]
        );
        if (m.pin) {
          await c.query(
            `INSERT INTO restaurant_staff_profiles (id,"organizationId","userId","displayName",status,"updatedAt") VALUES ($1,$2,$3,$3,'ACTIVE',now())`,
            [id(`staff_${m.key}`), org, id(m.key)]
          );
          await c.query(
            `INSERT INTO restaurant_operator_credentials (id,"organizationId","staffProfileId",type,"credentialHash","updatedAt") VALUES ($1,$2,$3,'PIN',$4,now())`,
            [
              id(`pin_${m.key}`),
              org,
              id(`staff_${m.key}`),
              await hashOperatorCredential('PIN', PIN),
            ]
          );
        }
      }
      await c.query(
        `INSERT INTO organization_scim_tokens (id,"organizationId",name,prefix,"tokenHash") VALUES ($1,$2,'Directory',$3,$4)`,
        [
          id('scim'),
          org,
          SCIM_TOKEN.slice(0, 12),
          createHash('sha256').update(SCIM_TOKEN).digest('hex'),
        ]
      );
      await c.query("SELECT set_config('app.is_platform_admin','false',false)");

      const { teamRouter } = await import('@/server/routers/team');
      const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
      team = (who) => {
        const m = MEMBERS.find((candidate) => candidate.key === who)!;
        return teamRouter.createCaller({
          db: createTenantDb(org, id(who)),
          entitlements: {
            organizationId: org,
            vertical: 'PHARMACY',
            enabledModules: ['pharmacy-core'],
            activeSeats: 4,
            seatLimit: 50,
            modules: [],
            limits: {},
          },
          session: {
            expires: 'later',
            user: {
              id: id(who),
              organizationId: org,
              role: m.role,
              department: 'Pharmacy',
              status: 'ACTIVE',
            },
          },
          organization: { id: org },
          support: null,
          requestMeta: { ip: null, userAgent: null },
          audit: { detail: {} },
        } as unknown as TRPCContext);
      };
    }, 120_000);

    beforeEach(() => {
      sent.length = 0;
    });

    afterAll(async () => {
      await c.query("SELECT set_config('app.is_platform_admin','true',false)");
      await c.query(`DELETE FROM audit_logs WHERE "organizationId"=$1`, [org]).catch(() => {});
      await c.query(`DELETE FROM organizations WHERE id=$1`, [org]).catch(() => {});
      await c.end();
    });

    it('runs as a role that cannot bypass row-level security', async () => {
      const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
      const flags = await createTenantDb(org, id('owner')).$queryRawUnsafe<
        { rolsuper: boolean; rolbypassrls: boolean }[]
      >('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
      expect(flags).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    });

    it('an administrator cannot change a pharmacist’s email: refused, nothing changed', async () => {
      await expect(
        team('manager').adminUpdateMember({
          id: id('pharmacist'),
          email: 'pharmacist.new@example.test',
          pin: PIN,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await userRow('pharmacist')).toEqual({
        email: emailOf('pharmacist'),
        status: 'ACTIVE',
      });
      expect(sent).toEqual([]);
      expect(await mayDispense('pharmacist')).toBe(true);
    });

    it('the owner changes a pharmacist’s email with their PIN; the pharmacist confirms and dispenses', async () => {
      // Without the PIN the owner is asked for it, and nothing changes.
      await expect(
        team('owner').adminUpdateMember({
          id: id('pharmacist'),
          email: 'pharmacist.new@example.test',
        })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(await userRow('pharmacist')).toEqual({
        email: emailOf('pharmacist'),
        status: 'ACTIVE',
      });

      await team('owner').adminUpdateMember({
        id: id('pharmacist'),
        email: 'pharmacist.new@example.test',
        pin: PIN,
      });
      expect(await userRow('pharmacist')).toEqual({
        email: 'pharmacist.new@example.test',
        status: 'INVITED',
      });
      // The owner's approval names this exact issue of the invitation.
      const [approval] = await rows(
        `SELECT metadata FROM audit_logs WHERE "targetId"=$1 AND action='team.adminUpdateMember' AND "actorId"=$2 ORDER BY "createdAt" DESC LIMIT 1`,
        [id('pharmacist'), id('owner')]
      );
      const [invitation] = await rows(`SELECT "updatedAt" FROM invitations WHERE "userId"=$1`, [
        id('pharmacist'),
      ]);
      expect(approval.metadata).toMatchObject({
        pinVerified: true,
        invitationIssuedAt: new Date(invitation.updatedAt).toISOString(),
      });
      expect(approval.metadata.approvedSubRoles.length).toBeGreaterThan(0);

      const token = confirmToken('pharmacist.new@example.test');
      expect(token).not.toBeNull();
      expect(confirmToken(emailOf('pharmacist'))).toBeNull();
      await accept(token!);
      expect(await userRow('pharmacist')).toEqual({
        email: 'pharmacist.new@example.test',
        status: 'ACTIVE',
      });
      expect(await mayDispense('pharmacist')).toBe(true);
    });

    it('an administrator still changes the email of staff below them, who confirm from the new address', async () => {
      await team('manager').adminUpdateMember({
        id: id('helper'),
        email: 'helper.new@example.test',
      });
      expect(await userRow('helper')).toEqual({
        email: 'helper.new@example.test',
        status: 'INVITED',
      });
      const token = confirmToken('helper.new@example.test');
      expect(token).not.toBeNull();
      await accept(token!);
      expect(await userRow('helper')).toEqual({
        email: 'helper.new@example.test',
        status: 'ACTIVE',
      });
    });

    it('an administrator is told plainly when the owner must make the change, and nothing changes', async () => {
      // The cashier holds Take payment, which this manager does not hold: issuing the
      // cashier's invitation again is the owner's call, so the email change is too.
      await expect(
        team('manager').adminUpdateMember({ id: id('cashier'), email: 'cashier.new@example.test' })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringMatching(/Only the owner can change this person's sign-in email/),
      });
      expect(await userRow('cashier')).toEqual({ email: emailOf('cashier'), status: 'ACTIVE' });
      expect(sent).toEqual([]);
    });

    it('a directory cannot change an active pharmacy member’s email: it could not be confirmed', async () => {
      const { PATCH } = await import('@/app/api/scim/v2/Users/[id]/route');
      const response = await PATCH(
        new Request(`https://test.invalid/api/scim/v2/Users/${id('helper')}`, {
          method: 'PATCH',
          headers: {
            authorization: `Bearer ${SCIM_TOKEN}`,
            'content-type': 'application/scim+json',
          },
          body: JSON.stringify({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'replace', path: 'userName', value: 'helper.scim@example.test' }],
          }),
        }),
        { params: Promise.resolve({ id: id('helper') }) }
      );
      expect(response.status).toBe(403);
      expect(((await response.json()) as { detail: string }).detail).toMatch(/team screen/);
      expect((await userRow('helper')).email).not.toBe('helper.scim@example.test');
      expect(sent).toEqual([]);
    });
  }
);
