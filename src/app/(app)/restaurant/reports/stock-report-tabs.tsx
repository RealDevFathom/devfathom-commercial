'use client';

import type { ReactNode } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export function StockReportTabs({
  wastage,
  movements,
}: {
  wastage: ReactNode;
  movements: ReactNode;
}) {
  return (
    <Tabs defaultValue="wastage" className="min-w-0">
      <div className="max-w-full overflow-x-auto">
        <TabsList aria-label="Stock reports" className="min-w-max">
          <TabsTrigger value="wastage">Wastage</TabsTrigger>
          <TabsTrigger value="movements">Stock movement</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="wastage">{wastage}</TabsContent>
      <TabsContent value="movements">{movements}</TabsContent>
    </Tabs>
  );
}
