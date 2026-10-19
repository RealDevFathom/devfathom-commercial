import base from './vitest.config.ts';
export default {...base,cacheDir:"/Users/Saad/Developer/devfathom-consolidation-20261013/validation/vite",test:{...base.test,include:["src/components/restaurant/promotions/promotions-console.test.tsx", "src/server/routers/restaurant-promotions.test.ts"],maxWorkers:1,cache:false,experimental:{fsModuleCache:false}}};
