'use server';

import { TRPCError } from '@trpc/server';
import { ZodError } from 'zod';
import { createTRPCContext } from '@/server/trpc';
import { appRouter } from '@/server/routers/_app';
import {
  growthReadInput,
  growthReviewInput,
  type GrowthView,
} from '@/lib/restaurant/growth-review-contract';

export async function loadGrowthReview(raw: unknown): Promise<GrowthView> {
  const input = growthReadInput.safeParse(raw);
  if (!input.success) return { status: 'INVALID' };
  try {
    return await appRouter
      .createCaller(await createTRPCContext())
      .restaurantGrowth.read(input.data);
  } catch (error) {
    return {
      status:
        error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code)
          ? 'DENIED'
          : 'UNAVAILABLE',
    };
  }
}
export async function submitGrowthReview(raw: unknown): Promise<GrowthView> {
  const input = growthReviewInput.parse(raw);
  return appRouter.createCaller(await createTRPCContext()).restaurantGrowth.review(input);
}

export async function listGrowth(raw: unknown) {
  const { growthListInput } = await import('@/lib/restaurant/growth-generation');
  try {
    return await appRouter
      .createCaller(await createTRPCContext())
      .restaurantGrowth.list(growthListInput.parse(raw));
  } catch {
    return { status: 'UNAVAILABLE' as const };
  }
}
export async function listGrowthBranches() {
  return appRouter.createCaller(await createTRPCContext()).restaurantGrowth.branches();
}
export async function generateGrowth(raw: unknown) {
  const { growthGenerateInput } = await import('@/lib/restaurant/growth-generation');
  try {
    const result = await appRouter
      .createCaller(await createTRPCContext())
      .restaurantGrowth.generate(growthGenerateInput.parse(raw));
    return { status: 'SAVED' as const, result };
  } catch (error) {
    if (error instanceof ZodError)
      return {
        status: 'INVALID' as const,
        message: 'Choose an ordered date range containing no more than 45 calendar dates.',
      };
    if (error instanceof TRPCError && error.code === 'BAD_REQUEST')
      return { status: 'INVALID' as const, message: error.message };
    throw error;
  }
}
