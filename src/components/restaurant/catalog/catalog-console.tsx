'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

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
    comboComponentGroups: Array<{
      id: string;
      comboProductId: string;
      name: string;
      minChoose: number;
      maxChoose: number | null;
      sortOrder: number;
      options: Array<{
        id: string;
        componentGroupId: string;
        productId: string;
        variantId: string | null;
        priceDelta: string;
        sortOrder: number;
      }>;
    }>;
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
        approvedSubstitutes: Array<{ id: string; substituteIngredientId: string }>;
      }>;
    }>;
  }>;
};

type Category = CatalogSnapshot['categories'][number];
type Product = CatalogSnapshot['products'][number];
type Variant = Product['variants'][number];
type ModifierGroup = CatalogSnapshot['modifierGroups'][number];
type ModifierOption = ModifierGroup['options'][number];
type Allergen = CatalogSnapshot['allergens'][number];
type Unit = CatalogSnapshot['units'][number];
type Conversion = CatalogSnapshot['conversions'][number];
type Ingredient = CatalogSnapshot['ingredients'][number];
type Recipe = CatalogSnapshot['recipes'][number];
type RecipeVersion = Recipe['versions'][number];
type RecipeLine = RecipeVersion['lines'][number];
type ComboGroup = Product['comboComponentGroups'][number];
type ComboOption = ComboGroup['options'][number];

type Editor =
  | { kind: 'category'; item?: Category }
  | { kind: 'product'; item?: Product }
  | { kind: 'variant'; productId: string; item?: Variant }
  | { kind: 'modifierGroup'; item?: ModifierGroup }
  | { kind: 'modifierOption'; modifierGroupId: string; item?: ModifierOption }
  | { kind: 'allergen'; item?: Allergen }
  | { kind: 'unit'; item?: Unit }
  | { kind: 'conversion'; item?: Conversion }
  | { kind: 'ingredient'; item?: Ingredient }
  | { kind: 'recipe'; productId: string }
  | { kind: 'recipeVersion'; recipeId: string; item?: RecipeVersion }
  | { kind: 'comboGroup'; comboProductId: string; item?: ComboGroup }
  | { kind: 'comboOption'; componentGroupId: string; productId?: string; item?: ComboOption }
  | {
      kind: 'recipeLine';
      recipeId: string;
      recipeVersionId: string;
      sourceType: 'ingredient' | 'recipe';
      item?: RecipeLine;
    };

type Confirmation = {
  title: string;
  description: string;
  label: string;
  destructive?: boolean;
  run: () => void;
};

type CatalogConsoleProps = {
  snapshot: CatalogSnapshot | null;
  canRead: boolean;
  canWrite: boolean;
  loadError?: boolean;
};

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';
const selectClass =
  'h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';

function formText(data: FormData, name: string) {
  return String(data.get(name) ?? '').trim();
}

function formInt(data: FormData, name: string, fallback = 0) {
  const value = formText(data, name);
  return value === '' ? fallback : Number(value);
}

function nullableInt(data: FormData, name: string) {
  const value = formText(data, name);
  return value === '' ? null : Number(value);
}

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

function editorTitle(editor: Editor) {
  const editing = 'item' in editor && editor.item;
  const names: Record<Editor['kind'], string> = {
    category: 'category',
    product: 'product',
    variant: 'variant',
    modifierGroup: 'modifier group',
    modifierOption: 'modifier option',
    allergen: 'allergen',
    unit: 'unit',
    conversion: 'conversion',
    ingredient: 'ingredient',
    recipe: 'recipe',
    recipeVersion: 'recipe version',
    recipeLine: 'recipe line',
    comboGroup: 'combo group',
    comboOption: 'combo option',
  };
  return `${editing ? 'Edit' : 'Add'} ${names[editor.kind]}`;
}

function recipeStatusTone(status: RecipeVersion['status']) {
  if (status === 'ACTIVE') return 'success' as const;
  if (status === 'DRAFT') return 'warning' as const;
  return 'neutral' as const;
}

