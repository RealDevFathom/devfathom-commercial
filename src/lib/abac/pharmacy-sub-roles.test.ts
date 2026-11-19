// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  PHARMACY_CAPABILITIES,
  PHARMACY_CHECKED_CAPABILITIES,
  PHARMACY_ROLE_TEMPLATES,
} from '@/lib/vertical-catalog';
import { can, type Action } from './index';
import { EXACT_GRANT_ONLY_ACTIONS } from './capabilities';
import { ALL_ACTIONS } from './policies';
import {
  PHARMACY_SUB_ROLES,
  PHARMACY_SUB_ROLE_ACTIONS,
  pharmacyActionsAllowedByRules,
  pharmacySubRoleGroups,
  pharmacySubRoleStates,
  pharmacyTemplateSubRoleKeys,
} from './pharmacy-sub-roles';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };

const isWildcard = (capability: string) => capability === '*' || capability.endsWith(':*');

/** Every action a pharmacy workspace can grant or check, from the real catalogue. */
const PHARMACY_ACTIONS = new Set<string>([
  ...ALL_ACTIONS.filter((action) => action.startsWith('pharmacy:')),
  // Shared report and procedure gates pharmacy workflows check, from the full action list.
  ...ALL_ACTIONS.filter((action) => action.startsWith('reports:') || action.startsWith('sop:')),
  ...PHARMACY_CHECKED_CAPABILITIES,
  ...PHARMACY_CAPABILITIES.filter((capability) => !isWildcard(capability)),
  ...PHARMACY_ROLE_TEMPLATES.flatMap((template) =>
    template.capabilities.filter((capability) => !isWildcard(capability))
  ),
]);

/** A tenant db whose only user holds `role` rules and `overrides`, as `can()` reads it. */
function dbFor(roleRules: Rule[] | null, overrides: Rule[] = []) {
  const row = {
    organizationRole: roleRules === null ? null : { permissions: roleRules },
    permissionOverrides: overrides,
  };
  return { user: { findUnique: async () => row } } as unknown as NonNullable<
    Parameters<typeof can>[3]
  >['db'];
}

async function allowedByEngine(
  db: ReturnType<typeof dbFor>,
  role: 'EMPLOYEE' | 'ADMIN' = 'EMPLOYEE'
) {
  const allowed = new Set<string>();
  for (const action of PHARMACY_SUB_ROLE_ACTIONS) {
    const subject = { id: 'member', role, status: 'ACTIVE' };
    if (await can(subject, action, undefined, { db })) allowed.add(action);
  }
  return allowed;
}

function actionsOf(subRoleKeys: readonly string[]) {
  return new Set(
    PHARMACY_SUB_ROLES.filter((subRole) => subRoleKeys.includes(subRole.key)).flatMap(
      (subRole) => subRole.actions
    )
  );
}

const allow = (capabilities: readonly string[]): Rule[] =>
  capabilities.map((capability) => ({ capability, effect: 'ALLOW' }));

describe('pharmacy sub-role catalogue', () => {
  it('puts every pharmacy action in exactly one sub-role', () => {
    const counts = new Map<string, number>();
    for (const action of PHARMACY_SUB_ROLE_ACTIONS)
      counts.set(action, (counts.get(action) ?? 0) + 1);
    const inNone = [...PHARMACY_ACTIONS].filter((action) => !counts.has(action));
    const inMany = [...counts].filter(([, count]) => count > 1).map(([action]) => action);
    expect(inNone).toEqual([]);
    expect(inMany).toEqual([]);
  });

  it('names only real ABAC actions, and none outside the pharmacy catalogue', () => {
    for (const action of PHARMACY_SUB_ROLE_ACTIONS) {
      expect(ALL_ACTIONS).toContain(action);
      expect(PHARMACY_ACTIONS.has(action)).toBe(true);
    }
  });

  it('gives every sub-role a unique key, a plain label and plain lines of what it allows', () => {
    const keys = PHARMACY_SUB_ROLES.map((subRole) => subRole.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const subRole of PHARMACY_SUB_ROLES) {
      expect(subRole.actions.length).toBeGreaterThan(0);
      expect(subRole.label.length).toBeGreaterThan(0);
      expect(subRole.allows.length).toBeGreaterThan(0);
      for (const { text } of subRole.allows) {
        expect(text).not.toMatch(/\n/);
        // Owner-facing words, never an action name.
        expect(text).not.toMatch(/\b(pharmacy|reports|sop):[a-z-]+/);
      }
    }
  });

  it('marks the five sensitive actions as carrying extra weight, and nothing else', () => {
    expect([...EXACT_GRANT_ONLY_ACTIONS].sort()).toEqual([
      'pharmacy:catalogue-review',
      'pharmacy:discount',
      'pharmacy:dispense',
      'pharmacy:prescriptions',
      'pharmacy:safety',
    ]);
    for (const subRole of PHARMACY_SUB_ROLES)
      expect(subRole.sensitive).toBe(
        subRole.actions.some((action) => EXACT_GRANT_ONLY_ACTIONS.has(action))
      );
    const sensitiveActions = PHARMACY_SUB_ROLES.filter((subRole) => subRole.sensitive).flatMap(
      (subRole) => subRole.actions
    );
    expect(new Set(sensitiveActions)).toEqual(new Set(EXACT_GRANT_ONLY_ACTIONS));
  });

  it('files each sub-role under a ready-made role that normally comes with it', () => {
    const templateKeys = PHARMACY_ROLE_TEMPLATES.map((template) => template.key);
    const grantedByAnyTemplate = new Set(
      PHARMACY_ROLE_TEMPLATES.flatMap((template) => pharmacyTemplateSubRoleKeys(template.key))
    );
    for (const subRole of PHARMACY_SUB_ROLES) {
      expect(templateKeys).toContain(subRole.homeRole);
      // A sub-role no template holds (DEV-66 discount) is granted only by the owner's choice.
      if (grantedByAnyTemplate.has(subRole.key))
        expect(pharmacyTemplateSubRoleKeys(subRole.homeRole)).toContain(subRole.key);
    }
    expect(grantedByAnyTemplate.has('give-discounts')).toBe(false);
  });

  it('shows every sub-role once, grouped by role, with the template names', () => {
    const groups = pharmacySubRoleGroups(new Set());
    const shown = groups.flatMap((group) => group.subRoles.map((subRole) => subRole.key));
    expect(shown.sort()).toEqual(PHARMACY_SUB_ROLES.map((subRole) => subRole.key).sort());
    for (const group of groups) {
      const template = PHARMACY_ROLE_TEMPLATES.find((candidate) => candidate.key === group.roleKey);
      expect(group.roleName).toBe(template?.name);
      expect(group.subRoles.length).toBeGreaterThan(0);
      for (const subRole of group.subRoles) expect(subRole.state).toBe('off');
    }
  });

  it('marks a sub-role partly held when only some of its actions are allowed', () => {
    // A test-only catalogue: today every real sub-role holds one action.
    const catalogue = [
      { key: 'counter-and-close', actions: ['pharmacy:counter', 'pharmacy:close'] as const },
      { key: 'dispense', actions: ['pharmacy:dispense'] as const },
    ];
    const partly = pharmacySubRoleStates(new Set(['pharmacy:counter']), catalogue);
    expect(partly.get('counter-and-close')).toBe('partial');
    expect(partly.get('dispense')).toBe('off');
    const whole = pharmacySubRoleStates(new Set(['pharmacy:counter', 'pharmacy:close']), catalogue);
    expect(whole.get('counter-and-close')).toBe('on');
  });
});

