/**
 * DEV-743: the one timeout configuration for integrated card-terminal calls. The counter router,
 * the recovery sweep and the service default all read it, so an attempt is judged by the same
 * clock wherever it is recovered: how long a charge or status query may take before its outcome
 * counts as UNKNOWN, how long a CREATED attempt may wait before it is closed unsent, and (at
 * twice this) how long a NOT_FOUND answer still means "maybe".
 *
 * It stays inside the 60-second request transaction (`src/app/api/trpc/[trpc]/route.ts`), so the
 * counter always gets an answer and an UNKNOWN outcome is resolved by a status check.
 */
export const CARD_TERMINAL_TIMEOUT_MS = 45_000;

/**
 * An attempt untouched this long is the recovery sweep's to recover; the counter owns a fresher
 * one. Always longer than one terminal call, so the sweep never queries a charge the counter is
 * still waiting on.
 */
export const CARD_TERMINAL_STALE_AFTER_MS = 2 * 60_000;
