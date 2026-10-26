import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VersionImmutabilityError } from './effective-dating';
import {
  RecipeError,
  activateRecipeVersion,
  addRecipeLineSubstitute,
  attachIngredientAllergen,
  createAllergen,
  createIngredient,
  createRecipe,
  createRecipeLine,
  createRecipeVersion,
  createUnit,
  deleteAllergen,
  deleteConversion,
  deleteUnit,
  getActiveRecipeVersion,
  getRecipeVersion,
  listRecipeVersions,
  updateRecipeVersion,
  upsertConversion,
} from './recipes';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('server-only', () => ({}));

/**
 * Unit tests for the recipes module: unit/conversion CRUD (cycle guard),
 * allergen/ingredient CRUD, recipe + version lifecycle (C3 immutability),
 * recipe-line cycle detection, and ingredient-allergen attachment.
 */

type Delegate = Record<string, ReturnType<typeof vi.fn>>;

function makeDb() {
  const model = (): Delegate => ({
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'generated_id',
      ...data,
    })),
    update: vi
      .fn()
      .mockImplementation(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
          id: where.id,
          ...data,
        })
      ),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    delete: vi.fn().mockResolvedValue({}),
    upsert: vi.fn().mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
      id: 'generated_id',
      ...create,
    })),
  });

  const db = {
    $queryRaw: vi.fn().mockResolvedValue([{ organizationId: 'org_1' }]),
    restaurantUnit: model(),
    restaurantUnitConversion: model(),
    restaurantAllergen: model(),
    restaurantIngredient: model(),
    restaurantIngredientAllergen: model(),
    restaurantRecipe: model(),
    restaurantRecipeVersion: model(),
    restaurantRecipeLine: model(),
    restaurantRecipeLineSubstitute: model(),
    restaurantProduct: model(),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return db;
}

let db: ReturnType<typeof makeDb>;
beforeEach(() => {
  db = makeDb();
});

const scoped = () => db as unknown as ScopedDb;

// ── Units ─────────────────────────────────────────────────────────────────────

describe('createUnit', () => {
  it('trims and persists the name and abbreviation', async () => {
    await createUnit(scoped(), { name: '  gram  ', abbreviation: 'g' });
    expect(db.restaurantUnit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: 'gram', abbreviation: 'g' }),
      })
    );
  });

  it('rejects blank name', async () => {
    await expect(createUnit(scoped(), { name: '   ' })).rejects.toThrow(RecipeError);
  });
});

describe('deleteUnit', () => {
  it('throws NOT_FOUND when unit absent', async () => {
    db.restaurantUnit.findUnique.mockResolvedValue(null);
    await expect(deleteUnit(scoped(), 'missing')).rejects.toMatchObject({ reason: 'NOT_FOUND' });
  });

  it('deletes when unit exists', async () => {
    db.restaurantUnit.findUnique.mockResolvedValue({ id: 'u1' });
    await deleteUnit(scoped(), 'u1');
    expect(db.restaurantUnit.delete).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', id: 'u1' },
    });
  });
});

// ── Conversion cycle guard ────────────────────────────────────────────────────

describe('upsertConversion', () => {
  it('rejects self-conversion', async () => {
    db.restaurantUnit.findUnique.mockResolvedValue({ id: 'u1' });
    await expect(upsertConversion(scoped(), 'u1', 'u1', '1')).rejects.toMatchObject({
      reason: 'CONVERSION_CYCLE',
    });
  });

  it('rejects when new edge closes a cycle', async () => {
    // Existing edges: A→B, B→C. Adding C→A would close A→B→C→A.
    db.restaurantUnit.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) => ({
        id: where.id,
      })
    );
    // fromUnitId = C, toUnitId = A; walking out from A finds B then C → cycle
    db.restaurantUnitConversion.findMany
      .mockResolvedValueOnce([{ toUnitId: 'B' }]) // from A
      .mockResolvedValueOnce([{ toUnitId: 'C' }]) // from B
      .mockResolvedValueOnce([]); // from C (already visited or no further edges)
    await expect(upsertConversion(scoped(), 'C', 'A', '1')).rejects.toMatchObject({
      reason: 'CONVERSION_CYCLE',
    });
  });

  it('upserts when no cycle', async () => {
    db.restaurantUnit.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) => ({
        id: where.id,
      })
    );
    db.restaurantUnitConversion.findMany.mockResolvedValue([]);
    await upsertConversion(scoped(), 'A', 'B', '1000');
    expect(db.restaurantUnitConversion.upsert).toHaveBeenCalled();
  });
});

