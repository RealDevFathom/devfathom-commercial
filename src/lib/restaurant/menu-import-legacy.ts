import 'server-only';

import {
  createMenuImportExtractHandler,
  runMenuImportExtraction as runExtraction,
} from '@/lib/restaurant/menu-import';
import { fixtureMenuImportRuntime } from '@/lib/restaurant/menu-import-fixture-runtime';

export * from '@/lib/restaurant/menu-import';

/** Compatibility entrypoint for existing dev/test jobs and direct extraction callers. */
export function runMenuImportExtraction(
  ...[db, importId, options]: Parameters<typeof runExtraction>
) {
  return runExtraction(db, importId, {
    ...options,
    runtime: options?.runtime ?? fixtureMenuImportRuntime,
  });
}

export const menuImportExtractHandler = createMenuImportExtractHandler(fixtureMenuImportRuntime);