export function RestaurantCatalogConsole({
  snapshot,
  canRead,
  canWrite,
  loadError = false,
}: CatalogConsoleProps) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const entitlements = useEntitlements();
  const menuModule = entitlements.modules.find((module) => module.key === 'restaurant-menu');
  const moduleEnabled =
    menuModule?.enabled ?? entitlements.enabledModules.includes('restaurant-menu');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [selectedModifierGroupId, setSelectedModifierGroupId] = useState<string | null>(null);
  const [selectedIngredientId, setSelectedIngredientId] = useState<string | null>(null);
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState('');
  const [isRefreshing, startRefresh] = useTransition();

  const succeed = (message: string, closeEditor = true) => {
    if (closeEditor) setEditor(null);
    setConfirmation(null);
    setMutationError('');
    toast.success(message);
    void utils.restaurantCatalog.getRecipeCost.invalidate();
    startRefresh(() => router.refresh());
  };
  const fail = (error: { message: string }) => {
    setMutationError(error.message);
    toast.error(error.message);
  };
  const options = (message: string, closeEditor = true) => ({
    onSuccess: () => succeed(message, closeEditor),
    onError: fail,
  });

  const createCategory = trpc.restaurantCatalog.createCategory.useMutation(
    options('Category created.')
  );
  const updateCategory = trpc.restaurantCatalog.updateCategory.useMutation(
    options('Category updated.')
  );
  const deleteCategory = trpc.restaurantCatalog.deleteCategory.useMutation(
    options('Category deleted.', false)
  );
  const createProduct = trpc.restaurantCatalog.createProduct.useMutation(
    options('Product created.')
  );
  const updateProduct = trpc.restaurantCatalog.updateProduct.useMutation(
    options('Product updated.')
  );
  const setProductStatus = trpc.restaurantCatalog.setProductStatus.useMutation(
    options('Product status updated.', false)
  );
  const createVariant = trpc.restaurantCatalog.createVariant.useMutation(
    options('Variant created.')
  );
  const updateVariant = trpc.restaurantCatalog.updateVariant.useMutation(
    options('Variant updated.')
  );
  const deleteVariant = trpc.restaurantCatalog.deleteVariant.useMutation(
    options('Variant deleted.', false)
  );
  const createModifierGroup = trpc.restaurantCatalog.createModifierGroup.useMutation(
    options('Modifier group created.')
  );
  const updateModifierGroup = trpc.restaurantCatalog.updateModifierGroup.useMutation(
    options('Modifier group updated.')
  );
  const deleteModifierGroup = trpc.restaurantCatalog.deleteModifierGroup.useMutation(
    options('Modifier group deleted.', false)
  );
  const createModifierOption = trpc.restaurantCatalog.createModifierOption.useMutation(
    options('Modifier option created.')
  );
  const updateModifierOption = trpc.restaurantCatalog.updateModifierOption.useMutation(
    options('Modifier option updated.')
  );
  const deleteModifierOption = trpc.restaurantCatalog.deleteModifierOption.useMutation(
    options('Modifier option deleted.', false)
  );
  const attachModifierGroup = trpc.restaurantCatalog.attachModifierGroup.useMutation(
    options('Modifier group attached.', false)
  );
  const detachModifierGroup = trpc.restaurantCatalog.detachModifierGroup.useMutation(
    options('Modifier group detached.', false)
  );
  const createComboGroup = trpc.restaurantCatalog.createComboGroup.useMutation(
    options('Combo group created.')
  );
  const updateComboGroup = trpc.restaurantCatalog.updateComboGroup.useMutation(
    options('Combo group updated.')
  );
  const deleteComboGroup = trpc.restaurantCatalog.deleteComboGroup.useMutation(
    options('Combo group deleted.', false)
  );
  const createComboOption = trpc.restaurantCatalog.createComboOption.useMutation(
    options('Combo option created.')
  );
  const updateComboOption = trpc.restaurantCatalog.updateComboOption.useMutation(
    options('Combo option updated.')
  );
  const deleteComboOption = trpc.restaurantCatalog.deleteComboOption.useMutation(
    options('Combo option deleted.', false)
  );
  const createAllergen = trpc.restaurantCatalog.createAllergen.useMutation(
    options('Allergen created.')
  );
  const updateAllergen = trpc.restaurantCatalog.updateAllergen.useMutation(
    options('Allergen updated.')
  );
  const deleteAllergen = trpc.restaurantCatalog.deleteAllergen.useMutation(
    options('Allergen deleted.', false)
  );
  const attachProductAllergen = trpc.restaurantCatalog.attachProductAllergen.useMutation(
    options('Product allergen attached.', false)
  );
  const detachProductAllergen = trpc.restaurantCatalog.detachProductAllergen.useMutation(
    options('Product allergen detached.', false)
  );
  const createUnit = trpc.restaurantCatalog.createUnit.useMutation(options('Unit created.'));
  const updateUnit = trpc.restaurantCatalog.updateUnit.useMutation(options('Unit updated.'));
  const deleteUnit = trpc.restaurantCatalog.deleteUnit.useMutation(options('Unit deleted.', false));
  const upsertConversion = trpc.restaurantCatalog.upsertConversion.useMutation(
    options('Conversion saved.')
  );
  const deleteConversion = trpc.restaurantCatalog.deleteConversion.useMutation(
    options('Conversion deleted.', false)
  );
  const createIngredient = trpc.restaurantCatalog.createIngredient.useMutation(
    options('Ingredient created.')
  );
  const updateIngredient = trpc.restaurantCatalog.updateIngredient.useMutation(
    options('Ingredient updated.')
  );
  const attachIngredientAllergen = trpc.restaurantCatalog.attachIngredientAllergen.useMutation(
    options('Ingredient allergen attached.', false)
  );
  const detachIngredientAllergen = trpc.restaurantCatalog.detachIngredientAllergen.useMutation(
    options('Ingredient allergen detached.', false)
  );
  const createRecipe = trpc.restaurantCatalog.createRecipe.useMutation(options('Recipe created.'));
  const createRecipeVersion = trpc.restaurantCatalog.createRecipeVersion.useMutation(
    options('Draft version created.')
  );
  const updateRecipeVersion = trpc.restaurantCatalog.updateRecipeVersion.useMutation(
    options('Draft version updated.')
  );
  const activateRecipeVersion = trpc.restaurantCatalog.activateRecipeVersion.useMutation(
    options('Recipe version activated.', false)
  );
  const createRecipeLine = trpc.restaurantCatalog.createRecipeLine.useMutation(
    options('Recipe line created.')
  );
  const updateRecipeLine = trpc.restaurantCatalog.updateRecipeLine.useMutation(
    options('Recipe line updated.')
  );
  const deleteRecipeLine = trpc.restaurantCatalog.deleteRecipeLine.useMutation(
    options('Recipe line deleted.', false)
  );
  const addRecipeLineSubstitute = trpc.restaurantCatalog.addRecipeLineSubstitute.useMutation(
    options('Approved substitute attached.', false)
  );
  const removeRecipeLineSubstitute = trpc.restaurantCatalog.removeRecipeLineSubstitute.useMutation(
    options('Approved substitute removed.', false)
  );

  const busy =
    isRefreshing ||
    [
      createCategory,
      updateCategory,
      deleteCategory,
      createProduct,
      updateProduct,
      setProductStatus,
      createVariant,
      updateVariant,
      deleteVariant,
      createModifierGroup,
      updateModifierGroup,
      deleteModifierGroup,
      createModifierOption,
      updateModifierOption,
      deleteModifierOption,
      attachModifierGroup,
      detachModifierGroup,
      createComboGroup,
      updateComboGroup,
      deleteComboGroup,
      createComboOption,
      updateComboOption,
      deleteComboOption,
      createAllergen,
      updateAllergen,
      deleteAllergen,
      attachProductAllergen,
      detachProductAllergen,
      createUnit,
      updateUnit,
      deleteUnit,
      upsertConversion,
      deleteConversion,
      createIngredient,
      updateIngredient,
      attachIngredientAllergen,
      detachIngredientAllergen,
      createRecipe,
      createRecipeVersion,
      updateRecipeVersion,
      activateRecipeVersion,
      createRecipeLine,
      updateRecipeLine,
      deleteRecipeLine,
      addRecipeLineSubstitute,
      removeRecipeLineSubstitute,
    ].some((mutation) => mutation.isPending);

  const categoriesById = useMemo(
    () => new Map(snapshot?.categories.map((item) => [item.id, item]) ?? []),
    [snapshot?.categories]
  );
  const productsById = useMemo(
    () => new Map(snapshot?.products.map((item) => [item.id, item]) ?? []),
    [snapshot?.products]
  );
  const modifierGroupsById = useMemo(
    () => new Map(snapshot?.modifierGroups.map((item) => [item.id, item]) ?? []),
    [snapshot?.modifierGroups]
  );
  const allergensById = useMemo(
    () => new Map(snapshot?.allergens.map((item) => [item.id, item]) ?? []),
    [snapshot?.allergens]
  );
  const unitsById = useMemo(
    () => new Map(snapshot?.units.map((item) => [item.id, item]) ?? []),
    [snapshot?.units]
  );
  const ingredientsById = useMemo(
    () => new Map(snapshot?.ingredients.map((item) => [item.id, item]) ?? []),
    [snapshot?.ingredients]
  );
  const recipesById = useMemo(
    () => new Map(snapshot?.recipes.map((item) => [item.id, item]) ?? []),
    [snapshot?.recipes]
  );
  const selectedProduct = selectedProductId ? productsById.get(selectedProductId) : undefined;
  const selectedModifierGroup = selectedModifierGroupId
    ? modifierGroupsById.get(selectedModifierGroupId)
    : undefined;
  const selectedIngredient = selectedIngredientId
    ? ingredientsById.get(selectedIngredientId)
    : undefined;
  const selectedRecipe = selectedRecipeId ? recipesById.get(selectedRecipeId) : undefined;
  const costVersion = selectedRecipe?.versions[0];
  const recipeCost = trpc.restaurantCatalog.getRecipeCost.useQuery(
    { recipeId: selectedRecipe?.id ?? '', versionId: costVersion?.id },
    { enabled: Boolean(selectedRecipe && costVersion && canRead) }
  );

  const openEditor = (value: Editor) => {
    setMutationError('');
    setEditor(value);
  };
  const ask = (value: Confirmation) => {
    setMutationError('');
    setConfirmation(value);
  };

  const submitEditor = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || busy || !canWrite) return;
    setMutationError('');
    const data = new FormData(event.currentTarget);
    switch (editor.kind) {
      case 'category': {
        const payload = {
          name: formText(data, 'name'),
          parentId: formText(data, 'parentId') || null,
          sortOrder: formInt(data, 'sortOrder'),
        };
        if (editor.item) updateCategory.mutate({ id: editor.item.id, ...payload });
        else createCategory.mutate(payload);
        break;
      }
      case 'product': {
        const payload = {
          name: formText(data, 'name'),
          description: formText(data, 'description') || null,
          categoryId: formText(data, 'categoryId') || null,
          sortOrder: formInt(data, 'sortOrder'),
        };
        if (editor.item) updateProduct.mutate({ id: editor.item.id, ...payload });
        else createProduct.mutate({ ...payload, type: formText(data, 'type') as 'ITEM' | 'COMBO' });
        break;
      }
      case 'comboGroup': {
        const payload = {
          name: formText(data, 'name'),
          minChoose: formInt(data, 'minChoose'),
          maxChoose: nullableInt(data, 'maxChoose'),
          sortOrder: formInt(data, 'sortOrder'),
        };
        if (editor.item) updateComboGroup.mutate({ id: editor.item.id, ...payload });
        else createComboGroup.mutate({ comboProductId: editor.comboProductId, ...payload });
        break;
      }
      case 'comboOption': {
        const payload = {
          priceDelta: formText(data, 'priceDelta') || '0',
          sortOrder: formInt(data, 'sortOrder'),
        };
        if (editor.item) updateComboOption.mutate({ id: editor.item.id, ...payload });
        else
          createComboOption.mutate({
            componentGroupId: editor.componentGroupId,
            productId: formText(data, 'productId'),
            variantId: formText(data, 'variantId') || null,
            ...payload,
          });
        break;
      }
      case 'variant': {
        const payload = {
          name: formText(data, 'name'),
          sortOrder: formInt(data, 'sortOrder'),
        };
        if (editor.item) updateVariant.mutate({ id: editor.item.id, ...payload });
        else createVariant.mutate({ productId: editor.productId, ...payload });
        break;
      }
      case 'modifierGroup': {
        const payload = {
          name: formText(data, 'name'),
          minSelect: formInt(data, 'minSelect'),
          maxSelect: nullableInt(data, 'maxSelect'),
        };
        if (editor.item) updateModifierGroup.mutate({ id: editor.item.id, ...payload });
        else createModifierGroup.mutate(payload);
        break;
      }
      case 'modifierOption': {
        const payload = {
          name: formText(data, 'name'),
          priceDelta: formText(data, 'priceDelta') || '0',
          sortOrder: formInt(data, 'sortOrder'),
        };
        if (editor.item) updateModifierOption.mutate({ id: editor.item.id, ...payload });
        else createModifierOption.mutate({ modifierGroupId: editor.modifierGroupId, ...payload });
        break;
      }
      case 'allergen': {
        const name = formText(data, 'name');
        if (editor.item) updateAllergen.mutate({ id: editor.item.id, name });
        else createAllergen.mutate({ name });
        break;
      }
      case 'unit': {
        const payload = {
          name: formText(data, 'name'),
          abbreviation: formText(data, 'abbreviation') || null,
        };
        if (editor.item) updateUnit.mutate({ id: editor.item.id, ...payload });
        else createUnit.mutate(payload);
        break;
      }
      case 'conversion':
        upsertConversion.mutate({
          fromUnitId: formText(data, 'fromUnitId'),
          toUnitId: formText(data, 'toUnitId'),
          factor: formText(data, 'factor'),
        });
        break;
      case 'ingredient': {
        const payload = {
          name: formText(data, 'name'),
          baseUnitId: formText(data, 'baseUnitId'),
          referenceCost: formText(data, 'referenceCost') || null,
        };
        if (editor.item) updateIngredient.mutate({ id: editor.item.id, ...payload });
        else createIngredient.mutate(payload);
        break;
      }
      case 'recipe':
        createRecipe.mutate({
          name: formText(data, 'name'),
          productId: formText(data, 'productId'),
          variantId: formText(data, 'variantId') || null,
        });
        break;
      case 'recipeVersion': {
        const payload = {
          yieldQuantity: formText(data, 'yieldQuantity') || null,
          yieldUnitId: formText(data, 'yieldUnitId') || null,
          portionCount: nullableInt(data, 'portionCount'),
          notes: formText(data, 'notes') || null,
        };
        if (editor.item) updateRecipeVersion.mutate({ id: editor.item.id, ...payload });
        else createRecipeVersion.mutate({ recipeId: editor.recipeId, ...payload });
        break;
      }
      case 'recipeLine': {
        const payload = {
          quantity: formText(data, 'quantity'),
          unitId: formText(data, 'unitId'),
          sortOrder: formInt(data, 'sortOrder'),
        };
        if (editor.item) {
          updateRecipeLine.mutate({ id: editor.item.id, ...payload });
        } else {
          const sourceId = formText(data, 'sourceId');
          createRecipeLine.mutate(
            editor.sourceType === 'ingredient'
              ? { recipeVersionId: editor.recipeVersionId, ingredientId: sourceId, ...payload }
              : { recipeVersionId: editor.recipeVersionId, subRecipeId: sourceId, ...payload }
          );
        }
        break;
      }
    }
  };

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Catalog"
        description="Maintain sellable items, modifiers, allergens, measures, ingredients, and versioned recipes."
        actions={
          canRead ? (
            <div className="flex items-center gap-2" aria-live="polite">
              {busy ? <StatusPill status="Saving" tone="info" /> : null}
              <StatusPill
                status={canWrite ? 'Editable' : 'Read only'}
                tone={canWrite ? 'success' : 'neutral'}
              />
            </div>
          ) : null
        }
      />

      {!moduleEnabled ? (
        <SectionCard title="Menu and Costing module disabled" titleLevel={2}>
          <div className="space-y-3" role="status">
            <StatusPill status="Disabled" tone="warning" />
            <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
              Catalog tools are unavailable for this organization. Enable Menu and Costing to load
              or manage canonical catalog data.
            </p>
          </div>
        </SectionCard>
      ) : loadError ? (
        <SectionCard title="Catalog could not be loaded" titleLevel={2}>
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
        <SectionCard title="Catalog access unavailable" titleLevel={2}>
          <p role="alert" className="text-sm text-destructive">
            You do not have permission to view the restaurant catalog.
          </p>
        </SectionCard>
      ) : snapshot ? (
        <>
          {!canWrite ? (
            <div
              role="status"
              className="rounded-md border border-border-default bg-surface-sunken px-4 py-3 text-sm text-text-muted"
            >
              Read-only access. A role carrying <span className="font-mono">menu:write</span> is
              required to change catalog data.
            </div>
          ) : null}

          <Tabs defaultValue="products" className="min-w-0 gap-5">
            <div className="max-w-full overflow-x-auto pb-1">
              <TabsList className="min-w-max">
                <TabsTrigger value="products">Products ({snapshot.products.length})</TabsTrigger>
                <TabsTrigger value="categories">
                  Categories ({snapshot.categories.length})
                </TabsTrigger>
                <TabsTrigger value="modifiers">
                  Modifiers ({snapshot.modifierGroups.length})
                </TabsTrigger>
                <TabsTrigger value="allergens">Allergens ({snapshot.allergens.length})</TabsTrigger>
                <TabsTrigger value="units">Units ({snapshot.units.length})</TabsTrigger>
                <TabsTrigger value="ingredients">
                  Ingredients ({snapshot.ingredients.length})
                </TabsTrigger>
                <TabsTrigger value="recipes">Recipes ({snapshot.recipes.length})</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="products" className="space-y-5">
              <SectionCard
                eyebrow="Sellable registry"
                title={`${snapshot.products.length} product${snapshot.products.length === 1 ? '' : 's'}`}
                titleLevel={2}
                actions={
                  canWrite ? (
                    <Button className="min-h-11" onClick={() => openEditor({ kind: 'product' })}>
                      Add product
                    </Button>
                  ) : null
                }
              >
                {snapshot.products.length === 0 ? (
                  <EmptyState
                    title="No products yet."
                    detail="Add the first sellable item, then attach variants, modifiers, and allergens."
                    action={
                      canWrite ? (
                        <Button onClick={() => openEditor({ kind: 'product' })}>Add product</Button>
                      ) : undefined
                    }
                  />
                ) : (
                  <Table className="min-w-[760px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Product</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead numeric>Variants</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snapshot.products.map((product) => (
                        <TableRow key={product.id} aria-selected={selectedProductId === product.id}>
                          <TableCell>
                            <span className="block font-medium text-text-strong">
                              {product.name}
                            </span>
                            <span className="block max-w-72 truncate text-xs text-text-muted">
                              {product.description ?? product.id}
                            </span>
                          </TableCell>
                          <TableCell className="text-text-muted">
                            {product.categoryId
                              ? (categoriesById.get(product.categoryId)?.name ?? 'Unknown')
                              : 'Uncategorized'}
                          </TableCell>
                          <TableCell>
                            <StatusPill
                              status={product.status}
                              tone={product.status === 'ACTIVE' ? 'success' : 'neutral'}
                            />
                          </TableCell>
                          <TableCell numeric>{product.variants.length}</TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setSelectedProductId(product.id)}
                              >
                                Manage
                              </Button>
                              {canWrite ? (
                                <>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={busy}
                                    onClick={() => openEditor({ kind: 'product', item: product })}
                                  >
                                    Edit
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant={
                                      product.status === 'ACTIVE' ? 'destructive' : 'outline'
                                    }
                                    disabled={busy}
                                    onClick={() => {
                                      if (product.status === 'ARCHIVED') {
                                        setProductStatus.mutate({
                                          id: product.id,
                                          status: 'ACTIVE',
                                        });
                                        return;
                                      }
                                      ask({
                                        title: `Archive ${product.name}?`,
                                        description:
                                          'The product remains available to historical records and can be restored later.',
                                        label: 'Archive product',
                                        destructive: true,
                                        run: () =>
                                          setProductStatus.mutate({
                                            id: product.id,
                                            status: 'ARCHIVED',
                                          }),
                                      });
                                    }}
                                  >
                                    {product.status === 'ACTIVE' ? 'Archive' : 'Restore'}
                                  </Button>
                                </>
                              ) : null}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </SectionCard>

              {selectedProduct ? (
                <SectionCard
                  eyebrow="Product detail"
                  title={selectedProduct.name}
                  titleLevel={2}
                  actions={
                    <Button variant="ghost" onClick={() => setSelectedProductId(null)}>
                      Close
                    </Button>
                  }
                >
                  <div className="grid gap-6 xl:grid-cols-3">
                    <div className="min-w-0 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <h4 className="font-display font-semibold text-text-strong">Variants</h4>
                        {canWrite ? (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              openEditor({ kind: 'variant', productId: selectedProduct.id })
                            }
                          >
                            Add variant
                          </Button>
                        ) : null}
                      </div>
                      {selectedProduct.variants.length ? (
                        <div className="divide-y divide-border-subtle rounded-md border border-border-subtle">
                          {selectedProduct.variants.map((variant) => (
                            <div
                              key={variant.id}
                              className="flex items-center justify-between gap-3 p-3"
                            >
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-text-strong">
                                  {variant.name}
                                </p>
                                <p className="font-mono text-[0.6875rem] text-text-muted">
                                  Order {variant.sortOrder}
                                </p>
                              </div>
                              {canWrite ? (
                                <div className="flex gap-1">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={busy}
                                    onClick={() =>
                                      openEditor({
                                        kind: 'variant',
                                        productId: selectedProduct.id,
                                        item: variant,
                                      })
                                    }
                                  >
                                    Edit
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    disabled={busy}
                                    onClick={() =>
                                      ask({
                                        title: `Delete ${variant.name}?`,
                                        description:
                                          'Referenced variants cannot be deleted. Existing menu or price references remain safe.',
                                        label: 'Delete variant',
                                        destructive: true,
                                        run: () => deleteVariant.mutate({ id: variant.id }),
                                      })
                                    }
                                  >
                                    Delete
                                  </Button>
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-text-muted">No variants.</p>
                      )}
                    </div>

                    <div className="min-w-0 space-y-3">
                      <h4 className="font-display font-semibold text-text-strong">
                        Modifier groups
                      </h4>
                      {canWrite ? (
                        <form
                          className="flex gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const modifierGroupId = formText(
                              new FormData(event.currentTarget),
                              'modifierGroupId'
                            );
                            if (modifierGroupId) {
                              attachModifierGroup.mutate({
                                productId: selectedProduct.id,
                                modifierGroupId,
                              });
                            }
                          }}
                        >
                          <StudioSelect
                            aria-label="Modifier group to attach"
                            name="modifierGroupId"
                            required
                            defaultValue=""
                            className={selectClass}
                            disabled={busy}
                          >
                            <option value="" disabled>
                              Select group
                            </option>
                            {snapshot.modifierGroups
                              .filter(
                                (group) =>
                                  !selectedProduct.modifierGroups.some(
                                    (link) => link.modifierGroupId === group.id
                                  )
                              )
                              .map((group) => (
                                <option key={group.id} value={group.id}>
                                  {group.name}
                                </option>
                              ))}
                          </StudioSelect>
                          <Button type="submit" className="min-h-11" disabled={busy}>
                            Attach
                          </Button>
                        </form>
                      ) : null}
                      <div className="space-y-2">
                        {selectedProduct.modifierGroups.length ? (
                          selectedProduct.modifierGroups.map((link) => (
                            <div
                              key={link.id}
                              className="flex items-center justify-between gap-3 rounded-md border border-border-subtle p-3"
                            >
                              <span className="text-sm text-text-strong">
                                {modifierGroupsById.get(link.modifierGroupId)?.name ?? 'Unknown'}
                              </span>
                              {canWrite ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() =>
                                    detachModifierGroup.mutate({
                                      productId: selectedProduct.id,
                                      modifierGroupId: link.modifierGroupId,
                                    })
                                  }
                                >
                                  Detach
                                </Button>
                              ) : null}
                            </div>
                          ))
                        ) : (
                          <p className="text-sm text-text-muted">No modifier groups attached.</p>
                        )}
                      </div>
                    </div>

                    <div className="min-w-0 space-y-3">
                      <h4 className="font-display font-semibold text-text-strong">Allergens</h4>
                      {canWrite ? (
                        <form
                          className="flex gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const allergenId = formText(
                              new FormData(event.currentTarget),
                              'allergenId'
                            );
                            if (allergenId) {
                              attachProductAllergen.mutate({
                                productId: selectedProduct.id,
                                allergenId,
                              });
                            }
                          }}
                        >
                          <StudioSelect
                            aria-label="Allergen to attach to product"
                            name="allergenId"
                            required
                            defaultValue=""
                            className={selectClass}
                            disabled={busy}
                          >
                            <option value="" disabled>
                              Select allergen
                            </option>
                            {snapshot.allergens
                              .filter(
                                (allergen) =>
                                  !selectedProduct.allergens.some(
                                    (link) => link.allergenId === allergen.id
                                  )
                              )
                              .map((allergen) => (
                                <option key={allergen.id} value={allergen.id}>
                                  {allergen.name}
                                </option>
                              ))}
                          </StudioSelect>
                          <Button type="submit" className="min-h-11" disabled={busy}>
                            Attach
                          </Button>
                        </form>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        {selectedProduct.allergens.length ? (
                          selectedProduct.allergens.map((link) => (
                            <span
                              key={link.id}
                              className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-xs text-text-strong"
                            >
                              {allergensById.get(link.allergenId)?.name ?? 'Unknown'}
                              {canWrite ? (
                                <button
                                  type="button"
                                  className="rounded-sm px-1 text-text-muted hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  aria-label={`Detach ${allergensById.get(link.allergenId)?.name ?? 'allergen'}`}
                                  disabled={busy}
                                  onClick={() =>
                                    detachProductAllergen.mutate({
                                      productId: selectedProduct.id,
                                      allergenId: link.allergenId,
                                    })
                                  }
                                >
                                  ×
                                </button>
                              ) : null}
                            </span>
                          ))
                        ) : (
                          <p className="text-sm text-text-muted">No allergens declared.</p>
                        )}
                      </div>
                    </div>
                  </div>
                  {selectedProduct.type === 'COMBO' ? (
                    <div className="mt-6 space-y-3 border-t border-border-subtle pt-5">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h4 className="font-display font-semibold text-text-strong">
                            Combo choices
                          </h4>
                          <p className="text-sm text-text-muted">
                            Configure required choices and their component products.
                          </p>
                          <p className="text-sm text-text-muted">
                            Combos cannot be added to menus or ordered until the order flow supports
                            combo selections.
                          </p>
                        </div>
                        {canWrite ? (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              openEditor({
                                kind: 'comboGroup',
                                comboProductId: selectedProduct.id,
                              })
                            }
                          >
                            Add choice group
                          </Button>
                        ) : null}
                      </div>
                      {selectedProduct.comboComponentGroups.length ? (
                        <div className="grid gap-3 lg:grid-cols-2">
                          {selectedProduct.comboComponentGroups.map((group) => (
                            <div
                              key={group.id}
                              className="rounded-md border border-border-subtle bg-surface-raised p-4"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="font-medium text-text-strong">{group.name}</p>
                                  <p className="text-xs text-text-muted">
                                    Choose {group.minChoose}–{group.maxChoose ?? 'any'} · Order{' '}
                                    {group.sortOrder}
                                  </p>
                                </div>
                                {canWrite ? (
                                  <div className="flex gap-1">
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      disabled={busy}
                                      onClick={() =>
                                        openEditor({
                                          kind: 'comboGroup',
                                          comboProductId: selectedProduct.id,
                                          item: group,
                                        })
                                      }
                                    >
                                      Edit
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="destructive"
                                      disabled={busy}
                                      onClick={() =>
                                        ask({
                                          title: `Delete ${group.name}?`,
                                          description:
                                            'Its component options will also be removed.',
                                          label: 'Delete group',
                                          destructive: true,
                                          run: () => deleteComboGroup.mutate({ id: group.id }),
                                        })
                                      }
                                    >
                                      Delete
                                    </Button>
                                  </div>
                                ) : null}
                              </div>
                              <div className="mt-3 space-y-2">
                                {group.options.map((option) => {
                                  const component = productsById.get(option.productId);
                                  const variant = component?.variants.find(
                                    (item) => item.id === option.variantId
                                  );
                                  return (
                                    <div
                                      key={option.id}
                                      className="flex items-center justify-between gap-3 rounded-sm bg-surface-sunken p-3 text-sm"
                                    >
                                      <span className="text-text-strong">
                                        {component?.name ?? 'Unknown product'}
                                        {variant ? ` · ${variant.name}` : ''}
                                        <span className="ml-2 font-mono text-xs text-text-muted">
                                          {option.priceDelta}
                                        </span>
                                      </span>
                                      {canWrite ? (
                                        <div className="flex gap-1">
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={busy}
                                            onClick={() =>
                                              openEditor({
                                                kind: 'comboOption',
                                                componentGroupId: group.id,
                                                item: option,
                                              })
                                            }
                                          >
                                            Edit
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={busy}
                                            onClick={() =>
                                              ask({
                                                title: `Remove ${component?.name ?? 'component option'}?`,
                                                description:
                                                  'This component option and its price delta will be removed from the choice group.',
                                                label: 'Remove option',
                                                destructive: true,
                                                run: () =>
                                                  deleteComboOption.mutate({ id: option.id }),
                                              })
                                            }
                                          >
                                            Remove
                                          </Button>
                                        </div>
                                      ) : null}
                                    </div>
                                  );
                                })}
                                {group.options.length === 0 ? (
                                  <p className="text-sm text-text-muted">No component options.</p>
                                ) : null}
                              </div>
                              {canWrite ? (
                                <Button
                                  className="mt-3"
                                  size="sm"
                                  variant="secondary"
                                  disabled={busy || snapshot.products.length < 2}
                                  onClick={() =>
                                    openEditor({
                                      kind: 'comboOption',
                                      componentGroupId: group.id,
                                    })
                                  }
                                >
                                  Add component option
                                </Button>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-text-muted">
                          No combo choice groups configured.
                        </p>
                      )}
                    </div>
                  ) : null}
                </SectionCard>
              ) : null}
            </TabsContent>

            <TabsContent value="categories">
              <SectionCard
                eyebrow="Hierarchy"
                title={`${snapshot.categories.length} categor${snapshot.categories.length === 1 ? 'y' : 'ies'}`}
                titleLevel={2}
                actions={
                  canWrite ? (
                    <Button className="min-h-11" onClick={() => openEditor({ kind: 'category' })}>
                      Add category
                    </Button>
                  ) : null
                }
              >
                {snapshot.categories.length === 0 ? (
                  <EmptyState
                    title="No categories yet."
                    detail="Categories are optional; products can remain uncategorized."
                    action={
                      canWrite ? (
                        <Button onClick={() => openEditor({ kind: 'category' })}>
                          Add category
                        </Button>
                      ) : undefined
                    }
                  />
                ) : (
                  <Table className="min-w-[620px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Parent</TableHead>
                        <TableHead numeric>Order</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snapshot.categories.map((category) => (
                        <TableRow key={category.id}>
                          <TableCell className="font-medium text-text-strong">
                            {category.name}
                          </TableCell>
                          <TableCell className="text-text-muted">
                            {category.parentId
                              ? (categoriesById.get(category.parentId)?.name ?? 'Unknown')
                              : 'Top level'}
                          </TableCell>
                          <TableCell numeric>{category.sortOrder}</TableCell>
                          <TableCell>
                            {canWrite ? (
                              <div className="flex justify-end gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() => openEditor({ kind: 'category', item: category })}
                                >
                                  Edit
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  disabled={busy}
                                  onClick={() =>
                                    ask({
                                      title: `Delete ${category.name}?`,
                                      description:
                                        'Child categories and products become uncategorized; they are not deleted.',
                                      label: 'Delete category',
                                      destructive: true,
                                      run: () => deleteCategory.mutate({ id: category.id }),
                                    })
                                  }
                                >
                                  Delete
                                </Button>
                              </div>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </SectionCard>
            </TabsContent>

            <TabsContent value="modifiers" className="space-y-5">
              <SectionCard
                eyebrow="Reusable choices"
                title={`${snapshot.modifierGroups.length} modifier group${snapshot.modifierGroups.length === 1 ? '' : 's'}`}
                titleLevel={2}
                actions={
                  canWrite ? (
                    <Button
                      className="min-h-11"
                      onClick={() => openEditor({ kind: 'modifierGroup' })}
                    >
                      Add group
                    </Button>
                  ) : null
                }
              >
                {snapshot.modifierGroups.length === 0 ? (
                  <EmptyState
                    title="No modifier groups yet."
                    detail="Create a reusable choice group, then attach it to products."
                    action={
                      canWrite ? (
                        <Button onClick={() => openEditor({ kind: 'modifierGroup' })}>
                          Add group
                        </Button>
                      ) : undefined
                    }
                  />
                ) : (
                  <Table className="min-w-[700px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Group</TableHead>
                        <TableHead>Selection</TableHead>
                        <TableHead numeric>Options</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snapshot.modifierGroups.map((group) => (
                        <TableRow
                          key={group.id}
                          aria-selected={selectedModifierGroupId === group.id}
                        >
                          <TableCell className="font-medium text-text-strong">
                            {group.name}
                          </TableCell>
                          <TableCell className="text-text-muted">
                            {group.minSelect} to {group.maxSelect ?? 'any'}
                          </TableCell>
                          <TableCell numeric>{group.options.length}</TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setSelectedModifierGroupId(group.id)}
                              >
                                Options
                              </Button>
                              {canWrite ? (
                                <>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={busy}
                                    onClick={() =>
                                      openEditor({ kind: 'modifierGroup', item: group })
                                    }
                                  >
                                    Edit
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    disabled={busy}
                                    onClick={() =>
                                      ask({
                                        title: `Delete ${group.name}?`,
                                        description:
                                          'Its options and product attachments will also be removed.',
                                        label: 'Delete group',
                                        destructive: true,
                                        run: () => deleteModifierGroup.mutate({ id: group.id }),
                                      })
                                    }
                                  >
                                    Delete
                                  </Button>
                                </>
                              ) : null}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </SectionCard>

              {selectedModifierGroup ? (
                <SectionCard
                  eyebrow="Group options"
                  title={selectedModifierGroup.name}
                  titleLevel={2}
                  actions={
                    <div className="flex gap-2">
                      {canWrite ? (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            openEditor({
                              kind: 'modifierOption',
                              modifierGroupId: selectedModifierGroup.id,
                            })
                          }
                        >
                          Add option
                        </Button>
                      ) : null}
                      <Button variant="ghost" onClick={() => setSelectedModifierGroupId(null)}>
                        Close
                      </Button>
                    </div>
                  }
                >
                  {selectedModifierGroup.options.length ? (
                    <Table className="min-w-[620px]">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Option</TableHead>
                          <TableHead numeric>Price delta</TableHead>
                          <TableHead numeric>Order</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selectedModifierGroup.options.map((option) => (
                          <TableRow key={option.id}>
                            <TableCell className="font-medium text-text-strong">
                              {option.name}
                            </TableCell>
                            <TableCell numeric>{option.priceDelta}</TableCell>
                            <TableCell numeric>{option.sortOrder}</TableCell>
                            <TableCell>
                              {canWrite ? (
                                <div className="flex justify-end gap-2">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={busy}
                                    onClick={() =>
                                      openEditor({
                                        kind: 'modifierOption',
                                        modifierGroupId: selectedModifierGroup.id,
                                        item: option,
                                      })
                                    }
                                  >
                                    Edit
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    disabled={busy}
                                    onClick={() =>
                                      ask({
                                        title: `Delete ${option.name}?`,
                                        description: 'This modifier option will be removed.',
                                        label: 'Delete option',
                                        destructive: true,
                                        run: () => deleteModifierOption.mutate({ id: option.id }),
                                      })
                                    }
                                  >
                                    Delete
                                  </Button>
                                </div>
                              ) : null}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <EmptyState
                      title="No options in this group."
                      detail="Add the first customer choice."
                    />
                  )}
                </SectionCard>
              ) : null}
            </TabsContent>

            <TabsContent value="allergens">
              <SectionCard
                eyebrow="Safety registry"
                title={`${snapshot.allergens.length} allergen${snapshot.allergens.length === 1 ? '' : 's'}`}
                titleLevel={2}
                actions={
                  canWrite ? (
                    <Button className="min-h-11" onClick={() => openEditor({ kind: 'allergen' })}>
                      Add allergen
                    </Button>
                  ) : null
                }
              >
                {snapshot.allergens.length === 0 ? (
                  <EmptyState
                    title="No allergens tracked."
                    detail="Add allergens before declaring them on products or ingredients."
                  />
                ) : (
                  <Table className="min-w-[520px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snapshot.allergens.map((allergen) => (
                        <TableRow key={allergen.id}>
                          <TableCell>
                            <span className="block font-medium text-text-strong">
                              {allergen.name}
                            </span>
                            <span className="font-mono text-[0.6875rem] text-text-muted">
                              {allergen.id}
                            </span>
                          </TableCell>
                          <TableCell>
                            {canWrite ? (
                              <div className="flex justify-end gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() => openEditor({ kind: 'allergen', item: allergen })}
                                >
                                  Edit
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  disabled={busy}
                                  onClick={() =>
                                    ask({
                                      title: `Delete ${allergen.name}?`,
                                      description:
                                        'Product and ingredient declarations for this allergen will also be removed.',
                                      label: 'Delete allergen',
                                      destructive: true,
                                      run: () => deleteAllergen.mutate({ id: allergen.id }),
                                    })
                                  }
                                >
                                  Delete
                                </Button>
                              </div>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </SectionCard>
            </TabsContent>

            <TabsContent value="units" className="space-y-5">
              <SectionCard
                eyebrow="Measures"
                title={`${snapshot.units.length} unit${snapshot.units.length === 1 ? '' : 's'}`}
                titleLevel={2}
                actions={
                  canWrite ? (
                    <Button className="min-h-11" onClick={() => openEditor({ kind: 'unit' })}>
                      Add unit
                    </Button>
                  ) : null
                }
              >
                {snapshot.units.length === 0 ? (
                  <EmptyState
                    title="No units yet."
                    detail="Units are required before ingredients and recipe lines can be created."
                  />
                ) : (
                  <Table className="min-w-[560px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Abbreviation</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snapshot.units.map((unit) => (
                        <TableRow key={unit.id}>
                          <TableCell className="font-medium text-text-strong">
                            {unit.name}
                          </TableCell>
                          <TableCell className="font-mono text-text-muted">
                            {unit.abbreviation ?? '—'}
                          </TableCell>
                          <TableCell>
                            {canWrite ? (
                              <div className="flex justify-end gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() => openEditor({ kind: 'unit', item: unit })}
                                >
                                  Edit
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  disabled={busy}
                                  onClick={() =>
                                    ask({
                                      title: `Delete ${unit.name}?`,
                                      description:
                                        'Units used by ingredients or recipes cannot be deleted.',
                                      label: 'Delete unit',
                                      destructive: true,
                                      run: () => deleteUnit.mutate({ id: unit.id }),
                                    })
                                  }
                                >
                                  Delete
                                </Button>
                              </div>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </SectionCard>

              <SectionCard
                eyebrow="Directed conversions"
                title={`${snapshot.conversions.length} conversion${snapshot.conversions.length === 1 ? '' : 's'}`}
                titleLevel={2}
                actions={
                  canWrite && snapshot.units.length > 1 ? (
                    <Button
                      variant="outline"
                      className="min-h-11"
                      onClick={() => openEditor({ kind: 'conversion' })}
                    >
                      Add conversion
                    </Button>
                  ) : null
                }
              >
                {snapshot.conversions.length === 0 ? (
                  <EmptyState
                    title="No conversions defined."
                    detail="Add a directed factor such as 1 kilogram = 1000 grams."
                  />
                ) : (
                  <Table className="min-w-[640px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>From</TableHead>
                        <TableHead>To</TableHead>
                        <TableHead numeric>Factor</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snapshot.conversions.map((conversion) => (
                        <TableRow key={conversion.id}>
                          <TableCell className="text-text-strong">
                            {unitsById.get(conversion.fromUnitId)?.name ?? 'Unknown'}
                          </TableCell>
                          <TableCell className="text-text-strong">
                            {unitsById.get(conversion.toUnitId)?.name ?? 'Unknown'}
                          </TableCell>
                          <TableCell numeric>{conversion.factor}</TableCell>
                          <TableCell>
                            {canWrite ? (
                              <div className="flex justify-end gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() =>
                                    openEditor({ kind: 'conversion', item: conversion })
                                  }
                                >
                                  Edit
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  disabled={busy}
                                  onClick={() =>
                                    ask({
                                      title: 'Delete this conversion?',
                                      description: 'The direct conversion factor will be removed.',
                                      label: 'Delete conversion',
                                      destructive: true,
                                      run: () =>
                                        deleteConversion.mutate({
                                          fromUnitId: conversion.fromUnitId,
                                          toUnitId: conversion.toUnitId,
                                        }),
                                    })
                                  }
                                >
                                  Delete
                                </Button>
                              </div>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </SectionCard>
            </TabsContent>

            <TabsContent value="ingredients" className="space-y-5">
              <SectionCard
                eyebrow="Recipe inputs"
                title={`${snapshot.ingredients.length} ingredient${snapshot.ingredients.length === 1 ? '' : 's'}`}
                titleLevel={2}
                actions={
                  canWrite ? (
                    <Button
                      className="min-h-11"
                      disabled={snapshot.units.length === 0}
                      onClick={() => openEditor({ kind: 'ingredient' })}
                    >
                      Add ingredient
                    </Button>
                  ) : null
                }
              >
                {snapshot.ingredients.length === 0 ? (
                  <EmptyState
                    title="No ingredients yet."
                    detail={
                      snapshot.units.length
                        ? 'Add ingredients for recipe lines and allergen declarations.'
                        : 'Add at least one unit before creating ingredients.'
                    }
                  />
                ) : (
                  <Table className="min-w-[720px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Ingredient</TableHead>
                        <TableHead>Base unit</TableHead>
                        <TableHead numeric>Reference cost</TableHead>
                        <TableHead numeric>Allergens</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snapshot.ingredients.map((ingredient) => (
                        <TableRow
                          key={ingredient.id}
                          aria-selected={selectedIngredientId === ingredient.id}
                        >
                          <TableCell className="font-medium text-text-strong">
                            {ingredient.name}
                          </TableCell>
                          <TableCell className="text-text-muted">
                            {unitsById.get(ingredient.baseUnitId)?.name ?? 'Unknown'}
                          </TableCell>
                          <TableCell numeric>{ingredient.referenceCost ?? '—'}</TableCell>
                          <TableCell numeric>{ingredient.allergens.length}</TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setSelectedIngredientId(ingredient.id)}
                              >
                                Allergens
                              </Button>
                              {canWrite ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() =>
                                    openEditor({ kind: 'ingredient', item: ingredient })
                                  }
                                >
                                  Edit
                                </Button>
                              ) : null}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </SectionCard>

              {selectedIngredient ? (
                <SectionCard
                  eyebrow="Ingredient allergens"
                  title={selectedIngredient.name}
                  titleLevel={2}
                  actions={
                    <Button variant="ghost" onClick={() => setSelectedIngredientId(null)}>
                      Close
                    </Button>
                  }
                >
                  {canWrite ? (
                    <form
                      className="mb-4 flex max-w-lg gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const allergenId = formText(
                          new FormData(event.currentTarget),
                          'allergenId'
                        );
                        if (allergenId) {
                          attachIngredientAllergen.mutate({
                            ingredientId: selectedIngredient.id,
                            allergenId,
                          });
                        }
                      }}
                    >
                      <StudioSelect
                        aria-label="Allergen to attach to ingredient"
                        name="allergenId"
                        required
                        defaultValue=""
                        className={selectClass}
                        disabled={busy}
                      >
                        <option value="" disabled>
                          Select allergen
                        </option>
                        {snapshot.allergens
                          .filter(
                            (allergen) =>
                              !selectedIngredient.allergens.some(
                                (link) => link.allergenId === allergen.id
                              )
                          )
                          .map((allergen) => (
                            <option key={allergen.id} value={allergen.id}>
                              {allergen.name}
                            </option>
                          ))}
                      </StudioSelect>
                      <Button type="submit" className="min-h-11" disabled={busy}>
                        Attach
                      </Button>
                    </form>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {selectedIngredient.allergens.length ? (
                      selectedIngredient.allergens.map((link) => (
                        <span
                          key={link.id}
                          className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-xs text-text-strong"
                        >
                          {allergensById.get(link.allergenId)?.name ?? 'Unknown'}
                          {canWrite ? (
                            <button
                              type="button"
                              className="rounded-sm px-1 text-text-muted hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={`Detach ${allergensById.get(link.allergenId)?.name ?? 'allergen'}`}
                              disabled={busy}
                              onClick={() =>
                                detachIngredientAllergen.mutate({
                                  ingredientId: selectedIngredient.id,
                                  allergenId: link.allergenId,
                                })
                              }
                            >
                              ×
                            </button>
                          ) : null}
                        </span>
                      ))
                    ) : (
                      <p className="text-sm text-text-muted">No allergens declared.</p>
                    )}
                  </div>
                </SectionCard>
              ) : null}
            </TabsContent>

            <TabsContent value="recipes" className="space-y-5">
              <SectionCard
                eyebrow="Versioned preparation"
                title={`${snapshot.recipes.length} recipe${snapshot.recipes.length === 1 ? '' : 's'}`}
                titleLevel={2}
                actions={
                  canWrite ? (
                    <Button
                      className="min-h-11"
                      disabled={snapshot.products.length === 0}
                      onClick={() =>
                        openEditor({
                          kind: 'recipe',
                          productId: snapshot.products[0]?.id ?? '',
                        })
                      }
                    >
                      Add recipe
                    </Button>
                  ) : null
                }
              >
                {snapshot.recipes.length === 0 ? (
                  <EmptyState
                    title="No recipes yet."
                    detail={
                      snapshot.products.length
                        ? 'Create a recipe identity, then add and activate a draft version.'
                        : 'Add a product before creating its recipe.'
                    }
                  />
                ) : (
                  <Table className="min-w-[720px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Recipe</TableHead>
                        <TableHead>Product</TableHead>
                        <TableHead>Active version</TableHead>
                        <TableHead numeric>Versions</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snapshot.recipes.map((recipe) => {
                        const active = recipe.versions.find(
                          (version) => version.status === 'ACTIVE'
                        );
                        const product = productsById.get(recipe.productId);
                        const variant = product?.variants.find(
                          (candidate) => candidate.id === recipe.variantId
                        );
                        return (
                          <TableRow key={recipe.id} aria-selected={selectedRecipeId === recipe.id}>
                            <TableCell className="font-medium text-text-strong">
                              {recipe.name}
                            </TableCell>
                            <TableCell>
                              <span className="block text-text-strong">
                                {product?.name ?? 'Unknown'}
                              </span>
                              {variant ? (
                                <span className="text-xs text-text-muted">{variant.name}</span>
                              ) : null}
                            </TableCell>
                            <TableCell>
                              {active ? (
                                <StatusPill
                                  status={`Version ${active.versionNumber}`}
                                  tone="success"
                                />
                              ) : (
                                <StatusPill status="No active version" tone="warning" />
                              )}
                            </TableCell>
                            <TableCell numeric>{recipe.versions.length}</TableCell>
                            <TableCell className="text-right">
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setSelectedRecipeId(recipe.id)}
                              >
                                Manage versions
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </SectionCard>

              {selectedRecipe ? (
                <SectionCard
                  eyebrow="Recipe lifecycle"
                  title={selectedRecipe.name}
                  titleLevel={2}
                  actions={
                    <div className="flex gap-2">
                      {canWrite ? (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            openEditor({ kind: 'recipeVersion', recipeId: selectedRecipe.id })
                          }
                        >
                          New draft
                        </Button>
                      ) : null}
                      <Button variant="ghost" onClick={() => setSelectedRecipeId(null)}>
                        Close
                      </Button>
                    </div>
                  }
                >
                  {costVersion ? (
                    <div className="mb-5 rounded-md border border-border-subtle bg-surface-sunken p-4">
                      <p className={labelClass}>Version {costVersion.versionNumber} cost</p>
                      {recipeCost.isLoading ? (
                        <p role="status" className="mt-2 text-sm text-text-muted">
                          Calculating recipe cost…
                        </p>
                      ) : recipeCost.isError ? (
                        <div className="mt-2 space-y-2" role="alert">
                          <p className="text-sm font-medium text-destructive">
                            {recipeCost.error.message}
                          </p>
                          <p className="text-sm text-text-muted">
                            Review Ingredients and Units / Conversions in this Catalog, add the
                            named exact directed conversion or cost input, then recalculate.
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void recipeCost.refetch()}
                          >
                            Recalculate
                          </Button>
                        </div>
                      ) : recipeCost.data ? (
                        <div className="mt-3 space-y-3">
                          <dl className="grid gap-3 sm:grid-cols-3">
                            <div>
                              <dt className={labelClass}>Batch cost</dt>
                              <dd className="mt-1 font-mono tabular-nums text-text-strong">
                                {recipeCost.data.batchCost}
                              </dd>
                            </div>
                            <div>
                              <dt className={labelClass}>Cost per portion</dt>
                              <dd className="mt-1 font-mono tabular-nums text-text-strong">
                                {recipeCost.data.costPerPortion ?? 'Not available'}
                              </dd>
                            </div>
                            <div>
                              <dt className={labelClass}>Cost per yield unit</dt>
                              <dd className="mt-1 font-mono tabular-nums text-text-strong">
                                {recipeCost.data.costPerYieldUnit ?? 'Not available'}
                              </dd>
                            </div>
                          </dl>
                          {recipeCost.data.missing.length ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <StatusPill status="Missing cost" tone="warning" />
                              <p className="text-sm text-text-muted">
                                {recipeCost.data.missing.join(', ')}
                              </p>
                            </div>
                          ) : null}
                          {recipeCost.data.priceComparisons.length ? (
                            <div className="border-t border-border-subtle pt-3">
                              <p className={labelClass}>Food cost by active branch price</p>
                              <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                                {recipeCost.data.priceComparisons.map((comparison) => (
                                  <li
                                    key={comparison.branchId}
                                    className="flex justify-between gap-3 text-sm"
                                  >
                                    <span className="text-text-muted">{comparison.branchName}</span>
                                    <span className="font-mono tabular-nums text-text-strong">
                                      {comparison.foodCostPercent}% at {comparison.price}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : (
                            <p className="text-sm text-text-muted">
                              No active branch price is available for this product.
                            </p>
                          )}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {selectedRecipe.versions.length ? (
                    <div className="space-y-4">
                      {selectedRecipe.versions.map((version) => (
                        <div
                          key={version.id}
                          className="rounded-md border border-border-subtle bg-surface-raised p-4"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <h4 className="font-display font-semibold text-text-strong">
                                  Version {version.versionNumber}
                                </h4>
                                <StatusPill
                                  status={version.status}
                                  tone={recipeStatusTone(version.status)}
                                />
                              </div>
                              <p className="text-xs text-text-muted">
                                Yield {version.yieldQuantity ?? '—'}{' '}
                                {version.yieldUnitId
                                  ? (unitsById.get(version.yieldUnitId)?.abbreviation ??
                                    unitsById.get(version.yieldUnitId)?.name)
                                  : ''}
                                {version.portionCount ? ` · ${version.portionCount} portions` : ''}
                              </p>
                              {version.notes ? (
                                <p className="max-w-2xl text-sm text-text-muted">{version.notes}</p>
                              ) : null}
                            </div>
                            {canWrite && version.status === 'DRAFT' ? (
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() =>
                                    openEditor({
                                      kind: 'recipeVersion',
                                      recipeId: selectedRecipe.id,
                                      item: version,
                                    })
                                  }
                                >
                                  Edit draft
                                </Button>
                                <Button
                                  size="sm"
                                  disabled={busy}
                                  onClick={() =>
                                    ask({
                                      title: `Activate version ${version.versionNumber}?`,
                                      description:
                                        'The current active version will become superseded. Activated versions are immutable.',
                                      label: 'Activate version',
                                      run: () =>
                                        activateRecipeVersion.mutate({
                                          recipeId: selectedRecipe.id,
                                          versionId: version.id,
                                        }),
                                    })
                                  }
                                >
                                  Activate
                                </Button>
                              </div>
                            ) : null}
                          </div>

                          <div className="mt-4 border-t border-border-subtle pt-4">
                            <div className="mb-2 flex items-center justify-between gap-3">
                              <p className={labelClass}>Recipe lines</p>
                              {canWrite && version.status === 'DRAFT' ? (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={busy || snapshot.units.length === 0}
                                  onClick={() =>
                                    openEditor({
                                      kind: 'recipeLine',
                                      recipeId: selectedRecipe.id,
                                      recipeVersionId: version.id,
                                      sourceType: snapshot.ingredients.length
                                        ? 'ingredient'
                                        : 'recipe',
                                    })
                                  }
                                >
                                  Add line
                                </Button>
                              ) : null}
                            </div>
                            {version.lines.length ? (
                              <Table className="min-w-[680px]">
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Source</TableHead>
                                    <TableHead numeric>Quantity</TableHead>
                                    <TableHead>Unit</TableHead>
                                    <TableHead numeric>Order</TableHead>
                                    {canWrite && version.status === 'DRAFT' ? (
                                      <TableHead className="text-right">Actions</TableHead>
                                    ) : null}
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {version.lines.map((line) => (
                                    <TableRow key={line.id}>
                                      <TableCell className="text-text-strong">
                                        <span className="block">
                                          {line.ingredientId
                                            ? (ingredientsById.get(line.ingredientId)?.name ??
                                              'Unknown ingredient')
                                            : line.subRecipeId
                                              ? (recipesById.get(line.subRecipeId)?.name ??
                                                'Unknown recipe')
                                              : 'Unknown'}
                                        </span>
                                        {line.ingredientId ? (
                                          <div className="mt-2 space-y-2">
                                            <div className="flex flex-wrap gap-1">
                                              {line.approvedSubstitutes.map((substitute) => (
                                                <span
                                                  key={substitute.id}
                                                  className="inline-flex items-center gap-1 rounded-sm bg-surface-sunken px-2 py-1 text-xs text-text-muted"
                                                >
                                                  {ingredientsById.get(
                                                    substitute.substituteIngredientId
                                                  )?.name ?? 'Unknown substitute'}
                                                  {canWrite && version.status === 'DRAFT' ? (
                                                    <button
                                                      type="button"
                                                      aria-label={`Remove ${ingredientsById.get(substitute.substituteIngredientId)?.name ?? 'approved substitute'}`}
                                                      className="rounded-sm px-1 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                      disabled={busy}
                                                      onClick={() =>
                                                        removeRecipeLineSubstitute.mutate({
                                                          id: substitute.id,
                                                        })
                                                      }
                                                    >
                                                      ×
                                                    </button>
                                                  ) : null}
                                                </span>
                                              ))}
                                              {line.approvedSubstitutes.length === 0 ? (
                                                <span className="text-xs text-text-muted">
                                                  No approved substitutes
                                                </span>
                                              ) : null}
                                            </div>
                                            {canWrite && version.status === 'DRAFT' ? (
                                              <form
                                                className="flex max-w-sm gap-2"
                                                onSubmit={(event) => {
                                                  event.preventDefault();
                                                  const substituteIngredientId = formText(
                                                    new FormData(event.currentTarget),
                                                    'substituteIngredientId'
                                                  );
                                                  if (substituteIngredientId) {
                                                    addRecipeLineSubstitute.mutate({
                                                      recipeLineId: line.id,
                                                      substituteIngredientId,
                                                    });
                                                  }
                                                }}
                                              >
                                                <StudioSelect
                                                  aria-label="Approved substitute ingredient"
                                                  name="substituteIngredientId"
                                                  required
                                                  defaultValue=""
                                                  className={selectClass}
                                                  disabled={busy}
                                                >
                                                  <option value="" disabled>
                                                    Add substitute
                                                  </option>
                                                  {snapshot.ingredients
                                                    .filter(
                                                      (ingredient) =>
                                                        ingredient.id !== line.ingredientId &&
                                                        !line.approvedSubstitutes.some(
                                                          (substitute) =>
                                                            substitute.substituteIngredientId ===
                                                            ingredient.id
                                                        )
                                                    )
                                                    .map((ingredient) => (
                                                      <option
                                                        key={ingredient.id}
                                                        value={ingredient.id}
                                                      >
                                                        {ingredient.name}
                                                      </option>
                                                    ))}
                                                </StudioSelect>
                                                <Button
                                                  type="submit"
                                                  size="sm"
                                                  variant="secondary"
                                                  disabled={busy}
                                                >
                                                  Attach
                                                </Button>
                                              </form>
                                            ) : null}
                                          </div>
                                        ) : null}
                                      </TableCell>
                                      <TableCell numeric>{line.quantity}</TableCell>
                                      <TableCell className="text-text-muted">
                                        {unitsById.get(line.unitId)?.name ?? 'Unknown'}
                                      </TableCell>
                                      <TableCell numeric>{line.sortOrder}</TableCell>
                                      {canWrite && version.status === 'DRAFT' ? (
                                        <TableCell>
                                          <div className="flex justify-end gap-2">
                                            <Button
                                              size="sm"
                                              variant="outline"
                                              disabled={busy}
                                              onClick={() =>
                                                openEditor({
                                                  kind: 'recipeLine',
                                                  recipeId: selectedRecipe.id,
                                                  recipeVersionId: version.id,
                                                  sourceType: line.ingredientId
                                                    ? 'ingredient'
                                                    : 'recipe',
                                                  item: line,
                                                })
                                              }
                                            >
                                              Edit
                                            </Button>
                                            <Button
                                              size="sm"
                                              variant="destructive"
                                              disabled={busy}
                                              onClick={() =>
                                                ask({
                                                  title: 'Delete this recipe line?',
                                                  description:
                                                    'The line will be removed from this draft version.',
                                                  label: 'Delete line',
                                                  destructive: true,
                                                  run: () =>
                                                    deleteRecipeLine.mutate({ id: line.id }),
                                                })
                                              }
                                            >
                                              Delete
                                            </Button>
                                          </div>
                                        </TableCell>
                                      ) : null}
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            ) : (
                              <p className="text-sm text-text-muted">No lines in this version.</p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      title="No versions yet."
                      detail="Create a draft, add recipe lines, then activate it."
                    />
                  )}
                </SectionCard>
              ) : null}
            </TabsContent>
          </Tabs>
        </>
      ) : null}

      <Dialog
        open={editor != null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setEditor(null);
            setMutationError('');
          }
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          {editor ? (
            <>
              <DialogHeader>
                <DialogTitle>{editorTitle(editor)}</DialogTitle>
                <DialogDescription>
                  Required fields are marked by the browser. Changes apply to the canonical
                  organization catalog.
                </DialogDescription>
              </DialogHeader>
              <form
                key={`${editor.kind}-${'item' in editor ? (editor.item?.id ?? 'new') : 'new'}`}
                className="space-y-4"
                onSubmit={submitEditor}
              >
                {mutationError ? (
                  <p
                    role="alert"
                    className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
                  >
                    {mutationError}
                  </p>
                ) : null}

                {editor.kind === 'category' ? (
                  <>
                    <Field label="Category name">
                      <Input
                        name="name"
                        required
                        maxLength={200}
                        defaultValue={editor.item?.name}
                        className="h-11"
                      />
                    </Field>
                    <Field label="Parent category">
                      <StudioSelect
                        name="parentId"
                        defaultValue={editor.item?.parentId ?? ''}
                        className={selectClass}
                      >
                        <option value="">Top level</option>
                        {snapshot?.categories
                          .filter((category) => category.id !== editor.item?.id)
                          .map((category) => (
                            <option key={category.id} value={category.id}>
                              {category.name}
                            </option>
                          ))}
                      </StudioSelect>
                    </Field>
                    <Field label="Sort order">
                      <Input
                        name="sortOrder"
                        type="number"
                        defaultValue={editor.item?.sortOrder ?? 0}
                        className="h-11"
                      />
                    </Field>
                  </>
                ) : null}

                {editor.kind === 'product' ? (
                  <>
                    <Field label="Product name">
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
                    {!editor.item ? (
                      <Field label="Product type">
                        <StudioSelect name="type" defaultValue="ITEM" className={selectClass}>
                          <option value="ITEM">Item</option>
                          <option value="COMBO">Combo</option>
                        </StudioSelect>
                      </Field>
                    ) : null}
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Category">
                        <StudioSelect
                          name="categoryId"
                          defaultValue={editor.item?.categoryId ?? ''}
                          className={selectClass}
                        >
                          <option value="">Uncategorized</option>
                          {snapshot?.categories.map((category) => (
                            <option key={category.id} value={category.id}>
                              {category.name}
                            </option>
                          ))}
                        </StudioSelect>
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

                {editor.kind === 'comboGroup' ? (
                  <>
                    <Field label="Choice group name">
                      <Input
                        name="name"
                        required
                        maxLength={200}
                        defaultValue={editor.item?.name}
                        className="h-11"
                      />
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-3">
                      <Field label="Minimum choices">
                        <Input
                          name="minChoose"
                          type="number"
                          min={0}
                          required
                          defaultValue={editor.item?.minChoose ?? 1}
                          className="h-11"
                        />
                      </Field>
                      <Field label="Maximum choices">
                        <Input
                          name="maxChoose"
                          type="number"
                          min={0}
                          placeholder="Unbounded"
                          defaultValue={editor.item?.maxChoose ?? ''}
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

                {editor.kind === 'comboOption' ? (
                  <>
                    {editor.item ? (
                      <p className="rounded-md bg-surface-sunken p-3 text-sm text-text-muted">
                        The component product cannot change after creation. Remove this option and
                        add another to replace it.
                      </p>
                    ) : (
                      <>
                        <Field label="Component product">
                          <StudioSelect
                            name="productId"
                            required
                            value={editor.productId ?? ''}
                            className={selectClass}
                            onChange={(event) =>
                              setEditor({ ...editor, productId: event.target.value })
                            }
                          >
                            <option value="" disabled>
                              Select product
                            </option>
                            {snapshot?.products
                              .filter((product) => product.id !== selectedProduct?.id)
                              .map((product) => (
                                <option key={product.id} value={product.id}>
                                  {product.name}
                                </option>
                              ))}
                          </StudioSelect>
                        </Field>
                        <Field label="Variant (optional)">
                          <StudioSelect name="variantId" defaultValue="" className={selectClass}>
                            <option value="">All variants</option>
                            {productsById.get(editor.productId ?? '')?.variants.map((variant) => (
                              <option key={variant.id} value={variant.id}>
                                {variant.name}
                              </option>
                            ))}
                          </StudioSelect>
                        </Field>
                      </>
                    )}
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Price delta">
                        <Input
                          name="priceDelta"
                          type="number"
                          step="0.01"
                          required
                          defaultValue={editor.item?.priceDelta ?? '0'}
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

                {editor.kind === 'variant' ? (
                  <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
                    <Field label="Variant name">
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

                {editor.kind === 'modifierGroup' ? (
                  <>
                    <Field label="Group name">
                      <Input
                        name="name"
                        required
                        maxLength={200}
                        defaultValue={editor.item?.name}
                        className="h-11"
                      />
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Minimum selections">
                        <Input
                          name="minSelect"
                          type="number"
                          min={0}
                          required
                          defaultValue={editor.item?.minSelect ?? 0}
                          className="h-11"
                        />
                      </Field>
                      <Field label="Maximum selections">
                        <Input
                          name="maxSelect"
                          type="number"
                          min={0}
                          placeholder="Unbounded"
                          defaultValue={editor.item?.maxSelect ?? ''}
                          className="h-11"
                        />
                      </Field>
                    </div>
                  </>
                ) : null}

                {editor.kind === 'modifierOption' ? (
                  <>
                    <Field label="Option name">
                      <Input
                        name="name"
                        required
                        maxLength={200}
                        defaultValue={editor.item?.name}
                        className="h-11"
                      />
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Price delta">
                        <Input
                          name="priceDelta"
                          type="number"
                          step="0.01"
                          required
                          defaultValue={editor.item?.priceDelta ?? '0'}
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

                {editor.kind === 'allergen' ? (
                  <Field label="Allergen name">
                    <Input
                      name="name"
                      required
                      maxLength={200}
                      defaultValue={editor.item?.name}
                      className="h-11"
                    />
                  </Field>
                ) : null}

                {editor.kind === 'unit' ? (
                  <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
                    <Field label="Unit name">
                      <Input
                        name="name"
                        required
                        maxLength={100}
                        defaultValue={editor.item?.name}
                        className="h-11"
                      />
                    </Field>
                    <Field label="Abbreviation">
                      <Input
                        name="abbreviation"
                        maxLength={20}
                        defaultValue={editor.item?.abbreviation ?? ''}
                        className="h-11"
                      />
                    </Field>
                  </div>
                ) : null}

                {editor.kind === 'conversion' ? (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="From unit">
                        <StudioSelect
                          name="fromUnitId"
                          required
                          defaultValue={editor.item?.fromUnitId ?? ''}
                          className={selectClass}
                          disabled={Boolean(editor.item)}
                        >
                          <option value="" disabled>
                            Select unit
                          </option>
                          {snapshot?.units.map((unit) => (
                            <option key={unit.id} value={unit.id}>
                              {unit.name}
                            </option>
                          ))}
                        </StudioSelect>
                      </Field>
                      <Field label="To unit">
                        <StudioSelect
                          name="toUnitId"
                          required
                          defaultValue={editor.item?.toUnitId ?? ''}
                          className={selectClass}
                          disabled={Boolean(editor.item)}
                        >
                          <option value="" disabled>
                            Select unit
                          </option>
                          {snapshot?.units.map((unit) => (
                            <option key={unit.id} value={unit.id}>
                              {unit.name}
                            </option>
                          ))}
                        </StudioSelect>
                      </Field>
                    </div>
                    {editor.item ? (
                      <>
                        <input type="hidden" name="fromUnitId" value={editor.item.fromUnitId} />
                        <input type="hidden" name="toUnitId" value={editor.item.toUnitId} />
                      </>
                    ) : null}
                    <Field label="Factor">
                      <Input
                        name="factor"
                        type="number"
                        step="any"
                        min="0.000001"
                        required
                        defaultValue={editor.item?.factor}
                        className="h-11"
                      />
                    </Field>
                    <p className="text-xs text-text-muted">
                      Factor means 1 from-unit equals this many to-units.
                    </p>
                  </>
                ) : null}

                {editor.kind === 'ingredient' ? (
                  <>
                    <Field label="Ingredient name">
                      <Input
                        name="name"
                        required
                        maxLength={200}
                        defaultValue={editor.item?.name}
                        className="h-11"
                      />
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Base unit">
                        <StudioSelect
                          name="baseUnitId"
                          required
                          defaultValue={editor.item?.baseUnitId ?? ''}
                          className={selectClass}
                        >
                          <option value="" disabled>
                            Select unit
                          </option>
                          {snapshot?.units.map((unit) => (
                            <option key={unit.id} value={unit.id}>
                              {unit.name}
                            </option>
                          ))}
                        </StudioSelect>
                      </Field>
                      <Field label="Reference cost">
                        <Input
                          name="referenceCost"
                          type="number"
                          step="0.0001"
                          min={0}
                          defaultValue={editor.item?.referenceCost ?? ''}
                          className="h-11"
                        />
                      </Field>
                    </div>
                  </>
                ) : null}

                {editor.kind === 'recipe' ? (
                  <>
                    <Field label="Recipe name">
                      <Input name="name" required maxLength={200} className="h-11" />
                    </Field>
                    <Field label="Product">
                      <StudioSelect
                        name="productId"
                        required
                        value={editor.productId}
                        className={selectClass}
                        onChange={(event) =>
                          setEditor({
                            kind: 'recipe',
                            productId: event.target.value,
                          })
                        }
                      >
                        {snapshot?.products.map((product) => (
                          <option key={product.id} value={product.id}>
                            {product.name}
                          </option>
                        ))}
                      </StudioSelect>
                    </Field>
                    <Field label="Variant">
                      <StudioSelect name="variantId" defaultValue="" className={selectClass}>
                        <option value="">All variants</option>
                        {productsById.get(editor.productId)?.variants.map((variant) => (
                          <option key={variant.id} value={variant.id}>
                            {variant.name}
                          </option>
                        ))}
                      </StudioSelect>
                    </Field>
                  </>
                ) : null}

                {editor.kind === 'recipeVersion' ? (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Yield quantity">
                        <Input
                          name="yieldQuantity"
                          type="number"
                          step="0.001"
                          min={0}
                          defaultValue={editor.item?.yieldQuantity ?? ''}
                          className="h-11"
                        />
                      </Field>
                      <Field label="Yield unit">
                        <StudioSelect
                          name="yieldUnitId"
                          defaultValue={editor.item?.yieldUnitId ?? ''}
                          className={selectClass}
                        >
                          <option value="">No yield unit</option>
                          {snapshot?.units.map((unit) => (
                            <option key={unit.id} value={unit.id}>
                              {unit.name}
                            </option>
                          ))}
                        </StudioSelect>
                      </Field>
                    </div>
                    <Field label="Portion count">
                      <Input
                        name="portionCount"
                        type="number"
                        min={1}
                        defaultValue={editor.item?.portionCount ?? ''}
                        className="h-11"
                      />
                    </Field>
                    <Field label="Notes">
                      <Textarea
                        name="notes"
                        maxLength={2000}
                        defaultValue={editor.item?.notes ?? ''}
                      />
                    </Field>
                  </>
                ) : null}

                {editor.kind === 'recipeLine' ? (
                  <>
                    {editor.item ? (
                      <p className="rounded-md bg-surface-sunken p-3 text-sm text-text-muted">
                        Source cannot change after creation. Delete and add a new line to replace
                        it.
                      </p>
                    ) : (
                      <>
                        <Field label="Source type">
                          <StudioSelect
                            value={editor.sourceType}
                            className={selectClass}
                            onChange={(event) =>
                              setEditor({
                                ...editor,
                                sourceType: event.target.value as 'ingredient' | 'recipe',
                              })
                            }
                          >
                            <option value="ingredient">Ingredient</option>
                            <option value="recipe">Sub-recipe</option>
                          </StudioSelect>
                        </Field>
                        <Field
                          label={editor.sourceType === 'ingredient' ? 'Ingredient' : 'Sub-recipe'}
                        >
                          <StudioSelect
                            name="sourceId"
                            required
                            defaultValue=""
                            className={selectClass}
                          >
                            <option value="" disabled>
                              Select source
                            </option>
                            {editor.sourceType === 'ingredient'
                              ? snapshot?.ingredients.map((ingredient) => (
                                  <option key={ingredient.id} value={ingredient.id}>
                                    {ingredient.name}
                                  </option>
                                ))
                              : snapshot?.recipes
                                  .filter((recipe) => recipe.id !== editor.recipeId)
                                  .map((recipe) => (
                                    <option key={recipe.id} value={recipe.id}>
                                      {recipe.name}
                                    </option>
                                  ))}
                          </StudioSelect>
                        </Field>
                      </>
                    )}
                    <div className="grid gap-4 sm:grid-cols-3">
                      <Field label="Quantity">
                        <Input
                          name="quantity"
                          type="number"
                          step="0.0001"
                          min="0.0001"
                          required
                          defaultValue={editor.item?.quantity}
                          className="h-11"
                        />
                      </Field>
                      <Field label="Unit">
                        <StudioSelect
                          name="unitId"
                          required
                          defaultValue={editor.item?.unitId ?? ''}
                          className={selectClass}
                        >
                          <option value="" disabled>
                            Select unit
                          </option>
                          {snapshot?.units.map((unit) => (
                            <option key={unit.id} value={unit.id}>
                              {unit.name}
                            </option>
                          ))}
                        </StudioSelect>
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
                  <Button type="submit" className="min-h-11" disabled={busy || !canWrite}>
                    {busy ? 'Saving…' : editorTitle(editor)}
                  </Button>
                </DialogFooter>
              </form>
            </>
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
              disabled={busy || !canWrite}
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