describe('deleteConversion', () => {
  it('throws NOT_FOUND when conversion absent', async () => {
    db.restaurantUnitConversion.findUnique.mockResolvedValue(null);
    await expect(deleteConversion(scoped(), 'A', 'B')).rejects.toMatchObject({
      reason: 'NOT_FOUND',
    });
  });
});

// ── Allergens ─────────────────────────────────────────────────────────────────

describe('createAllergen', () => {
  it('creates with trimmed name', async () => {
    await createAllergen(scoped(), { name: ' Peanuts ' });
    expect(db.restaurantAllergen.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'Peanuts' }) })
    );
  });

  it('rejects blank name', async () => {
    await expect(createAllergen(scoped(), { name: '' })).rejects.toThrow(RecipeError);
  });
});

describe('deleteAllergen', () => {
  it('throws NOT_FOUND when absent', async () => {
    await expect(deleteAllergen(scoped(), 'missing')).rejects.toMatchObject({
      reason: 'NOT_FOUND',
    });
  });

  it('deletes when present', async () => {
    db.restaurantAllergen.findUnique.mockResolvedValue({ id: 'a1' });
    await deleteAllergen(scoped(), 'a1');
    expect(db.restaurantAllergen.delete).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', id: 'a1' },
    });
  });
});

// ── Ingredients ───────────────────────────────────────────────────────────────

describe('createIngredient', () => {
  it('creates with referenceCost as Decimal (C4)', async () => {
    db.restaurantUnit.findUnique.mockResolvedValue({ id: 'u1' });
    await createIngredient(scoped(), { name: 'Flour', baseUnitId: 'u1', referenceCost: '1.25' });
    const call = db.restaurantIngredient.create.mock.calls[0][0];
    expect(call.data.referenceCost?.toString()).toBe('1.25');
  });

  it('rejects missing unit', async () => {
    db.restaurantUnit.findUnique.mockResolvedValue(null);
    await expect(
      createIngredient(scoped(), { name: 'Flour', baseUnitId: 'missing' })
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
  });
});

// ── Ingredient-allergen attachment ────────────────────────────────────────────

describe('attachIngredientAllergen', () => {
  it('creates the junction row', async () => {
    db.restaurantIngredient.findUnique.mockResolvedValue({ id: 'i1' });
    db.restaurantAllergen.findUnique.mockResolvedValue({ id: 'a1' });
    db.restaurantIngredientAllergen.findUnique.mockResolvedValue(null);
    await attachIngredientAllergen(scoped(), 'i1', 'a1');
    expect(db.restaurantIngredientAllergen.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { organizationId: 'org_1', ingredientId: 'i1', allergenId: 'a1' },
      })
    );
  });

  it('throws ALREADY_ATTACHED on duplicate', async () => {
    db.restaurantIngredient.findUnique.mockResolvedValue({ id: 'i1' });
    db.restaurantAllergen.findUnique.mockResolvedValue({ id: 'a1' });
    db.restaurantIngredientAllergen.findUnique.mockResolvedValue({ id: 'existing' });
    await expect(attachIngredientAllergen(scoped(), 'i1', 'a1')).rejects.toMatchObject({
      reason: 'ALREADY_ATTACHED',
    });
  });
});

// ── Recipe identity ───────────────────────────────────────────────────────────

describe('createRecipe', () => {
  it('creates when product exists', async () => {
    db.restaurantProduct.findUnique.mockResolvedValue({ id: 'p1' });
    await createRecipe(scoped(), { productId: 'p1', name: 'Burger Recipe' });
    expect(db.restaurantRecipe.create).toHaveBeenCalled();
  });

  it('rejects missing product', async () => {
    db.restaurantProduct.findUnique.mockResolvedValue(null);
    await expect(createRecipe(scoped(), { productId: 'missing', name: 'X' })).rejects.toMatchObject(
      {
        reason: 'NOT_FOUND',
      }
    );
  });
});

// ── Recipe version lifecycle (C3) ─────────────────────────────────────────────

