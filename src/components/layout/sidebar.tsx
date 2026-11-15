'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { m } from 'motion/react';
import {
  LayoutDashboard,
  FolderKanban,
  DollarSign,
  Users,
  MessageSquare,
  UserCog,
  Settings,
  ChevronLeft,
  ChevronRight,
  Briefcase,
  Video,
  StickyNote,
  BarChart3,
  ScrollText,
  ClipboardList,
  Building2,
  Monitor,
  BookOpen,
  UtensilsCrossed,
  FileUp,
  LayoutGrid,
  ReceiptText,
  CookingPot,
  PackageSearch,
  ShoppingCart,
  ListChecks,
  ShieldCheck,
  Bell,
  Camera,
  CalendarClock,
  Landmark,
  MapPin,
  Bike,
  FileText,
  ClipboardCheck,
  ConciergeBell,
  Replace,
  BookLock,
  Pill,
  Tags,
  BedDouble,
  DoorOpen,
  MessageSquareText,
  Printer,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { easeOutExpo } from '@/lib/motion';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FathomMark } from '@/components/brand/logo';
import { usePreferences } from '@/components/preferences-provider';
import { useEntitlements } from '@/components/entitlements-provider';
import { trpc } from '@/lib/trpc';
import { evaluateSessionUser } from '@/lib/auth/session-state';
import type { TenantBrand } from '@/lib/tenant-brand';
import { isModuleGranted, moduleForPath, verticalForModuleKey } from '@/lib/module-catalog';
import type { EntitlementView } from '@/lib/module-catalog';
import type { Action } from '@/lib/abac/policies';

type NavGroup = 'Workspace' | 'Restaurant' | 'Pharmacy' | 'Hospitality' | 'Firm';

/** A hospitality property capability, as the property scope check names it. */
export type HotelCapability = Extract<Action, `hotel:${string}`>;

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  group: NavGroup;
  adminOnly?: boolean;
  // Visible to ADMIN and HR (people-ops surfaces). Takes precedence over adminOnly.
  hrAccess?: boolean;
  module?: string;
  /**
   * Hospitality entries only: the property capabilities that open this entry's
   * page, exactly as the page checks them. The entry shows when the signed-in
   * member holds any of them at some assigned property, so a member whose role
   * grants rates or marketing alone sees those pages and nothing else. A
   * Hospitality entry that names none never shows.
   */
  hotelCapabilities?: readonly HotelCapability[];
  /** Shown only when the signed-in user holds one of these capabilities. */
  pharmacyCapabilities?: readonly string[];
  /**
   * `adminOnly` entries only: also shown to a non-administrator holding one of
   * these capabilities, for pages whose server gate admits an administrator OR
   * the capability (day close: `pharmacy:close`, DEV-127).
   */
  memberCapabilities?: readonly string[];
  /**
   * In a pharmacy workspace, shown to non-administrators only while this module
   * is granted. Without it the page has nothing for them there, so the entry
   * would be a dead end (#979). Other products are unchanged.
   */
  memberModule?: string;
}

