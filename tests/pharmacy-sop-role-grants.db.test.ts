// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { can } from '@/lib/abac';
import type { Action } from '@/lib/abac';
import type { AuthzDb } from '@/lib/authz';
import { PHARMACY_ROLE_TEMPLATES, PHARMACY_SOP_TEMPLATE_GRANTS } from '@/lib/vertical-catalog';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

/**
 * DEV-751 — the phased, opt-in SOP grant for EXISTING pharmacy tenants
 * (docs/operations/pharmacy-sop-rollout/{up,down}.sql).
 *
 * Runs as the migration owner, which is subject to FORCE ROW LEVEL SECURITY.
 * Every fixture and every script run happens inside one transaction that is
 * rolled back at the end, so nothing outlives the suite. The scripts' own
 * BEGIN/COMMIT are stripped so they run inside that transaction; the platform
 * flag is reset to 'false' first, so only the script's own set_config can make
 * its writes visible to RLS. Skips when the URLs are absent (same variables as
 * tests/pharmacy-sop.db.test.ts); the static contract below always runs.
 */
const runtimeUrl =
  process.env.PHARMACY_SOP_TEST_RUNTIME_DATABASE_URL ??
  process.env.WHA1316_RUNTIME_DATABASE_URL ??
  process.env.TEST_DATABASE_URL;
const ownerUrl =
  process.env.PHARMACY_SOP_TEST_OWNER_DATABASE_URL ?? process.env.WHA1316_OWNER_DATABASE_URL;
const describeIfDatabase = runtimeUrl && ownerUrl ? describe : describe.skip;

const upFile = readFileSync('docs/operations/pharmacy-sop-rollout/up.sql', 'utf8');
const downFile = readFileSync('docs/operations/pharmacy-sop-rollout/down.sql', 'utf8');
const body = (sql: string) => sql.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
const up = body(upFile);
const down = body(downFile);
const SET_FLAG = "SELECT set_config('app.is_platform_admin', 'true', true);";

const SOP = ['sop:complete', 'sop:manage', 'sop:verify'] as const;
/** The approved grant (Saad, delegated on DEV-751). `admin` holds '*' already. */
const APPROVED: Record<string, readonly string[]> = {
  owner: ['sop:complete', 'sop:manage', 'sop:verify'],
  'owner-operator': ['sop:complete', 'sop:manage', 'sop:verify'],
  manager: ['sop:complete', 'sop:manage', 'sop:verify'],
  pharmacist: ['sop:complete', 'sop:verify'],
  cashier: ['sop:complete'],
  procurement: ['sop:complete'],
  inventory: ['sop:complete'],
  finance: [],
  auditor: [],
  admin: [],
};

describe('DEV-751 phased SOP grant contract', () => {
  it('is not a Prisma migration and keeps the explicit transaction around set_config', () => {
    for (const sql of [upFile, downFile]) {
      expect(sql).toMatch(/^BEGIN;$/m);
      expect(sql).toMatch(/^COMMIT;$/m);
      expect(sql.indexOf(SET_FLAG)).toBeGreaterThan(sql.indexOf('BEGIN;'));
      expect(sql.indexOf(SET_FLAG)).toBeLessThan(sql.indexOf('COMMIT;'));
    }
    expect(upFile).toContain('ON CONFLICT ("organizationRoleId", capability) DO NOTHING');
    expect(upFile).not.toMatch(/\bUPDATE\s+organization_role_permissions/i);
    expect(upFile).not.toMatch(/\bDELETE\b/i);
    expect(upFile).not.toMatch(/pharmacy:close/);
  });

  it('matches the new-tenant SOP template grants exactly', () => {
    const fromTemplates = Object.fromEntries(
      PHARMACY_ROLE_TEMPLATES.map((role) => [
        role.key,
        role.capabilities.filter((capability) => capability.startsWith('sop:')).sort(),
      ])
    );
    for (const [key, grants] of Object.entries(APPROVED)) {
      if (key === 'admin') continue;
      expect(fromTemplates[key], key).toEqual([...grants]);
    }
    expect(Object.keys(PHARMACY_SOP_TEMPLATE_GRANTS).sort()).toEqual(
      Object.entries(APPROVED)
        .filter(([, grants]) => grants.length > 0)
        .map(([key]) => key)
        .sort()
    );
  });
});

