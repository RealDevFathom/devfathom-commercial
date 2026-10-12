import { kdsAdvanceRoute } from '@/lib/restaurant/kds';

/**
 * POST /api/restaurant/kds/recall
 *
 * Recall a ready line back to the range (PREPARED→FIRING). Thin transport; the L2
 * `advanceItem` command validates the transition against the L1 state machine.
 */
export const POST = kdsAdvanceRoute('RECALL');
