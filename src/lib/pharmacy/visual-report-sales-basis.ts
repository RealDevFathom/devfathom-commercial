import { Prisma } from '@/generated/prisma/client';

/** Net charged line revenue. Both report queries alias the completed sale line as l. */
export const completedLineRevenue = Prisma.sql`l."grossMinor" - l."discountMinor"`;
