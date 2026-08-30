-- Additive configuration seam for approved ingredient substitutes on a recipe
-- ingredient line. Execution, costing, and POS selection remain out of scope.
CREATE TABLE "restaurant_recipe_line_substitutes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "recipeLineId" TEXT NOT NULL,
    "substituteIngredientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_recipe_line_substitutes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "restaurant_recipe_line_substitutes_recipeLineId_substituteIngredientId_key"
    ON "restaurant_recipe_line_substitutes"("recipeLineId", "substituteIngredientId");
CREATE INDEX "restaurant_recipe_line_substitutes_organizationId_idx"
    ON "restaurant_recipe_line_substitutes"("organizationId");
CREATE INDEX "restaurant_recipe_line_substitutes_substituteIngredientId_idx"
    ON "restaurant_recipe_line_substitutes"("substituteIngredientId");

-- Required parent key for the tenant-scoped recipe-line foreign key below.
ALTER TABLE "restaurant_recipe_lines"
    ADD CONSTRAINT "restaurant_recipe_lines_organizationId_id_key"
    UNIQUE ("organizationId", "id");

ALTER TABLE "restaurant_recipe_line_substitutes"
    ADD CONSTRAINT "restaurant_recipe_line_substitutes_recipeLineId_fkey"
    FOREIGN KEY ("recipeLineId") REFERENCES "restaurant_recipe_lines"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_recipe_line_substitutes"
    ADD CONSTRAINT "restaurant_recipe_line_substitutes_substituteIngredientId_fkey"
    FOREIGN KEY ("substituteIngredientId") REFERENCES "restaurant_ingredients"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Composite tenant keys prevent cross-organization references even when a
-- privileged maintenance connection bypasses RLS.
ALTER TABLE "restaurant_recipe_line_substitutes"
    ADD CONSTRAINT "restaurant_recipe_line_substitutes_organizationId_id_key"
    UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_recipe_line_substitutes"
    ADD CONSTRAINT "tenant_recipe_line_substitute_line_fk"
    FOREIGN KEY ("organizationId", "recipeLineId")
    REFERENCES "restaurant_recipe_lines" ("organizationId", "id")
    DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_recipe_line_substitutes"
    ADD CONSTRAINT "tenant_recipe_line_substitute_ingredient_fk"
    FOREIGN KEY ("organizationId", "substituteIngredientId")
    REFERENCES "restaurant_ingredients" ("organizationId", "id")
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "restaurant_recipe_line_substitutes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_recipe_line_substitutes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_recipe_line_substitutes"
    USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
