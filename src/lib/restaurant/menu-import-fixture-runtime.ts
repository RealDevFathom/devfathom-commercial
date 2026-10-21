import 'server-only';

import { createFixtureMenuExtractionAdapter } from '@/lib/restaurant/menu-extraction-fixtures';
import { MenuExtractionError } from '@/lib/restaurant/menu-extraction';
import { defaultMenuImportRuntime, type MenuImportRuntime } from '@/lib/restaurant/menu-import';

/** Legacy test/dev composition only; exclude this module from production packaging. */
export const fixtureMenuImportRuntime: MenuImportRuntime = {
  ...defaultMenuImportRuntime,
  resolveAdapter: (name) => {
    if (name !== 'FIXTURE') return defaultMenuImportRuntime.resolveAdapter(name);
    if (process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'development') {
      throw new MenuExtractionError('Menu extraction is unavailable.', 'ADAPTER_UNAVAILABLE');
    }
    return createFixtureMenuExtractionAdapter();
  },
};
