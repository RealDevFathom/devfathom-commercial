import 'server-only';

import { DEMO_RESET_JOB_TYPE } from '@/lib/restaurant/scheduler';
import { demoResetJobHandler } from '@/lib/demo/jobs';
import {
  MENU_IMPORT_EXTRACT_JOB,
  menuImportExtractHandler,
} from '@/lib/restaurant/menu-import-legacy';
import {
  coreRestaurantJobHandlers,
  resolveRestaurantJobHandler as resolveHandler,
  runRestaurantJob as runJob,
  type RestaurantJobContext,
  type RestaurantJobHandler,
} from '@/lib/restaurant/job-handlers-core';

export type {
  RestaurantJobContext,
  RestaurantJobHandler,
} from '@/lib/restaurant/job-handlers-core';

/** Legacy composition keeps demo reset registered for its authenticated cron. */
export const restaurantJobHandlers: Record<string, RestaurantJobHandler> = {
  ...coreRestaurantJobHandlers,
  [MENU_IMPORT_EXTRACT_JOB]: menuImportExtractHandler,
  [DEMO_RESET_JOB_TYPE]: demoResetJobHandler,
};

export function resolveRestaurantJobHandler(type: string): RestaurantJobHandler | undefined {
  return resolveHandler(type, restaurantJobHandlers);
}

export function runRestaurantJob(context: RestaurantJobContext): Promise<void> {
  return runJob(context, restaurantJobHandlers);
}
