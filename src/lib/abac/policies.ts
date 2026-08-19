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
  'resignation:request', // submit your own resignation
  'resignation:readAll', // see the company-wide resignation queue
  'resignation:review', // approve/decline a resignation (resource: { userId, status, targetRole })
  'staff:manage', // restaurant M2: back-office staff & operator-credential management (org-role driven)
  'menu:read', // restaurant M3-L2: read canonical catalog, recipes, and costing data
  'menu:write', // restaurant M3-L2: mutate canonical catalog, recipes, and costing data
  'floor:manage', // restaurant M4-L3: floor/table/section/station configuration (org-role driven)
  // restaurant M4-L2 (COORDINATED): the order-read capability L3's floor/section/
  // station reads gate on. L2 owns this additive entry; declared here too so the
  // L3 lane compiles and tests standalone. Supervisor dedups at merge (the
  // second-merged lane realigns — same adjacency rule as the other coordinated files).
  'orders:read', // restaurant M4-L2: order-read gate (org-role driven)
  'orders:manage', // restaurant M4-L2: order back-office mutation gate (org-role driven)
  'money:read', // restaurant M5-L1: back-office money reads (bills/tenders/refunds/drawers/close) — org-role driven
  // restaurant M6-L2 inventory domain capabilities (org-role driven via customDecision path):
  'inventory:read',   // console reads: stock on hand, ledger, counts, transfers, batches, low-stock rules
  'inventory:adjust', // post transfers, manual corrections, sale reversals
  'inventory:waste',  // post wastage, spoilage, staff-meal movements
  'inventory:count',  // create/submit/post physical counts
  // Restaurant M6 (COORDINATED): the inventory/purchasing capabilities the M6
  // back-office surfaces enforce. L2 (inventory ops) and L3 (purchasing) both
  // gate reads on `inventory:read`; L3 owns `purchasing:create`/`purchasing:approve`.
  // Each lane declares the entries it needs so it compiles and tests standalone;
  // the supervisor dedups the `inventory:read` overlap at merge (same adjacency
  // rule as `_app.ts` and the M4 `orders:read` coordination above).
  'inventory:read', // restaurant M6: back-office inventory/purchasing reads — org-role driven
  'purchasing:create', // restaurant M6-L3: supplier/PO/receiving mutations — org-role driven
  'purchasing:approve', // restaurant M6-L3: purchase-order approval transition — org-role driven
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

export const POLICIES: Record<Action, Policy[]> = {
  // ── Coarse role gates (back the tRPC procedures) ──────────────────────────
  'admin:access': [isAdmin],
  'hr:access': [isHrOrAdmin],
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

  // Reviewing a resignation requires HR/admin, a still-PENDING request, that it
  // isn't your own, and — for HR reviewers — that the resignee isn't an admin
  // (an admin's departure is reviewed by another admin).
  'resignation:review': [
    ({ subject, resource }) =>
      (subject.role === 'ADMIN' || subject.role === 'HR') &&
      resource?.status === 'PENDING' &&
      resource?.userId !== subject.id &&
      !(subject.role === 'HR' && resource?.targetRole === 'ADMIN'),
  ],

  // Restaurant M2 (§8): staff & operator-credential management is granted through
  // an organization role/override carrying the `staff:manage` capability (or `*`,
  // e.g. the restaurant Owner template), evaluated by the DB `customDecision` path
  // in `can()` — not by a coarse agency role. No static policy is registered, so a
  // subject without an explicit grant is denied by default. A restaurant General
  // Manager granted `staff:manage` is therefore authorized without being a global
  // platform ADMIN, and an agency admin is not implicitly granted a restaurant
  // capability.
  'staff:manage': [],

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
  'orders:read': [],
  'orders:manage': [],

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
  // Restaurant M6: inventory/purchasing back-office capabilities. Granted through
  // an organization role/override carrying the capability (or `*`, e.g. the
  // restaurant Owner or Purchasing Officer templates), evaluated by the DB
  // `customDecision` path in `can()`; no static agency-role policy, so a subject
  // without an explicit grant is denied by default (COORDINATED with L2 — see the
  // ALL_ACTIONS note above; the supervisor dedups the `inventory:read` overlap).
  'inventory:read': [],
  'purchasing:create': [],
  'purchasing:approve': [],
};
