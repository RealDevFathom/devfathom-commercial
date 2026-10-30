import { NextResponse } from 'next/server';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { z } from 'zod';

import { pharmacyLoyaltyRouter } from '@/app/(app)/pharmacy/loyalty/loyalty-router';
import { createTRPCContext } from '@/server/trpc';

const bodySchema = z
  .object({
    branchId: z.string().trim().min(1).max(128),
    preferredLanguage: z.enum(['en', 'ur']),
  })
  .strict();

/** Sets the English/Urdu language used by this customer's WhatsApp reminders. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ customerId: string }> }
) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });

  try {
    const caller = pharmacyLoyaltyRouter.createCaller(await createTRPCContext({ req: request }));
    return NextResponse.json(
      await caller.setPreferredLanguage({
        customerId: (await params).customerId,
        ...parsed.data,
      })
    );
  } catch (error) {
    if (error instanceof TRPCError) {
      const status = getHTTPStatusCodeFromError(error);
      return NextResponse.json({ error: 'Customer language could not be updated.' }, { status });
    }
    throw error;
  }
}
