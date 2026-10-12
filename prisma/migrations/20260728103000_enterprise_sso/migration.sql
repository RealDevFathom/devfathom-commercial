CREATE TABLE "organization_sso_states" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "identityConnectionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organization_sso_states_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organization_sso_states_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "organization_sso_states_identityConnectionId_fkey"
      FOREIGN KEY ("identityConnectionId") REFERENCES "organization_identity_connections"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "organization_sso_states_key_key" ON "organization_sso_states"("key");
CREATE INDEX "organization_sso_states_organizationId_expiresAt_idx"
  ON "organization_sso_states"("organizationId", "expiresAt");
CREATE INDEX "organization_sso_states_identityConnectionId_expiresAt_idx"
  ON "organization_sso_states"("identityConnectionId", "expiresAt");

CREATE TABLE "tenant_sso_tickets" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tenant_sso_tickets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_sso_tickets_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "tenant_sso_tickets_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "tenant_sso_tickets_tokenHash_key" ON "tenant_sso_tickets"("tokenHash");
CREATE INDEX "tenant_sso_tickets_organizationId_expiresAt_idx"
  ON "tenant_sso_tickets"("organizationId", "expiresAt");
CREATE INDEX "tenant_sso_tickets_userId_expiresAt_idx"
  ON "tenant_sso_tickets"("userId", "expiresAt");

ALTER TABLE "organization_sso_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_sso_states" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "organization_sso_states"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

ALTER TABLE "tenant_sso_tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_sso_tickets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenant_sso_tickets"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
