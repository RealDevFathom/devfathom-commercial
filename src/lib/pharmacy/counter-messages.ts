import messages from '@/messages/en.json';

/**
 * PH-POS / UX rule 11 — the counter never shows the operator a raw reason code.
 *
 * The pharmacy aggregates raise typed errors whose `reason` IS the message the
 * router forwards, so an unmapped failure reaches the counter as
 * `INVALID_ARRANGEMENT` or `DRAWER_NOT_OPEN` — a symbol that names neither the
 * problem nor the fix. Every reason a counter action can actually raise is given
 * the sentence a pharmacist can act on.
 *
 * Pure and database-free so the mapping is testable on its own; the console
 * imports `counterErrorMessage` and never formats a failure itself.
 */

export const COUNTER_ERROR_MESSAGES: Record<string, string> = messages.CounterErrors;

/**
 * A reason code as the aggregates raise it: SCREAMING_SNAKE_CASE, no spaces.
 * Anything of this shape is an internal symbol, never operator copy.
 */
const RAW_REASON_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/** Shown when a reason is unmapped, so no code can reach the counter. */
export const COUNTER_UNKNOWN_ERROR_MESSAGE = messages.CounterErrors.UNKNOWN;

/** Shown when the failure carries nothing usable at all. */
export const COUNTER_GENERIC_ERROR_MESSAGE = messages.CounterErrors.GENERIC;

/**
 * Turn a thrown counter failure into a sentence the operator can act on.
 *
 * UX rule 11 is unconditional, so an UNMAPPED reason must still not surface as
 * a code — falling through to the raw message is what leaked `DRAWER_NOT_OPEN`
 * onto the counter during the POS browser run. The shape is therefore checked
 * rather than trusted, and only prose is ever passed through.
 */
export function counterErrorMessage(error: unknown, translate?: (key: string) => string): string {
  const text = (key: string) => (translate ? translate(key) : COUNTER_ERROR_MESSAGES[key]!);
  if (!(error instanceof Error) || !error.message) return text('GENERIC');
  if (Object.hasOwn(COUNTER_ERROR_MESSAGES, error.message)) return text(error.message);
  if (RAW_REASON_CODE.test(error.message)) return text('UNKNOWN');
  const known = Object.entries(COUNTER_ERROR_MESSAGES).find(([, value]) => value === error.message);
  return known ? text(known[0]) : error.message;
}
