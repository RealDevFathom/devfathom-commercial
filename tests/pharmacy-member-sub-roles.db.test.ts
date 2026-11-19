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

const prefix = `sr_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const id = (key: string) => `${prefix}_${key}`;
const orgA = id('a');
const orgB = id('b');
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
      for (const org of [orgA, orgB]) {
        await c.query(
          `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now())`,
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
      callers = {
        admin: (who) => organizationAdminRouter.createCaller(context(who)),
        context,
      };
    }, 120_000);

    afterAll(async () => {
      await c.query("SELECT set_config('app.is_platform_admin','true',false)");
      for (const org of [orgA, orgB]) {
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
      const result = await callers
        .admin('owner')
        .setMemberSubRole({ userId: id('cashier'), subRoleKey: 'receive-stock', ticked: true });
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
          pinVerified: false,
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

    it('never lets anyone give a sub-role they cannot use themselves', async () => {
      // The Owner template has no dispensing (clinical powers stay with pharmacists).
      expect(await allowed('owner', 'pharmacy:dispense')).toBe(false);
      await expect(
        callers.admin('owner').setMemberSubRole({
          userId: id('cashier2'),
          subRoleKey: 'dispense-prescriptions',
          ticked: true,
          pin: PIN,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // An Owner / Operator administrator holds it, and may give it with their PIN; the
      // prescription rule follows dispensing, so both are recorded.
      const given = await callers.admin('operator').setMemberSubRole({
        userId: id('cashier2'),
        subRoleKey: 'dispense-prescriptions',
        ticked: true,
        pin: PIN,
      });
      expect(given.changed.sort()).toEqual(['dispense-prescriptions', 'record-prescriptions']);
      // A manager-administrator cannot give financial reports they do not hold.
      expect(await allowed('manager', 'reports:financial')).toBe(false);
      await expect(
        callers.admin('manager').setMemberSubRole({
          userId: id('cashier2'),
          subRoleKey: 'financial-reports',
          ticked: true,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await allowed('cashier2', 'reports:financial')).toBe(false);
    });

    it('limits an administrator who is not the owner to members below them', async () => {
      for (const target of ['owner', 'operator', 'manager'])
        await expect(
          callers.admin('manager').setMemberSubRole({
            userId: id(target),
            subRoleKey: 'manage-stock',
            ticked: false,
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // Below them, and something they hold themselves: allowed.
      await callers
        .admin('manager')
        .setMemberSubRole({ userId: id('cashier2'), subRoleKey: 'manage-stock', ticked: true });
      expect(await allowed('cashier2', 'pharmacy:inventory')).toBe(true);
      // A member without administrator access cannot reach the procedure at all.
      await expect(
        callers.admin('cashier').setMemberSubRole({
          userId: id('cashier2'),
          subRoleKey: 'manage-stock',
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
      await callers
        .admin('owner')
        .applyMemberRoleTemplate({ userId: id('owner2'), roleKey: 'cashier' });
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
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await overrides('pharmacist')).toEqual([{ capability: 'pharmacy:*', effect: 'DENY' }]);
      expect(await allowed('pharmacist', 'pharmacy:procurement')).toBe(false);
    });

    it('starts a person from a ready-made role with exactly its sub-roles', async () => {
      const { pharmacyTemplateSubRoleKeys } = await import('@/lib/abac/pharmacy-sub-roles');
      await callers
        .admin('owner')
        .applyMemberRoleTemplate({ userId: id('cashier'), roleKey: 'cashier' });
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
          .setMemberSubRole({ userId: id('cashier'), subRoleKey: 'manage-stock', ticked });
      const before = (await audits('cashier')).length;
      await Promise.all([edit(true), edit(true), edit(true), edit(true)]);
      expect(await overrides('cashier')).toEqual([
        { capability: 'pharmacy:inventory', effect: 'ALLOW' },
      ]);
      expect(await audits('cashier')).toHaveLength(before + 1);
      const outcomes = await Promise.allSettled([edit(false), edit(true), edit(false), edit(true)]);
      expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
      const rowsNow = await overrides('cashier');
      expect(rowsNow.length).toBeLessThanOrEqual(1);
      const last = (await audits('cashier')).at(-1);
      expect(await allowed('cashier', 'pharmacy:inventory')).toBe(last.metadata.ticked);
      expect(rowsNow).toEqual(
        last.metadata.ticked ? [{ capability: 'pharmacy:inventory', effect: 'ALLOW' }] : []
      );
    });
  }
);
