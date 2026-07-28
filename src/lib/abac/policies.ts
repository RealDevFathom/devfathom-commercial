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
export const ACTIVE_STATUSES = new Set(['ACTIVE', 'ON_LEAVE']);

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
] as const;

export type Action = (typeof ALL_ACTIONS)[number];

const isAdmin: Policy = ({ subject }) => subject.role === 'ADMIN';
const isHrOrAdmin: Policy = ({ subject }) => subject.role === 'ADMIN' || subject.role === 'HR';
const isActiveMember: Policy = ({ subject }) =>
  !subject.status || ACTIVE_STATUSES.has(subject.status);

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
};
