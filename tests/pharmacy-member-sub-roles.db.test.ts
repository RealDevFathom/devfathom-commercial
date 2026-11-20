// @vitest-environment node
/**
 * DEV-959B: ticking a pharmacy member's sub-roles, on real tables, as the restricted runtime
 * role with forced row-level security. Every rule the server enforces is exercised through
 * the real organizationAdmin procedures and the real ABAC engine. Skipped (never silently
 * passed) without the database URLs.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';
import type { TRPCContext } from '@/server/trpc';

vi.mock('server-only', () => ({}));

const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL ?? '';
const runtimeUrl = process.env.TEST_DATABASE_URL ?? '';
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;
// The change writes its own audit row in its transaction; only the request log is skipped.
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});
// Invites and reviews send email; nothing leaves the test.
vi.mock('@/lib/email', async () => {
  const actual = await vi.importActual<typeof import('@/lib/email')>('@/lib/email');
  return { ...actual, sendEmail: vi.fn(async () => ({ ok: true })) };
});

const prefix = `sr_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const id = (key: string) => `${prefix}_${key}`;
const orgA = id('a');
const orgB = id('b');
// A pharmacy with exactly one owner, for the paths that could leave it without one.
const orgC = id('c');
const ORGS = [orgA, orgB, orgC];
const PIN = '2468';

type Member = {
  key: string;
  org: string;
  role: 'ADMIN' | 'EMPLOYEE';
  template: string;
  pin?: boolean;
};
const MEMBERS: Member[] = [
  { key: 'owner', org: orgA, role: 'ADMIN', template: 'owner', pin: true },
  { key: 'owner2', org: orgA, role: 'ADMIN', template: 'owner', pin: true },
  { key: 'manager', org: orgA, role: 'ADMIN', template: 'manager', pin: true },
  { key: 'operator', org: orgA, role: 'ADMIN', template: 'owner-operator', pin: true },
  { key: 'cashier', org: orgA, role: 'EMPLOYEE', template: 'cashier' },
  { key: 'cashier2', org: orgA, role: 'EMPLOYEE', template: 'cashier' },
  { key: 'pharmacist', org: orgA, role: 'EMPLOYEE', template: 'pharmacist' },
  { key: 'ownerb', org: orgB, role: 'ADMIN', template: 'owner', pin: true },
  { key: 'cashier3', org: orgA, role: 'EMPLOYEE', template: 'cashier' },
  // Administrator access through a personal exception, not the base role.
  { key: 'exadmin', org: orgA, role: 'EMPLOYEE', template: 'cashier' },
  { key: 'helper', org: orgA, role: 'EMPLOYEE', template: 'helper' },
  { key: 'solo', org: orgC, role: 'ADMIN', template: 'owner', pin: true },
  { key: 'managerc', org: orgC, role: 'ADMIN', template: 'manager', pin: true },
  { key: 'cashierc', org: orgC, role: 'EMPLOYEE', template: 'cashier' },
  // Moved into an empty custom role while that role is being edited (race test).
  { key: 'mover', org: orgA, role: 'EMPLOYEE', template: 'cashier' },
];
const member = (key: string) => MEMBERS.find((candidate) => candidate.key === key)!;

(ownerUrl && runtimeUrl ? describe : describe.skip)(
  'DEV-959B ticking a member’s sub-roles under the restricted PostgreSQL runtime role',
  () => {
    const c = new pg.Client({ connectionString: ownerUrl });
    let callers: {
      admin: (
        who: string
      ) => ReturnType<
        (typeof import('@/server/routers/organization-admin'))['organizationAdminRouter']['createCaller']
      >;
      team: (
        who: string
      ) => ReturnType<(typeof import('@/server/routers/team'))['teamRouter']['createCaller']>;
      resignations: (
        who: string
      ) => ReturnType<
        (typeof import('@/server/routers/resignations'))['resignationsRouter']['createCaller']
      >;
      context: (who: string) => TRPCContext;
    };

    async function rows(sql: string, values: unknown[] = []) {
      await c.query("SELECT set_config('app.is_platform_admin','true',false)");
      return (await c.query(sql, values)).rows;
    }
    const overrides = (who: string) =>
      rows(
        `SELECT capability, effect FROM user_permission_overrides WHERE "userId"=$1 ORDER BY capability`,
        [id(who)]
      );
    const audits = (who: string) =>
      rows(
        `SELECT action, "actorId", changes, metadata FROM audit_logs WHERE "targetId"=$1 AND action LIKE 'organizationAdmin.%' ORDER BY "createdAt", id`,
        [id(who)]
      );
    const accessAudits = (who: string) =>
      rows(
        `SELECT action, "actorId", "actorType", source FROM audit_logs WHERE "targetId"=$1 AND category='TEAM' ORDER BY "createdAt", id`,
        [id(who)]
      );
    const userRow = async (who: string) =>
      (
        await rows(
          `SELECT u.role, u.status, r.key FROM users u LEFT JOIN organization_roles r ON r.id=u."organizationRoleId" WHERE u.id=$1`,
          [id(who)]
        )
      )[0];
    const activeOwners = (org: string) =>
      rows(
        `SELECT u.id FROM users u JOIN organization_roles r ON r.id=u."organizationRoleId" WHERE u."organizationId"=$1 AND r.key='owner' AND u.status='ACTIVE' AND u.role='ADMIN'`,
        [org]
      );
    async function allowed(who: string, action: string) {
      const { can } = await import('@/lib/abac');
      const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
      const m = member(who);
      return can(
        { id: id(who), role: m.role, department: 'Pharmacy', status: 'ACTIVE' },
        action as never,
        undefined,
        { db: createTenantDb(m.org, id(who)) as never }
      );
    }

    beforeAll(async () => {
      assertDisposableRlsDatabase(ownerUrl);
      assertDisposableRlsDatabase(runtimeUrl);
      const { PHARMACY_ROLE_TEMPLATES } = await import('@/lib/vertical-catalog');
      const { hashOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
      await c.connect();
      await c.query("SELECT set_config('app.is_platform_admin','true',false)");
      for (const org of ORGS) {
        await c.query(
          `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",vertical,"seatLimit","createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED','PHARMACY',50,now(),now())`,
          [org]
        );
        await c.query(
          `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'Pharmacy','Pharmacy',now()), ($3,$2,'COUNTER','Counter',now())`,
          [`${org}_dep`, org, `${org}_dep_counter`]
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
      }
      // A custom (non-system) role with one holder, edited later for everyone who holds it.
      await c.query(
        `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,'helper','Helper',false,now())`,
        [`${orgA}_role_helper`, orgA]
      );
      await c.query(
        `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'pharmacy:orders','ALLOW')`,
        [`${orgA}_role_helper_0`, orgA, `${orgA}_role_helper`]
      );
      // An empty custom role in A, and a group (custom role) with dispensing in C.
      for (const [roleId, org, key, capability] of [
        [`${orgA}_role_empty`, orgA, 'empty', 'pharmacy:orders'],
        [`${orgC}_role_groupd`, orgC, 'groupd', 'pharmacy:dispense'],
      ] as const) {
        await c.query(
          `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,$3,$3,false,now())`,
          [roleId, org, key]
        );
        await c.query(
          `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,$4,'ALLOW')`,
          [`${roleId}_0`, org, roleId, capability]
        );
      }
      for (const m of MEMBERS) {
        await c.query(
          `INSERT INTO users (id,"organizationId","organizationRoleId",name,email,department,title,role,status,"updatedAt") VALUES ($1,$2,$3,$1,$1,'Pharmacy','Staff',$4,'ACTIVE',now())`,
          [id(m.key), m.org, `${m.org}_role_${m.template}`, m.role]
        );
        if (m.pin) {
          await c.query(
            `INSERT INTO restaurant_staff_profiles (id,"organizationId","userId","displayName",status,"updatedAt") VALUES ($1,$2,$3,$3,'ACTIVE',now())`,
            [id(`staff_${m.key}`), m.org, id(m.key)]
          );
          await c.query(
            `INSERT INTO restaurant_operator_credentials (id,"organizationId","staffProfileId",type,"credentialHash","updatedAt") VALUES ($1,$2,$3,'PIN',$4,now())`,
            [
              id(`pin_${m.key}`),
              m.org,
              id(`staff_${m.key}`),
              await hashOperatorCredential('PIN', PIN),
            ]
          );
        }
      }
      await c.query(
        `INSERT INTO user_permission_overrides (id,"organizationId","userId",capability,effect,reason,"updatedAt") VALUES ($1,$2,$3,'admin:access','ALLOW','fixture',now())`,
        [id('exadmin_admin'), orgA, id('exadmin')]
      );
      await c.query(
        `INSERT INTO platform_users (id,name,email,"passwordHash",role,"updatedAt") VALUES ($1,$1,$2,'not-a-real-hash','SUPER_ADMIN',now())`,
        [id('platform'), `${id('platform')}@platform.test`]
      );
      await c.query("SELECT set_config('app.is_platform_admin','false',false)");

      const { organizationAdminRouter } = await import('@/server/routers/organization-admin');
      const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
      const context = (who: string) => {
        const m = member(who);
        return {
          db: createTenantDb(m.org, id(who)),
          entitlements: {
            organizationId: m.org,
            vertical: 'PHARMACY',
            enabledModules: ['pharmacy-core'],
            activeSeats: 3,
            seatLimit: 50,
            modules: [],
            limits: {},
          },
          session: {
            expires: 'later',
            user: {
              id: id(who),
              organizationId: m.org,
              role: m.role,
              department: 'Pharmacy',
              status: 'ACTIVE',
            },
          },
          organization: { id: m.org },
          support: null,
          requestMeta: { ip: null, userAgent: null },
          audit: { detail: {} },
        } as unknown as TRPCContext;
      };
      const { teamRouter } = await import('@/server/routers/team');
      const { resignationsRouter } = await import('@/server/routers/resignations');
      callers = {
        admin: (who) => organizationAdminRouter.createCaller(context(who)),
        team: (who) => teamRouter.createCaller(context(who)),
        resignations: (who) => resignationsRouter.createCaller(context(who)),
        context,
      };
    }, 120_000);

    afterAll(async () => {
      await c.query("SELECT set_config('app.is_platform_admin','true',false)");
      await c
        .query(`DELETE FROM platform_audit_logs WHERE "actorPlatformUserId"=$1`, [id('platform')])
        .catch(() => {});
      await c.query(`DELETE FROM platform_users WHERE id=$1`, [id('platform')]).catch(() => {});
      for (const org of ORGS) {
        await c.query(`DELETE FROM audit_logs WHERE "organizationId"=$1`, [org]).catch(() => {});
        await c.query(`DELETE FROM organizations WHERE id=$1`, [org]).catch(() => {});
      }
      await c.end();
    });

    it('runs as a role that cannot bypass row-level security', async () => {
      const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
      const flags = await createTenantDb(orgA, id('owner')).$queryRawUnsafe<
        { rolsuper: boolean; rolbypassrls: boolean }[]
      >('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
      expect(flags).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const forced = await rows(
        `SELECT relforcerowsecurity FROM pg_class WHERE relname IN ('user_permission_overrides','audit_logs','users')`
      );
      expect(forced.every((row) => row.relforcerowsecurity)).toBe(true);
    });

    it('shows a cashier the Cashier sub-roles ticked and every other one unticked', async () => {
      const { pharmacyTemplateSubRoleKeys } = await import('@/lib/abac/pharmacy-sub-roles');
      const access = await callers.admin('owner').memberAccess({ userId: id('cashier') });
      const on = access.groups
        .flatMap((group) => group.subRoles)
        .filter((subRole) => subRole.state === 'on')
        .map((subRole) => subRole.key)
        .sort();
      expect(on).toEqual(pharmacyTemplateSubRoleKeys('cashier').sort());
      expect(access.ticking.editing).toEqual({ allowed: true, reason: null });
      expect(access.ticking.roleKey).toBe('cashier');
      expect(access.ticking.personal).toEqual({});
    });

    it('ticks another role’s sub-role as a personal exception, audited, effective at once', async () => {
      expect(await allowed('cashier', 'pharmacy:procurement')).toBe(false);
      // Order and receive stock carries extra weight: the owner gives it with their own PIN.
      await expect(
        callers
          .admin('owner')
          .setMemberSubRole({ userId: id('cashier'), subRoleKey: 'receive-stock', ticked: true })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      const result = await callers.admin('owner').setMemberSubRole({
        userId: id('cashier'),
        subRoleKey: 'receive-stock',
        ticked: true,
        pin: PIN,
      });
      expect(result.changed).toEqual(['receive-stock']);
      expect(await allowed('cashier', 'pharmacy:procurement')).toBe(true);
      expect(await overrides('cashier')).toEqual([
        { capability: 'pharmacy:procurement', effect: 'ALLOW' },
      ]);
      const [audit] = await audits('cashier');
      expect(audit).toMatchObject({
        action: 'organizationAdmin.setMemberSubRole',
        actorId: id('owner'),
        changes: {
          subRoles: { before: { 'receive-stock': 'off' }, after: { 'receive-stock': 'on' } },
        },
        metadata: {
          subRole: 'receive-stock',
          ticked: true,
          changedSubRoles: ['receive-stock'],
          exceptionBefore: null,
          exceptionAfter: { effect: 'ALLOW' },
          pinVerified: true,
        },
      });
      expect(typeof audit.metadata.changedAt).toBe('string');
      // Asking again for the same state changes and records nothing.
      await callers
        .admin('owner')
        .setMemberSubRole({ userId: id('cashier'), subRoleKey: 'receive-stock', ticked: true });
      expect(await audits('cashier')).toHaveLength(1);
    });

    it('unticks a role’s own sub-role and the next request is refused, same session', async () => {
      const { capabilityProcedure, router } = await import('@/server/trpc');
      const probe = router({ counter: capabilityProcedure('pharmacy:counter').query(() => 'ok') });
      const cashierSession = callers.context('cashier');
      expect(await probe.createCaller(cashierSession).counter()).toBe('ok');
      await callers
        .admin('owner')
        .setMemberSubRole({ userId: id('cashier'), subRoleKey: 'take-payment', ticked: false });
      // No cached decision: the very next call with the unchanged session is refused.
      await expect(probe.createCaller(cashierSession).counter()).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(await overrides('cashier')).toContainEqual({
        capability: 'pharmacy:counter',
        effect: 'DENY',
      });
      // Ticking it again drops the exception: the role gives it, so later role upgrades reach them.
      await callers
        .admin('owner')
        .setMemberSubRole({ userId: id('cashier'), subRoleKey: 'take-payment', ticked: true });
      expect(await probe.createCaller(cashierSession).counter()).toBe('ok');
      expect(await overrides('cashier')).toEqual([
        { capability: 'pharmacy:procurement', effect: 'ALLOW' },
      ]);
    });

    it('needs the editor’s fresh PIN for a weighty sub-role, striking a wrong one', async () => {
      const give = (pin?: string) =>
        callers.admin('owner').setMemberSubRole({
          userId: id('cashier'),
          subRoleKey: 'controlled-medicines',
          ticked: true,
          ...(pin ? { pin } : {}),
        });
      await expect(give()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      await expect(give('0000')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const [strike] = await rows(
        `SELECT "failedAttempts" FROM restaurant_operator_credentials WHERE id=$1`,
        [id('pin_owner')]
      );
      expect(strike.failedAttempts).toBe(1);
      expect(await allowed('cashier', 'pharmacy:safety')).toBe(false);
      expect(await audits('cashier')).toHaveLength(3);
      await give(PIN);
      expect(await allowed('cashier', 'pharmacy:safety')).toBe(true);
      const last = (await audits('cashier')).at(-1);
      expect(last.metadata).toMatchObject({ subRole: 'controlled-medicines', pinVerified: true });
      const pinAudit = await rows(
        `SELECT 1 FROM audit_logs WHERE "organizationId"=$1 AND metadata::text LIKE $2`,
        [orgA, `%${PIN}%`]
      );
      expect(pinAudit).toEqual([]);
    });

    it('lets the owner give any sub-role, even one they do not hold, with their fresh PIN', async () => {
      // The Owner template has no dispensing (clinical powers stay with pharmacists).
      expect(await allowed('owner', 'pharmacy:dispense')).toBe(false);
      await expect(
        callers.admin('owner').setMemberSubRole({
          userId: id('cashier2'),
          subRoleKey: 'dispense-prescriptions',
          ticked: true,
        })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(await allowed('cashier2', 'pharmacy:dispense')).toBe(false);
      // The prescription rule follows dispensing, so both are recorded.
      const given = await callers.admin('owner').setMemberSubRole({
        userId: id('cashier2'),
        subRoleKey: 'dispense-prescriptions',
        ticked: true,
        pin: PIN,
      });
      expect(given.changed.sort()).toEqual(['dispense-prescriptions', 'record-prescriptions']);
      expect(await allowed('cashier2', 'pharmacy:dispense')).toBe(true);
    });

    it('never lets an administrator who is not the owner change a weighty sub-role', async () => {
      // An Owner / Operator administrator holds dispensing, but is not the owner.
      expect(await allowed('operator', 'pharmacy:dispense')).toBe(true);
      for (const ticked of [true, false])
        await expect(
          callers.admin('operator').setMemberSubRole({
            userId: id(ticked ? 'cashier3' : 'cashier2'),
            subRoleKey: 'dispense-prescriptions',
            ticked,
            pin: PIN,
          })
        ).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: expect.stringMatching(/Only the owner can change/),
        });
      expect(await allowed('cashier3', 'pharmacy:dispense')).toBe(false);
      expect(await allowed('cashier2', 'pharmacy:dispense')).toBe(true);
      // Nor one they do not hold, weighty or not.
      expect(await allowed('manager', 'reports:financial')).toBe(false);
      await expect(
        callers.admin('manager').setMemberSubRole({
          userId: id('cashier2'),
          subRoleKey: 'financial-reports',
          ticked: true,
          pin: PIN,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await allowed('cashier2', 'reports:financial')).toBe(false);
      // Manage stock, which the manager holds, is weighty: refused too.
      await expect(
        callers.admin('manager').setMemberSubRole({
          userId: id('cashier3'),
          subRoleKey: 'manage-stock',
          ticked: true,
          pin: PIN,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await allowed('cashier3', 'pharmacy:inventory')).toBe(false);
    });

    it('limits an administrator who is not the owner to members below them', async () => {
      // Including someone who is an administrator only through a personal exception.
      for (const target of ['owner', 'owner2', 'operator', 'manager', 'exadmin'])
        await expect(
          callers.admin('manager').setMemberSubRole({
            userId: id(target),
            subRoleKey: 'customer-orders',
            ticked: false,
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await allowed('exadmin', 'pharmacy:orders')).toBe(true);
      const view = await callers.admin('manager').memberAccess({ userId: id('exadmin') });
      expect(view.ticking.editing.allowed).toBe(false);
      // Below them, a non-weighty sub-role they hold themselves: allowed both ways.
      await callers
        .admin('manager')
        .setMemberSubRole({ userId: id('cashier2'), subRoleKey: 'customer-orders', ticked: false });
      expect(await allowed('cashier2', 'pharmacy:orders')).toBe(false);
      await callers
        .admin('manager')
        .setMemberSubRole({ userId: id('cashier2'), subRoleKey: 'customer-orders', ticked: true });
      expect(await allowed('cashier2', 'pharmacy:orders')).toBe(true);
      // A member without administrator access cannot reach the procedure at all.
      await expect(
        callers.admin('cashier').setMemberSubRole({
          userId: id('cashier2'),
          subRoleKey: 'customer-orders',
          ticked: false,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('keeps every owner’s owner access and at least one active owner', async () => {
      await expect(
        callers.admin('owner').setMemberSubRole({
          userId: id('owner'),
          subRoleKey: 'manage-stock',
          ticked: false,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        callers.admin('owner').setMemberSubRole({
          userId: id('owner2'),
          subRoleKey: 'manage-stock',
          ticked: false,
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await overrides('owner2')).toEqual([]);
      // An owner may start the other owner from a ready-made role; one owner remains.
      // It takes weighty sub-roles away, so it needs the owner's PIN.
      await expect(
        callers.admin('owner').applyMemberRoleTemplate({ userId: id('owner2'), roleKey: 'cashier' })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      await callers
        .admin('owner')
        .applyMemberRoleTemplate({ userId: id('owner2'), roleKey: 'cashier', pin: PIN });
      const owners = await rows(
        `SELECT u.id FROM users u JOIN organization_roles r ON r.id=u."organizationRoleId" WHERE u."organizationId"=$1 AND r.key='owner' AND u.status='ACTIVE'`,
        [orgA]
      );
      expect(owners).toEqual([{ id: id('owner') }]);
      // Only an owner makes someone an owner: never an administrator who is not the owner.
      await expect(
        callers
          .admin('manager')
          .applyMemberRoleTemplate({ userId: id('owner2'), roleKey: 'owner', pin: PIN })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // The Owner role goes only to a workspace administrator, who can run the workspace;
      // an employee given it would count as an owner without admin access.
      for (const who of ['owner', 'manager'] as const)
        await expect(
          callers
            .admin(who)
            .applyMemberRoleTemplate({ userId: id('cashier2'), roleKey: 'owner', pin: PIN })
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      const [cashier2] = await rows(
        `SELECT r.key FROM users u JOIN organization_roles r ON r.id=u."organizationRoleId" WHERE u.id=$1`,
        [id('cashier2')]
      );
      expect(cashier2.key).toBe('cashier');
      // The owner may make an administrator an owner again, with their PIN.
      await callers
        .admin('owner')
        .applyMemberRoleTemplate({ userId: id('owner2'), roleKey: 'owner', pin: PIN });
      expect(await allowed('owner2', 'admin:access')).toBe(true);
    });

    it('lets a refusal win over a tick', async () => {
      await c.query("SELECT set_config('app.is_platform_admin','true',false)");
      await c.query(
        `INSERT INTO user_permission_overrides (id,"organizationId","userId",capability,effect,reason,"updatedAt") VALUES ($1,$2,$3,'pharmacy:*','DENY','fixture',now())`,
        [id('deny_pharmacist'), orgA, id('pharmacist')]
      );
      await expect(
        callers.admin('owner').setMemberSubRole({
          userId: id('pharmacist'),
          subRoleKey: 'receive-stock',
          ticked: true,
          pin: PIN,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await overrides('pharmacist')).toEqual([{ capability: 'pharmacy:*', effect: 'DENY' }]);
      expect(await allowed('pharmacist', 'pharmacy:procurement')).toBe(false);
    });

    it('starts a person from a ready-made role with exactly its sub-roles', async () => {
      const { pharmacyTemplateSubRoleKeys } = await import('@/lib/abac/pharmacy-sub-roles');
      // The cashier holds weighty exceptions the role does not give: the owner's PIN.
      await callers
        .admin('owner')
        .applyMemberRoleTemplate({ userId: id('cashier'), roleKey: 'cashier', pin: PIN });
      const access = await callers.admin('owner').memberAccess({ userId: id('cashier') });
      expect(
        access.groups
          .flatMap((group) => group.subRoles)
          .filter((subRole) => subRole.state === 'on')
          .map((subRole) => subRole.key)
          .sort()
      ).toEqual(pharmacyTemplateSubRoleKeys('cashier').sort());
      expect(await overrides('cashier')).toEqual([]);
      const last = (await audits('cashier')).at(-1);
      expect(last.action).toBe('organizationAdmin.applyMemberRoleTemplate');
    });

    it('refuses another organization’s owner and hides each tenant’s rows from the other', async () => {
      await expect(
        callers.admin('ownerb').setMemberSubRole({
          userId: id('cashier'),
          subRoleKey: 'receive-stock',
          ticked: true,
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        callers.admin('ownerb').memberAccess({ userId: id('cashier') })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
      const tenantB = createTenantDb(orgB, id('ownerb'));
      expect(
        await tenantB.userPermissionOverride.findMany({ where: { userId: id('cashier2') } })
      ).toEqual([]);
      await expect(
        tenantB.userPermissionOverride.create({
          data: {
            organizationId: orgA,
            userId: id('cashier2'),
            capability: 'pharmacy:manage',
            effect: 'ALLOW',
            reason: 'cross-tenant probe',
          },
        })
      ).rejects.toThrow();
    });

    it('resolves concurrent edits of one person to one consistent result', async () => {
      const edit = (ticked: boolean) =>
        callers
          .admin('owner')
          .setMemberSubRole({ userId: id('cashier'), subRoleKey: 'operational-reports', ticked });
      const before = (await audits('cashier')).length;
      await Promise.all([edit(true), edit(true), edit(true), edit(true)]);
      expect(await overrides('cashier')).toEqual([
        { capability: 'reports:operational', effect: 'ALLOW' },
      ]);
      expect(await audits('cashier')).toHaveLength(before + 1);
      const outcomes = await Promise.allSettled([edit(false), edit(true), edit(false), edit(true)]);
      expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
      const rowsNow = await overrides('cashier');
      expect(rowsNow.length).toBeLessThanOrEqual(1);
      const last = (await audits('cashier')).at(-1);
      expect(await allowed('cashier', 'reports:operational')).toBe(last.metadata.ticked);
      expect(rowsNow).toEqual(
        last.metadata.ticked ? [{ capability: 'reports:operational', effect: 'ALLOW' }] : []
      );
    });

    // ── DEV-959B security review: every path that sets or changes a role, on real tables ──

    it('organizationAdmin.updateMember: a manager cannot make a cashier a pharmacist', async () => {
      await expect(
        callers.admin('manager').updateMember({
          id: id('cashier3'),
          role: 'EMPLOYEE',
          status: 'ACTIVE',
          organizationRoleId: `${orgA}_role_pharmacist`,
          title: 'Staff',
          department: 'COUNTER',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await userRow('cashier3')).key).toBe('cashier');
      expect(await allowed('cashier3', 'pharmacy:dispense')).toBe(false);
    });

    it('organizationAdmin.updateMember: a manager cannot move the only owner to Cashier', async () => {
      expect(await activeOwners(orgC)).toEqual([{ id: id('solo') }]);
      await expect(
        callers.admin('managerc').updateMember({
          id: id('solo'),
          role: 'EMPLOYEE',
          status: 'ACTIVE',
          organizationRoleId: `${orgC}_role_cashier`,
          title: 'Staff',
          department: 'COUNTER',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await userRow('solo')).toMatchObject({ role: 'ADMIN', key: 'owner' });
      expect(await activeOwners(orgC)).toEqual([{ id: id('solo') }]);
    });

    it('organizationAdmin.updateMember: the owner changes a role with a fresh PIN, audited', async () => {
      const change = (pin?: string) =>
        callers.admin('owner').updateMember({
          id: id('cashier3'),
          role: 'EMPLOYEE',
          status: 'ACTIVE',
          organizationRoleId: `${orgA}_role_pharmacist`,
          title: 'Staff',
          department: 'COUNTER',
          ...(pin ? { pin } : {}),
        });
      await expect(change()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect((await userRow('cashier3')).key).toBe('cashier');
      await change(PIN);
      expect((await userRow('cashier3')).key).toBe('pharmacist');
      expect(await allowed('cashier3', 'pharmacy:dispense')).toBe(true);
      expect((await accessAudits('cashier3')).at(-1)).toMatchObject({
        action: 'organizationAdmin.updateMember',
        actorId: id('owner'),
      });
      // Put the cashier back for the paths below.
      await callers
        .admin('owner')
        .applyMemberRoleTemplate({ userId: id('cashier3'), roleKey: 'cashier', pin: PIN });
    });

    it('organizationAdmin.createMember: no administrator access or weighty role from a manager', async () => {
      const create = (who: string, key: string, role: 'ADMIN' | 'EMPLOYEE', email: string) =>
        callers.admin(who).createMember({
          name: email,
          email: `${email}@example.test`,
          password: 'Temporary-pass-1234',
          title: 'Staff',
          role,
          department: 'COUNTER',
          organizationRoleId: `${orgA}_role_${key}`,
          branchIds: [],
        });
      await expect(create('manager', 'cashier', 'ADMIN', id('new1'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(create('manager', 'pharmacist', 'EMPLOYEE', id('new2'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      // The owner needs a fresh PIN for a weighty role too; nothing was created on a refusal.
      await expect(create('owner', 'pharmacist', 'EMPLOYEE', id('new3'))).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      expect(
        await rows(`SELECT id FROM users WHERE email = ANY($1)`, [
          [id('new1'), id('new2'), id('new3')].map((email) => `${email}@example.test`),
        ])
      ).toEqual([]);
      // The manager cannot take payment, so cannot give a Cashier role either.
      await expect(create('manager', 'cashier', 'EMPLOYEE', id('new5'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringMatching(/you cannot take payment/),
      });
      // A role made only of what the manager holds and carries no extra weight is fine.
      await create('manager', 'helper', 'EMPLOYEE', id('new4'));
      expect(
        await rows(`SELECT role FROM users WHERE email=$1`, [`${id('new4')}@example.test`])
      ).toEqual([{ role: 'EMPLOYEE' }]);
    });

    it('team.inviteMember: a manager cannot invite into a weighty role or as an administrator', async () => {
      const invite = (who: string, key: string, role: 'ADMIN' | 'EMPLOYEE', email: string) =>
        callers.team(who).inviteMember({
          name: email,
          email: `${email}@example.test`,
          role,
          organizationRoleId: `${orgA}_role_${key}`,
          department: 'COUNTER',
          title: 'Staff',
        });
      await expect(invite('manager', 'pharmacist', 'EMPLOYEE', id('inv1'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(invite('manager', 'admin', 'ADMIN', id('inv2'))).rejects.toMatchObject({
        code: expect.stringMatching(/FORBIDDEN|BAD_REQUEST/),
      });
      expect(
        await rows(`SELECT id FROM users WHERE email = ANY($1)`, [
          [id('inv1'), id('inv2')].map((email) => `${email}@example.test`),
        ])
      ).toEqual([]);
      // The owner invites a pharmacist with a fresh PIN.
      await expect(invite('owner', 'pharmacist', 'EMPLOYEE', id('inv3'))).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      await callers.team('owner').inviteMember({
        name: id('inv3'),
        email: `${id('inv3')}@example.test`,
        role: 'EMPLOYEE',
        organizationRoleId: `${orgA}_role_pharmacist`,
        department: 'COUNTER',
        title: 'Staff',
        pin: PIN,
      });
      expect(
        await rows(
          `SELECT u.status, r.key FROM users u JOIN organization_roles r ON r.id=u."organizationRoleId" WHERE u.email=$1`,
          [`${id('inv3')}@example.test`]
        )
      ).toEqual([{ status: 'INVITED', key: 'pharmacist' }]);
    });

    it('team.adminUpdateMember and layOffMember: an administrator’s protections hold', async () => {
      await expect(
        callers.team('managerc').adminUpdateMember({ id: id('solo'), role: 'EMPLOYEE' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        callers.team('managerc').adminUpdateMember({ id: id('solo'), status: 'INACTIVE' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        callers.team('manager').adminUpdateMember({ id: id('exadmin'), status: 'INACTIVE' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        callers.team('managerc').layOffMember({ id: id('solo'), reason: 'probe' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await userRow('solo')).toMatchObject({ role: 'ADMIN', status: 'ACTIVE' });
      expect(await userRow('exadmin')).toMatchObject({ status: 'ACTIVE' });
      // A manager may still change a cashier's details below them.
      await callers.team('managerc').adminUpdateMember({ id: id('cashierc'), title: 'Counter' });
    });

    it('organizationAdmin.upsertRole: editing a custom role checks everyone who holds it', async () => {
      const save = (who: string, capabilities: string[], pin?: string) =>
        callers.admin(who).upsertRole({
          id: `${orgA}_role_helper`,
          key: 'helper',
          name: 'Helper',
          description: null,
          permissions: capabilities.map((capability) => ({ capability, effect: 'ALLOW' as const })),
          ...(pin ? { pin } : {}),
        });
      await expect(save('manager', ['pharmacy:orders', 'pharmacy:dispense'])).rejects.toMatchObject(
        {
          code: 'FORBIDDEN',
        }
      );
      await expect(save('owner', ['pharmacy:orders', 'pharmacy:dispense'])).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      expect(await allowed('helper', 'pharmacy:dispense')).toBe(false);
      await save('owner', ['pharmacy:orders', 'pharmacy:dispense'], PIN);
      expect(await allowed('helper', 'pharmacy:dispense')).toBe(true);
      expect((await accessAudits('helper')).at(-1)).toMatchObject({
        action: 'organizationAdmin.upsertRole',
        actorId: id('owner'),
      });
    });

    it('the assistant’s member tools pass the same rules', async () => {
      const { buildPeopleTools } = await import('@/lib/ai/tools/people');
      const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
      const tools = buildPeopleTools({
        db: createTenantDb(orgC, id('managerc')),
        isAdmin: true,
        isHr: false,
        isAdminOrHr: true,
        ctx: {
          organizationId: orgC,
          userId: id('managerc'),
          name: 'Manager',
          vertical: 'PHARMACY',
        },
        can: vi.fn(async () => true),
        audit: vi.fn(),
        resolvePerson: async (name: string) => ({
          kind: 'match',
          value: { id: id(name), name: id(name) },
        }),
      } as never) as unknown as Record<
        string,
        { execute: (input: Record<string, unknown>) => Promise<{ error?: string }> }
      >;
      const promote = await tools.updateMember.execute({ name: 'cashierc', role: 'ADMIN' });
      expect(promote.error).toMatch(/Only the owner can/);
      expect((await userRow('cashierc')).role).toBe('EMPLOYEE');
      const layOff = await tools.layOffMember.execute({ name: 'solo', reason: 'probe' });
      expect(layOff.error).toBeTruthy();
      expect((await userRow('solo')).status).toBe('ACTIVE');
    });

    it('SCIM provisioning only takes access away and keeps the only owner', async () => {
      const { scimAccessChange } = await import('@/lib/scim');
      const { AccessChangeError } = await import('@/lib/team/pharmacy-access-guard');
      const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
      const scim = <T>(write: (db: never) => Promise<T>, targets: string[], action: string) =>
        withTenantDb(orgC, (db) =>
          scimAccessChange(
            { organizationId: orgC, tokenId: 'token', db },
            targets.map(id),
            action,
            async () => ({ targetIds: targets.map(id), value: await write(db as never) })
          )
        );
      // Deactivating the only owner is refused, and rolled back.
      await expect(
        scim(
          (db: { user: { update: (args: unknown) => Promise<unknown> } }) =>
            db.user.update({ where: { id: id('solo') }, data: { status: 'INACTIVE' } }),
          ['solo'],
          'scim.deactivateUser'
        )
      ).rejects.toBeInstanceOf(AccessChangeError);
      expect((await userRow('solo')).status).toBe('ACTIVE');
      // Putting a cashier in the Pharmacist group gives weighty sub-roles: refused.
      await expect(
        scim(
          (db: { user: { update: (args: unknown) => Promise<unknown> } }) =>
            db.user.update({
              where: { id: id('cashierc') },
              data: { organizationRoleId: `${orgC}_role_pharmacist` },
            }),
          ['cashierc'],
          'scim.patchGroup'
        )
      ).rejects.toMatchObject({ refusal: { code: 'FORBIDDEN' } });
      expect((await userRow('cashierc')).key).toBe('cashier');
      expect(await accessAudits('cashierc')).not.toContainEqual(
        expect.objectContaining({ action: 'scim.patchGroup' })
      );
    });

    it('single sign-on never provisions an administrator into a pharmacy', async () => {
      const { provisionIdentityUser } = await import('@/lib/sso');
      const connection = {
        id: id('sso'),
        organizationId: orgC,
        allowJit: true,
        domains: [],
        configuration: {},
        roleMappings: { admins: 'ADMIN' },
        organization: { id: orgC, slug: orgC, status: 'ACTIVE' },
      } as never;
      const email = `${id('sso_admin')}@example.test`;
      await expect(
        provisionIdentityUser(connection, { email, name: 'SSO', groups: ['admins'] })
      ).rejects.toMatchObject({ refusal: { code: 'FORBIDDEN' } });
      expect(await rows(`SELECT id FROM users WHERE email=$1`, [email])).toEqual([]);
      // A plain member is provisioned, and recorded.
      const plain = await provisionIdentityUser(connection, {
        email: `${id('sso_staff')}@example.test`,
        name: 'SSO staff',
      });
      expect(plain.role).toBe('EMPLOYEE');
      expect(await rows(`SELECT action FROM audit_logs WHERE "targetId"=$1`, [plain.id])).toEqual([
        { action: 'sso.provisionUser' },
      ]);
    });

    it('platform console commands pass the same rules', async () => {
      const { executePlatformCommand } = await import('@/lib/platform/commands');
      const actor = {
        sessionId: 'session',
        id: id('platform'),
        name: 'Platform',
        email: `${id('platform')}@platform.test`,
        role: 'SUPER_ADMIN',
        expiresAt: new Date(Date.now() + 60_000),
        mfaEnabled: true,
      } as never;
      const request = new Request('https://platform.test/command');
      await expect(
        executePlatformCommand(
          actor,
          'organization.user',
          { id: id('solo'), status: 'INACTIVE' },
          request
        )
      ).rejects.toMatchObject({ message: 'At least one active owner must remain.' });
      expect((await userRow('solo')).status).toBe('ACTIVE');
      await expect(
        executePlatformCommand(
          actor,
          'organization.permission',
          {
            organizationId: orgC,
            userId: id('cashierc'),
            capability: 'pharmacy:dispense',
            effect: 'ALLOW',
            reason: 'platform probe',
          },
          request
        )
      ).rejects.toMatchObject({ message: expect.stringMatching(/extra weight/) });
      expect(await allowed('cashierc', 'pharmacy:dispense')).toBe(false);
      // Taking access away still works, recorded in the tenant's audit too.
      await executePlatformCommand(
        actor,
        'organization.permission',
        {
          organizationId: orgC,
          userId: id('cashierc'),
          capability: 'pharmacy:orders',
          effect: 'DENY',
          reason: 'platform probe',
        },
        request
      );
      expect(await allowed('cashierc', 'pharmacy:orders')).toBe(false);
      expect((await accessAudits('cashierc')).at(-1)).toMatchObject({
        action: 'platform.organization.permission',
        actorType: 'SYSTEM',
      });
    });

    it('approving the only owner’s resignation never leaves the pharmacy without an owner', async () => {
      await c.query("SELECT set_config('app.is_platform_admin','true',false)");
      await c.query(
        `INSERT INTO resignations (id,"organizationId","userId",reason,"proposedLastDay","updatedAt") VALUES ($1,$2,$3,'Moving on',now() - interval '1 day',now())`,
        [id('resign_solo'), orgC, id('solo')]
      );
      await expect(
        callers.resignations('managerc').review({
          id: id('resign_solo'),
          decision: 'APPROVED',
          lastWorkingDay: new Date(Date.now() - 86_400_000),
        })
      ).rejects.toMatchObject({ message: expect.stringMatching(/owner/) });
      expect((await userRow('solo')).status).toBe('ACTIVE');
      expect(await activeOwners(orgC)).toEqual([{ id: id('solo') }]);
    });

    // ── DEV-959B round-2 review: races, re-activation and invitation acceptance ──

    /** Holds the organisation row lock from a second connection until `release` runs. */
    async function holdOrganisationLock(org: string) {
      const lock = new pg.Client({ connectionString: ownerUrl });
      await lock.connect();
      await lock.query('BEGIN');
      await lock.query("SELECT set_config('app.is_platform_admin','true',true)");
      await lock.query(`SELECT id FROM organizations WHERE id=$1 FOR UPDATE`, [org]);
      const pid = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      return {
        lock,
        /** Waits until another session is blocked behind this lock. */
        async waitForWaiter() {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const [row] = await rows(
              `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
              [pid]
            );
            if (row.n > 0) return;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error('Nothing waited on the organisation lock.');
        },
        async release() {
          await lock.query('COMMIT');
          await lock.end();
        },
      };
    }

    it('upsertRole lists the role’s holders under the lock: a racing move is still checked', async () => {
      expect(await allowed('mover', 'pharmacy:dispense')).toBe(false);
      const held = await holdOrganisationLock(orgA);
      // A manager adds dispensing and controlled medicines to an EMPTY custom role…
      const edit = callers
        .admin('manager')
        .upsertRole({
          id: `${orgA}_role_empty`,
          key: 'empty',
          name: 'Empty',
          description: null,
          permissions: ['pharmacy:orders', 'pharmacy:dispense', 'pharmacy:safety'].map(
            (capability) => ({ capability, effect: 'ALLOW' as const })
          ),
          pin: PIN,
        })
        .then(
          () => 'saved',
          (error: { code?: string }) => error.code
        );
      await held.waitForWaiter();
      // …while a cashier is moved into that role (a move that changes nothing on its own).
      await held.lock.query(`UPDATE users SET "organizationRoleId"=$1 WHERE id=$2`, [
        `${orgA}_role_empty`,
        id('mover'),
      ]);
      await held.release();
      expect(await edit).toBe('FORBIDDEN');
      expect(await allowed('mover', 'pharmacy:dispense')).toBe(false);
      expect(await allowed('mover', 'pharmacy:safety')).toBe(false);
      expect(
        await rows(
          `SELECT capability FROM organization_role_permissions WHERE "organizationRoleId"=$1`,
          [`${orgA}_role_empty`]
        )
      ).toEqual([{ capability: 'pharmacy:orders' }]);
    });

    it('SCIM group changes list members under the lock: a person created meanwhile is checked', async () => {
      const { scimPatchGroupMembers } = await import('@/lib/scim');
      const { AccessChangeError } = await import('@/lib/team/pharmacy-access-guard');
      const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
      const late = id('late');
      const held = await holdOrganisationLock(orgC);
      // The directory adds a person who does not exist yet to a group that gives dispensing…
      const patch = withTenantDb(orgC, (db) =>
        scimPatchGroupMembers(
          { organizationId: orgC, tokenId: 'token', db },
          `${orgC}_role_groupd`,
          [{ op: 'add', ids: [late] }]
        )
      ).then(
        () => 'saved',
        (error: unknown) =>
          error instanceof AccessChangeError ? error.refusal.code : String(error)
      );
      await held.waitForWaiter();
      // …and the person is created before the change runs.
      await held.lock.query(
        `INSERT INTO users (id,"organizationId",name,email,department,title,role,status,"updatedAt") VALUES ($1,$2,$1,$1,'Pharmacy','Staff','EMPLOYEE','ACTIVE',now())`,
        [late, orgC]
      );
      await held.release();
      expect(await patch).toBe('FORBIDDEN');
      const [person] = await rows(`SELECT "organizationRoleId" FROM users WHERE id=$1`, [late]);
      expect(person.organizationRoleId).toBeNull();
    });

    it('re-activating someone who holds a weighty sub-role needs the owner and the owner’s PIN', async () => {
      // cashier2 was given dispensing by the owner earlier.
      expect(await allowed('cashier2', 'pharmacy:dispense')).toBe(true);
      await callers.team('owner').adminUpdateMember({ id: id('cashier2'), status: 'INACTIVE' });
      expect((await userRow('cashier2')).status).toBe('INACTIVE');
      // An administrator who is not the owner cannot bring them back.
      await expect(
        callers.team('manager').adminUpdateMember({ id: id('cashier2'), status: 'ACTIVE' })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringMatching(/Only the owner can change/),
      });
      // Nor can directory provisioning.
      const { scimAccessChange } = await import('@/lib/scim');
      const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
      await expect(
        withTenantDb(orgA, (db) =>
          scimAccessChange(
            { organizationId: orgA, tokenId: 'token', db },
            [id('cashier2')],
            'scim.patchUser',
            async () => ({
              targetIds: [id('cashier2')],
              value: await db.user.update({
                where: { id: id('cashier2') },
                data: { status: 'ACTIVE' },
                select: { id: true },
              }),
            })
          )
        )
      ).rejects.toMatchObject({ refusal: { code: 'FORBIDDEN' } });
      expect((await userRow('cashier2')).status).toBe('INACTIVE');
      // The owner needs a fresh PIN, and then brings them back, audited.
      await expect(
        callers.team('owner').adminUpdateMember({ id: id('cashier2'), status: 'ACTIVE' })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      await callers
        .team('owner')
        .adminUpdateMember({ id: id('cashier2'), status: 'ACTIVE', pin: PIN });
      expect((await userRow('cashier2')).status).toBe('ACTIVE');
      const [audit] = await rows(
        `SELECT metadata FROM audit_logs WHERE "targetId"=$1 AND action='team.adminUpdateMember' ORDER BY "createdAt" DESC LIMIT 1`,
        [id('cashier2')]
      );
      expect(audit.metadata.reactivatedWeighty).toEqual(
        expect.arrayContaining(['dispense-prescriptions'])
      );
      // Someone with no weighty sub-role is brought back by an administrator as before.
      await callers.team('owner').adminUpdateMember({ id: id('cashier3'), status: 'INACTIVE' });
      await callers.team('manager').adminUpdateMember({ id: id('cashier3'), status: 'ACTIVE' });
      expect((await userRow('cashier3')).status).toBe('ACTIVE');
    });

    describe('accepting an invitation is checked again', () => {
      async function accept(org: string, token: string) {
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
      const tokenOf = (url: string) => url.split('/invite/')[1]!;

      it('refuses an invitation into a weighty role made before these rules, until the owner re-sends it', async () => {
        const { INVITATION_NEEDS_OWNER_MESSAGE } = await import('@/lib/team/pharmacy-access-guard');
        const { hashInviteToken } = await import('@/lib/invite-token');
        const email = `${id('preship')}@example.test`;
        const token = `${id('preship_token')}_0123456789abcdef`;
        await c.query("SELECT set_config('app.is_platform_admin','true',false)");
        await c.query(
          `INSERT INTO users (id,"organizationId","organizationRoleId",name,email,department,title,role,status,"updatedAt") VALUES ($1,$2,$3,$1,$4,'Pharmacy','Pharmacist','EMPLOYEE','INVITED',now())`,
          [id('preship'), orgA, `${orgA}_role_pharmacist`, email]
        );
        await c.query(
          `INSERT INTO invitations (id,"organizationId","userId",email,"tokenHash","invitedById","expiresAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,now() + interval '2 days',now())`,
          [id('preship_inv'), orgA, id('preship'), email, hashInviteToken(token), id('owner')]
        );
        // The invitee sees why, and the invitation stays unused.
        await expect(accept(orgA, token)).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: INVITATION_NEEDS_OWNER_MESSAGE,
        });
        expect((await userRow('preship')).status).toBe('INVITED');
        const [invitation] = await rows(`SELECT "acceptedAt" FROM invitations WHERE id=$1`, [
          id('preship_inv'),
        ]);
        expect(invitation.acceptedAt).toBeNull();
        // The owner sends it again with their PIN; the new invitation is accepted.
        const resent = await callers.team('owner').inviteMember({
          name: id('preship'),
          email,
          role: 'EMPLOYEE',
          organizationRoleId: `${orgA}_role_pharmacist`,
          department: 'COUNTER',
          title: 'Pharmacist',
          pin: PIN,
        });
        await accept(orgA, tokenOf(resent.inviteUrl));
        expect((await userRow('preship')).status).toBe('ACTIVE');
        const { can } = await import('@/lib/abac');
        const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
        expect(
          await can(
            { id: id('preship'), role: 'EMPLOYEE', department: 'Pharmacy', status: 'ACTIVE' },
            'pharmacy:dispense',
            undefined,
            { db: createTenantDb(orgA, id('preship')) as never }
          )
        ).toBe(true);
        expect(
          (
            await rows(`SELECT action FROM audit_logs WHERE "targetId"=$1 ORDER BY "createdAt"`, [
              id('preship'),
            ])
          ).map((row) => row.action)
        ).toEqual(expect.arrayContaining(['team.inviteMember', 'invitations.accept']));
      });

      it('refuses an invitation from someone who has since lost the right to give it', async () => {
        const email = `${id('lost')}@example.test`;
        const invited = await callers.team('manager').inviteMember({
          name: id('lost'),
          email,
          role: 'EMPLOYEE',
          organizationRoleId: `${orgA}_role_empty`,
          department: 'COUNTER',
          title: 'Staff',
        });
        await c.query("SELECT set_config('app.is_platform_admin','true',false)");
        await c.query(`UPDATE users SET status='INACTIVE' WHERE id=$1`, [id('manager')]);
        try {
          await expect(accept(orgA, tokenOf(invited.inviteUrl))).rejects.toMatchObject({
            code: 'FORBIDDEN',
          });
          const [person] = await rows(`SELECT status FROM users WHERE email=$1`, [email]);
          expect(person.status).toBe('INVITED');
        } finally {
          await c.query(`UPDATE users SET status='ACTIVE' WHERE id=$1`, [id('manager')]);
        }
        // With the inviter's right back, the same invitation is accepted.
        await accept(orgA, tokenOf(invited.inviteUrl));
        const [person] = await rows(`SELECT status FROM users WHERE email=$1`, [email]);
        expect(person.status).toBe('ACTIVE');
      });
    });

    it('refuses a support session before any PIN is checked, so it never strikes the PIN', async () => {
      const strikes = async () =>
        (
          await rows(`SELECT "failedAttempts" FROM restaurant_operator_credentials WHERE id=$1`, [
            id('pin_owner'),
          ])
        )[0].failedAttempts as number;
      const before = await strikes();
      const support = {
        ...callers.context('owner'),
        support: { id: 'support-session' },
      } as TRPCContext;
      const { organizationAdminRouter } = await import('@/server/routers/organization-admin');
      const { teamRouter } = await import('@/server/routers/team');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(
          organizationAdminRouter.createCaller(support).setMemberSubRole({
            userId: id('cashier3'),
            subRoleKey: 'dispense-prescriptions',
            ticked: true,
            pin: '0000',
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(
          teamRouter
            .createCaller(support)
            .adminUpdateMember({ id: id('cashier3'), role: 'ADMIN', pin: '0000' })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      expect(await strikes()).toBe(before);
    });

    it('the assistant refuses member writes during a support session', async () => {
      const { buildPeopleTools } = await import('@/lib/ai/tools/people');
      const { createTenantDb } = await import('@/lib/tenancy/scoped-db');
      const tools = buildPeopleTools({
        db: createTenantDb(orgA, id('owner')),
        isAdmin: true,
        isHr: false,
        isAdminOrHr: true,
        ctx: {
          organizationId: orgA,
          userId: id('owner'),
          name: 'Owner',
          vertical: 'PHARMACY',
          supportSession: true,
        },
        can: vi.fn(async () => true),
        audit: vi.fn(),
        resolvePerson: async (name: string) => ({
          kind: 'match',
          value: { id: id(name), name: id(name) },
        }),
      } as never) as unknown as Record<
        string,
        { execute: (input: Record<string, unknown>) => Promise<{ error?: string }> }
      >;
      const promote = await tools.updateMember.execute({ name: 'cashier3', role: 'HR' });
      expect(promote.error).toMatch(/support session/);
      expect((await userRow('cashier3')).role).toBe('EMPLOYEE');
    });
  }
);