describe('createRecipeVersion', () => {
  it('assigns versionNumber = 1 for first version', async () => {
    db.restaurantRecipe.findUnique.mockResolvedValue({ id: 'r1' });
    db.restaurantUnit.findUnique.mockResolvedValue({ id: 'u1' });
    db.restaurantRecipeVersion.findMany.mockResolvedValue([]);
    await createRecipeVersion(scoped(), { recipeId: 'r1', yieldUnitId: 'u1' });
    const call = db.restaurantRecipeVersion.create.mock.calls[0][0];
    expect(call.data.versionNumber).toBe(1);
    expect(call.data.status).toBe('DRAFT');
  });

  it('assigns next monotonic versionNumber', async () => {
    db.restaurantRecipe.findUnique.mockResolvedValue({ id: 'r1' });
    db.restaurantRecipeVersion.findMany.mockResolvedValue([
      { id: 'v1', versionNumber: 1, status: 'ACTIVE' },
    ]);
    await createRecipeVersion(scoped(), { recipeId: 'r1' });
    const call = db.restaurantRecipeVersion.create.mock.calls[0][0];
    expect(call.data.versionNumber).toBe(2);
  });
});

describe('updateRecipeVersion — C3 immutability', () => {
  it('allows editing DRAFT version', async () => {
    db.restaurantRecipeVersion.findUnique.mockResolvedValue({
      id: 'v1',
      status: 'DRAFT',
      recipeId: 'r1',
    });
    await updateRecipeVersion(scoped(), 'v1', { notes: 'updated' });
    expect(db.restaurantRecipeVersion.update).toHaveBeenCalled();
  });

  it('rejects editing ACTIVE version (VersionImmutabilityError)', async () => {
    db.restaurantRecipeVersion.findUnique.mockResolvedValue({
      id: 'v1',
      status: 'ACTIVE',
      recipeId: 'r1',
    });
    await expect(updateRecipeVersion(scoped(), 'v1', { notes: 'x' })).rejects.toThrow(
      VersionImmutabilityError
    );
  });

  it('rejects editing SUPERSEDED version', async () => {
    db.restaurantRecipeVersion.findUnique.mockResolvedValue({
      id: 'v1',
      status: 'SUPERSEDED',
      recipeId: 'r1',
    });
    await expect(updateRecipeVersion(scoped(), 'v1', { notes: 'x' })).rejects.toThrow(
      VersionImmutabilityError
    );
  });

  it('rechecks mutability after waiting for the version lock', async () => {
    let status = 'DRAFT';
    db.$queryRaw.mockImplementation(async (query: TemplateStringsArray) => {
      if (query.join('?').includes('FOR UPDATE')) status = 'ACTIVE';
      return [{ organizationId: 'org_1' }];
    });
    db.restaurantRecipeVersion.findUnique.mockImplementation(async () => ({
      id: 'v1',
      status,
      recipeId: 'r1',
    }));

    await expect(updateRecipeVersion(scoped(), 'v1', { notes: 'too late' })).rejects.toThrow(
      VersionImmutabilityError
    );
    expect(db.restaurantRecipeVersion.update).not.toHaveBeenCalled();
  });
});

describe('activateRecipeVersion', () => {
  it('activates DRAFT and supersedes prior ACTIVE in one transaction', async () => {
    db.restaurantRecipe.findUnique.mockResolvedValue({ id: 'r1' });
    db.restaurantRecipeVersion.findMany.mockResolvedValue([
      { id: 'v1', status: 'ACTIVE', versionNumber: 1 },
      { id: 'v2', status: 'DRAFT', versionNumber: 2 },
    ]);
    await activateRecipeVersion(scoped(), 'r1', 'v2');
    expect(
      db.$queryRaw.mock.calls.some(([query]) =>
        (query as TemplateStringsArray).join('?').includes('ORDER BY id FOR UPDATE')
      )
    ).toBe(true);
    // Two updates inside the transaction: supersede v1, activate v2
    expect(db.restaurantRecipeVersion.update).toHaveBeenCalledTimes(2);
    const calls = db.restaurantRecipeVersion.update.mock.calls as Array<
      [{ where: { id: string }; data: { status: string } }]
    >;
    const statuses = calls.map((c) => c[0].data.status);
    expect(statuses).toContain('SUPERSEDED');
    expect(statuses).toContain('ACTIVE');
  });

  it('superseded version stays readable (getActiveRecipeVersion returns new ACTIVE)', async () => {
    db.restaurantRecipe.findUnique.mockResolvedValue({ id: 'r1' });
    // After activation the findMany for getActiveRecipeVersion returns both rows
    db.restaurantRecipeVersion.findMany.mockResolvedValue([
      { id: 'v1', status: 'SUPERSEDED', versionNumber: 1 },
      { id: 'v2', status: 'ACTIVE', versionNumber: 2 },
    ]);
    const active = await getActiveRecipeVersion(scoped(), 'r1');
    expect(active?.id).toBe('v2');
  });
});

