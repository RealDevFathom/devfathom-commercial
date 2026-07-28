'use client';

// TEMPORARY visual-QA harness for the design-system shared layer.
// Public route (under /brand) so it renders without auth. DELETE after review.

import { useState } from 'react';
import { Sidebar } from '@/components/layout/sidebar';
import { PageHeader } from '@/components/ui/page-header';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { FilterChips } from '@/components/ui/filter-chips';
import { UtilizationBar } from '@/components/ui/utilization-bar';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EntitlementsProvider } from '@/components/entitlements-provider';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

export default function PreviewPage() {
  const [filter, setFilter] = useState('all');
  return (
    <EntitlementsProvider
      value={{
        organizationId: 'brand-preview',
        seatLimit: 1,
        activeSeats: 1,
        enabledModules: [
          'dashboard',
          'projects',
          'clients',
          'notes',
          'meetings',
          'chat',
          'finance',
          'hr',
          'reviews',
          'audit',
          'email',
          'api',
        ],
        modules: [],
        limits: {},
      }}
    >
      <div className="flex min-h-screen bg-background">
        <div className="hidden lg:block">
          <Sidebar />
        </div>
        <div className="min-w-0 flex-1 lg:pl-60">
          <main className="mx-auto max-w-[1400px] space-y-8 px-[clamp(1.25rem,5vw,4rem)] py-8">
            <PageHeader
              eyebrow="FIRM"
              heading="Finance"
              description="Recognised revenue, invoicing, and what is owed. Specific and earned — never invented."
              actions={<Button>New invoice</Button>}
            />

            {/* Stat ledger */}
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border-subtle bg-border-subtle md:grid-cols-4">
              <div className="bg-card p-5">
                <Stat
                  label="RECOGNISED · JUNE"
                  value="$142.6k"
                  delta="+9%"
                  deltaDirection="up"
                  sub="vs May"
                />
              </div>
              <div className="bg-card p-5">
                <Stat label="OUTSTANDING" value="$52.3k" delta="4 invoices" deltaDirection="flat" />
              </div>
              <div className="bg-card p-5">
                <Stat label="OVERDUE" value="$60.0k" delta="1 invoice" deltaDirection="down" />
              </div>
              <div className="bg-card p-5">
                <Stat label="RECOGNISED YTD" value="$1.18M" delta="+22%" deltaDirection="up" />
              </div>
            </div>

            <FilterChips
              value={filter}
              onChange={setFilter}
              items={[
                { label: 'All', value: 'all', count: 6 },
                { label: 'On track', value: 'on-track', count: 4 },
                { label: 'At risk', value: 'at-risk', count: 1 },
                { label: 'Blocked', value: 'blocked', count: 1 },
              ]}
            />

            <div className="grid gap-6 lg:grid-cols-3">
              <SectionCard className="lg:col-span-2" eyebrow="INVOICES" title="Awaiting approval">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead>Due</TableHead>
                      <TableHead numeric>Amount</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[
                      {
                        id: 'INV-0241',
                        client: 'Meridian Health',
                        due: '12 Jul',
                        amt: '$24,800',
                        s: 'pending',
                      },
                      {
                        id: 'INV-0238',
                        client: 'Northwind Logistics',
                        due: '04 Jul',
                        amt: '$18,200',
                        s: 'overdue',
                      },
                      {
                        id: 'INV-0235',
                        client: 'Atlas Capital',
                        due: '20 Jul',
                        amt: '$9,400',
                        s: 'sent',
                      },
                      {
                        id: 'INV-0230',
                        client: 'Harbor Freight',
                        due: '28 Jun',
                        amt: '$41,000',
                        s: 'paid',
                      },
                    ].map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono">{r.id}</TableCell>
                        <TableCell>{r.client}</TableCell>
                        <TableCell className="font-mono text-text-muted">{r.due}</TableCell>
                        <TableCell numeric>{r.amt}</TableCell>
                        <TableCell>
                          <StatusPill status={r.s} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </SectionCard>

              <SectionCard eyebrow="UTILISATION" title="This quarter">
                <div className="space-y-4">
                  <UtilizationBar label="Mara Quinn" value={92} />
                  <UtilizationBar label="Daniel Osei" value={78} />
                  <UtilizationBar label="Priya Nair" value={64} />
                  <UtilizationBar label="Tom Vale" value={40} />
                </div>
              </SectionCard>
            </div>

            {/* Buttons + badges + pills row */}
            <SectionCard eyebrow="COMPONENTS" title="Controls">
              <div className="flex flex-wrap items-center gap-3">
                <Button>Primary</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="destructive">Destructive</Button>
                <Button size="sm">Small</Button>
                <Badge>Badge</Badge>
                <StatusPill status="on-track" />
                <StatusPill status="at-risk" />
                <StatusPill status="blocked" />
                <StatusPill status="paid" />
              </div>
            </SectionCard>
          </main>
        </div>
      </div>
    </EntitlementsProvider>
  );
}
