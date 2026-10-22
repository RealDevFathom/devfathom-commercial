import 'server-only';

import { publicProcedure, router } from '@/server/trpc';
import { readMonthlyAIUsage } from '@/lib/ai/usage';

export const platformAIUsageRouter = router({
  currentMonth: publicProcedure.query(() => readMonthlyAIUsage()),
});
