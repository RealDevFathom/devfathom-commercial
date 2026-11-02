import 'server-only';

import { publicProcedure, router } from '@/server/trpc';
import { readMonthlyAIUsage } from '@/lib/ai/usage';

/**
 * Platform AI spend report. A public procedure on purpose: the tenant tRPC
 * context is never trusted here. readMonthlyAIUsage authenticates the platform
 * session itself and allows SUPER_ADMIN only.
 */
export const platformAIUsageRouter = router({
  currentMonth: publicProcedure.query(() => readMonthlyAIUsage()),
});
