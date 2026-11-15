/**
 * DEV-751 — pharmacy SOP values shared by the router and the Procedures
 * workspace. Client-safe: no server imports.
 */

/**
 * Upper bounds the router accepts for a schedule's window and grace, in
 * minutes (matching the restaurant SOP router). The schedule form checks the
 * same bounds before it sends anything.
 */
export const PHARMACY_SOP_SCHEDULE_LIMITS = {
  windowMinutes: 1440,
  graceMinutes: 1440,
} as const;

/**
 * The fixed wording of the PRECONDITION_FAILED refusal for a session user with
 * no active staff profile. The workspace recognises it to offer "Set up my
 * procedures profile" instead of a dead end.
 */
export const PHARMACY_SOP_NO_STAFF_PROFILE_MESSAGE =
  'Set up your procedures profile at this branch before taking part in procedures.';

/**
 * The fixed wording of a CONFLICT refusal when the procedure moved on (sent
 * for review, checked, sent back) since the person opened it. The router and
 * the proof upload route both answer with it; the runner re-reads the
 * procedure when it sees it.
 */
export const PHARMACY_SOP_CHANGED_MESSAGE =
  'This procedure has changed since you opened it. Refresh to see its current state.';

/**
 * Overdue escalation (opt-in per branch, OFF by default): how long after a
 * procedure's window closes, unsubmitted, before the chosen manager is told in
 * the app. The router and the Setup form accept the same bounds.
 */
export const PHARMACY_SOP_ESCALATION_DELAY = {
  defaultMinutes: 30,
  minMinutes: 0,
  maxMinutes: 1440,
} as const;