// Grouped to match the Studio WORKSPACE / RESTAURANT / FIRM rail. Order defines the
// numbered index (recomputed after RBAC filtering so numbers stay contiguous).
export const navigation: NavItem[] = [
  {
    label: 'Dashboard',
    href: '/dashboard',
    icon: LayoutDashboard,
    group: 'Workspace',
  },
  {
    label: 'Projects',
    href: '/projects',
    icon: FolderKanban,
    group: 'Workspace',
  },
  {
    label: 'Clients',
    href: '/clients',
    icon: Briefcase,
    group: 'Workspace',
  },
  {
    label: 'Notes',
    href: '/notes',
    icon: StickyNote,
    group: 'Workspace',
  },
  // Email stays disabled until its OAuth credentials and mailbox schema are deployed.
  {
    label: 'Meetings',
    href: '/meetings',
    icon: Video,
    group: 'Workspace',
  },
  {
    label: 'Chat',
    href: '/chat',
    icon: MessageSquare,
    group: 'Workspace',
  },
  {
    label: 'Finance',
    href: '/finance',
    icon: DollarSign,
    adminOnly: true,
    group: 'Firm',
  },
  // #979: inviting is administration; the member directory is licensed by HR.
  { label: 'Team', href: '/team', icon: Users, group: 'Firm', memberModule: 'hr' },
  { label: 'Point of sale', href: '/pos', icon: Monitor, group: 'Restaurant' },
  { label: 'Kitchen display', href: '/kds', icon: CookingPot, group: 'Restaurant' },
  { label: 'Floor', href: '/restaurant/floor', icon: LayoutGrid, group: 'Restaurant' },
  { label: 'Orders', href: '/restaurant/orders', icon: ReceiptText, group: 'Restaurant' },
  {
    label: 'Catering',
    href: '/restaurant/catering',
    icon: ConciergeBell,
    group: 'Restaurant',
    module: 'restaurant-core',
  },
  {
    label: 'Finance & reconciliation',
    href: '/restaurant/money',
    icon: DollarSign,
    group: 'Restaurant',
  },
  {
    label: 'Inventory',
    href: '/restaurant/inventory',
    icon: PackageSearch,
    group: 'Restaurant',
  },
  {
    label: 'Purchasing',
    href: '/restaurant/purchasing',
    icon: ShoppingCart,
    group: 'Restaurant',
  },
  { label: 'SOP board', href: '/restaurant/sop', icon: ListChecks, group: 'Restaurant' },
  { label: 'SOP reports', href: '/restaurant/sop/reports', icon: BarChart3, group: 'Restaurant' },
  {
    label: 'SOP admin',
    href: '/restaurant/sop/admin',
    icon: Settings,
    group: 'Restaurant',
    adminOnly: true,
  },
  {
    label: 'SOP oversight',
    href: '/restaurant/sop/oversight',
    icon: ShieldCheck,
    group: 'Restaurant',
    adminOnly: true,
  },
  {
    label: 'Restaurant staff',
    href: '/restaurant/staff',
    icon: Users,
    group: 'Restaurant',
  },
  {
    label: 'Roster',
    href: '/restaurant/staff/roster',
    icon: CalendarClock,
    group: 'Restaurant',
    module: 'restaurant-core',
  },
  {
    label: 'Tax',
    href: '/restaurant/tax',
    icon: Landmark,
    adminOnly: true,
    group: 'Restaurant',
  },
  {
    label: 'Branches',
    href: '/restaurant/settings/branches',
    icon: MapPin,
    adminOnly: true,
    group: 'Restaurant',
    module: 'restaurant-core',
  },
  {
    label: 'Delivery',
    href: '/restaurant/delivery',
    icon: Bike,
    adminOnly: true,
    group: 'Restaurant',
    module: 'restaurant-core',
  },
  {
    label: 'Restaurant devices',
    href: '/restaurant/devices',
    icon: Monitor,
    adminOnly: true,
    group: 'Restaurant',
  },
  {
    label: 'Cameras',
    href: '/restaurant/integrations/cameras',
    icon: Camera,
    adminOnly: true,
    group: 'Restaurant',
    module: 'restaurant-integrations',
  },
  {
    label: 'Catalog',
    href: '/restaurant/catalog',
    icon: BookOpen,
    group: 'Restaurant',
  },
  {
    label: 'Menus',
    href: '/restaurant/menus',
    icon: UtensilsCrossed,
    group: 'Restaurant',
  },
  {
    // R-lane (WHA-210): the OCR menu-import console. Gated to admins because
    // `menu:import` is held only by templates carrying `*` (the restaurant
    // Owner), which is the same set the page itself admits.
    label: 'Menu import',
    href: '/restaurant/menu-import',
    icon: FileUp,
    adminOnly: true,
    group: 'Restaurant',
    module: 'restaurant-menu',
  },
  {
    label: 'Offers',
    href: '/restaurant/promotions',
    icon: Tags,
    group: 'Restaurant',
    module: 'restaurant-menu',
  },
  {
    label: 'Notifications',
    href: '/restaurant/notifications',
    icon: Bell,
    group: 'Restaurant',
  },
  {
    label: 'Customers & Loyalty',
    href: '/restaurant/loyalty',
    icon: Users,
    group: 'Restaurant',
  },
  {
    label: 'Reports',
    href: '/restaurant/reports',
    icon: BarChart3,
    group: 'Restaurant',
  },
  {
    label: 'Advanced Insights',
    href: '/restaurant/insights',
    icon: BarChart3,
    group: 'Restaurant',
  },
  // PLAT-02/03 — the pharmacy workspace's front door. Both gate on mandatory
  // Pharmacy Core through explicit module ownership, so vertical and entitlement
  // checks remain fail-closed without a broad `/pharmacy` route mapping.
  {
    label: 'Onboarding',
    href: '/pharmacy',
    icon: ListChecks,
    adminOnly: true,
    group: 'Pharmacy',
    module: 'pharmacy-core',
  },
  {
    label: 'Medicine catalog',
    href: '/pharmacy/medicines',
    icon: Pill,
    adminOnly: true,
    group: 'Pharmacy',
    module: 'pharmacy-core',
  },
  // PH-POS / POS-01: the counter is the pharmacy's primary operating surface, so
  // it is a first-class rail entry gated by its explicit module ownership.
  // #979: a cashier is not offered an entry that ends in "Day close unavailable".
  // DEV-127: the console opens for an administrator or a member granted
  // `pharmacy:close` (the Pharmacist template), exactly as its procedures do.
  {
    label: 'Day close',
    href: '/pharmacy/counter/close',
    icon: Monitor,
    adminOnly: true,
    memberCapabilities: ['pharmacy:close'],
    group: 'Pharmacy',
    module: 'pharmacy-counter',
  },
  {
    label: 'Counter',
    href: '/pharmacy/counter',
    icon: Monitor,
    group: 'Pharmacy',
    module: 'pharmacy-counter',
    pharmacyCapabilities: ['pharmacy:counter'],
  },
  {
    label: 'Inventory',
    href: '/pharmacy/inventory',
    icon: PackageSearch,
    group: 'Pharmacy',
  },
  {
    label: 'Purchasing',
    href: '/pharmacy/purchasing',
    icon: ShoppingCart,
    group: 'Pharmacy',
    pharmacyCapabilities: ['pharmacy:procurement'],
  },
  {
    label: 'Finance',
    href: '/pharmacy/finance',
    icon: DollarSign,
    adminOnly: true,
    group: 'Pharmacy',
  },
  {
    label: 'Reports & Insights',
    href: '/pharmacy/reports',
    icon: BarChart3,
    group: 'Pharmacy',
    pharmacyCapabilities: ['reports:operational'],
  },
  {
    label: 'Cameras',
    href: '/pharmacy/cameras',
    icon: Camera,
    group: 'Pharmacy',
    adminOnly: true,
    module: 'pharmacy-core',
  },
  {
    label: 'Khata',
    href: '/pharmacy/khata',
    icon: Landmark,
    group: 'Pharmacy',
    adminOnly: true,
    module: 'pharmacy-counter',
  },
  {
    label: 'Loyalty points',
    href: '/pharmacy/loyalty',
    icon: Users,
    group: 'Pharmacy',
    adminOnly: true,
    module: 'pharmacy-crm',
  },
  {
    label: 'Marketing & growth',
    href: '/pharmacy/marketing',
    icon: BarChart3,
    group: 'Pharmacy',
    adminOnly: true,
    module: 'pharmacy-crm',
  },
  {
    label: 'Prescriptions',
    href: '/pharmacy/prescriptions',
    icon: FileText,
    group: 'Pharmacy',
    module: 'pharmacy-dispensing',
    pharmacyCapabilities: ['pharmacy:prescriptions'],
  },
  {
    label: 'Pharmacist queue',
    href: '/pharmacy/pharmacist-queue',
    icon: ClipboardCheck,
    group: 'Pharmacy',
    module: 'pharmacy-dispensing',
    pharmacyCapabilities: ['pharmacy:dispense'],
  },
  // DEV-35: the substitution workspace opens for dispense or Pharmacy Safety.
  {
    label: 'Substitution',
    href: '/pharmacy/substitution',
    icon: Replace,
    group: 'Pharmacy',
    module: 'pharmacy-dispensing',
    pharmacyCapabilities: ['pharmacy:dispense', 'pharmacy:safety'],
  },
  {
    label: 'Controlled register',
    href: '/pharmacy/controlled-register',
    icon: BookLock,
    group: 'Pharmacy',
    module: 'pharmacy-safety',
    pharmacyCapabilities: ['pharmacy:safety'],
  },
  // DEV-751: pharmacy procedures on the shared SOP engine, licensed as Pharmacy
  // Safety. Shown to whoever holds any SOP capability (complete, verify or
  // manage) — the same three `pharmacySop.access` reports and the page checks.
  {
    label: 'Procedures',
    href: '/pharmacy/sop',
    icon: ClipboardList,
    group: 'Pharmacy',
    module: 'pharmacy-safety',
    pharmacyCapabilities: ['pharmacy:sop'],
  },
  {
    label: 'Regulatory profile',
    href: '/pharmacy/regulatory',
    icon: ShieldCheck,
    adminOnly: true,
    group: 'Pharmacy',
    module: 'pharmacy-core',
  },
  {
    label: 'Branch assignments',
    href: '/pharmacy/settings/branches',
    icon: MapPin,
    adminOnly: true,
    group: 'Pharmacy',
    module: 'pharmacy-core',
  },
  {
    label: 'Printer settings',
    href: '/pharmacy/settings/printers',
    icon: Printer,
    adminOnly: true,
    group: 'Pharmacy',
    module: 'pharmacy-counter',
  },
  // H1-01 — the hospitality rail. Only configuration surfaces are here so far:
  // every operating surface arrives with its own lane, and a nav entry pointing
  // at a route that does not exist is a dead end (UX rule 12). Gated through
  // explicit module ownership, so the vertical filter hides it from restaurant
  // and pharmacy workspaces without a `/hotel` catch-all, and per entry on the
  // capability its page checks (`hotelCapabilities`), so each entry shows to
  // whoever holds that capability at some property and to no one else.
  // Labelled by what it configures: the workspace "Settings" entry sits in the
  // same rail, and two entries reading "Settings" named nothing. In the order a
  // property is set up: the property, what it sells, then what it adds.
  {
    label: 'Property',
    href: '/hotel/settings/property',
    icon: BedDouble,
    group: 'Hospitality',
    module: 'hotel-core',
    hotelCapabilities: ['hotel:property-admin'],
  },
  // PROP-02 / PROP-03 — room types, rooms, beds and units, their status and blocks.
  {
    label: 'Rooms',
    href: '/hotel/settings/rooms',
    icon: DoorOpen,
    group: 'Hospitality',
    module: 'hotel-core',
    hotelCapabilities: ['hotel:property-admin'],
  },
  // MEAL-01 — the board bases a property sells: rates work, not property administration.
  {
    label: 'Meal plans',
    href: '/hotel/settings/meal-plans',
    icon: UtensilsCrossed,
    group: 'Hospitality',
    module: 'hotel-core',
    hotelCapabilities: ['hotel:rates'],
  },
  // PROP-07 — halls, lawns and boardrooms; licensed by Banquets.
  {
    label: 'Function spaces',
    href: '/hotel/settings/spaces',
    icon: LayoutGrid,
    group: 'Hospitality',
    module: 'hotel-banquets',
    hotelCapabilities: ['hotel:property-admin'],
  },
  // H1-06 (PROP-05) — the extras catalog every folio charge will name.
  {
    label: 'Extras',
    href: '/hotel/settings/extras',
    icon: Tags,
    group: 'Hospitality',
    module: 'hotel-core',
    hotelCapabilities: ['hotel:property-admin'],
  },
  // UPS-04 — what a property sends a guest at each step of a stay; licensed by
  // Guest Journey and Upsell. Marketing drafts; property administration approves.
  {
    label: 'Guest messages',
    href: '/hotel/settings/journey',
    icon: MessageSquareText,
    group: 'Hospitality',
    module: 'hotel-upsell',
    hotelCapabilities: ['hotel:property-admin', 'hotel:marketing'],
  },
  {
    label: 'Reviews',
    href: '/reviews',
    icon: ClipboardList,
    group: 'Firm',
  },
  {
    label: 'Insights',
    href: '/team/stats',
    icon: BarChart3,
    adminOnly: true,
    group: 'Firm',
  },
  {
    label: 'HR',
    href: '/hr',
    icon: UserCog,
    hrAccess: true,
    group: 'Firm',
  },
  {
    label: 'Audit Log',
    href: '/audit-logs',
    icon: ScrollText,
    adminOnly: true,
    group: 'Firm',
  },
  {
    label: 'Organization',
    href: '/organization',
    icon: Building2,
    adminOnly: true,
    group: 'Firm',
  },
  { label: 'Settings', href: '/settings', icon: Settings, group: 'Firm' },
];

