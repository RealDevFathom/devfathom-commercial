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