describe('ready-made roles are reproduced exactly by their sub-roles', () => {
  it.each(PHARMACY_ROLE_TEMPLATES.map((template) => [template.key, template] as const))(
    '%s: the ticked sub-roles hold exactly what the ABAC engine allows',
    async (_key, template) => {
      const keys = pharmacyTemplateSubRoleKeys(template.key);
      const engine = await allowedByEngine(dbFor(allow(template.capabilities)));
      expect(actionsOf(keys)).toEqual(engine);
      // Nothing half-held: a template is a whole number of sub-roles.
      const states = pharmacySubRoleStates(engine);
      expect([...states.values()]).not.toContain('partial');
      expect(pharmacyActionsAllowedByRules(allow(template.capabilities))).toEqual(engine);
    }
  );

  it('ticks the Cashier sub-roles and leaves the rest unticked', () => {
    expect(pharmacyTemplateSubRoleKeys('cashier').sort()).toEqual(
      ['customer-orders', 'do-procedures', 'take-payment'].sort()
    );
  });

  it('never ticks the exact-grant-only sub-roles from the Owner wildcard', () => {
    const owner = pharmacyTemplateSubRoleKeys('owner');
    expect(owner).toContain('run-branches');
    expect(owner).toContain('controlled-medicines');
    expect(owner).not.toContain('dispense-prescriptions');
    expect(owner).not.toContain('record-prescriptions');
    expect(owner).not.toContain('review-catalogue');
    expect(owner).not.toContain('give-discounts');
  });

  it('lets a deny win over the template, as the engine does', async () => {
    const cases: Array<{ role: Rule[]; overrides: Rule[] }> = [
      {
        role: allow(PHARMACY_ROLE_TEMPLATES.find((t) => t.key === 'owner')!.capabilities),
        overrides: [{ capability: 'pharmacy:*', effect: 'DENY' }],
      },
      {
        role: allow(PHARMACY_ROLE_TEMPLATES.find((t) => t.key === 'pharmacist')!.capabilities),
        overrides: [{ capability: 'pharmacy:dispense', effect: 'DENY' }],
      },
      {
        role: [
          ...allow(PHARMACY_ROLE_TEMPLATES.find((t) => t.key === 'cashier')!.capabilities),
          { capability: 'pharmacy:counter', effect: 'DENY' },
        ],
        overrides: [{ capability: 'pharmacy:discount', effect: 'ALLOW' }],
      },
    ];
    for (const { role, overrides } of cases) {
      const engine = await allowedByEngine(dbFor(role, overrides));
      expect(pharmacyActionsAllowedByRules([...overrides, ...role])).toEqual(engine);
    }
    const deniedOwner = await allowedByEngine(dbFor(cases[0].role, cases[0].overrides));
    expect([...deniedOwner].some((action) => action.startsWith('pharmacy:'))).toBe(false);
    // A dispense DENY also takes prescription capture away.
    const deniedPharmacist = await allowedByEngine(dbFor(cases[1].role, cases[1].overrides));
    expect(deniedPharmacist.has('pharmacy:prescriptions')).toBe(false);
    expect(deniedPharmacist.has('pharmacy:close')).toBe(true);
    const cashier = await allowedByEngine(dbFor(cases[2].role, cases[2].overrides));
    expect(cashier.has('pharmacy:counter')).toBe(false);
    expect(cashier.has('pharmacy:discount')).toBe(true);
  });

  it('types the catalogue actions as ABAC actions', () => {
    const typed: readonly Action[] = PHARMACY_SUB_ROLE_ACTIONS;
    expect(typed.length).toBe(new Set(typed).size);
  });
});
