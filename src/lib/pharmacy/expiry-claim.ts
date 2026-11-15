/**
 * DEV-728: the most stock positions one distributor expiry claim draft may carry.
 * The board sends at most this many per click (soonest expiry first); positions
 * left over go on the next claim, since drafted lots drop out of the claimable set.
 */
export const EXPIRY_CLAIM_MAX_POSITIONS = 100;
