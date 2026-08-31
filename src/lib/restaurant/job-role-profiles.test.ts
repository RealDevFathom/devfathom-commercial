/**
 * B1 / WHA-285 — the vertical-supplied job-role PROFILES, as pure data.
 *
 * These assertions need no database, so they hold even when the `.db.test.ts`
 * companion skips for want of PostgreSQL. What they guard is the part a database
 * cannot check: that the seeded profiles are DELIBERATE — every capability is a
 * real catalog capability, the privilege ladder actually climbs, and the roles
 * the deny/direct-grant stories depend on genuinely lack the capability those
 * stories hand out.
 */
import { describe, expect, it } from 'vitest';

import {
  RESTAURANT_CAPABILITIES,
  RESTAURANT_JOB_ROLE_TEMPLATES,
  RESTAURANT_ROLE_TEMPLATES,
} from '@/lib/vertical-catalog';

import { DEFAULT_JOB_ROLES, normalizeJobRoleKey } from './job-roles';

const byKey = new Map(RESTAURANT_JOB_ROLE_TEMPLATES.map((role) => [role.key, role]));
const capabilitiesOf = (key: string): readonly string[] => {
  const role = byKey.get(key);
  if (!role) throw new Error(`No job-role template for "${key}"`);
  return role.capabilities;
};