const GROUP_ORDER: NavGroup[] = ['Workspace', 'Restaurant', 'Pharmacy', 'Hospitality', 'Firm'];

/** Every capability a hospitality entry names, asked about in one rail query. */
const HOTEL_RAIL_CAPABILITIES: HotelCapability[] = [
  ...new Set(navigation.flatMap((item) => item.hotelCapabilities ?? [])),
];
const NO_HOTEL_CAPABILITIES: readonly HotelCapability[] = [];

/**
 * `hotelCapabilities` are the property capabilities the member holds at one or
 * more of their assigned properties (none by default). A Hospitality entry
 * shows when it names one of them; every other entry ignores them.
 */
export function visibleNavigation(
  entitlements: Pick<EntitlementView, 'enabledModules' | 'vertical'>,
  role?: string,
  hotelCapabilities: readonly HotelCapability[] = NO_HOTEL_CAPABILITIES,
  pharmacyCapabilities: readonly string[] = []
) {
  const isAdmin = role === 'ADMIN';
  const isHr = role === 'HR';
  return navigation
    .filter((item) => {
      const moduleKey = item.module ?? moduleForPath(item.href, entitlements.vertical);
      // WHA-8: a module belonging to the other vertical never appears, even if a
      // mis-provisioned organization has it enabled. Items that resolve to no
      // module at all (the shared Firm entries) are never vertical-gated.
      const moduleVertical = moduleKey ? verticalForModuleKey(moduleKey) : null;
      if (moduleVertical && entitlements.vertical && moduleVertical !== entitlements.vertical)
        return false;
      if (moduleKey && !isModuleGranted(moduleKey, entitlements.enabledModules)) return false;
      if (item.group === 'Hospitality')
        return (item.hotelCapabilities ?? []).some((capability) =>
          hotelCapabilities.includes(capability)
        );
      if (
        item.pharmacyCapabilities?.length &&
        !item.pharmacyCapabilities.some((capability) => pharmacyCapabilities.includes(capability))
      )
        return false;
      if (item.hrAccess) return isAdmin || isHr;
      if (item.adminOnly)
        return (
          isAdmin ||
          Boolean(
            item.memberCapabilities?.some((capability) => pharmacyCapabilities.includes(capability))
          )
        );
      if (item.memberModule && !isAdmin && entitlements.vertical === 'PHARMACY')
        return isModuleGranted(item.memberModule, entitlements.enabledModules);
      return true;
    })
    .sort((left, right) => GROUP_ORDER.indexOf(left.group) - GROUP_ORDER.indexOf(right.group));
}