// ── Historical reads (GOV-2) ──────────────────────────────────────────────────

describe('getRecipeVersion', () => {
  it('reads a SUPERSEDED version by id (history stays readable)', async () => {
    db.restaurantRecipeVersion.findUnique.mockResolvedValue({
      id: 'v1',
      recipeId: 'r1',
      status: 'SUPERSEDED',
      versionNumber: 1,
      notes: 'original',
    });
    const version = await getRecipeVersion(scoped(), 'v1');
    expect(version).toMatchObject({ id: 'v1', status: 'SUPERSEDED', notes: 'original' });
    // findUnique fetches the full row (no field select) so history is complete.
    expect(db.restaurantRecipeVersion.findUnique).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', id: 'v1' },
    });
  });

  it('throws NOT_FOUND for a missing version', async () => {
    db.restaurantRecipeVersion.findUnique.mockResolvedValue(null);
    await expect(getRecipeVersion(scoped(), 'missing')).rejects.toMatchObject({
      reason: 'NOT_FOUND',
    });
  });
});

describe('listRecipeVersions', () => {
  it('lists every version newest-first, requiring the recipe in scope', async () => {
    db.restaurantRecipe.findUnique.mockResolvedValue({ id: 'r1' });
    db.restaurantRecipeVersion.findMany.mockResolvedValue([
      { id: 'v2', recipeId: 'r1', status: 'ACTIVE', versionNumber: 2 },
      { id: 'v1', recipeId: 'r1', status: 'SUPERSEDED', versionNumber: 1 },
    ]);
    const versions = await listRecipeVersions(scoped(), 'r1');
    expect(versions.map((v) => v.id)).toEqual(['v2', 'v1']);
    expect(db.restaurantRecipeVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org_1', recipeId: 'r1' },
        orderBy: { versionNumber: 'desc' },
      })
    );
  });

  it('throws NOT_FOUND when the recipe is absent', async () => {
    db.restaurantRecipe.findUnique.mockResolvedValue(null);
    await expect(listRecipeVersions(scoped(), 'missing')).rejects.toMatchObject({
      reason: 'NOT_FOUND',
    });
  });
});

// ── Recipe-line cycle detection ───────────────────────────────────────────────

describe('createRecipeLine — recipe cycle detection', () => {
  it('rejects a direct self-referencing sub-recipe line', async () => {
    db.restaurantRecipeVersion.findUnique.mockResolvedValue({
      id: 'v1',
      status: 'DRAFT',
      recipeId: 'r1',
    });
    db.restaurantUnit.findUnique.mockResolvedValue({ id: 'u1' });
    // sub-recipe is the same recipe as the parent
    db.restaurantRecipe.findUnique.mockResolvedValue({ id: 'r1' });
    // Walking from r1: no lines (it would reference itself immediately)
    db.restaurantRecipeLine.findMany.mockResolvedValue([]);

    await expect(
      createRecipeLine(scoped(), {
        recipeVersionId: 'v1',
        subRecipeId: 'r1',
        quantity: '1',
        unitId: 'u1',
      })
    ).rejects.toMatchObject({ reason: 'RECIPE_CYCLE' });
  });

  it('rejects a transitive cycle (r1 → r2 → r1)', async () => {
    db.restaurantRecipeVersion.findUnique.mockResolvedValue({
      id: 'v1',
      status: 'DRAFT',
      recipeId: 'r1',
    });
    db.restaurantUnit.findUnique.mockResolvedValue({ id: 'u1' });
    db.restaurantRecipe.findUnique.mockResolvedValue({ id: 'r2' });
    // r2 has a line referencing r1
    db.restaurantRecipeLine.findMany.mockResolvedValue([{ subRecipeId: 'r1' }]);

    await expect(
      createRecipeLine(scoped(), {
        recipeVersionId: 'v1',
        subRecipeId: 'r2',
        quantity: '1',
        unitId: 'u1',
      })
    ).rejects.toMatchObject({ reason: 'RECIPE_CYCLE' });
  });

  it('rejects XOR violation (both ingredientId and subRecipeId)', async () => {
    db.restaurantRecipeVersion.findUnique.mockResolvedValue({
      id: 'v1',
      status: 'DRAFT',
      recipeId: 'r1',
    });
    await expect(
      createRecipeLine(scoped(), {
        recipeVersionId: 'v1',
        ingredientId: 'i1',
        subRecipeId: 'r2',
        quantity: '1',
        unitId: 'u1',
      } as unknown as Parameters<typeof createRecipeLine>[1])
    ).rejects.toMatchObject({ reason: 'INVALID' });
  });
});

