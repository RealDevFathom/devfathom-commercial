/**
 * Server-owned ceiling on the stock-count variance threshold, in units. Kept free of
 * server imports so settings UI can show the same bound. The organizations CHECK
 * constraint (migration 20261106230000) mirrors this value.
 */
export const PHARMACY_COUNT_MAX_VARIANCE_THRESHOLD_UNITS = 10;
