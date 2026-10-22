import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getOrderSettlementForBranch, moneyReadRoute } from '@/lib/restaurant/checkout-routes';
import { readAIConfig } from '@/lib/ai/provider';
import { getTierForFeature } from '@/lib/ai/tiers';
import { emptyUpsellEngine, type UpsellEnginePort } from '@/lib/ai/shared/upsell-engine.types';
import { recordAudit } from '@/server/audit';

const query = z.object({ orderId: z.string().min(1) });

/** Replaced by the engine lane when it lands; keeping the port injectable makes that merge local. */
export let upsellEngine: UpsellEnginePort = emptyUpsellEngine;
export function setUpsellEngineForTest(engine: UpsellEnginePort) {
  upsellEngine = engine;
}

function aiIsConfigured() {
  try {
    readAIConfig();
    return true;
  } catch {
    return false;
  }
}

/**
 * GET /api/restaurant/checkout/summary?orderId=…
 *
 * The order's settlement state for the register (C12 read contract, consumed by L7a):
 * the derived order total, the accounted total, each live bill's status/total/receipt
 * number, any unbilled items, and whether the order is fully settled (+ the first
 * blocker). Scoped to the device's branch — a cross-branch/cross-tenant id is a 404.
 * Gated on `payments:collect`.
 */
export const GET = moneyReadRoute({
  capability: 'payments:collect',
  run: async (ctx, request) => {
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'A non-empty orderId query is required.' },
        { status: 400 }
      );
    }
    const summary = await getOrderSettlementForBranch(
      ctx.db,
      parsed.data.orderId,
      ctx.device.branchId
    );
    if (!summary) return NextResponse.json({ error: 'The order does not exist.' }, { status: 404 });

    // This is intentionally a server-only gate. A client flag must never reveal or enable AI.
    const organization = await ctx.db.organization.findUnique({
      where: { id: ctx.organizationId },
      select: { id: true, askFathomEnabled: true },
    });
    if (
      organization?.id !== ctx.organizationId ||
      organization.askFathomEnabled !== true ||
      !aiIsConfigured()
    ) {
      return NextResponse.json({ ...summary, aiUpsell: null });
    }

    const tier = getTierForFeature('restaurant-growth');
    const result = await upsellEngine.suggest({
      organizationId: ctx.organizationId,
      branchId: ctx.device.branchId,
      orderId: parsed.data.orderId,
    });
    if (result.tier !== tier) throw new Error('The upsell engine returned an invalid AI tier.');

    if (result.suggestion) {
      await recordAudit(
        {
          organizationId: ctx.organizationId,
          actorType: 'RESTAURANT_OPERATOR',
          actorStaffProfileId: ctx.session.activeStaffProfileId,
          source: 'SYSTEM',
          category: 'AI',
          operation: 'READ',
          action: 'ai.restaurant.checkout-upsell',
          description: 'Generated a checkout upsell suggestion.',
          targetType: 'RestaurantOrder',
          targetId: parsed.data.orderId,
          changes: { before: null, after: result.suggestion },
          metadata: { model: result.model, tier: result.tier },
        },
        ctx.db
      );
    }
    return NextResponse.json({ ...summary, aiUpsell: result.suggestion });
  },
});