describe('B1 job-role profiles — the seeded set', () => {
  it('seeds the ten job roles the brief names, with unique keys and names', () => {
    expect(RESTAURANT_JOB_ROLE_TEMPLATES.map((role) => role.key).sort()).toEqual([
      'accountant',
      'barista',
      'cashier',
      'delivery-rider',
      'host',
      'kitchen',
      'manager',
      'owner',
      'server',
      'shift-supervisor',
    ]);
    expect(new Set(RESTAURANT_JOB_ROLE_TEMPLATES.map((role) => role.name)).size).toBe(
      RESTAURANT_JOB_ROLE_TEMPLATES.length
    );
    // "Kitchen / Line Cook" is one role, keyed `kitchen` — the key predates B1 and
    // is load-bearing for the SOP starter packs, so only the label was widened.
    expect(byKey.get('kitchen')?.name).toBe('Kitchen / Line Cook');
  });

  it('is the seed source `ensureDefaultJobRoles` installs', () => {
    // The selector (`jobRoleTemplatesForVertical`) is covered in the catalog's own
    // test — this module is not an approved consumer of the vertical enum.
    expect(DEFAULT_JOB_ROLES).toBe(RESTAURANT_JOB_ROLE_TEMPLATES);
  });

  it('uses keys that survive the normaliser unchanged', () => {
    // A template key that normalises to something else would seed one row and
    // then never be found again by key.
    for (const role of RESTAURANT_JOB_ROLE_TEMPLATES) {
      expect(normalizeJobRoleKey(role.key)).toBe(role.key);
      expect(role.name.trim()).toBe(role.name);
      expect(role.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('B1 job-role profiles — deliberate capabilities', () => {
  it('grants only capabilities the vertical catalog defines', () => {
    const known = new Set(RESTAURANT_CAPABILITIES);
    const unknown = RESTAURANT_JOB_ROLE_TEMPLATES.flatMap((role) =>
      role.capabilities
        .filter((capability) => !known.has(capability))
        .map((c) => `${role.key}:${c}`)
    );
    expect(unknown).toEqual([]);
  });

  it('grants each capability at most once per role, and grants every role something', () => {
    for (const role of RESTAURANT_JOB_ROLE_TEMPLATES) {
      expect(role.capabilities.length).toBeGreaterThan(0);
      expect(new Set(role.capabilities).size).toBe(role.capabilities.length);
    }
  });

  it('never uses the `*` wildcard, so every grant stays deniable', () => {
    // The ORGANIZATION-role `owner` template does use `*`; the JOB-role `owner`
    // must not, or a per-person DENY against it would be a silent no-op.
    expect(RESTAURANT_ROLE_TEMPLATES.find((r) => r.key === 'owner')?.capabilities).toContain('*');
    for (const role of RESTAURANT_JOB_ROLE_TEMPLATES) {
      expect(role.capabilities).not.toContain('*');
    }
  });

  it('climbs a real privilege ladder: cashier ⊂ shift supervisor ⊂ manager ⊂ owner', () => {
    const ladder = ['cashier', 'shift-supervisor', 'manager', 'owner'];
    for (let i = 0; i < ladder.length - 1; i += 1) {
      const lower = new Set(capabilitiesOf(ladder[i]!));
      const higher = new Set(capabilitiesOf(ladder[i + 1]!));
      const missing = [...lower].filter((capability) => !higher.has(capability));
      expect({ step: `${ladder[i]} → ${ladder[i + 1]}`, missing }).toEqual({
        step: `${ladder[i]} → ${ladder[i + 1]}`,
        missing: [],
      });
      expect(higher.size).toBeGreaterThan(lower.size);
    }
  });

  it('withholds supervisor money powers from the roles below the line', () => {
    // These two exclusions are what make the B1 direct-grant and deny stories
    // meaningful, so they are asserted rather than left to the profile author.
    for (const key of ['barista', 'cashier', 'server', 'kitchen', 'host', 'delivery-rider']) {
      expect(capabilitiesOf(key)).not.toContain('orders:discount');
      expect(capabilitiesOf(key)).not.toContain('payments:refund');
    }
    expect(capabilitiesOf('shift-supervisor')).toContain('orders:discount');
    expect(capabilitiesOf('shift-supervisor')).toContain('payments:refund');
  });

  it('lets default cashier and server roles read delivery customers without managing them', () => {
    for (const key of ['cashier', 'server']) {
      expect(capabilitiesOf(key)).toContain('customers:read');
      expect(capabilitiesOf(key)).not.toContain('customers:manage');
    }
  });

  it('keeps the back-office roles off the floor and the floor roles out of the books', () => {
    // An accountant reconciles; they never take an order or open a drawer.
    expect(capabilitiesOf('accountant')).not.toContain('pos:operate');
    expect(capabilitiesOf('accountant')).not.toContain('orders:take');
    expect(capabilitiesOf('accountant')).toContain('reports:financial');
    // Financial reporting and pay rates stay with the owner and the accountant.
    for (const key of ['barista', 'cashier', 'server', 'kitchen', 'host', 'shift-supervisor']) {
      expect(capabilitiesOf(key)).not.toContain('reports:financial');
      expect(capabilitiesOf(key)).not.toContain('workforce:rates');
    }
    expect(capabilitiesOf('owner')).toContain('workforce:rates');
    // A host seats guests; they handle no money at all.
    for (const capability of capabilitiesOf('host')) {
      expect(capability.startsWith('cash:')).toBe(false);
      expect(capability.startsWith('payments:')).toBe(false);
    }
  });

  it('does not collide with the separate organization-role templates', () => {
    // `cashier`, `server` and `kitchen` name the same job on two DIFFERENT
    // subjects (a staff profile vs an app user) in two different tables. The
    // overlap is intended; what must not happen is the two lists drifting into
    // one another, so this pins that they remain separately authored objects.
    const shared = RESTAURANT_JOB_ROLE_TEMPLATES.filter((jobRole) =>
      RESTAURANT_ROLE_TEMPLATES.some((orgRole) => orgRole.key === jobRole.key)
    ).map((role) => role.key);
    expect(shared.sort()).toEqual(['accountant', 'cashier', 'kitchen', 'owner', 'server']);
    for (const key of shared) {
      const orgRole = RESTAURANT_ROLE_TEMPLATES.find((role) => role.key === key)!;
      const jobRole = byKey.get(key)!;
      expect(jobRole).not.toBe(orgRole);
    }
  });
});
