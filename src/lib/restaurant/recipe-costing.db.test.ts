/**
 * Run only against an explicitly supplied disposable, migrated TEST_DATABASE_URL.
 * No listener/seed is started. All fixtures roll back in one transaction.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';

vi.mock('server-only', () => ({}));

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl) process.env.DATABASE_URL = testUrl;
const D = (value: string) => new Prisma.Decimal(value);

(testUrl ? describe : describe.skip)('recipe dimensions in PostgreSQL', () => {
  it('scales persisted portions and converted subrecipe yields, then fails closed without conversion', async () => {
    const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
    const { explodeRecipeInDb } = await import('./recipe-costing');
    const organizationId = `recipe_units_${randomUUID().replaceAll('-', '')}`;
    const rollback = new Error('ROLLBACK_RECIPE_UNIT_FIXTURES');
    await expect(
      withPlatformDb(async (db) => {
        await db.organization.create({
          data: {
            id: organizationId,
            slug: organizationId,
            legalName: 'Recipe units regression',
            displayName: 'Recipe units regression',
            status: 'ACTIVE',
          },
        });
        await db.$queryRaw`SELECT set_config('app.current_organization_id', ${organizationId}, true), set_config('app.is_platform_admin', 'false', true)`;
        const kg = await db.restaurantUnit.create({ data: { name: 'kilogram' } });
        const g = await db.restaurantUnit.create({ data: { name: 'gram' } });
        const conversion = await db.restaurantUnitConversion.create({
          data: { fromUnitId: g.id, toUnitId: kg.id, factor: D('0.001') },
        });
        const product = await db.restaurantProduct.create({ data: { name: 'Recipe unit proof' } });
        const ingredient = await db.restaurantIngredient.create({
          data: { name: 'Flour', baseUnitId: g.id, referenceCost: D('0.04') },
        });
        const child = await db.restaurantRecipe.create({
          data: { productId: product.id, name: '2 kg base' },
        });
        const childVersion = await db.restaurantRecipeVersion.create({
          data: {
            recipeId: child.id,
            versionNumber: 1,
            status: 'ACTIVE',
            yieldQuantity: D('2'),
            yieldUnitId: kg.id,
            portionCount: 99,
          },
        });
        await db.restaurantRecipeLine.create({
          data: {
            recipeVersionId: childVersion.id,
            ingredientId: ingredient.id,
            quantity: D('100'),
            unitId: g.id,
          },
        });
        const parent = await db.restaurantRecipe.create({
          data: { productId: product.id, name: '10 portions' },
        });
        const parentVersion = await db.restaurantRecipeVersion.create({
          data: {
            recipeId: parent.id,
            versionNumber: 1,
            status: 'ACTIVE',
            yieldQuantity: D('2'),
            yieldUnitId: kg.id,
            portionCount: 10,
          },
        });
        await db.restaurantRecipeLine.create({
          data: {
            recipeVersionId: parentVersion.id,
            subRecipeId: child.id,
            quantity: D('500'),
            unitId: g.id,
          },
        });
        const selector = { organizationId, recipeVersionId: parentVersion.id };
        expect(
          (
            await explodeRecipeInDb(db, { ...selector, portions: D('20') })
          ).ingredients[0].quantityInBaseUnit.toString()
        ).toBe('50');
        expect(
          (
            await explodeRecipeInDb(db, { ...selector, portions: D('2.5') })
          ).ingredients[0].quantityInBaseUnit.toString()
        ).toBe('6.25');
        expect(
          (
            await explodeRecipeInDb(db, { ...selector, batches: D('1') })
          ).ingredients[0].quantityInBaseUnit.toString()
        ).toBe('25');
        await db.restaurantUnitConversion.delete({ where: { id: conversion.id } });
        await expect(explodeRecipeInDb(db, selector)).rejects.toMatchObject({
          reason: 'NO_UNIT_CONVERSION',
        });
        throw rollback;
      })
    ).rejects.toBe(rollback);
  });
});
