\set ON_ERROR_STOP on

-- Run only in a fresh disposable database. This fixture builds the minimum
-- pre-migration parent surface needed to execute and probe the substitute seam.
CREATE ROLE restaurant_substitute_probe NOLOGIN NOSUPERUSER NOBYPASSRLS;

CREATE TABLE "restaurant_recipe_lines" (
    "id" TEXT PRIMARY KEY,
    "organizationId" TEXT NOT NULL
);
CREATE TABLE "restaurant_ingredients" (
    "id" TEXT PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    UNIQUE ("organizationId", "id")
);

INSERT INTO "restaurant_recipe_lines" ("id", "organizationId") VALUES
    ('line_same_tenant', 'org_a'),
    ('line_other_tenant', 'org_b');
INSERT INTO "restaurant_ingredients" ("id", "organizationId") VALUES
    ('ingredient_same_tenant', 'org_a'),
    ('ingredient_other_tenant', 'org_b');

\ir ../../prisma/migrations/20260830235900_restaurant_recipe_ingredient_substitutes/migration.sql

GRANT USAGE ON SCHEMA public TO restaurant_substitute_probe;
GRANT SELECT ON "restaurant_recipe_lines", "restaurant_ingredients" TO restaurant_substitute_probe;
GRANT SELECT, INSERT ON "restaurant_recipe_line_substitutes" TO restaurant_substitute_probe;

SET ROLE restaurant_substitute_probe;
DO $$
DECLARE
    role_row RECORD;
    cross_tenant_denied BOOLEAN := false;
BEGIN
    SELECT rolcanlogin, rolsuper, rolbypassrls
      INTO role_row
      FROM pg_catalog.pg_roles
     WHERE rolname = current_user;

    IF role_row.rolsuper OR role_row.rolbypassrls THEN
        RAISE EXCEPTION 'probe role must be NOSUPERUSER and NOBYPASSRLS';
    END IF;

    PERFORM set_config('app.is_platform_admin', 'false', false);
    PERFORM set_config('app.current_organization_id', 'org_a', false);

    INSERT INTO "restaurant_recipe_line_substitutes"
        ("id", "organizationId", "recipeLineId", "substituteIngredientId")
    VALUES
        ('sub_same_tenant', 'org_a', 'line_same_tenant', 'ingredient_same_tenant');

    BEGIN
        INSERT INTO "restaurant_recipe_line_substitutes"
            ("id", "organizationId", "recipeLineId", "substituteIngredientId")
        VALUES
            ('sub_other_tenant', 'org_b', 'line_other_tenant', 'ingredient_other_tenant');
    EXCEPTION
        WHEN insufficient_privilege THEN
            cross_tenant_denied := true;
    END;

    IF NOT cross_tenant_denied THEN
        RAISE EXCEPTION 'cross-tenant substitute insert unexpectedly succeeded';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM "restaurant_recipe_line_substitutes"
         WHERE "id" = 'sub_same_tenant'
           AND "organizationId" = 'org_a'
    ) THEN
        RAISE EXCEPTION 'same-tenant substitute insert was not visible';
    END IF;
END
$$;
RESET ROLE;
