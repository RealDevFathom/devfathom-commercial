'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export function InventoryReportTabs({
  wastage,
  stockMovements,
}: {
  wastage: React.ReactNode;
  stockMovements: React.ReactNode;
}) {
  return (
    <Tabs defaultValue="wastage" className="min-w-0 gap-5">
      <div className="max-w-full overflow-x-auto">
        <TabsList aria-label="Inventory movement reports" className="min-w-max">
          <TabsTrigger value="wastage">Wastage</TabsTrigger>
          <TabsTrigger value="stock-movements">Stock movement</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="wastage">{wastage}</TabsContent>
      <TabsContent value="stock-movements">{stockMovements}</TabsContent>
    </Tabs>
  );
}
