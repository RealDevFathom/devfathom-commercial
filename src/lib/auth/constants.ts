/**
 * Shared between the per-host credentials provider and the shared-host flow, so
 * the two cannot drift apart on the two things that must never differ: which
 * account statuses may sign in, and the timing defence.
 */

/**
 * A valid bcrypt hash of a value no one will ever submit. When a login targets a
 * missing/inactive account we still run a bcrypt comparison against this hash so
 * the response time is independent of whether the account exists — this defeats
 * the username-enumeration timing oracle.
 */
export const DUMMY_PASSWORD_HASH = '$2b$10$7Jh22HC1lxzaVDwJSaJVp./wPe52BukW8KMrtnZfsoTMNsvJxWclS';

/**
 * Account statuses permitted to authenticate. ON_LEAVE staff keep their access;
 * INACTIVE (deactivated) and INVITED (not yet onboarded) accounts are blocked.
 * Using an allow-list means any future/unknown status fails closed.
 */
export const SIGNIN_ALLOWED_STATUSES = new Set(['ACTIVE', 'ON_LEAVE']);
