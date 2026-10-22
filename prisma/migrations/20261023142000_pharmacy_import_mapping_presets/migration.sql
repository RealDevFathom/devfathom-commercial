CREATE TABLE "import_mapping_presets" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "name" TEXT NOT NULL, "mapping" JSONB NOT NULL, "createdByUserId" TEXT NOT NULL,
  "updatedByUserId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "import_mapping_presets_org_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "import_mapping_presets_created_by_fkey" FOREIGN KEY ("organizationId", "createdByUserId") REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "import_mapping_presets_updated_by_fkey" FOREIGN KEY ("organizationId", "updatedByUserId") REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "import_mapping_presets_mapping_object" CHECK (jsonb_typeof("mapping") = 'object'),
  CONSTRAINT "import_mapping_presets_name_nonempty" CHECK (length(btrim("name")) BETWEEN 1 AND 80),
  CONSTRAINT "import_mapping_presets_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "import_mapping_presets_org_name_key" UNIQUE ("organizationId", "name")
);
CREATE INDEX "import_mapping_presets_org_updated_idx" ON "import_mapping_presets" ("organizationId", "updatedAt");
ALTER TABLE "import_mapping_presets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_mapping_presets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "import_mapping_presets_tenant_isolation" ON "import_mapping_presets"
 USING ("organizationId" = current_setting('app.current_organization_id', true))
 WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));
