'use client';

import type { ReactNode } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export function ProfitabilityReportTabs({
  foodCost,
  dishProfitability,
  catering,
}: {
  foodCost: ReactNode;
  dishProfitability: ReactNode;
  catering: ReactNode;
}) {
  return (
    <Tabs defaultValue="food-cost">
      <TabsList aria-label="Profitability reports">
        <TabsTrigger value="food-cost">Food cost</TabsTrigger>
        <TabsTrigger value="dish-profitability">Dish profitability</TabsTrigger>
        <TabsTrigger value="catering">Catering</TabsTrigger>
      </TabsList>
      <TabsContent value="food-cost">{foodCost}</TabsContent>
      <TabsContent value="dish-profitability">{dishProfitability}</TabsContent>
      <TabsContent value="catering">{catering}</TabsContent>
    </Tabs>
  );
}
