'use client';

import { useState } from 'react';

import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export function MoneyConsole() {
  const [tab, setTab] = useState('bills');

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Money"
        description="Review bills, payments, drawers, and daily-close ledgers."
      />

      <SectionCard eyebrow="Money ledger" title="Filters">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1.5">
            <span className="block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted">
              Branch ID
            </span>
            <Input aria-label="Branch ID" placeholder="branch_…" className="h-11" />
          </label>
          <label className="space-y-1.5">
            <span className="block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted">
              Business date
            </span>
            <Input aria-label="Business date" type="date" className="h-11" />
          </label>
        </div>
      </SectionCard>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Money ledgers">
          <TabsTrigger value="bills">Bills</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="drawers">Drawers</TabsTrigger>
          <TabsTrigger value="daily-close">Daily close</TabsTrigger>
        </TabsList>
        {['bills', 'payments', 'drawers', 'daily-close'].map((value) => (
          <TabsContent key={value} value={value}>
            <SectionCard title="Money ledger shell">
              <p className="text-sm text-text-muted">Loading read model…</p>
            </SectionCard>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
