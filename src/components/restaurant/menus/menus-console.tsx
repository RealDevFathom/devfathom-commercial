'use client';

import { useMemo, useState, useTransition, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { useEntitlements } from '@/components/entitlements-provider';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/lib/trpc';
import {
  OPERATIONAL_ORDER_CHANNELS,
  type OperationalOrderChannel,
  type OrderChannel,
} from '@/lib/restaurant/order-channels';

type Channel = OrderChannel;
type VersionStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED';
type PublicationStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';

export type MenusSnapshot = {
  brands: Array<{
    id: string;
    name: string;
    status: 'ACTIVE' | 'ARCHIVED';
    isDefault: boolean;
  }>;
  branches: Array<{
    id: string;
    name: string;
    timezone: string;
    active: boolean;
    isDefault: boolean;
  }>;
  products: Array<{
    id: string;
    name: string;
    status: 'ACTIVE' | 'ARCHIVED';
    variants: Array<{ id: string; productId: string; name: string }>;
  }>;
  menus: Array<{
    id: string;
    brandId: string;
    name: string;
    description: string | null;
    sections: Array<{
      id: string;
      menuId: string;
      name: string;
      sortOrder: number;
      items: Array<{
        id: string;
        sectionId: string;
        productId: string;
        variantId: string | null;
        displayName: string | null;
        sortOrder: number;
      }>;
    }>;
  }>;
  priceLists: Array<{
    id: string;
    name: string;
    isDefault: boolean;
    versions: Array<{
      id: string;
      priceListId: string;
      versionNumber: number;
      effectiveFrom: string;
      status: VersionStatus;
      activatedAt: string | null;
      supersededAt: string | null;
      entries: Array<{
        id: string;
        priceListVersionId: string;
        productId: string;
        variantId: string | null;
        price: string;
      }>;
    }>;
  }>;
  publications: Array<{
    id: string;
    branchId: string;
    menuId: string;
    priceListId: string | null;
    status: PublicationStatus;
    channels: Channel[];
    publishedAt: string | null;
    retiredAt: string | null;
    windows: Array<{
      id: string;
      publicationId: string;
      menuItemId: string | null;
      label: string | null;
      daysOfWeek: number[];
      startMinutes: number;
      endMinutes: number;
    }>;
    exceptions: Array<{
      id: string;
      publicationId: string;
      date: string;
      isClosed: boolean;
      label: string | null;
    }>;
    itemOverrides: Array<{
      id: string;
      publicationId: string;
      menuItemId: string;
      isAvailable: boolean;
      priceOverride: string | null;
    }>;
  }>;
};

type Brand = MenusSnapshot['brands'][number];
type Menu = MenusSnapshot['menus'][number];
type MenuSection = Menu['sections'][number];
type MenuItem = MenuSection['items'][number];
type PriceList = MenusSnapshot['priceLists'][number];
type PriceVersion = PriceList['versions'][number];
type PriceEntry = PriceVersion['entries'][number];
type Publication = MenusSnapshot['publications'][number];
type PublicationWindow = Publication['windows'][number];
type PublicationException = Publication['exceptions'][number];
type ItemOverride = Publication['itemOverrides'][number];

type Editor =
  | { kind: 'brand'; item?: Brand }
  | { kind: 'menu'; item?: Menu }
  | { kind: 'section'; menuId: string; item?: MenuSection }
  | { kind: 'item'; sectionId: string; productId: string; item?: MenuItem }
  | { kind: 'priceList' }
  | { kind: 'priceVersion'; priceListId: string }
  | { kind: 'priceEntry'; versionId: string; productId: string; item?: PriceEntry }
  | { kind: 'publication' }
  | { kind: 'channels'; publication: Publication }
  | { kind: 'window'; publicationId: string; item?: PublicationWindow }
  | { kind: 'exception'; publicationId: string; item?: PublicationException }
  | { kind: 'override'; publicationId: string; menuItemId: string; item?: ItemOverride };

type Confirmation = {
  title: string;
  description: string;
  label: string;
  destructive?: boolean;
  run: () => void;
};

type PreviewInput = {
  publicationId: string;
  channel: OperationalOrderChannel;
  at?: Date;
};

type MenusConsoleProps = {
  snapshot: MenusSnapshot | null;
  canRead: boolean;
  canWrite: boolean;
  canPrice: boolean;
  canPublish: boolean;
  loadError?: boolean;
};

const channels: Channel[] = [...OPERATIONAL_ORDER_CHANNELS];
const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';
const selectClass =
  'h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="space-y-1.5">
      <span className={labelClass}>{label}</span>
      {children}
    </label>
  );
}

function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-dashed border-border-default px-5 py-10 text-center">
      <p className="font-medium text-text-strong">{title}</p>
      <p className="mt-1 text-sm text-text-muted">{detail}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

function text(data: FormData, name: string) {
  return String(data.get(name) ?? '').trim();
}

function integer(data: FormData, name: string, fallback = 0) {
  const value = text(data, name);
  return value === '' ? fallback : Number(value);
}

function timeToMinutes(value: string) {
  const [hours = '0', minutes = '0'] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

function minutesToTime(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function dateLabel(value: string | null) {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value)
      )
    : '—';
}

function statusTone(status: VersionStatus | PublicationStatus | Brand['status']) {
  if (status === 'ACTIVE' || status === 'PUBLISHED') return 'success' as const;
  if (status === 'DRAFT') return 'warning' as const;
  return 'neutral' as const;
}

function editorTitle(editor: Editor) {
  const edit = 'item' in editor && editor.item;
  const names: Record<Editor['kind'], string> = {
    brand: 'brand',
    menu: 'menu',
    section: 'section',
    item: 'menu item',
    priceList: 'price list',
    priceVersion: 'price-list version',
    priceEntry: 'price entry',
    publication: 'publication',
    channels: 'publication channels',
    window: 'availability window',
    exception: 'availability exception',
    override: 'item override',
  };
  return `${edit ? 'Edit' : editor.kind === 'channels' ? 'Set' : 'Add'} ${names[editor.kind]}`;
}

