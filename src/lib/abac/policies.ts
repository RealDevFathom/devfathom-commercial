/**
 * ABAC policy catalogue — the single source of truth for "who may do what".
 *
 * Each action maps to a list of policies; access is granted if ANY policy
 * returns true (default-deny). Keep policies small and readable: they should
 * state an intent ("HR or an admin, but not against another admin") rather than
 * scatter role checks across the codebase.
 *
 * Adding a capability later = add an action + its policy here. Granting it to a
 * new role = widen the predicate. No call sites change.
 */
import type { Policy } from './types';

// Statuses that count as an active member of the company (may use the app).
// Owned by the session-state module so the API guard, the page guard, and the
// policy engine can never drift apart (#16).
export { ACTIVE_STATUSES } from '@/lib/auth/session-state';
import { ACTIVE_STATUSES } from '@/lib/auth/session-state';

export const ALL_ACTIONS = [
  'admin:access', // the legacy "is this person an admin" gate
  'hr:access', // HR console: people-ops surfaces
  'team:view', // read the team directory
  'team:layoff', // terminate / deactivate a member (resource: { targetRole })
  'team:setRole', // change a member's role (privilege escalation — admin only)
  'leave:approve', // approve/decline leave requests
  'finance:read', // view finance & invoices
  'finance:manage', // change pharmacy accounts, with a live grant or the active system Owner
  'resignation:request', // submit your own resignation
  'resignation:readAll', // see the company-wide resignation queue
  'resignation:review', // approve/decline a resignation (resource: { userId, status, targetRole })
  'staff:manage', // restaurant M2: back-office staff & operator-credential management (org-role driven)
  'devices:manage', // restaurant M2: terminal enrollment, listing, and two-person revocation
  'menu:read', // restaurant M3-L2: read canonical catalog, recipes, and costing data
  'menu:write', // restaurant M3-L2: mutate canonical catalog, recipes, and costing data
  'floor:manage', // restaurant M4-L3: floor/table/section/station configuration (org-role driven)
  // restaurant M4-L2 (COORDINATED): the order-read capability L3's floor/section/
  // station reads gate on. L2 owns this additive entry; declared here too so the
  // L3 lane compiles and tests standalone. Supervisor dedups at merge (the
  // second-merged lane realigns — same adjacency rule as the other coordinated files).
  'orders:take', // restaurant sign-in: explicit order-taking grant, no coarse-role fallback
  'orders:read', // restaurant M4-L2: order-read gate (org-role driven)
  'orders:manage', // restaurant M4-L2: order back-office mutation gate (org-role driven)
  'orders:void', // restaurant: back-office order cancel / item void gate (org-role driven)
  'catering:read',
  'catering:manage',
  'money:read', // restaurant M5-L1: back-office money reads (bills/tenders/refunds/drawers/close) — org-role driven
  // restaurant M6-L2 inventory domain capabilities (org-role driven via customDecision path):
  'inventory:read', // console reads: stock on hand, ledger, counts, transfers, batches, low-stock rules
  'inventory:adjust', // post transfers, manual corrections, sale reversals
  'inventory:waste', // post wastage, spoilage, staff-meal movements
  'inventory:count', // create/submit/post physical counts
  // Restaurant M6-L3 (COORDINATED): purchasing capabilities the M6 back-office
  // surfaces enforce. Reads gate on `inventory:read`, declared once by L2 above;
  // L3 owns `purchasing:create`/`purchasing:approve`. The supervisor deduped L3's
  // coordinated `inventory:read` overlap at merge (same adjacency rule as `_app.ts`
  // and the M4 `orders:read` coordination above).
  'purchasing:create', // restaurant M6-L3: supplier/PO/receiving mutations — org-role driven
  'purchasing:approve', // restaurant M6-L3: purchase-order approval transition — org-role driven
  // Restaurant M7-L2: scheduler/outbox/webhook-inbox operations console — queue
  // browse, execution history, dead-letter review + requeue. Org-role driven via
  // the existing `reports:operational` capability (already in the vertical-catalog
  // role templates: general-manager, financial-controller, sop-compliance-auditor).
  'reports:operational', // restaurant M7-L2: background-ops read/requeue console — org-role driven
  'sop:manage', // restaurant M7-L3: SOP authoring console — templates/versions/steps/assignments/schedule preview (org-role driven)
  'sop:complete', // restaurant M7-L4: SOP occurrence execution (start/complete-step/submit) — org-role driven
  'sop:verify', // restaurant M7-L4: SOP verification decisions (VERIFY/REJECT/WAIVE) — org-role driven
  'customers:read', // restaurant M8: customer profile/interaction/consent reads — org-role driven
  'customers:manage', // restaurant customer mutations and full-profile export — org-role driven
  'loyalty:redeem', // restaurant M8: loyalty redemption — org-role driven
  'reports:financial', // restaurant M8: financial reports and exports — org-role driven
  'workforce:rates', // restaurant M8: restricted labour-cost facts — org-role driven, default deny
  'restaurant:configure', // restaurant M8: loyalty configuration and consolidated access — org-role driven
  'menu:import', // R-lane WHA-194: OCR menu import — upload, review queue, confirmed catalog import
  'pharmacy:counter',
  'pharmacy:close',
  'pharmacy:manage',
  'pharmacy:procurement',
  // PUR-02: approve and send a purchase order. Separate from raising one, so the
  // approver is a manager or owner and never just whoever can create orders.
  'pharmacy:procurement-approve',
  'pharmacy:inventory',
  'pharmacy:dispense', // RX-03/04: pharmacist decisions and substitution evidence
  'pharmacy:prescriptions', // prescription workspace/files: pharmacist or tenant administrator
  'pharmacy:safety', // RX-05: controlled register and incident approval
  'pharmacy:catalogue-review', // MED-06: confirm or reject regulated connector proposals
  // DEV-19: submit catalogue edits (new ingredients and medicines, packs, MRPs,
  // barcodes, aliases) to the review queue. Deny by default.
  'pharmacy:catalogue-edit',
  'pharmacy:orders', // MKT-03/05: staff acceptance and fulfilment of customer proposals
  // DEV-66: give a counter discount (up to the owner's maximum) without a manager's PIN.
  'pharmacy:discount',
  // H1-01: hospitality capabilities use explicit organization-role grants.
  // Property scope is enforced separately by the consuming procedures.
  'hotel:reservations',
  'hotel:front-desk',
  'hotel:folio',
  'hotel:folio-adjust',
  'hotel:payments',
  'hotel:refunds',
  'hotel:rates',
  'hotel:availability-override',
  'hotel:housekeeping',
  'hotel:night-audit',
  'hotel:guest-identity',
  'hotel:reports-financial',
  'hotel:channels',
  'hotel:property-admin',
  'hotel:marketing',
  'hotel:agents',
  'hotel:banquets',
  'hotel:maintenance',
  'hotel:api-admin',
] as const;

