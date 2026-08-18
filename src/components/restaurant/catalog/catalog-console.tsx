'use client';

import { useRouter } from 'next/navigation';

import { useEntitlements } from '@/components/entitlements-provider';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export type CatalogSnapshot = {
  categories: Array<{ id: string; parentId: string | null; name: string; sortOrder: number }>;
  products: Array<{
    id: string;
    categoryId: string | null;
    type: 'ITEM' | 'COMBO';
    status: 'ACTIVE' | 'ARCHIVED';
    name: string;
    description: string | null;
    sortOrder: number;
    variants: Array<{ id: string; productId: string; name: string; sortOrder: number }>;
    modifierGroups: Array<{ id: string; modifierGroupId: string; sortOrder: number }>;
    allergens: Array<{ id: string; allergenId: string }>;
  }>;
  modifierGroups: Array<{
    id: string;
    name: string;
    minSelect: number;
    maxSelect: number | null;
    options: Array<{
      id: string;
      modifierGroupId: string;
      name: string;
      priceDelta: string;
      sortOrder: number;
    }>;
  }>;
  allergens: Array<{ id: string; name: string }>;
  units: Array<{ id: string; name: string; abbreviation: string | null }>;
  conversions: Array<{
    id: string;
    fromUnitId: string;
    toUnitId: string;
    factor: string;
  }>;
  ingredients: Array<{
    id: string;
    name: string;
    baseUnitId: string;
    referenceCost: string | null;
    allergens: Array<{ id: string; allergenId: string }>;
  }>;
  recipes: Array<{
    id: string;
    productId: string;
    variantId: string | null;
    name: string;
    versions: Array<{
      id: string;
      recipeId: string;
      versionNumber: number;
      status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED';
      yieldQuantity: string | null;
      yieldUnitId: string | null;
      portionCount: number | null;
      notes: string | null;
      activatedAt: string | null;
      supersededAt: string | null;
      lines: Array<{
        id: string;
        recipeVersionId: string;
        ingredientId: string | null;
        subRecipeId: string | null;
        quantity: string;
        unitId: string;
        sortOrder: number;
      }>;
    }>;
  }>;
};

type CatalogConsoleProps = {
  snapshot: CatalogSnapshot | null;
  canRead: boolean;
  canWrite: boolean;
  loadError?: boolean;
};

const sections = [
  ['products', 'Products'],
  ['categories', 'Categories'],
  ['modifiers', 'Modifiers'],
  ['allergens', 'Allergens'],
  ['units', 'Units'],
  ['ingredients', 'Ingredients'],
  ['recipes', 'Recipes'],
] as const;

export function RestaurantCatalogConsole({
  snapshot,
  canRead,
  canWrite,
  loadError = false,
}: CatalogConsoleProps) {
  const router = useRouter();
  const entitlements = useEntitlements();
  const menuModule = entitlements.modules.find((module) => module.key === 'restaurant-menu');
  const moduleEnabled =
    menuModule?.enabled ?? entitlements.enabledModules.includes('restaurant-menu');

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Catalog"
        description="Maintain sellable items, modifiers, allergens, measures, ingredients, and versioned recipes."
        actions={
          canRead ? (
            <StatusPill
              status={canWrite ? 'Editable' : 'Read only'}
              tone={canWrite ? 'success' : 'neutral'}
            />
          ) : null
        }
      />

      {!moduleEnabled ? (
        <SectionCard title="Menu and Costing module disabled">
          <div className="space-y-3" role="status">
            <StatusPill status="Disabled" tone="warning" />
            <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
              Catalog tools are unavailable for this organization. Enable Menu and Costing to load
              or manage canonical catalog data.
            </p>
          </div>
        </SectionCard>
      ) : loadError ? (
        <SectionCard title="Catalog could not be loaded">
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-destructive">
              Catalog data is safe, but the current snapshot is unavailable.
            </p>
            <Button type="button" variant="outline" onClick={() => router.refresh()}>
              Try again
            </Button>
          </div>
        </SectionCard>
      ) : !canRead ? (
        <SectionCard title="Catalog access unavailable">
          <p role="alert" className="text-sm text-destructive">
            You do not have permission to view the restaurant catalog.
          </p>
        </SectionCard>
      ) : snapshot ? (
        <Tabs defaultValue="products" className="min-w-0 gap-5">
          <div className="max-w-full overflow-x-auto pb-1">
            <TabsList className="min-w-max">
              {sections.map(([value, label]) => (
                <TabsTrigger key={value} value={value}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {sections.map(([value, label]) => {
            const count =
              value === 'modifiers' ? snapshot.modifierGroups.length : snapshot[value].length;
            return (
              <TabsContent key={value} value={value}>
                <SectionCard eyebrow="Canonical registry" title={`${count} ${label.toLowerCase()}`}>
                  <p className="text-sm text-text-muted">
                    {count === 0
                      ? `No ${label.toLowerCase()} yet.`
                      : `${label} loaded and ready to manage.`}
                  </p>
                </SectionCard>
              </TabsContent>
            );
          })}
        </Tabs>
      ) : null}
    </div>
  );
}
