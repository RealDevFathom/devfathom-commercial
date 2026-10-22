import base from './vitest.config.ts';
export default {...base,cacheDir:"/Users/Saad/Developer/devfathom-consolidation-20261013/validation/vite",test:{...base.test,include:["src/app/(app)/settings/settings-entitlements.test.tsx", "src/components/restaurant/print-routing-section.test.tsx"],maxWorkers:1,cache:false,experimental:{fsModuleCache:false}}};