export type Action = (typeof ALL_ACTIONS)[number];

const isAdmin: Policy = ({ subject }) => subject.role === 'ADMIN';
const isHrOrAdmin: Policy = ({ subject }) => subject.role === 'ADMIN' || subject.role === 'HR';
// #16: fail closed. A subject whose status is unknown is not a proven active
// member, and every caller now resolves its subject from a session that has
// already passed `evaluateSessionUser`, so a missing status means something
// upstream is wrong — not that the member is fine.
const isActiveMember: Policy = ({ subject }) =>
  Boolean(subject.status) && ACTIVE_STATUSES.has(subject.status!);

// Mandatory resource constraints apply before either persisted capabilities or
// static policies can grant access. A capability establishes action eligibility,
// but cannot authorize an invalid resource or state transition.
export const RESOURCE_CONSTRAINTS: Partial<Record<Action, Policy>> = {
  'resignation:review': ({ subject, resource }) =>
    resource?.type === 'Resignation' &&
    resource.status === 'PENDING' &&
    typeof resource.userId === 'string' &&
    resource.userId.length > 0 &&
    resource.userId !== subject.id &&
    typeof resource.targetRole === 'string' &&
    resource.targetRole.length > 0 &&
    !(subject.role === 'HR' && resource.targetRole === 'ADMIN'),
};