describe('recipe ingredient substitutes', () => {
  beforeEach(() => {
    db.restaurantRecipeLine.findUnique.mockResolvedValue({
      id: 'line_1',
      recipeVersionId: 'version_1',
      ingredientId: 'ingredient_original',
    });
    db.restaurantRecipeVersion.findUnique.mockResolvedValue({
      id: 'version_1',
      status: 'DRAFT',
      recipeId: 'recipe_1',
    });
    db.restaurantIngredient.findUnique.mockResolvedValue({ id: 'ingredient_substitute' });
  });

  it('adds a distinct, tenant-visible ingredient to a draft ingredient line', async () => {
    await addRecipeLineSubstitute(scoped(), {
      recipeLineId: 'line_1',
      substituteIngredientId: 'ingredient_substitute',
    });
    expect(db.restaurantRecipeLineSubstitute.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org_1',
        recipeLineId: 'line_1',
        substituteIngredientId: 'ingredient_substitute',
      },
    });
  });

  it('rejects self-substitution and sub-recipe lines', async () => {
    await expect(
      addRecipeLineSubstitute(scoped(), {
        recipeLineId: 'line_1',
        substituteIngredientId: 'ingredient_original',
      })
    ).rejects.toMatchObject({ reason: 'INVALID' });
    db.restaurantRecipeLine.findUnique.mockResolvedValue({
      id: 'line_1',
      recipeVersionId: 'version_1',
      ingredientId: null,
    });
    await expect(
      addRecipeLineSubstitute(scoped(), {
        recipeLineId: 'line_1',
        substituteIngredientId: 'ingredient_substitute',
      })
    ).rejects.toMatchObject({ reason: 'INVALID' });
    expect(db.restaurantRecipeLineSubstitute.create).not.toHaveBeenCalled();
  });

  it('rejects a cross-tenant or missing substitute hidden by the scoped database', async () => {
    db.restaurantIngredient.findUnique.mockResolvedValue(null);
    await expect(
      addRecipeLineSubstitute(scoped(), {
        recipeLineId: 'line_1',
        substituteIngredientId: 'other_tenant_ingredient',
      })
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    expect(db.restaurantRecipeLineSubstitute.create).not.toHaveBeenCalled();
  });

  it('rejects changes to an active recipe version and duplicate approval', async () => {
    db.restaurantRecipeVersion.findUnique.mockResolvedValue({
      id: 'version_1',
      status: 'ACTIVE',
      recipeId: 'recipe_1',
    });
    await expect(
      addRecipeLineSubstitute(scoped(), {
        recipeLineId: 'line_1',
        substituteIngredientId: 'ingredient_substitute',
      })
    ).rejects.toBeInstanceOf(VersionImmutabilityError);

    db.restaurantRecipeVersion.findUnique.mockResolvedValue({
      id: 'version_1',
      status: 'DRAFT',
      recipeId: 'recipe_1',
    });
    db.restaurantRecipeLineSubstitute.findUnique.mockResolvedValue({ id: 'existing' });
    await expect(
      addRecipeLineSubstitute(scoped(), {
        recipeLineId: 'line_1',
        substituteIngredientId: 'ingredient_substitute',
      })
    ).rejects.toMatchObject({ reason: 'ALREADY_ATTACHED' });
  });
});
