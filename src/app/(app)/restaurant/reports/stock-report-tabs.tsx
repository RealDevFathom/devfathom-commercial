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
    <Tabs defaultValue="wastage">
      <TabsList aria-label="Stock reports">
        <TabsTrigger value="wastage">Wastage</TabsTrigger>
        <TabsTrigger value="movements">Stock movement</TabsTrigger>
      </TabsList>
      <TabsContent value="wastage">{wastage}</TabsContent>
      <TabsContent value="movements">{movements}</TabsContent>
    </Tabs>
  );
}
