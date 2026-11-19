/**
 * DEV-959A — the pharmacy sub-role catalogue.
 *
 * A sub-role is a named group of ABAC actions, in plain words, that an owner can read
 * (and, in a later phase, tick) on the team screen. Every pharmacy action belongs to
 * exactly one sub-role, and each sub-role sits under the ready-made role it normally
 * comes with. Sub-roles are display data only: they never grant anything. Which ones a
 * ready-made role has is derived from its real template in `vertical-catalog.ts` with the
 * same rule evaluator the ABAC engine uses (`decideFromRules`), never hand-copied.
 */
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { EXACT_GRANT_ONLY_ACTIONS, decideFromRules } from './capabilities';
import type { Action } from './policies';

export type PharmacySubRoleDefinition = {
  key: string;
  label: string;
  /** One plain line saying what the sub-role allows. */
  description: string;
  /** Key of the ready-made role (template) this sub-role normally comes with. */
  homeRole: string;
  actions: readonly Action[];
};

export type PharmacySubRole = PharmacySubRoleDefinition & {
  /** Carries extra weight: contains an action no wildcard grant ever reaches. */
  sensitive: boolean;
};

const DEFINITIONS: readonly PharmacySubRoleDefinition[] = [
  {
    key: 'take-payment',
    label: 'Take payment',
    description: 'Sell at the counter, take payment, open the cash drawer and use khata.',
    homeRole: 'cashier',
    actions: ['pharmacy:counter'],
  },
  {
    key: 'customer-orders',
    label: 'Handle customer orders',
    description: 'Accept and fulfil orders customers send in.',
    homeRole: 'cashier',
    actions: ['pharmacy:orders'],
  },
  {
    // DEV-66: no ready-made role holds it; the owner grants it by name.
    key: 'give-discounts',
    label: 'Give discounts',
    description: 'Give a discount, up to the owner’s maximum, without a manager’s PIN.',
    homeRole: 'cashier',
    actions: ['pharmacy:discount'],
  },
  {
    key: 'do-procedures',
    label: 'Do procedure checklists',
    description: 'Work through the daily procedure checklists assigned to them.',
    homeRole: 'cashier',
    actions: ['sop:complete'],
  },
  {
    key: 'dispense-prescriptions',
    label: 'Dispense prescriptions',
    description: 'Check and dispense prescriptions and record substitutions as a pharmacist.',
    homeRole: 'pharmacist',
    actions: ['pharmacy:dispense'],
  },
  {
    key: 'record-prescriptions',
    label: 'Record prescriptions',
    description: 'Enter prescriptions and keep their files. Dispensing includes this.',
    homeRole: 'pharmacist',
    actions: ['pharmacy:prescriptions'],
  },
  {
    key: 'review-catalogue',
    label: 'Approve medicine catalogue changes',
    description: 'Confirm or reject proposed changes to regulated medicine records.',
    homeRole: 'pharmacist',
    actions: ['pharmacy:catalogue-review'],
  },
  {
    key: 'close-the-day',
    label: 'Close the day',
    description: 'Close the day for every branch of the pharmacy.',
    homeRole: 'pharmacist',
    actions: ['pharmacy:close'],
  },
  {
    key: 'run-branches',
    label: 'Run their branches',
    description: 'Refunds with a PIN, day close and operational reports for their branches.',
    homeRole: 'manager',
    actions: ['pharmacy:manage'],
  },
  {
    key: 'approve-purchase-orders',
    label: 'Approve purchase orders',
    description: 'Approve and send purchase orders that someone else raised.',
    homeRole: 'manager',
    actions: ['pharmacy:procurement-approve'],
  },
  {
    key: 'set-up-procedures',
    label: 'Set up procedures',
    description: 'Write procedure checklists and assign them to branches.',
    homeRole: 'manager',
    actions: ['sop:manage'],
  },
  {
    key: 'check-procedures',
    label: 'Check procedure checklists',
    description: 'Verify, reject or waive checklists that others completed.',
    homeRole: 'manager',
    actions: ['sop:verify'],
  },
  {
    key: 'receive-stock',
    label: 'Order and receive stock',
    description: 'Raise purchase orders, deal with suppliers and receive deliveries.',
    homeRole: 'procurement',
    actions: ['pharmacy:procurement'],
  },
  {
    key: 'manage-stock',
    label: 'Manage stock',
    description: 'Count stock, move it between branches and correct stock levels.',
    homeRole: 'inventory',
    actions: ['pharmacy:inventory'],
  },
  {
    key: 'financial-reports',
    label: 'See financial reports',
    description: 'Open the money reports: sales value, margins and statements.',
    homeRole: 'finance',
    actions: ['reports:financial'],
  },
  {
    key: 'operational-reports',
    label: 'See operational reports',
    description: 'Open the Reports centre for every branch.',
    homeRole: 'auditor',
    actions: ['reports:operational'],
  },
  {
    key: 'controlled-medicines',
    label: 'Controlled medicines and safety',
    description: 'Keep the controlled medicines register and approve safety reports.',
    homeRole: 'owner',
    actions: ['pharmacy:safety'],
  },
  {
    key: 'suggest-catalogue-edits',
    label: 'Suggest medicine catalogue changes',
    description: 'Submit new medicines, packs, prices and barcodes for review.',
    homeRole: 'owner',
    actions: ['pharmacy:catalogue-edit'],
  },
];