export const POLICIES: Record<Action, Policy[]> = {
  // ── Coarse role gates (back the tRPC procedures) ──────────────────────────
  'admin:access': [isAdmin],
  'hr:access': [isHrOrAdmin],
  'finance:manage': [], // Only a persisted grant or the active system Owner can change pharmacy accounts.
  'finance:read': [isAdmin], // HR does NOT get finance
  'team:view': [isActiveMember],
  'team:setRole': [isAdmin], // only admins may grant/revoke roles
  'leave:approve': [isHrOrAdmin],
  'resignation:readAll': [isHrOrAdmin],

  // ── Attribute-conditioned policies ────────────────────────────────────────
  // Admins or HR may lay someone off — but HR may not lay off an admin.
  'team:layoff': [
    isAdmin,
    ({ subject, resource }) => subject.role === 'HR' && resource?.targetRole !== 'ADMIN',
  ],

  // Any currently-employed member may resign.
  'resignation:request': [isActiveMember],

  // Default eligibility is HR/admin. RESOURCE_CONSTRAINTS enforces PENDING,
  // non-self review and the HR/admin target boundary for every grant source.
  'resignation:review': [isHrOrAdmin],

  // Restaurant M2 (§8): staff & operator-credential management is granted through
  // an organization role/override carrying the `staff:manage` capability (or `*`,
  // e.g. the restaurant Owner template), evaluated by the DB `customDecision` path
  // in `can()` — not by a coarse agency role. No static policy is registered, so a
  // subject without an explicit grant is denied by default. A restaurant General
  // Manager granted `staff:manage` is therefore authorized without being a global
  // platform ADMIN, and an agency admin is not implicitly granted a restaurant
  // capability.
  'staff:manage': [],
  'devices:manage': [],

  // Restaurant M3-L2: canonical catalog + costing substrate. Granted through
  // an organization role carrying `menu:read` or `menu:write` (or `*`), evaluated
  // by the DB `customDecision` path — no static agency-role policy.
  'menu:read': [],
  'menu:write': [],

  // Restaurant M4: floor configuration (`floor:manage`, M4-L3) and order reads
  // (`orders:read`, coordinated with L2). Both are org-role-driven — granted
  // through an organization role/override carrying the capability (or `*`),
  // evaluated by the DB `customDecision` path in `can()`; no static agency-role
  // policy, so a subject without an explicit grant is denied by default.
  'floor:manage': [],
  'orders:take': [],
  'orders:read': [],
  'orders:manage': [],
  // Back-office order cancellation and item voids gate on the same `orders:void`
  // capability the restaurant role templates (General Manager, Branch Manager)
  // already grant — not on the Owner-only `orders:manage`. Org-role-driven, no
  // static agency-role policy, so it is default-deny without an explicit grant.
  'orders:void': [],
  'catering:read': [],
  'catering:manage': [],

  // Restaurant M5-L1: back-office money reads (bills/splits/comps, tenders +
  // refunds with payment event trails, drawer-session review, daily-close
  // review). Granted through an organization role/override carrying `money:read`
  // (or `*`), evaluated by the DB `customDecision` path in `can()`; no static
  // agency-role policy, so a subject without an explicit grant is denied by
  // default. Terminal money mutations gate on the existing pos/payments/cash
  // capabilities, not on this back-office read action (C11).
  'money:read': [],

  // Restaurant M6-L2 inventory console capabilities. All four are org-role-driven
  // — granted through an organization role/override carrying the capability (or
  // `*`), evaluated by the DB `customDecision` path; no static agency-role policy.
  'inventory:read': [],
  'inventory:adjust': [],
  'inventory:waste': [],
  'inventory:count': [],
  // Restaurant M6-L3: purchasing back-office capabilities. Granted through an
  // organization role/override carrying the capability (or `*`, e.g. the restaurant
  // Owner or Purchasing Officer templates), evaluated by the DB `customDecision`
  // path in `can()`; no static agency-role policy, so a subject without an explicit
  // grant is denied by default (COORDINATED with L2 — reads gate on `inventory:read`,
  // declared once above; the supervisor deduped L3's `inventory:read` overlap).
  'purchasing:create': [],
  'purchasing:approve': [],

  // Restaurant M7-L2: background-operations console (scheduler queue, execution
  // history, dead-letter + requeue, outbox status, webhook inbox). Granted through
  // an organization role/override carrying `reports:operational` (or `*`), evaluated
  // by the DB `customDecision` path in `can()`; no static agency-role policy, so a
  // subject without an explicit grant is denied by default.
  'reports:operational': [],
  // Restaurant M7-L3: SOP authoring console (templates, versions, steps, branch
  // assignments, schedule preview). Granted through an organization role/override
  // carrying `sop:manage` (or `*`, e.g. the restaurant Owner or SOP/Compliance
  // Auditor templates in vertical-catalog), evaluated by the DB `customDecision`
  // path in `can()`; no static agency-role policy, so a subject without an
  // explicit grant is denied by default.
  'sop:manage': [],
  // restaurant M7-L4: SOP execution — org-role-driven, no static agency-role policy.
  'sop:complete': [],
  // restaurant M7-L4: SOP verification decisions — org-role-driven, no static agency-role
  // policy (default-deny without an explicit grant via customDecision path).
  'sop:verify': [],
  // Restaurant M8 capabilities use the existing organization-role
  // customDecision path. Empty static policies preserve default deny; labour
  // cost requires BOTH reports:financial and workforce:rates at the report gate.
  'customers:read': [],
  'customers:manage': [],
  'loyalty:redeem': [],
  'reports:financial': [],
  'workforce:rates': [],
  'restaurant:configure': [],

  // R-lane WHA-194: OCR menu import. Held separate from `menu:write` on purpose
  // — importing a menu creates products, categories and draft prices in bulk
  // from untrusted OCR output, which is a strictly larger blast radius than
  // editing one dish. Org-role-driven through the DB `customDecision` path with
  // no static agency-role policy, so it is DEFAULT DENY until an organization
  // grants it explicitly (or holds `*`, e.g. the restaurant Owner template).
  'menu:import': [],
  'pharmacy:counter': [],
  'pharmacy:close': [],
  'pharmacy:manage': [],
  // Tenant administrators without an assigned organization role retain the
  // purchasing and Goods-in access they had before pharmacy capabilities became
  // explicit (#375). `can()` prevents an assigned role with no matching grant
  // from falling through to this policy, and resolves a custom DENY first.
  'pharmacy:procurement': [isAdmin],
  // Purchase-order approval follows the same rule: the Manager template grants
  // it explicitly, `pharmacy:*` (Owner) covers it, and a tenant administrator
  // without an organization role (the solo owner) holds it directly. `can()`
  // keeps an assigned role without the grant from falling through to this policy.
  'pharmacy:procurement-approve': [isAdmin],
  'pharmacy:inventory': [],
  // Dispensing is an exact-grant-only action: tenant administration alone is
  // insufficient, and wildcard ALLOW rules cannot opt a user in. Wildcard DENY
  // rules are still resolved by `can()` before this default-deny policy.
  'pharmacy:dispense': [],
  // Prescription capture is also an administrative records workflow. Unlike
  // dispensing, tenant administrators may enter it without receiving the
  // broader pharmacist capability. The ABAC engine aliases dispense rules to
  // this action so an explicit dispense DENY still vetoes this fallback.
  'pharmacy:prescriptions': [isAdmin],
  'pharmacy:safety': [],
  'pharmacy:catalogue-review': [],
  // DEV-19: like procurement approval, the tenant-admin fallback reaches only an
  // administrator without an organization role (`can()` keeps an assigned role
  // without the grant from falling through). `pharmacy:*` (Owner) and the Owner /
  // Operator template grant it; every other role is refused unless granted.
  'pharmacy:catalogue-edit': [isAdmin],
  'pharmacy:orders': [],
  // DEV-66: by default a discount needs a manager's PIN. The owner may grant this to any
  // role (the Cashier included) by its exact name; no wildcard and no static policy
  // grants it, so nobody skips the manager's approval unless the owner chose them.
  'pharmacy:discount': [],

  // H1-01: no static agency-role policy grants hospitality capabilities.
  // Explicit capabilities and wildcards use the existing customDecision path.
  'hotel:reservations': [],
  'hotel:front-desk': [],
  'hotel:folio': [],
  'hotel:folio-adjust': [],
  'hotel:payments': [],
  'hotel:refunds': [],
  'hotel:rates': [],
  'hotel:availability-override': [],
  'hotel:housekeeping': [],
  'hotel:night-audit': [],
  'hotel:guest-identity': [],
  'hotel:reports-financial': [],
  'hotel:channels': [],
  'hotel:property-admin': [],
  'hotel:marketing': [],
  'hotel:agents': [],
  'hotel:banquets': [],
  'hotel:maintenance': [],
  'hotel:api-admin': [],
};