export function useVisibleNavigation() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const entitlements = useEntitlements();
  const propertiesEnabled = Boolean(
    session?.user.id &&
    session.user.organizationId === entitlements.organizationId &&
    evaluateSessionUser(session.user).ok &&
    entitlements.vertical === 'HOSPITALITY' &&
    isModuleGranted('hotel-core', entitlements.enabledModules)
  );
  // One read for the whole rail: the member's assigned properties, each with
  // the capabilities this member holds there, every one resolved through the
  // same scope check the pages repeat — so the rail never shows an entry its
  // page would refuse.
  const properties = trpc.hotelProperty.access.propertiesByCapability.useQuery(
    { capabilities: HOTEL_RAIL_CAPABILITIES },
    {
      enabled: propertiesEnabled,
      retry: false,
      staleTime: 0,
      refetchOnMount: 'always',
    }
  );
  const refetchProperties = properties.refetch;
  useEffect(() => {
    if (propertiesEnabled) void refetchProperties();
  }, [propertiesEnabled, session?.user.id, session?.user.organizationId, refetchProperties]);
  // A cached response for another signed-in identity cannot expose an entry.
  const current = Boolean(
    propertiesEnabled &&
    !properties.isError &&
    !properties.isFetching &&
    properties.data?.userId === session?.user.id &&
    properties.data?.organizationId === session?.user.organizationId
  );
  const hotelCapabilities =
    current && properties.data
      ? [...new Set(properties.data.properties.flatMap((property) => property.capabilities))]
      : NO_HOTEL_CAPABILITIES;
  const safetyModule =
    entitlements.vertical === 'PHARMACY' &&
    isModuleGranted('pharmacy-safety', entitlements.enabledModules);
  const safetyAccess = trpc.pharmacySafety.access.useQuery(undefined, {
    enabled: safetyModule,
    retry: false,
    staleTime: 30_000,
  });
  // #979: the rest of the pharmacy rail, resolved by the same ABAC engine the
  // pages use. Pharmacy Core is mandatory, so every pharmacy workspace asks.
  const pharmacyRail =
    entitlements.vertical === 'PHARMACY' &&
    Boolean(session?.user.id) &&
    isModuleGranted('pharmacy-core', entitlements.enabledModules);
  const railAccess = trpc.pharmacyAccess.navigation.useQuery(undefined, {
    enabled: pharmacyRail,
    // A transient failure must not leave the rail without entries the member
    // holds; only an authorization refusal is final.
    retry: (failures, error) => failures < 2 && error.data?.code !== 'FORBIDDEN',
    staleTime: 30_000,
  });
  // A cached answer for another signed-in identity cannot expose an entry.
  const railCapabilities =
    pharmacyRail && railAccess.data && railAccess.data.userId === session?.user.id
      ? railAccess.data.capabilities
      : [];
  const sopAccess = trpc.pharmacySop.access.useQuery(undefined, {
    enabled: safetyModule,
    retry: false,
    staleTime: 30_000,
  });
  const pharmacyCapabilities = [
    ...(safetyAccess.data?.allowed ? ['pharmacy:safety'] : []),
    ...(sopAccess.data &&
    (sopAccess.data.canComplete || sopAccess.data.canVerify || sopAccess.data.canManage)
      ? ['pharmacy:sop']
      : []),
    ...railCapabilities,
  ];
  const filteredNav = visibleNavigation(
    entitlements,
    session?.user?.role,
    hotelCapabilities,
    pharmacyCapabilities
  );

  const indexByHref = new Map(filteredNav.map((item, i) => [item.href, i + 1]));
  const matchingHrefs = filteredNav
    .map((item) => item.href)
    .filter((href) => pathname === href || pathname.startsWith(href + '/'));
  const bestMatch = matchingHrefs.reduce(
    (best, href) => (href.length > best.length ? href : best),
    ''
  );

  return { bestMatch, filteredNav, indexByHref };
}

