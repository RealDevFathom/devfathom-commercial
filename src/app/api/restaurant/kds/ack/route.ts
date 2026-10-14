import { kdsAdvanceRoute } from '@/lib/restaurant/kds';

/**
 * POST /api/restaurant/kds/ack
 *
 * Acknowledge a queued line and start cooking it (QUEUED→FIRING). Thin transport;
 * the L2 `advanceItem` command validates the transition against the L1 state machine.
 */
export const POST = kdsAdvanceRoute('ACK');