export function RestaurantMenusConsole({
  snapshot,
  canRead,
  canWrite,
  canPrice,
  canPublish,
  loadError = false,
}: MenusConsoleProps) {
  const router = useRouter();
  const entitlements = useEntitlements();
  const menuModule = entitlements.modules.find((module) => module.key === 'restaurant-menu');
  const moduleEnabled =
    menuModule?.enabled ?? entitlements.enabledModules.includes('restaurant-menu');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [selectedMenuId, setSelectedMenuId] = useState(snapshot?.menus[0]?.id ?? '');
  const [selectedPriceListId, setSelectedPriceListId] = useState(snapshot?.priceLists[0]?.id ?? '');
  const [selectedPublicationId, setSelectedPublicationId] = useState(
    snapshot?.publications[0]?.id ?? ''
  );
  const [previewRequest, setPreviewRequest] = useState<PreviewInput | null>(null);
  const [mutationError, setMutationError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [isRefreshing, startRefresh] = useTransition();

  const succeed = (message: string) => {
    setEditor(null);
    setConfirmation(null);
    setMutationError('');
    setStatusMessage(message);
    toast.success(message);
    startRefresh(() => router.refresh());
  };
  const fail = (error: { message: string }) => {
    setMutationError(error.message);
    setStatusMessage('');
    toast.error(error.message);
  };
  const options = (message: string) => ({ onSuccess: () => succeed(message), onError: fail });

  const ensureDefaultBrand = trpc.restaurantCatalog.ensureDefaultBrand.useMutation(
    options('Default brand created.')
  );
  const createBrand = trpc.restaurantCatalog.createBrand.useMutation(options('Brand created.'));
  const updateBrand = trpc.restaurantCatalog.updateBrand.useMutation(options('Brand updated.'));
  const setDefaultBrand = trpc.restaurantCatalog.setDefaultBrand.useMutation(
    options('Default brand updated.')
  );
  const setBrandStatus = trpc.restaurantCatalog.setBrandStatus.useMutation(
    options('Brand status updated.')
  );
  const createMenu = trpc.restaurantMenus.createMenu.useMutation(options('Menu created.'));
  const updateMenu = trpc.restaurantMenus.updateMenu.useMutation(options('Menu updated.'));
  const deleteMenu = trpc.restaurantMenus.deleteMenu.useMutation(options('Menu deleted.'));
  const createSection = trpc.restaurantMenus.createSection.useMutation(options('Section created.'));
  const updateSection = trpc.restaurantMenus.updateSection.useMutation(options('Section updated.'));
  const deleteSection = trpc.restaurantMenus.deleteSection.useMutation(options('Section deleted.'));
  const createItem = trpc.restaurantMenus.createItem.useMutation(options('Menu item added.'));
  const updateItem = trpc.restaurantMenus.updateItem.useMutation(options('Menu item updated.'));
  const deleteItem = trpc.restaurantMenus.deleteItem.useMutation(options('Menu item removed.'));
  const createPriceList = trpc.restaurantMenus.createPriceList.useMutation(
    options('Price list created.')
  );
  const createPriceListVersion = trpc.restaurantMenus.createPriceListVersion.useMutation(
    options('Draft price-list version created.')
  );
  const activatePriceListVersion = trpc.restaurantMenus.activatePriceListVersion.useMutation(
    options('Price-list version activated.')
  );
  const supersedePriceListVersion = trpc.restaurantMenus.supersedePriceListVersion.useMutation(
    options('Price-list version superseded.')
  );
  const addPriceEntry = trpc.restaurantMenus.addPriceEntry.useMutation(
    options('Price entry added.')
  );
  const updatePriceEntry = trpc.restaurantMenus.updatePriceEntry.useMutation(
    options('Price entry updated.')
  );
  const removePriceEntry = trpc.restaurantMenus.removePriceEntry.useMutation(
    options('Price entry removed.')
  );
  const createPublication = trpc.restaurantMenus.createPublication.useMutation(
    options('Draft publication created.')
  );
  const publishPublication = trpc.restaurantMenus.publishPublication.useMutation(
    options('Publication published.')
  );
  const retirePublication = trpc.restaurantMenus.retirePublication.useMutation(
    options('Publication retired.')
  );
  const setPublicationChannels = trpc.restaurantMenus.setPublicationChannels.useMutation(
    options('Publication channels updated.')
  );
  const addAvailabilityWindow = trpc.restaurantMenus.addAvailabilityWindow.useMutation(
    options('Availability window added.')
  );
  const removeAvailabilityWindow = trpc.restaurantMenus.removeAvailabilityWindow.useMutation(
    options('Availability window removed.')
  );
  const setAvailabilityException = trpc.restaurantMenus.setAvailabilityException.useMutation(
    options('Availability exception saved.')
  );
  const removeAvailabilityException = trpc.restaurantMenus.removeAvailabilityException.useMutation(
    options('Availability exception removed.')
  );
  const setItemOverride = trpc.restaurantMenus.setItemOverride.useMutation(
    options('Item override saved.')
  );
  const clearItemOverride = trpc.restaurantMenus.clearItemOverride.useMutation(
    options('Item override cleared.')
  );

  const preview = trpc.restaurantMenus.effectiveMenu.useQuery(
    previewRequest ?? { publicationId: '', channel: 'DINE_IN' },
    { enabled: previewRequest != null, retry: false }
  );

  const mutations = [
    ensureDefaultBrand,
    createBrand,
    updateBrand,
    setDefaultBrand,
    setBrandStatus,
    createMenu,
    updateMenu,
    deleteMenu,
    createSection,
    updateSection,
    deleteSection,
    createItem,
    updateItem,
    deleteItem,
    createPriceList,
    createPriceListVersion,
    activatePriceListVersion,
    supersedePriceListVersion,
    addPriceEntry,
    updatePriceEntry,
    removePriceEntry,
    createPublication,
    publishPublication,
    retirePublication,
    setPublicationChannels,
    addAvailabilityWindow,
    removeAvailabilityWindow,
    setAvailabilityException,
    removeAvailabilityException,
    setItemOverride,
    clearItemOverride,
  ] as const;
  const busy = isRefreshing || mutations.some((mutation) => mutation.isPending);

  const brandsById = useMemo(
    () => new Map(snapshot?.brands.map((item) => [item.id, item]) ?? []),
    [snapshot?.brands]
  );
  const branchesById = useMemo(
    () => new Map(snapshot?.branches.map((item) => [item.id, item]) ?? []),
    [snapshot?.branches]
  );
  const productsById = useMemo(
    () => new Map(snapshot?.products.map((item) => [item.id, item]) ?? []),
    [snapshot?.products]
  );
  const menusById = useMemo(
    () => new Map(snapshot?.menus.map((item) => [item.id, item]) ?? []),
    [snapshot?.menus]
  );
  const priceListsById = useMemo(
    () => new Map(snapshot?.priceLists.map((item) => [item.id, item]) ?? []),
    [snapshot?.priceLists]
  );
  const activeProducts = snapshot?.products.filter((product) => product.status === 'ACTIVE') ?? [];
  const selectedMenu = menusById.get(selectedMenuId) ?? snapshot?.menus[0];
  const selectedPriceList = priceListsById.get(selectedPriceListId) ?? snapshot?.priceLists[0];
  const selectedPublication =
    snapshot?.publications.find((item) => item.id === selectedPublicationId) ??
    snapshot?.publications[0];
  const publicationMenu = selectedPublication
    ? menusById.get(selectedPublication.menuId)
    : undefined;
  const publicationItems = publicationMenu?.sections.flatMap((section) => section.items) ?? [];

  const openEditor = (value: Editor) => {
    setMutationError('');
    setStatusMessage('');
    setEditor(value);
  };
  const ask = (value: Confirmation) => {
    setMutationError('');
    setStatusMessage('');
    setConfirmation(value);
  };

  const submitEditor = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || busy) return;
    setMutationError('');
    const data = new FormData(event.currentTarget);

    switch (editor.kind) {
      case 'brand':
        if (!canWrite) return;
        if (editor.item) updateBrand.mutate({ id: editor.item.id, name: text(data, 'name') });
        else createBrand.mutate({ name: text(data, 'name') });
        break;
      case 'menu': {
        if (!canWrite) return;
        const payload = {
          name: text(data, 'name'),
          description: text(data, 'description') || null,
        };
        if (editor.item) updateMenu.mutate({ id: editor.item.id, ...payload });
        else createMenu.mutate({ brandId: text(data, 'brandId'), ...payload });
        break;
      }
      case 'section': {
        if (!canWrite) return;
        const payload = { name: text(data, 'name'), sortOrder: integer(data, 'sortOrder') };
        if (editor.item) updateSection.mutate({ id: editor.item.id, ...payload });
        else createSection.mutate({ menuId: editor.menuId, ...payload });
        break;
      }
      case 'item': {
        if (!canWrite) return;
        const payload = {
          displayName: text(data, 'displayName') || null,
          sortOrder: integer(data, 'sortOrder'),
        };
        if (editor.item) updateItem.mutate({ id: editor.item.id, ...payload });
        else
          createItem.mutate({
            sectionId: editor.sectionId,
            productId: text(data, 'productId'),
            variantId: text(data, 'variantId') || null,
            ...payload,
          });
        break;
      }
      case 'priceList':
        if (!canPrice) return;
        createPriceList.mutate({
          name: text(data, 'name'),
          isDefault: data.has('isDefault'),
        });
        break;
      case 'priceVersion':
        if (!canPrice) return;
        createPriceListVersion.mutate({
          priceListId: editor.priceListId,
          effectiveFrom: new Date(text(data, 'effectiveFrom')),
        });
        break;
      case 'priceEntry':
        if (!canPrice) return;
        if (editor.item) {
          updatePriceEntry.mutate({ entryId: editor.item.id, price: text(data, 'price') });
        } else {
          addPriceEntry.mutate({
            priceListVersionId: editor.versionId,
            productId: text(data, 'productId'),
            variantId: text(data, 'variantId') || null,
            price: text(data, 'price'),
          });
        }
        break;
      case 'publication':
        if (!canPublish) return;
        createPublication.mutate({
          branchId: text(data, 'branchId'),
          menuId: text(data, 'menuId'),
          priceListId: text(data, 'priceListId') || null,
          channels: data.getAll('channels') as OperationalOrderChannel[],
        });
        break;
      case 'channels':
        if (!canPublish) return;
        setPublicationChannels.mutate({
          id: editor.publication.id,
          channels: data.getAll('channels') as OperationalOrderChannel[],
        });
        break;
      case 'window':
        if (!canPublish) return;
        addAvailabilityWindow.mutate({
          publicationId: editor.publicationId,
          menuItemId: text(data, 'menuItemId') || null,
          label: text(data, 'label') || null,
          daysOfWeek: data.getAll('daysOfWeek').map(Number),
          startMinutes: timeToMinutes(text(data, 'startTime')),
          endMinutes: timeToMinutes(text(data, 'endTime')),
        });
        break;
      case 'exception':
        if (!canPublish) return;
        setAvailabilityException.mutate({
          publicationId: editor.publicationId,
          date: new Date(`${text(data, 'date')}T00:00:00`),
          isClosed: data.has('isClosed'),
          label: text(data, 'label') || null,
        });
        break;
      case 'override':
        if (!canPrice) return;
        setItemOverride.mutate({
          publicationId: editor.publicationId,
          menuItemId: text(data, 'menuItemId'),
          isAvailable: data.has('isAvailable'),
          priceOverride: text(data, 'priceOverride') || null,
        });
        break;
    }
  };

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Menus & publishing"
        description="Operate brands, canonical menus, effective-dated prices, branch availability, and live channel output."
        actions={
          canRead ? (
            <div className="flex flex-wrap items-center justify-end gap-2" aria-live="polite">
              {busy ? <StatusPill status="Saving" tone="info" /> : null}
              <StatusPill
                status={canWrite || canPrice || canPublish ? 'Operational' : 'Read only'}
                tone={canWrite || canPrice || canPublish ? 'success' : 'neutral'}
              />
            </div>
          ) : null
        }
      />

      {!moduleEnabled ? (
        <SectionCard title="Menu and Costing module disabled">
          <div className="space-y-3" role="status">
            <StatusPill status="Disabled" tone="warning" />
            <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
              Menu authoring and branch publishing are unavailable for this organization. Enable
              Menu and Costing to open this workspace.
            </p>
          </div>
        </SectionCard>
      ) : loadError ? (
        <SectionCard title="Menus could not be loaded">
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-destructive">
              Restaurant data is safe, but the current workspace snapshot is unavailable.
            </p>
            <Button type="button" variant="outline" onClick={() => router.refresh()}>
              Try again
            </Button>
          </div>
        </SectionCard>
      ) : !canRead ? (
        <SectionCard title="Menu access unavailable">
          <p role="alert" className="text-sm text-destructive">
            You do not have permission to view restaurant menus or publications.
          </p>
        </SectionCard>
      ) : !snapshot ? (
        <SectionCard title="Loading menu workspace…">
          <p role="status" className="text-sm text-text-muted">
            Loading the latest menu snapshot.
          </p>
        </SectionCard>
      ) : (
        <>
          {!canWrite && !canPrice && !canPublish ? (
            <div
              role="status"
              className="rounded-md border border-border-default bg-surface-sunken px-4 py-3 text-sm text-text-muted"
            >
              Read-only access. Editing, pricing, and publishing controls are disabled for your
              role.
            </div>
          ) : null}
          <div className="sr-only" aria-live="polite">
            {statusMessage}
          </div>
          {mutationError ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            >
              {mutationError}
            </p>
          ) : null}

          <Tabs defaultValue="brands" className="min-w-0 gap-5">
            <div className="max-w-full overflow-x-auto pb-1">
              <TabsList className="min-w-max">
                <TabsTrigger value="brands">Brands ({snapshot.brands.length})</TabsTrigger>
                <TabsTrigger value="menus">Menus ({snapshot.menus.length})</TabsTrigger>
                <TabsTrigger value="prices">Price lists ({snapshot.priceLists.length})</TabsTrigger>
                <TabsTrigger value="publications">
                  Publications ({snapshot.publications.length})
                </TabsTrigger>
                <TabsTrigger value="preview">Effective preview</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="brands">
              <SectionCard
                eyebrow="Brand register"
                title={`${snapshot.brands.length} brand${snapshot.brands.length === 1 ? '' : 's'}`}
                titleLevel={2}
                actions={
                  <Button
                    className="min-h-11"
                    disabled={!canWrite || busy}
                    onClick={() => openEditor({ kind: 'brand' })}
                  >
                    Add brand
                  </Button>
                }
              >
                {snapshot.brands.length === 0 ? (
                  <EmptyState
                    title="No restaurant brand yet."
                    detail="Create the canonical default brand before authoring a menu."
                    action={
                      <Button
                        disabled={!canWrite || busy}
                        onClick={() => ensureDefaultBrand.mutate({ name: 'Default brand' })}
                      >
                        Create default brand
                      </Button>
                    }
                  />
                ) : (
                  <Table className="min-w-[680px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Brand</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Default</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snapshot.brands.map((brand) => (
                        <TableRow key={brand.id}>
                          <TableCell className="font-medium text-text-strong">
                            {brand.name}
                          </TableCell>
                          <TableCell>
                            <StatusPill status={brand.status} tone={statusTone(brand.status)} />
                          </TableCell>
                          <TableCell>{brand.isDefault ? 'Yes' : 'No'}</TableCell>
                          <TableCell>
                            <div className="flex flex-wrap justify-end gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!canWrite || busy}
                                onClick={() => openEditor({ kind: 'brand', item: brand })}
                              >
                                Edit
                              </Button>
                              {!brand.isDefault ? (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={!canWrite || busy || brand.status === 'ARCHIVED'}
                                  onClick={() => setDefaultBrand.mutate({ id: brand.id })}
                                >
                                  Make default
                                </Button>
                              ) : null}
                              <Button
                                size="sm"
                                variant={brand.status === 'ACTIVE' ? 'destructive' : 'outline'}
                                disabled={!canWrite || busy}
                                onClick={() => {
                                  if (brand.status === 'ARCHIVED') {
                                    setBrandStatus.mutate({ id: brand.id, status: 'ACTIVE' });
                                    return;
                                  }
                                  ask({
                                    title: `Archive ${brand.name}?`,
                                    description:
                                      'The brand and its historical records remain available. Restore it to author new menus.',
                                    label: 'Archive brand',
                                    destructive: true,
                                    run: () =>
                                      setBrandStatus.mutate({ id: brand.id, status: 'ARCHIVED' }),
                                  });
                                }}
                              >
                                {brand.status === 'ACTIVE' ? 'Archive' : 'Restore'}
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </SectionCard>
            </TabsContent>

            <TabsContent value="menus" className="space-y-5">
              <SectionCard
                eyebrow="Canonical structure"
                title="Brand menus"
                actions={
                  <Button
                    className="min-h-11"
                    disabled={!canWrite || busy || snapshot.brands.length === 0}
                    onClick={() => openEditor({ kind: 'menu' })}
                  >
                    Add menu
                  </Button>
                }
              >
                {snapshot.menus.length === 0 ? (
                  <EmptyState
                    title="No menus yet."
                    detail="Add a menu to an active brand, then organize it into sections and canonical items."
                  />
                ) : (
                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                    <Field label="Menu">
                      <select
                        value={selectedMenu?.id ?? ''}
                        className={selectClass}
                        onChange={(event) => setSelectedMenuId(event.target.value)}
                      >
                        {snapshot.menus.map((menu) => (
                          <option key={menu.id} value={menu.id}>
                            {brandsById.get(menu.brandId)?.name ?? 'Unknown brand'} — {menu.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {selectedMenu ? (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          disabled={!canWrite || busy}
                          onClick={() => openEditor({ kind: 'menu', item: selectedMenu })}
                        >
                          Edit menu
                        </Button>
                        <Button
                          variant="destructive"
                          disabled={!canWrite || busy}
                          onClick={() =>
                            ask({
                              title: `Delete ${selectedMenu.name}?`,
                              description:
                                'Published or referenced menus cannot be deleted. Existing branch records remain safe.',
                              label: 'Delete menu',
                              destructive: true,
                              run: () => deleteMenu.mutate({ id: selectedMenu.id }),
                            })
                          }
                        >
                          Delete menu
                        </Button>
                      </div>
                    ) : null}
                  </div>
                )}
              </SectionCard>

              {selectedMenu ? (
                <SectionCard
                  eyebrow={brandsById.get(selectedMenu.brandId)?.name ?? 'Brand'}
                  title={selectedMenu.name}
                  actions={
                    <Button
                      disabled={!canWrite || busy}
                      onClick={() => openEditor({ kind: 'section', menuId: selectedMenu.id })}
                    >
                      Add section
                    </Button>
                  }
                >
                  {selectedMenu.description ? (
                    <p className="mb-5 text-sm leading-relaxed text-text-muted">
                      {selectedMenu.description}
                    </p>
                  ) : null}
                  {selectedMenu.sections.length === 0 ? (
                    <EmptyState
                      title="No sections in this menu."
                      detail="Add a section such as Breakfast, Mains, or Drinks."
                    />
                  ) : (
                    <div className="space-y-5">
                      {selectedMenu.sections.map((section) => (
                        <div
                          key={section.id}
                          className="min-w-0 rounded-md border border-border-subtle bg-surface-raised p-4"
                        >
                          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <h4 className="font-display font-semibold text-text-strong">
                                {section.name}
                              </h4>
                              <p className="font-mono text-[0.6875rem] text-text-muted">
                                Order {section.sortOrder} · {section.items.length} items
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                disabled={!canWrite || busy || activeProducts.length === 0}
                                onClick={() =>
                                  openEditor({
                                    kind: 'item',
                                    sectionId: section.id,
                                    productId: activeProducts[0]?.id ?? '',
                                  })
                                }
                              >
                                Add item
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!canWrite || busy}
                                onClick={() =>
                                  openEditor({
                                    kind: 'section',
                                    menuId: selectedMenu.id,
                                    item: section,
                                  })
                                }
                              >
                                Edit
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={!canWrite || busy}
                                onClick={() =>
                                  ask({
                                    title: `Delete ${section.name}?`,
                                    description:
                                      'This removes the section and its menu-item placements. Canonical products are not deleted.',
                                    label: 'Delete section',
                                    destructive: true,
                                    run: () => deleteSection.mutate({ id: section.id }),
                                  })
                                }
                              >
                                Delete
                              </Button>
                            </div>
                          </div>
                          {section.items.length === 0 ? (
                            <p className="text-sm text-text-muted">No items in this section.</p>
                          ) : (
                            <Table className="min-w-[620px]">
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Menu item</TableHead>
                                  <TableHead>Canonical product</TableHead>
                                  <TableHead numeric>Order</TableHead>
                                  <TableHead className="text-right">Actions</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {section.items.map((item) => {
                                  const product = productsById.get(item.productId);
                                  const variant = product?.variants.find(
                                    (candidate) => candidate.id === item.variantId
                                  );
                                  return (
                                    <TableRow key={item.id}>
                                      <TableCell className="font-medium text-text-strong">
                                        {item.displayName || product?.name || 'Unknown item'}
                                      </TableCell>
                                      <TableCell className="text-text-muted">
                                        {product?.name ?? 'Unknown'}
                                        {variant ? ` · ${variant.name}` : ''}
                                      </TableCell>
                                      <TableCell numeric>{item.sortOrder}</TableCell>
                                      <TableCell>
                                        <div className="flex justify-end gap-2">
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={!canWrite || busy}
                                            onClick={() =>
                                              openEditor({
                                                kind: 'item',
                                                sectionId: section.id,
                                                productId: item.productId,
                                                item,
                                              })
                                            }
                                          >
                                            Edit
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="destructive"
                                            disabled={!canWrite || busy}
                                            onClick={() =>
                                              ask({
                                                title: 'Remove menu item?',
                                                description:
                                                  'This removes only the menu placement. The canonical product remains intact.',
                                                label: 'Remove item',
                                                destructive: true,
                                                run: () => deleteItem.mutate({ id: item.id }),
                                              })
                                            }
                                          >
                                            Remove
                                          </Button>
                                        </div>
                                      </TableCell>
                                    </TableRow>
                                  );
                                })}
                              </TableBody>
                            </Table>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </SectionCard>
              ) : null}
            </TabsContent>

            <TabsContent value="prices" className="space-y-5">
              <SectionCard
                eyebrow="Effective dating"
                title="Price lists"
                actions={
                  <Button
                    className="min-h-11"
                    disabled={!canPrice || busy}
                    onClick={() => openEditor({ kind: 'priceList' })}
                  >
                    Add price list
                  </Button>
                }
              >
                {snapshot.priceLists.length === 0 ? (
                  <EmptyState
                    title="No price lists yet."
                    detail="Create a list, open a dated draft, and add canonical product prices."
                  />
                ) : (
                  <Field label="Price list">
                    <select
                      value={selectedPriceList?.id ?? ''}
                      className={selectClass}
                      onChange={(event) => setSelectedPriceListId(event.target.value)}
                    >
                      {snapshot.priceLists.map((list) => (
                        <option key={list.id} value={list.id}>
                          {list.name}
                          {list.isDefault ? ' — default' : ''}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </SectionCard>

              {selectedPriceList ? (
                <SectionCard
                  eyebrow={selectedPriceList.isDefault ? 'Default price list' : 'Price list'}
                  title={selectedPriceList.name}
                  actions={
                    <Button
                      disabled={!canPrice || busy}
                      onClick={() =>
                        openEditor({ kind: 'priceVersion', priceListId: selectedPriceList.id })
                      }
                    >
                      New version
                    </Button>
                  }
                >
                  {selectedPriceList.versions.length === 0 ? (
                    <EmptyState
                      title="No versions yet."
                      detail="Open a draft version with its effective date."
                    />
                  ) : (
                    <div className="space-y-5">
                      {selectedPriceList.versions.map((version) => (
                        <div
                          key={version.id}
                          className="min-w-0 rounded-md border border-border-subtle p-4"
                        >
                          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                            <div className="space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <h4 className="font-display font-semibold text-text-strong">
                                  Version {version.versionNumber}
                                </h4>
                                <StatusPill
                                  status={version.status}
                                  tone={statusTone(version.status)}
                                />
                              </div>
                              <p className="text-xs text-text-muted">
                                Effective {dateLabel(version.effectiveFrom)} · Activated{' '}
                                {dateLabel(version.activatedAt)}
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {version.status === 'DRAFT' ? (
                                <>
                                  <Button
                                    size="sm"
                                    disabled={!canPrice || busy || activeProducts.length === 0}
                                    onClick={() =>
                                      openEditor({
                                        kind: 'priceEntry',
                                        versionId: version.id,
                                        productId: activeProducts[0]?.id ?? '',
                                      })
                                    }
                                  >
                                    Add price
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={!canPrice || busy}
                                    onClick={() =>
                                      ask({
                                        title: `Activate version ${version.versionNumber}?`,
                                        description:
                                          'Activation makes this version immutable and resolves it from its effective date.',
                                        label: 'Activate version',
                                        run: () =>
                                          activatePriceListVersion.mutate({
                                            versionId: version.id,
                                          }),
                                      })
                                    }
                                  >
                                    Activate
                                  </Button>
                                </>
                              ) : null}
                              {version.status === 'ACTIVE' ? (
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  disabled={!canPrice || busy}
                                  onClick={() =>
                                    ask({
                                      title: `Supersede version ${version.versionNumber}?`,
                                      description:
                                        'The version remains in history but stops being the active price source.',
                                      label: 'Supersede version',
                                      destructive: true,
                                      run: () =>
                                        supersedePriceListVersion.mutate({ versionId: version.id }),
                                    })
                                  }
                                >
                                  Supersede
                                </Button>
                              ) : null}
                            </div>
                          </div>
                          {version.entries.length === 0 ? (
                            <p className="text-sm text-text-muted">No price entries.</p>
                          ) : (
                            <Table className="min-w-[620px]">
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Product</TableHead>
                                  <TableHead>Variant</TableHead>
                                  <TableHead numeric>Price</TableHead>
                                  <TableHead className="text-right">Actions</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {version.entries.map((entry) => {
                                  const product = productsById.get(entry.productId);
                                  return (
                                    <TableRow key={entry.id}>
                                      <TableCell>{product?.name ?? 'Unknown'}</TableCell>
                                      <TableCell className="text-text-muted">
                                        {product?.variants.find(
                                          (variant) => variant.id === entry.variantId
                                        )?.name ?? 'Base product'}
                                      </TableCell>
                                      <TableCell numeric>{entry.price}</TableCell>
                                      <TableCell>
                                        <div className="flex justify-end gap-2">
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={
                                              !canPrice || busy || version.status !== 'DRAFT'
                                            }
                                            onClick={() =>
                                              openEditor({
                                                kind: 'priceEntry',
                                                versionId: version.id,
                                                productId: entry.productId,
                                                item: entry,
                                              })
                                            }
                                          >
                                            Edit
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="destructive"
                                            disabled={
                                              !canPrice || busy || version.status !== 'DRAFT'
                                            }
                                            onClick={() =>
                                              ask({
                                                title: 'Remove price entry?',
                                                description:
                                                  'The product remains canonical. This draft price row will be removed.',
                                                label: 'Remove price',
                                                destructive: true,
                                                run: () =>
                                                  removePriceEntry.mutate({ entryId: entry.id }),
                                              })
                                            }
                                          >
                                            Remove
                                          </Button>
                                        </div>
                                      </TableCell>
                                    </TableRow>
                                  );
                                })}
                              </TableBody>
                            </Table>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </SectionCard>
              ) : null}
            </TabsContent>

            <TabsContent value="publications" className="space-y-5">
              <SectionCard
                eyebrow="Branch register"
                title="Menu publications"
                actions={
                  <Button
                    className="min-h-11"
                    disabled={
                      !canPublish ||
                      busy ||
                      snapshot.branches.length === 0 ||
                      snapshot.menus.length === 0
                    }
                    onClick={() => openEditor({ kind: 'publication' })}
                  >
                    Add publication
                  </Button>
                }
              >
                {snapshot.publications.length === 0 ? (
                  <EmptyState
                    title="No branch publications yet."
                    detail="Bind a canonical menu to a branch, channels, and optional price list."
                  />
                ) : (
                  <Table className="min-w-[820px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Branch</TableHead>
                        <TableHead>Menu</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Channels</TableHead>
                        <TableHead>Price list</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snapshot.publications.map((publication) => (
                        <TableRow
                          key={publication.id}
                          aria-selected={selectedPublication?.id === publication.id}
                        >
                          <TableCell>
                            {branchesById.get(publication.branchId)?.name ?? 'Unknown'}
                          </TableCell>
                          <TableCell>
                            {menusById.get(publication.menuId)?.name ?? 'Unknown'}
                          </TableCell>
                          <TableCell>
                            <StatusPill
                              status={publication.status}
                              tone={statusTone(publication.status)}
                            />
                          </TableCell>
                          <TableCell>{publication.channels.join(', ') || 'None'}</TableCell>
                          <TableCell>
                            {publication.priceListId
                              ? (priceListsById.get(publication.priceListId)?.name ?? 'Unknown')
                              : 'Default fallback'}
                          </TableCell>
                          <TableCell>
                            <div className="flex justify-end">
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setSelectedPublicationId(publication.id)}
                              >
                                Manage
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </SectionCard>

              {selectedPublication ? (
                <SectionCard
                  eyebrow={branchesById.get(selectedPublication.branchId)?.timezone ?? 'Branch'}
                  title={`${branchesById.get(selectedPublication.branchId)?.name ?? 'Unknown branch'} · ${menusById.get(selectedPublication.menuId)?.name ?? 'Unknown menu'}`}
                  actions={
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        variant="outline"
                        disabled={!canPublish || busy || selectedPublication.status === 'RETIRED'}
                        onClick={() =>
                          openEditor({ kind: 'channels', publication: selectedPublication })
                        }
                      >
                        Channels
                      </Button>
                      {selectedPublication.status === 'DRAFT' ? (
                        <Button
                          disabled={!canPublish || busy}
                          onClick={() =>
                            ask({
                              title: 'Publish this branch menu?',
                              description:
                                'Its configured channels, price list, availability, and overrides become live.',
                              label: 'Publish menu',
                              run: () => publishPublication.mutate({ id: selectedPublication.id }),
                            })
                          }
                        >
                          Publish
                        </Button>
                      ) : null}
                      {selectedPublication.status === 'PUBLISHED' ? (
                        <Button
                          variant="destructive"
                          disabled={!canPublish || busy}
                          onClick={() =>
                            ask({
                              title: 'Retire this publication?',
                              description:
                                'The branch menu stops serving live channels. History remains available.',
                              label: 'Retire publication',
                              destructive: true,
                              run: () => retirePublication.mutate({ id: selectedPublication.id }),
                            })
                          }
                        >
                          Retire
                        </Button>
                      ) : null}
                    </div>
                  }
                >
                  <div className="mb-5 flex flex-wrap items-center gap-3">
                    <StatusPill
                      status={selectedPublication.status}
                      tone={statusTone(selectedPublication.status)}
                    />
                    <span className="text-xs text-text-muted">
                      Published {dateLabel(selectedPublication.publishedAt)} · Retired{' '}
                      {dateLabel(selectedPublication.retiredAt)}
                    </span>
                  </div>

                  <div className="grid gap-5 xl:grid-cols-3">
                    <div className="min-w-0 space-y-3 rounded-md border border-border-subtle p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="font-display font-semibold text-text-strong">Dayparts</h4>
                        <Button
                          size="sm"
                          disabled={!canPublish || busy || selectedPublication.status === 'RETIRED'}
                          onClick={() =>
                            openEditor({
                              kind: 'window',
                              publicationId: selectedPublication.id,
                            })
                          }
                        >
                          Add window
                        </Button>
                      </div>
                      {selectedPublication.windows.length === 0 ? (
                        <p className="text-sm text-text-muted">No windows; availability is open.</p>
                      ) : (
                        <div className="divide-y divide-border-subtle">
                          {selectedPublication.windows.map((window) => (
                            <div
                              key={window.id}
                              className="flex items-start justify-between gap-3 py-3"
                            >
                              <div className="min-w-0 text-sm">
                                <p className="font-medium text-text-strong">
                                  {window.label ||
                                    (window.menuItemId ? 'Item window' : 'Publication window')}
                                </p>
                                <p className="text-xs text-text-muted">
                                  {window.daysOfWeek.map((day) => dayNames[day]).join(', ') ||
                                    'No days'}{' '}
                                  · {minutesToTime(window.startMinutes)}–
                                  {minutesToTime(window.endMinutes)}
                                </p>
                              </div>
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={!canPublish || busy}
                                onClick={() =>
                                  ask({
                                    title: 'Remove availability window?',
                                    description: 'This daypart stops constraining the publication.',
                                    label: 'Remove window',
                                    destructive: true,
                                    run: () =>
                                      removeAvailabilityWindow.mutate({ windowId: window.id }),
                                  })
                                }
                              >
                                Remove
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 space-y-3 rounded-md border border-border-subtle p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="font-display font-semibold text-text-strong">Exceptions</h4>
                        <Button
                          size="sm"
                          disabled={!canPublish || busy || selectedPublication.status === 'RETIRED'}
                          onClick={() =>
                            openEditor({
                              kind: 'exception',
                              publicationId: selectedPublication.id,
                            })
                          }
                        >
                          Add exception
                        </Button>
                      </div>
                      {selectedPublication.exceptions.length === 0 ? (
                        <p className="text-sm text-text-muted">No calendar exceptions.</p>
                      ) : (
                        <div className="divide-y divide-border-subtle">
                          {selectedPublication.exceptions.map((exception) => (
                            <div
                              key={exception.id}
                              className="flex items-start justify-between gap-3 py-3"
                            >
                              <div className="text-sm">
                                <p className="font-medium text-text-strong">
                                  {new Date(exception.date).toLocaleDateString()}
                                </p>
                                <p className="text-xs text-text-muted">
                                  {exception.isClosed ? 'Closed' : 'Forced open'}
                                  {exception.label ? ` · ${exception.label}` : ''}
                                </p>
                              </div>
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={!canPublish || busy}
                                onClick={() =>
                                  ask({
                                    title: 'Remove availability exception?',
                                    description: 'Normal daypart rules will apply to this date.',
                                    label: 'Remove exception',
                                    destructive: true,
                                    run: () =>
                                      removeAvailabilityException.mutate({
                                        exceptionId: exception.id,
                                      }),
                                  })
                                }
                              >
                                Remove
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 space-y-3 rounded-md border border-border-subtle p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="font-display font-semibold text-text-strong">Overrides</h4>
                        <Button
                          size="sm"
                          disabled={
                            !canPrice ||
                            busy ||
                            publicationItems.length === 0 ||
                            selectedPublication.status === 'RETIRED'
                          }
                          onClick={() =>
                            openEditor({
                              kind: 'override',
                              publicationId: selectedPublication.id,
                              menuItemId: publicationItems[0]?.id ?? '',
                            })
                          }
                        >
                          Add override
                        </Button>
                      </div>
                      {selectedPublication.itemOverrides.length === 0 ? (
                        <p className="text-sm text-text-muted">
                          No availability or price overrides.
                        </p>
                      ) : (
                        <div className="divide-y divide-border-subtle">
                          {selectedPublication.itemOverrides.map((override) => {
                            const item = publicationItems.find(
                              (candidate) => candidate.id === override.menuItemId
                            );
                            const product = item ? productsById.get(item.productId) : undefined;
                            return (
                              <div
                                key={override.id}
                                className="flex items-start justify-between gap-3 py-3"
                              >
                                <div className="min-w-0 text-sm">
                                  <p className="truncate font-medium text-text-strong">
                                    {item?.displayName || product?.name || 'Unknown item'}
                                  </p>
                                  <p className="text-xs text-text-muted">
                                    {override.isAvailable ? 'Available' : 'Unavailable'} · Price{' '}
                                    {override.priceOverride ?? 'inherited'}
                                  </p>
                                </div>
                                <div className="flex gap-1">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={!canPrice || busy}
                                    onClick={() =>
                                      openEditor({
                                        kind: 'override',
                                        publicationId: selectedPublication.id,
                                        menuItemId: override.menuItemId,
                                        item: override,
                                      })
                                    }
                                  >
                                    Edit
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    disabled={!canPrice || busy}
                                    onClick={() =>
                                      ask({
                                        title: 'Clear item override?',
                                        description:
                                          'Availability and pricing return to publication and price-list rules.',
                                        label: 'Clear override',
                                        destructive: true,
                                        run: () =>
                                          clearItemOverride.mutate({ overrideId: override.id }),
                                      })
                                    }
                                  >
                                    Clear
                                  </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </SectionCard>
              ) : null}
            </TabsContent>

            <TabsContent value="preview" className="space-y-5">
              <SectionCard eyebrow="Read model" title="Effective menu preview">
                {snapshot.publications.length === 0 ? (
                  <EmptyState
                    title="No publication to preview."
                    detail="Create a branch publication before resolving its effective menu."
                  />
                ) : (
                  <form
                    className="grid gap-4 lg:grid-cols-4 lg:items-end"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const data = new FormData(event.currentTarget);
                      const instant = text(data, 'at');
                      setPreviewRequest({
                        publicationId: text(data, 'publicationId'),
                        channel: text(data, 'channel') as OperationalOrderChannel,
                        ...(instant ? { at: new Date(instant) } : {}),
                      });
                    }}
                  >
                    <Field label="Preview branch menu">
                      <select name="publicationId" className={selectClass} required>
                        {snapshot.publications.map((publication) => (
                          <option key={publication.id} value={publication.id}>
                            {branchesById.get(publication.branchId)?.name ?? 'Unknown branch'} —{' '}
                            {menusById.get(publication.menuId)?.name ?? 'Unknown menu'}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Preview channel">
                      <select name="channel" className={selectClass} defaultValue="DINE_IN">
                        {channels.map((channel) => (
                          <option key={channel} value={channel}>
                            {channel.replace('_', ' ')}
                          </option>
                        ))}
                        <option value="DELIVERY">DELIVERY</option>
                      </select>
                    </Field>
                    <Field label="Preview instant">
                      <Input name="at" type="datetime-local" className="h-11" />
                    </Field>
                    <Button type="submit" className="min-h-11" disabled={preview.isFetching}>
                      {preview.isFetching ? 'Resolving…' : 'Load effective menu'}
                    </Button>
                  </form>
                )}
              </SectionCard>

              {preview.error ? (
                <SectionCard title="Preview could not be resolved">
                  <p role="alert" className="text-sm text-destructive">
                    {preview.error.message}
                  </p>
                </SectionCard>
              ) : preview.data ? (
                <SectionCard
                  eyebrow={`${preview.data.publication.branch.name} · ${preview.data.publication.channel.replace('_', ' ')}`}
                  title={preview.data.menu.name}
                  actions={
                    <div className="flex flex-wrap gap-2">
                      <StatusPill status={preview.data.publication.status} />
                      <StatusPill
                        status={
                          preview.data.publication.channelPublished
                            ? 'Channel open'
                            : 'Channel closed'
                        }
                        tone={preview.data.publication.channelPublished ? 'success' : 'warning'}
                      />
                    </div>
                  }
                >
                  {preview.data.sections.length === 0 ? (
                    <EmptyState title="Effective menu is empty." detail="No sections resolved." />
                  ) : (
                    <div className="space-y-5">
                      {preview.data.sections.map((section) => (
                        <div key={section.id} className="min-w-0">
                          <h4 className="mb-2 font-display font-semibold text-text-strong">
                            {section.name}
                          </h4>
                          <Table className="min-w-[620px]">
                            <TableHeader>
                              <TableRow>
                                <TableHead>Item</TableHead>
                                <TableHead>Availability</TableHead>
                                <TableHead>Price source</TableHead>
                                <TableHead numeric>Price</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {section.items.map((item) => (
                                <TableRow key={item.id}>
                                  <TableCell className="font-medium text-text-strong">
                                    {item.displayName || item.product.name}
                                    {item.variant ? ` · ${item.variant.name}` : ''}
                                  </TableCell>
                                  <TableCell>
                                    <StatusPill
                                      status={item.available ? 'Available' : 'Unavailable'}
                                      tone={item.available ? 'success' : 'danger'}
                                    />
                                  </TableCell>
                                  <TableCell className="text-text-muted">
                                    {item.priceSource.replaceAll('_', ' ')}
                                  </TableCell>
                                  <TableCell numeric>{item.price ?? '—'}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      ))}
                    </div>
                  )}
                </SectionCard>
              ) : previewRequest ? (
                <SectionCard title="Resolving effective menu…">
                  <p role="status" className="text-sm text-text-muted">
                    Applying channel, branch timezone, daypart, exception, and price precedence.
                  </p>
                </SectionCard>
              ) : null}
            </TabsContent>
          </Tabs>
        </>
      )}

      <Dialog
        open={editor != null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setEditor(null);
            setMutationError('');
          }
        }}
      >
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
          {editor ? (
            <form className="space-y-4" onSubmit={submitEditor}>
              <DialogHeader>
                <DialogTitle>{editorTitle(editor)}</DialogTitle>
                <DialogDescription>
                  Changes use the capability-gated restaurant catalog and menu procedures.
                </DialogDescription>
              </DialogHeader>

              {editor.kind === 'brand' ? (
                <Field label="Brand name">
                  <Input
                    name="name"
                    required
                    maxLength={200}
                    defaultValue={editor.item?.name}
                    className="h-11"
                  />
                </Field>
              ) : null}

              {editor.kind === 'menu' ? (
                <>
                  {!editor.item ? (
                    <Field label="Brand">
                      <select name="brandId" required className={selectClass}>
                        {snapshot?.brands
                          .filter((brand) => brand.status === 'ACTIVE')
                          .map((brand) => (
                            <option key={brand.id} value={brand.id}>
                              {brand.name}
                            </option>
                          ))}
                      </select>
                    </Field>
                  ) : null}
                  <Field label="Menu name">
                    <Input
                      name="name"
                      required
                      maxLength={200}
                      defaultValue={editor.item?.name}
                      className="h-11"
                    />
                  </Field>
                  <Field label="Description">
                    <Textarea
                      name="description"
                      maxLength={2000}
                      defaultValue={editor.item?.description ?? ''}
                    />
                  </Field>
                </>
              ) : null}

              {editor.kind === 'section' ? (
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
                  <Field label="Section name">
                    <Input
                      name="name"
                      required
                      maxLength={200}
                      defaultValue={editor.item?.name}
                      className="h-11"
                    />
                  </Field>
                  <Field label="Sort order">
                    <Input
                      name="sortOrder"
                      type="number"
                      defaultValue={editor.item?.sortOrder ?? 0}
                      className="h-11"
                    />
                  </Field>
                </div>
              ) : null}

              {editor.kind === 'item' ? (
                <>
                  {editor.item ? (
                    <p className="rounded-md bg-surface-sunken p-3 text-sm text-text-muted">
                      Canonical product and variant cannot change after placement. Remove and add a
                      new item to replace them.
                    </p>
                  ) : (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Canonical product">
                        <select
                          name="productId"
                          required
                          value={editor.productId}
                          className={selectClass}
                          onChange={(event) =>
                            setEditor({ ...editor, productId: event.target.value })
                          }
                        >
                          {activeProducts.map((product) => (
                            <option key={product.id} value={product.id}>
                              {product.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Canonical variant">
                        <select name="variantId" defaultValue="" className={selectClass}>
                          <option value="">Base product</option>
                          {productsById.get(editor.productId)?.variants.map((variant) => (
                            <option key={variant.id} value={variant.id}>
                              {variant.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>
                  )}
                  <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
                    <Field label="Display name">
                      <Input
                        name="displayName"
                        maxLength={200}
                        defaultValue={editor.item?.displayName ?? ''}
                        className="h-11"
                      />
                    </Field>
                    <Field label="Sort order">
                      <Input
                        name="sortOrder"
                        type="number"
                        defaultValue={editor.item?.sortOrder ?? 0}
                        className="h-11"
                      />
                    </Field>
                  </div>
                </>
              ) : null}

              {editor.kind === 'priceList' ? (
                <>
                  <Field label="Price-list name">
                    <Input name="name" required maxLength={200} className="h-11" />
                  </Field>
                  <label className="flex min-h-11 items-center gap-3 rounded-md border border-border-default px-3 text-sm text-text-strong">
                    <input name="isDefault" type="checkbox" />
                    Use as default fallback price list
                  </label>
                </>
              ) : null}

              {editor.kind === 'priceVersion' ? (
                <Field label="Effective from">
                  <Input name="effectiveFrom" type="datetime-local" required className="h-11" />
                </Field>
              ) : null}

              {editor.kind === 'priceEntry' ? (
                <>
                  {editor.item ? (
                    <p className="rounded-md bg-surface-sunken p-3 text-sm text-text-muted">
                      Product and variant are fixed for this draft entry.
                    </p>
                  ) : (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Canonical product">
                        <select
                          name="productId"
                          required
                          value={editor.productId}
                          className={selectClass}
                          onChange={(event) =>
                            setEditor({ ...editor, productId: event.target.value })
                          }
                        >
                          {activeProducts.map((product) => (
                            <option key={product.id} value={product.id}>
                              {product.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Canonical variant">
                        <select name="variantId" defaultValue="" className={selectClass}>
                          <option value="">Base product</option>
                          {productsById.get(editor.productId)?.variants.map((variant) => (
                            <option key={variant.id} value={variant.id}>
                              {variant.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>
                  )}
                  <Field label="Price">
                    <Input
                      name="price"
                      type="number"
                      min="0"
                      step="0.01"
                      required
                      defaultValue={editor.item?.price}
                      className="h-11"
                    />
                  </Field>
                </>
              ) : null}

              {editor.kind === 'publication' ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Branch">
                      <select name="branchId" required className={selectClass}>
                        {snapshot?.branches.map((branch) => (
                          <option key={branch.id} value={branch.id} disabled={!branch.active}>
                            {branch.name}
                            {branch.active ? '' : ' — inactive'}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Menu">
                      <select name="menuId" required className={selectClass}>
                        {snapshot?.menus.map((menu) => (
                          <option key={menu.id} value={menu.id}>
                            {menu.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field label="Publication price list">
                    <select name="priceListId" defaultValue="" className={selectClass}>
                      <option value="">Default fallback only</option>
                      {snapshot?.priceLists.map((list) => (
                        <option key={list.id} value={list.id}>
                          {list.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              ) : null}

              {editor.kind === 'publication' || editor.kind === 'channels' ? (
                <fieldset className="space-y-2">
                  <legend className={labelClass}>Order channels</legend>
                  <div className="flex flex-wrap gap-3">
                    {channels.map((channel) => (
                      <label
                        key={channel}
                        className="flex min-h-11 items-center gap-2 rounded-md border border-border-default px-3 text-sm text-text-strong"
                      >
                        <input
                          name="channels"
                          type="checkbox"
                          value={channel}
                          defaultChecked={
                            editor.kind === 'channels'
                              ? editor.publication.channels.includes(channel)
                              : false
                          }
                        />
                        {channel.replace('_', ' ')}
                      </label>
                    ))}
                    <label className="flex min-h-11 items-center gap-2 rounded-md border border-border-default px-3 text-sm text-text-muted">
                      <input name="channels" type="checkbox" value="DELIVERY" />
                      DELIVERY
                    </label>
                  </div>
                </fieldset>
              ) : null}

              {editor.kind === 'window' ? (
                <>
                  <Field label="Scope">
                    <select name="menuItemId" defaultValue="" className={selectClass}>
                      <option value="">Whole publication</option>
                      {publicationItems.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.displayName ||
                            productsById.get(item.productId)?.name ||
                            'Unknown item'}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Daypart label">
                    <Input name="label" maxLength={120} className="h-11" />
                  </Field>
                  <fieldset className="space-y-2">
                    <legend className={labelClass}>Days of week</legend>
                    <div className="flex flex-wrap gap-2">
                      {dayNames.map((day, index) => (
                        <label
                          key={day}
                          className="flex min-h-11 items-center gap-2 rounded-md border border-border-default px-3 text-sm"
                        >
                          <input name="daysOfWeek" type="checkbox" value={index} />
                          {day}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Starts">
                      <Input name="startTime" type="time" required className="h-11" />
                    </Field>
                    <Field label="Ends">
                      <Input name="endTime" type="time" required className="h-11" />
                    </Field>
                  </div>
                </>
              ) : null}

              {editor.kind === 'exception' ? (
                <>
                  <Field label="Branch-local date">
                    <Input
                      name="date"
                      type="date"
                      required
                      defaultValue={editor.item?.date.slice(0, 10)}
                      className="h-11"
                    />
                  </Field>
                  <Field label="Exception label">
                    <Input
                      name="label"
                      maxLength={120}
                      defaultValue={editor.item?.label ?? ''}
                      className="h-11"
                    />
                  </Field>
                  <label className="flex min-h-11 items-center gap-3 rounded-md border border-border-default px-3 text-sm text-text-strong">
                    <input
                      name="isClosed"
                      type="checkbox"
                      defaultChecked={editor.item?.isClosed ?? true}
                    />
                    Close menu on this date
                  </label>
                </>
              ) : null}

              {editor.kind === 'override' ? (
                <>
                  <Field label="Menu item">
                    <select
                      name="menuItemId"
                      required
                      value={editor.menuItemId}
                      disabled={Boolean(editor.item)}
                      className={selectClass}
                      onChange={(event) => setEditor({ ...editor, menuItemId: event.target.value })}
                    >
                      {publicationItems.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.displayName ||
                            productsById.get(item.productId)?.name ||
                            'Unknown item'}
                        </option>
                      ))}
                    </select>
                    {editor.item ? (
                      <input type="hidden" name="menuItemId" value={editor.menuItemId} />
                    ) : null}
                  </Field>
                  <Field label="Price override">
                    <Input
                      name="priceOverride"
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue={editor.item?.priceOverride ?? ''}
                      className="h-11"
                    />
                  </Field>
                  <label className="flex min-h-11 items-center gap-3 rounded-md border border-border-default px-3 text-sm text-text-strong">
                    <input
                      name="isAvailable"
                      type="checkbox"
                      defaultChecked={editor.item?.isAvailable ?? true}
                    />
                    Item available
                  </label>
                </>
              ) : null}

              {mutationError ? (
                <p
                  role="alert"
                  className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
                >
                  {mutationError}
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={busy}
                  onClick={() => setEditor(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" className="min-h-11" disabled={busy}>
                  {busy ? 'Saving…' : editorTitle(editor)}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmation != null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setConfirmation(null);
            setMutationError('');
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{confirmation?.title}</DialogTitle>
            <DialogDescription>{confirmation?.description}</DialogDescription>
          </DialogHeader>
          {mutationError ? (
            <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {mutationError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={confirmation?.destructive ? 'destructive' : 'default'}
              className="min-h-11"
              disabled={busy}
              onClick={() => confirmation?.run()}
            >
              {busy ? 'Working…' : confirmation?.label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
