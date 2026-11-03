'use client';

import { useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { useBreadcrumbStore } from '@/lib/breadcrumb-store';
import { cn } from '@/lib/utils';
import { navigation } from './sidebar';

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
};

// The menu's own name for a page, so a breadcrumb reads like the nav item that opened it.
// A one-segment section root (e.g. `/pharmacy`, whose menu entry is its onboarding page)
// keeps its section name instead, since every page under it shares that crumb.
const navLabels = new Map<string, string>();
for (const item of navigation) {
  const isSectionRoot =
    item.href.split('/').filter(Boolean).length === 1 &&
    navigation.some((other) => other.href.startsWith(`${item.href}/`));
  if (!isSectionRoot && !navLabels.has(item.href)) navLabels.set(item.href, item.label);
}

/** `branch-comparison` -> `Branch comparison`: readable when no named label exists. */
export function humanizeSegment(segment: string) {
  const words = segment.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

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
        breadcrumbLabels[segment] ||
        navLabels.get(href) ||
        humanizeSegment(segment),
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
