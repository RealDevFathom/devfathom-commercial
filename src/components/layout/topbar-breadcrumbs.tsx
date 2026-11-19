'use client';

import { useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { useBreadcrumbStore } from '@/lib/breadcrumb-store';
import { cn } from '@/lib/utils';

export const routeLabels: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/projects': 'Projects',
  '/projects/import': 'Import',
  '/clients': 'Clients',
  '/notes': 'Notes',
  '/email': 'Email',
  '/finance': 'Finance',
  '/meetings': 'Meetings',
  '/chat': 'Chat',
  '/team': 'Team',
  '/team/stats': 'Insights',
  '/hr': 'HR & Leave',
  '/reviews': 'Reviews',
  '/audit-logs': 'Audit Log',
  '/api-docs': 'API Access',
  '/settings': 'Settings',
  // The hospitality settings pages, named as the hospitality menu names them.
  '/hotel/settings/property': 'Property',
  '/hotel/settings/rooms': 'Rooms',
  '/hotel/settings/meal-plans': 'Meal plans',
  '/hotel/settings/spaces': 'Function spaces',
  '/hotel/settings/extras': 'Extras',
  '/hotel/settings/journey': 'Guest messages',
  // Pharmacy accounts pages use their page headings in the breadcrumb.
  '/pharmacy/accounts/account-activity-bridge': 'Account activity bridge',
  '/pharmacy/accounts/account-code-reference': 'Account code reference',
  '/pharmacy/accounts/ap-aging': 'Supplier expense invoice aging',
  '/pharmacy/accounts/balance-sheet': 'Balance sheet',
  '/pharmacy/accounts/cash-flow': 'Classified cash-flow projection',
  '/pharmacy/accounts/cheque-maturity': 'Recorded cheque maturity',
  '/pharmacy/accounts/fiscal-exceptions': 'Fiscal exception evidence',
  '/pharmacy/accounts/general-journal': 'General journal vouchers',
  '/pharmacy/accounts/journal-entry-lookup': 'Journal entry lookup',
  '/pharmacy/accounts/journal-evidence-export': 'Journal evidence export',
  '/pharmacy/accounts/profit-loss': 'Profit and loss',
  '/pharmacy/accounts/tax-profile-review': 'Tax profile review',
  '/pharmacy/accounts/trial-balance-control': 'Trial-balance control',
  // DEV-751: the pharmacy SOP workspace is named "Procedures" in the UI.
  '/pharmacy/sop': 'Procedures',
  // DEV-111: the slug is hyphenated; the breadcrumb uses the page heading.
  '/pharmacy/pharmacist-queue': 'Pharmacist queue',
  // DEV-960: the owner's per-branch setting, named by its page heading.
  '/pharmacy/settings/one-pharmacist-per-shift': 'One pharmacist per shift',
  // DEV-44: the other pharmacy destinations, named as the pharmacy menu names them.
  '/pharmacy/medicines': 'Medicine catalog',
  '/pharmacy/counter': 'Counter',
  '/pharmacy/counter/close': 'Day close',
  '/pharmacy/inventory': 'Inventory',
  '/pharmacy/purchasing': 'Purchasing',
  '/pharmacy/finance': 'Finance',
  '/pharmacy/reports': 'Reports & Insights',
  '/pharmacy/cameras': 'Cameras',
  '/pharmacy/khata': 'Khata',
  '/pharmacy/loyalty': 'Loyalty points',
  '/pharmacy/marketing': 'Marketing & growth',
  '/pharmacy/prescriptions': 'Prescriptions',
  '/pharmacy/substitution': 'Substitution',
  '/pharmacy/controlled-register': 'Controlled register',
  '/pharmacy/regulatory': 'Regulatory profile',
  '/pharmacy/settings/branches': 'Branch assignments',
  '/pharmacy/settings/pin': 'Your PIN',
  '/pharmacy/settings/printers': 'Printer settings',
};

const linkableDetailRoute = /^\/(projects|clients|notes|team|meetings)\/[^/]+$/;
const subscribeToHydration = () => () => {};

function isLinkableBreadcrumb(href: string) {
  return href in routeLabels || linkableDetailRoute.test(href);
}

export function TopbarBreadcrumbs() {
  const pathname = usePathname();
  const breadcrumbLabels = useBreadcrumbStore((state) => state.labels);
  const mounted = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false
  );

  // A cached layout can observe the destination pathname before its server
  // markup has hydrated. Keep that first render route-inert, then derive every
  // label from the live pathname once hydration has completed.
  if (!mounted) return null;

  const segments = pathname.split('/').filter(Boolean);

  const breadcrumbs = segments.map((segment, index) => {
    const href = `/${segments.slice(0, index + 1).join('/')}`;
    return {
      label:
        routeLabels[href] ||
        // DEV-44: `/pharmacy` is the Onboarding page only when it is the current
        // page; above another pharmacy page it is the workspace, "Pharmacy".
        (href === '/pharmacy' && index === segments.length - 1 ? 'Onboarding' : undefined) ||
        breadcrumbLabels[segment] ||
        segment.charAt(0).toUpperCase() + segment.slice(1),
      href,
      linkable: isLinkableBreadcrumb(href),
    };
  });

  return breadcrumbs.map((crumb, index) => (
    <div key={crumb.href} className="flex min-w-0 items-center gap-1">
      {index > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />}
      {index === breadcrumbs.length - 1 || !crumb.linkable ? (
        <span
          className={cn(
            'truncate',
            index === breadcrumbs.length - 1
              ? 'font-medium text-foreground'
              : 'text-muted-foreground'
          )}
          aria-current={index === breadcrumbs.length - 1 ? 'page' : undefined}
        >
          {crumb.label}
        </span>
      ) : (
        <Link
          href={crumb.href}
          className="truncate text-muted-foreground transition-colors hover:text-foreground"
        >
          {crumb.label}
        </Link>
      )}
    </div>
  ));
}
