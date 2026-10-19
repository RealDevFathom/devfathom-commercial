import base from './vitest.config.ts';
export default {...base, cacheDir:"/Users/Saad/Developer/devfathom-consolidation-20261013/validation/vite", test:{...base.test, include:["src/lib/hotel/foundation.test.ts", "src/lib/platform/hotel-foundation.test.tsx"], maxWorkers:1, cache:false, experimental:{fsModuleCache:false}}};
