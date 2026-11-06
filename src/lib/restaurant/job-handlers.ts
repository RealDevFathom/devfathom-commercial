import 'server-only';

import { DEMO_RESET_JOB_TYPE } from '@/lib/restaurant/scheduler';
import { demoResetJobHandler } from '@/lib/demo/jobs';
import {
  MENU_IMPORT_EXTRACT_JOB,
  menuImportExtractHandler,
} from '@/lib/restaurant/menu-import-legacy';
import {
  PHARMACY_SOP_AUTO_GENERATE_BRANCH_JOB,
  PHARMACY_SOP_AUTO_GENERATE_JOB,
  pharmacySopAutoGenerateBranchHandler,
  pharmacySopAutoGenerateHandler,
} from '@/lib/pharmacy/sop-auto-schedule-job';
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
  // DEV-751: opt-in pharmacy SOP automatic scheduling (enqueued only once a
  // pharmacy branch turns it on; a no-op in an organization with no SOP site).
  // The hourly parent enqueues one per-branch child per ON branch.
  [PHARMACY_SOP_AUTO_GENERATE_JOB]: pharmacySopAutoGenerateHandler,
  [PHARMACY_SOP_AUTO_GENERATE_BRANCH_JOB]: pharmacySopAutoGenerateBranchHandler,
};

export function resolveRestaurantJobHandler(type: string): RestaurantJobHandler | undefined {
  return resolveHandler(type, restaurantJobHandlers);
}

export function runRestaurantJob(context: RestaurantJobContext): Promise<void> {
  return runJob(context, restaurantJobHandlers);
}