type Row = {
  id: string;
  organizationId: string;
  organizationRoleId: string;
  capability: string;
  effect: 'ALLOW' | 'DENY';
};

describeIfDatabase('DEV-751 phased SOP grant against PostgreSQL', () => {
  const client = new Client({ connectionString: ownerUrl });
  const notices: string[] = [];
  const run = randomUUID().replaceAll('-', '').slice(0, 12);
  const pharmacy = `dev751g_${run}_ph`;
  const lookalike = `dev751g_${run}_ph2`;
  const restaurant = `dev751g_${run}_rest`;
  const orgs = [pharmacy, lookalike, restaurant];
  const roleId = (org: string, key: string) => `${org}_${key}`;
  const systemKeys = Object.keys(APPROVED);
  let before: Row[] = [];
  let afterUp: Row[] = [];

  async function rows(): Promise<Row[]> {
    const result = await client.query<Row>(
      `SELECT id,"organizationId","organizationRoleId",capability,effect::text AS effect
         FROM organization_role_permissions WHERE "organizationId" = ANY($1) ORDER BY id`,
      [orgs]
    );
    return result.rows;
  }
  const sopOf = (all: Row[], role: string) =>
    all
      .filter((row) => row.organizationRoleId === role && row.capability.startsWith('sop:'))
      .map(({ capability, effect }) => ({ capability, effect }))
      .sort((a, b) => a.capability.localeCompare(b.capability));
  async function asOperatorWithoutFlag() {
    await client.query(`SELECT set_config('app.is_platform_admin','false',true)`);
  }
  async function attempt(sql: string) {
    await client.query('SAVEPOINT attempt');
    try {
      await client.query(sql);
      return 'ACCEPTED';
    } catch (error) {
      return (error as Error).message;
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT attempt');
    }
  }
  type Rule = Pick<Row, 'capability' | 'effect'>;
  /** Feed can() the real rows of one role, in the shape customDecision selects them. */
  function authz(role: string | null, overrides: Rule[], source: Row[]) {
    return {
      user: {
        findUnique: async () => ({
          organizationRole: role
            ? {
                permissions: source
                  .filter((row) => row.organizationRoleId === role)
                  .map(({ capability, effect }) => ({ capability, effect })),
              }
            : null,
          permissionOverrides: overrides,
        }),
      },
    } as unknown as AuthzDb;
  }
  const subject = (role = 'EMPLOYEE') => ({ id: 'u', role, department: null, status: 'ACTIVE' });

  beforeAll(async () => {
    assertDisposableRlsDatabase(ownerUrl!);
    await client.connect();
    client.on('notice', (notice) => notices.push(notice.message ?? ''));
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
    for (const [org, vertical] of [
      [pharmacy, 'PHARMACY'],
      [lookalike, 'PHARMACY'],
      [restaurant, 'RESTAURANT'],
    ] as const) {
      await client.query(
        `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",vertical,"createdAt","updatedAt")
         VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',$2,now(),now())`,
        [org, vertical]
      );
    }
    const addRole = async (org: string, key: string, isSystem: boolean, grants: string[]) => {
      await client.query(
        `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,$3,$3,$4,now())`,
        [roleId(org, key), org, key, isSystem]
      );
      for (const capability of grants) {
        await client.query(
          `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,$4,'ALLOW')`,
          [`${roleId(org, key)}_${capability}`, org, roleId(org, key), capability]
        );
      }
    };
    // Existing tenants were provisioned before the SOP grants: base, non-SOP grants only.
    const baseGrants = (key: string) =>
      key === 'admin'
        ? ['*']
        : (PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)?.capabilities ?? []).filter(
            (capability) => !capability.startsWith('sop:')
          );
    for (const key of systemKeys) {
      await addRole(pharmacy, key, true, baseGrants(key));
      await addRole(restaurant, key, true, baseGrants(key));
    }
    await addRole(pharmacy, 'sop-lead', false, ['pharmacy:counter']);
    // A tenant-authored role that reuses a system key in another pharmacy.
    await addRole(lookalike, 'manager', false, ['pharmacy:manage']);
    // Explicit DENY on a system role, and an ALLOW that predates the rollout.
    await client.query(
      `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'sop:verify','DENY')`,
      [`${roleId(pharmacy, 'pharmacist')}_deny_verify`, pharmacy, roleId(pharmacy, 'pharmacist')]
    );
    await client.query(
      `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'sop:complete','ALLOW')`,
      [`${roleId(pharmacy, 'manager')}_pre_complete`, pharmacy, roleId(pharmacy, 'manager')]
    );
    before = await rows();
  }, 60_000);

  afterAll(async () => {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  });

  it('is subject to forced RLS: without the flag the owner sees none of the fixtures', async () => {
    await asOperatorWithoutFlag();
    const visible = await client.query(
      `SELECT count(*)::int AS n FROM organization_roles WHERE "organizationId" = ANY($1)`,
      [orgs]
    );
    expect(visible.rows[0].n).toBe(0);
  });

  it('refuses to run when its set_config is missing instead of silently doing nothing', async () => {
    await asOperatorWithoutFlag();
    const message = await attempt(up.replace(SET_FLAG, ''));
    expect(message).toContain('app.is_platform_admin is not set');
    expect(await attempt(down.replace(SET_FLAG, ''))).toContain('app.is_platform_admin is not set');
  });

  it('refuses a grant map that would write a non-SOP capability', async () => {
    await asOperatorWithoutFlag();
    const poisoned = up.replace(
      '"cashier":        ["sop:complete"]',
      '"cashier":        ["sop:complete", "pharmacy:close"]'
    );
    expect(poisoned).not.toBe(up);
    expect(await attempt(poisoned)).toContain('refusing to write capabilities outside sop:*');
    const admin = up.replace('"inventory":', '"admin": ["sop:manage"],\n    "inventory":');
    expect(await attempt(admin)).toContain('refusing to grant SOP access to role keys: admin');
  });

  it('grants exactly the approved SOP actions to pharmacy system roles via its own set_config', async () => {
    await asOperatorWithoutFlag();
    notices.length = 0;
    await client.query(up);
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
    afterUp = await rows();
    expect(notices.some((n) => /^DEV-751 up: planned=\d+ inserted=\d+/.test(n))).toBe(true);
    for (const key of systemKeys) {
      const expected = APPROVED[key]!.map((capability) => ({
        capability,
        effect: key === 'pharmacist' && capability === 'sop:verify' ? 'DENY' : 'ALLOW',
      }));
      expect(sopOf(afterUp, roleId(pharmacy, key)), key).toEqual(expected);
    }
  });

  it('keeps the explicit DENY and the pre-existing ALLOW rows as they were', () => {
    const find = (id: string) => afterUp.find((row) => row.id === id);
    expect(find(`${roleId(pharmacy, 'pharmacist')}_deny_verify`)?.effect).toBe('DENY');
    expect(find(`${roleId(pharmacy, 'manager')}_pre_complete`)?.effect).toBe('ALLOW');
    expect(
      afterUp.filter(
        (row) =>
          row.organizationRoleId === roleId(pharmacy, 'pharmacist') &&
          row.capability === 'sop:verify'
      )
    ).toHaveLength(1);
  });

  it('writes only deterministic sop:* ALLOW rows in the role organization and nothing else', () => {
    const beforeIds = new Set(before.map((row) => row.id));
    const added = afterUp.filter((row) => !beforeIds.has(row.id));
    // 3+3+3 (owner, owner-operator, manager) + 2 (pharmacist) + 3x1, minus the DENY and pre-existing ALLOW.
    expect(added).toHaveLength(14 - 2);
    for (const row of added) {
      expect(SOP).toContain(row.capability);
      expect(row.effect).toBe('ALLOW');
      expect(row.organizationId).toBe(pharmacy);
      expect(row.id).toMatch(/^dev751_sop_[0-9a-f]{32}$/);
    }
    // Every row that existed before is byte-for-byte unchanged (pharmacy:close included).
    expect(afterUp.filter((row) => beforeIds.has(row.id))).toEqual(before);
  });

  it('leaves custom roles and other verticals untouched', () => {
    for (const role of [
      roleId(pharmacy, 'sop-lead'),
      roleId(lookalike, 'manager'),
      ...systemKeys.map((key) => roleId(restaurant, key)),
    ]) {
      expect(afterUp.filter((row) => row.organizationRoleId === role)).toEqual(
        before.filter((row) => row.organizationRoleId === role)
      );
    }
  });

  it('is idempotent: a re-run inserts nothing', async () => {
    await asOperatorWithoutFlag();
    notices.length = 0;
    await client.query(up);
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
    expect(notices.find((n) => n.startsWith('DEV-751 up:'))).toMatch(/ inserted=0 /);
    expect(await rows()).toEqual(afterUp);
  });

  it('resolves through can(): grants work, DENY rows and user DENY overrides win', async () => {
    const current = await rows();
    const allowed = (
      role: string | null,
      action: Action,
      overrides: Rule[] = [],
      who = 'EMPLOYEE',
      source: Row[] = current
    ) => can(subject(who), action, undefined, { db: authz(role, overrides, source) });
    for (const key of systemKeys) {
      for (const action of SOP) {
        const expected =
          key === 'admin' ||
          (APPROVED[key]!.includes(action) && !(key === 'pharmacist' && action === 'sop:verify'));
        expect(await allowed(roleId(pharmacy, key), action), `${key} ${action}`).toBe(expected);
      }
    }
    // A user-level DENY override beats the role ALLOW (src/lib/abac/index.ts customDecision).
    expect(
      await allowed(roleId(pharmacy, 'cashier'), 'sop:complete', [
        { capability: 'sop:complete', effect: 'DENY' },
      ])
    ).toBe(false);
    expect(
      await allowed(roleId(pharmacy, 'admin'), 'sop:manage', [
        { capability: 'sop:*', effect: 'DENY' },
      ])
    ).toBe(false);
    // Tenant ADMIN without an organization role has no SOP access: sop:* have no static policy.
    expect(await allowed(null, 'sop:manage', [], 'ADMIN')).toBe(false);
    // Day close (DEV-739, on hold) and every other non-SOP decision are unchanged.
    for (const key of systemKeys) {
      for (const action of ['pharmacy:close', 'pharmacy:manage', 'reports:financial'] as const) {
        const role = roleId(pharmacy, key);
        expect(await allowed(role, action), `${key} ${action}`).toBe(
          await allowed(role, action, [], 'EMPLOYEE', before)
        );
      }
    }
  });

  it('down.sql removes only its own ALLOW rows, keeping DENYs and pre-existing grants', async () => {
    // A row the script inserted but that was later flipped to DENY must survive rollback.
    await client.query('SAVEPOINT flipped');
    const flipped = await client.query(
      `UPDATE organization_role_permissions SET effect='DENY'
        WHERE "organizationRoleId"=$1 AND capability='sop:verify' AND starts_with(id, 'dev751_sop_')`,
      [roleId(pharmacy, 'owner-operator')]
    );
    expect(flipped.rowCount).toBe(1);
    await asOperatorWithoutFlag();
    await client.query(down);
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
    expect(sopOf(await rows(), roleId(pharmacy, 'owner-operator'))).toEqual([
      { capability: 'sop:verify', effect: 'DENY' },
    ]);
    await client.query('ROLLBACK TO SAVEPOINT flipped');

    await asOperatorWithoutFlag();
    notices.length = 0;
    await client.query(down);
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
    expect(notices.find((n) => n.startsWith('DEV-751 down:'))).toMatch(/removed=\d+/);
    expect(await rows()).toEqual(before);

    notices.length = 0;
    await asOperatorWithoutFlag();
    await client.query(down);
    expect(notices.find((n) => n.startsWith('DEV-751 down:'))).toBe('DEV-751 down: removed=0');
  });
});
