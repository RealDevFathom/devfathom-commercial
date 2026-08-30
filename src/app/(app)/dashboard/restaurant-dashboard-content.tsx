import Link from 'next/link';
import {
  ArrowRight,
  BarChart3,
  CookingPot,
  DollarSign,
  LayoutGrid,
  ListChecks,
  PackageSearch,
  ReceiptText,
  ShoppingCart,
  Users,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { moduleForPath } from '@/lib/module-catalog';
import { RestaurantManagementOverview } from './restaurant-management-overview';

const operationalLinks = [
  { label: 'Point of sale', href: '/pos', icon: ReceiptText },
  { label: 'Kitchen display', href: '/kds', icon: CookingPot },
  { label: 'Floor', href: '/restaurant/floor', icon: LayoutGrid },
  { label: 'Orders', href: '/restaurant/orders', icon: ReceiptText },
  { label: 'Restaurant Finance', href: '/restaurant/money', icon: DollarSign },
  { label: 'Inventory', href: '/restaurant/inventory', icon: PackageSearch },
  { label: 'Purchasing', href: '/restaurant/purchasing', icon: ShoppingCart },
  { label: 'SOP board', href: '/restaurant/sop', icon: ListChecks },
  { label: 'Customers & loyalty', href: '/restaurant/loyalty', icon: Users },
  { label: 'Advanced Insights', href: '/restaurant/insights', icon: BarChart3 },
] as const;

export function RestaurantDashboardContent({ enabledModules }: { enabledModules: string[] }) {
  const visibleLinks = operationalLinks.filter((item) => {
    const moduleKey = moduleForPath(item.href, 'RESTAURANT');
    return moduleKey ? enabledModules.includes(moduleKey) : true;
  });

  return (
    <div>
      <PageHeader
        eyebrow="Restaurant workspace"
        heading="Restaurant dashboard"
        description="Review reconciled closed-day performance, then move into the operational workspace that needs attention."
        actions={
          <StatusPill
            status="Closed-day data"
            tone="neutral"
            label="Management workspace"
            className="text-text-body"
          />
        }
        className="[&_[data-slot=eyebrow]]:text-text-body"
      />

      <RestaurantManagementOverview
        insightsEnabled={enabledModules.includes('restaurant-insights')}
      />

      {visibleLinks.length > 0 ? (
        <SectionCard
          eyebrow="Operations"
          title="Quick access"
          titleLevel={2}
          className="mt-5 [&_[data-slot=eyebrow]]:text-text-body"
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visibleLinks.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="group flex min-h-20 items-center gap-4 rounded-md border border-border-subtle bg-surface-page p-4 text-text-strong transition-colors hover:border-border-default hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-sm border border-border-subtle bg-card">
                    <Icon className="size-4 text-accent-brand" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1 font-display text-sm font-semibold">
                    {item.label}
                  </span>
                  <ArrowRight
                    className="size-4 shrink-0 text-text-faint transition-transform group-hover:translate-x-0.5"
                    aria-hidden
                  />
                </Link>
              );
            })}
          </div>
        </SectionCard>
      ) : (
        <SectionCard
          eyebrow="Setup"
          title="Your restaurant workspace is ready for modules"
          titleLevel={2}
          actions={<StatusPill status="Core only" tone="info" />}
          className="[&_[data-slot=eyebrow]]:text-text-body"
        >
          <p className="max-w-2xl text-sm leading-6 text-text-muted">
            Restaurant Core is active. Ask your organization administrator to enable an operational
            module such as POS, inventory, purchasing, SOPs, loyalty, or insights; its workspace
            will appear here automatically.
          </p>
          <Link
            href="/restaurant/staff"
            className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-sm border border-border-default bg-card px-4 text-sm font-semibold text-text-strong hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Set up restaurant staff
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </SectionCard>
      )}
    </div>
  );
}