export const PHARMACY_SUB_ROLES: readonly PharmacySubRole[] = DEFINITIONS.map((definition) => ({
  ...definition,
  sensitive: definition.actions.some((action) => EXACT_GRANT_ONLY_ACTIONS.has(action)),
}));

/** Every action the pharmacy sub-roles cover, in catalogue order. */
export const PHARMACY_SUB_ROLE_ACTIONS: readonly Action[] = PHARMACY_SUB_ROLES.flatMap(
  (subRole) => subRole.actions
);

/** The order in which role groups are shown; names come from the real templates. */
const GROUP_ORDER = [
  'cashier',
  'pharmacist',
  'manager',
  'procurement',
  'inventory',
  'finance',
  'auditor',
  'owner',
] as const;

export type PharmacySubRoleState = 'on' | 'off' | 'partial';

export type PharmacySubRoleGroup = {
  roleKey: string;
  roleName: string;
  subRoles: Array<PharmacySubRole & { state: PharmacySubRoleState }>;
};

function templateName(key: string): string {
  return PHARMACY_ROLE_TEMPLATES.find((template) => template.key === key)?.name ?? key;
}

/** Ticks each sub-role whose actions are all in `allowed`; some of them is `partial`. */
export function pharmacySubRoleStates(
  allowed: ReadonlySet<string>
): Map<string, PharmacySubRoleState> {
  return new Map(
    PHARMACY_SUB_ROLES.map((subRole) => {
      const held = subRole.actions.filter((action) => allowed.has(action)).length;
      const state: PharmacySubRoleState =
        held === 0 ? 'off' : held === subRole.actions.length ? 'on' : 'partial';
      return [subRole.key, state];
    })
  );
}

/** All sub-roles grouped under their usual role, ticked from the allowed actions. */
export function pharmacySubRoleGroups(allowed: ReadonlySet<string>): PharmacySubRoleGroup[] {
  const states = pharmacySubRoleStates(allowed);
  return GROUP_ORDER.map((roleKey) => ({
    roleKey,
    roleName: templateName(roleKey),
    subRoles: PHARMACY_SUB_ROLES.filter((subRole) => subRole.homeRole === roleKey).map(
      (subRole) => ({ ...subRole, state: states.get(subRole.key) ?? 'off' })
    ),
  }));
}

/** The catalogue actions a set of persisted rules allows on its own (deny wins). */
export function pharmacyActionsAllowedByRules(
  rules: readonly { capability: string; effect: string }[]
): Set<Action> {
  return new Set(
    PHARMACY_SUB_ROLE_ACTIONS.filter((action) => decideFromRules(rules, action) === true)
  );
}

/** Keys of the sub-roles a ready-made pharmacy role has, from its real template. */
export function pharmacyTemplateSubRoleKeys(roleKey: string): string[] {
  const template = PHARMACY_ROLE_TEMPLATES.find((candidate) => candidate.key === roleKey);
  if (!template) return [];
  const allowed = pharmacyActionsAllowedByRules(
    template.capabilities.map((capability) => ({ capability, effect: 'ALLOW' }))
  );
  const states = pharmacySubRoleStates(allowed);
  return PHARMACY_SUB_ROLES.filter((subRole) => states.get(subRole.key) === 'on').map(
    (subRole) => subRole.key
  );
}
