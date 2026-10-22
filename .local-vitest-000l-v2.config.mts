import base from './vitest.config.ts';
export default {...base, cacheDir:"/Users/Saad/Developer/devfathom-consolidation-20261013/validation/vite", test:{...base.test, include:["src/server/hotel-property-scope.test.ts", "src/lib/platform/hotel-property-maintenance.test.ts"], maxWorkers:1, cache:false, experimental:{fsModuleCache:false}}};