interface SidebarProps {
  brand?: TenantBrand;
  onNavigate?: () => void;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  collapsible?: boolean;
}

export function Sidebar({
  brand,
  onNavigate,
  collapsed: controlledCollapsed,
  onCollapsedChange,
  collapsible = true,
}: SidebarProps = {}) {
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const collapsed = controlledCollapsed ?? localCollapsed;
  const { data: session } = useSession();
  const { icons } = usePreferences();
  const { bestMatch, filteredNav, indexByHref } = useVisibleNavigation();
  const numbered = icons !== 'architectural';

  const getInitials = (name: string) =>
    name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);

  let renderIndex = 0;

  const toggleCollapsed = () => {
    const next = !collapsed;
    if (controlledCollapsed == null) setLocalCollapsed(next);
    onCollapsedChange?.(next);
  };

  return (
    <aside
      role="navigation"
      aria-label="Main navigation"
      data-collapsed={collapsed || undefined}
      className={cn(
        'studio-drawer fixed start-0 top-0 z-40 flex h-dvh flex-col border-e border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-300 ease-out',
        collapsed ? 'w-16' : 'w-[min(20rem,88vw)]'
      )}
    >
      {/* Wordmark */}
      <div
        className={cn(
          'flex h-20 items-center border-b border-sidebar-border px-5',
          collapsed ? 'justify-center' : 'gap-3'
        )}
      >
        {brand?.markUrl || brand?.logoUrl ? (
          <Image
            src={brand.markUrl ?? brand.logoUrl ?? ''}
            alt=""
            width={36}
            height={36}
            unoptimized
            className="h-9 w-9 shrink-0 rounded-lg object-contain"
          />
        ) : (
          <FathomMark className="h-9 w-9 shrink-0" variant="brand" />
        )}
        {!collapsed && (
          <div className="flex flex-col overflow-hidden animate-fade-in">
            <span className="font-display text-[15px] font-semibold tracking-[-0.025em] text-sidebar-accent-foreground">
              {brand?.displayName ?? 'DevFathom'}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-sidebar-foreground/55">
              Company workspace
            </span>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-5">
        {GROUP_ORDER.map((group) => {
          const items = filteredNav.filter((i) => i.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="space-y-1">
              {!collapsed && (
                <p className="px-2 pb-2 font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-sidebar-foreground/45">
                  Runbook / {group}
                </p>
              )}
              {items.map((item) => {
                const isActive = item.href === bestMatch;
                const Icon = item.icon;
                const num = indexByHref.get(item.href) ?? 0;
                const animIndex = renderIndex++;

                const link = (
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'group relative flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors duration-150',
                      collapsed && 'justify-center px-0',
                      isActive
                        ? 'text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground/85 hover:bg-white/[0.06] hover:text-sidebar-accent-foreground'
                    )}
                  >
                    {isActive && (
                      <m.span
                        layoutId="sidebar-active"
                        className="absolute inset-0 rounded-xl bg-sidebar-accent shadow-sm"
                        style={{ boxShadow: 'inset 3px 0 0 0 var(--sidebar-primary)' }}
                        transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                      />
                    )}
                    {/* Index (numeric) or architectural icon */}
                    {numbered ? (
                      <span
                        className={cn(
                          'relative z-10 w-5 shrink-0 text-center font-mono text-[10px] tabular-nums transition-colors',
                          isActive
                            ? 'text-sidebar-primary'
                            : 'text-sidebar-foreground/45 group-hover:text-sidebar-foreground/70'
                        )}
                      >
                        {String(num).padStart(2, '0')}
                      </span>
                    ) : (
                      <Icon
                        className={cn(
                          'relative z-10 h-[18px] w-[18px] shrink-0 transition-colors',
                          isActive
                            ? 'text-sidebar-primary'
                            : 'text-sidebar-foreground/60 group-hover:text-sidebar-foreground'
                        )}
                      />
                    )}
                    {!collapsed && <span className="relative z-10 truncate">{item.label}</span>}
                  </Link>
                );

                const entry = collapsed ? (
                  <Tooltip>
                    <TooltipTrigger render={link} />
                    <TooltipContent side="right" className="font-medium">
                      {item.label}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  link
                );

                return (
                  <m.div
                    key={item.href}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{
                      delay: 0.03 * animIndex + 0.05,
                      duration: 0.4,
                      ease: easeOutExpo,
                    }}
                  >
                    {entry}
                  </m.div>
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* Collapse toggle */}
      {collapsible && (
        <button
          onClick={toggleCollapsed}
          className={cn(
            'mx-3 mb-3 flex min-h-11 items-center rounded-xl p-2 font-mono text-[9px] uppercase tracking-[0.16em] text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
            collapsed ? 'justify-center' : 'justify-between px-3'
          )}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {!collapsed && <span>Close rail</span>}
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      )}

      {/* User chip */}
      <div
        className={cn('border-t border-sidebar-border p-4', collapsed ? 'flex justify-center' : '')}
      >
        {session?.user && (
          <div className={cn('flex items-center gap-3', collapsed ? 'justify-center' : '')}>
            <Avatar className="h-9 w-9 shrink-0">
              <AvatarImage src={session.user.image ?? undefined} alt={session.user.name} />
              <AvatarFallback className="bg-sidebar-primary/20 text-xs font-medium text-sidebar-primary">
                {getInitials(session.user.name)}
              </AvatarFallback>
            </Avatar>
            {!collapsed && (
              <div className="flex flex-col overflow-hidden">
                <span className="truncate text-sm font-medium text-sidebar-accent-foreground">
                  {session.user.name}
                </span>
                <span className="truncate font-mono text-[11px] text-sidebar-foreground/50">
                  {session.user.title}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

export function TopNavigation() {
  const { icons } = usePreferences();
  const { bestMatch, filteredNav, indexByHref } = useVisibleNavigation();
  const numbered = icons !== 'architectural';

  return (
    <div className="studio-navigation hidden border-b border-border-subtle bg-card lg:block">
      <nav
        aria-label="Primary navigation"
        className="mx-auto flex h-14 w-full max-w-[1540px] items-center gap-1 overflow-x-auto px-8"
      >
        {filteredNav.map((item, index) => {
          const isActive = item.href === bestMatch;
          const beginsFirmGroup = item.group === 'Firm' && filteredNav[index - 1]?.group !== 'Firm';
          const Icon = item.icon;
          const num = indexByHref.get(item.href) ?? 0;

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'group relative isolate flex h-9 shrink-0 items-center gap-2 rounded-full px-3.5 text-xs font-medium text-text-muted transition-colors hover:bg-muted hover:text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive && 'text-primary-foreground hover:text-primary-foreground',
                beginsFirmGroup && 'ml-3'
              )}
            >
              {numbered ? (
                <span
                  className={cn(
                    'font-mono text-[10px] tabular-nums text-text-body',
                    isActive && 'text-accent-brand'
                  )}
                >
                  {String(num).padStart(2, '0')}
                </span>
              ) : (
                <Icon
                  className={cn(
                    'h-3.5 w-3.5 text-text-faint group-hover:text-text-muted',
                    isActive && 'text-accent-brand'
                  )}
                />
              )}
              <span>{item.label}</span>
              {isActive && (
                <m.span
                  layoutId="topnav-active"
                  className="absolute inset-0 -z-10 rounded-full bg-primary"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
