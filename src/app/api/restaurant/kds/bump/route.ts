import { kdsAdvanceRoute } from '@/lib/restaurant/kds';

/**
 * POST /api/restaurant/kds/bump
 *
 * Bump a cooking line to ready (FIRING→PREPARED). Thin transport; a bump of a line
 * not in a legal source state is rejected by the L2 command (409) — the KDS action
 * can only ever be a legal item-domain transition.
 */
export const POST = kdsAdvanceRoute('BUMP');
