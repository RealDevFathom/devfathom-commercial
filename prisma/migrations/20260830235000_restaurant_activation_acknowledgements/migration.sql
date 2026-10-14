CREATE TYPE "RestaurantActivationAcknowledgementKind" AS ENUM ('TAX', 'PAYMENT', 'DEVICE', 'OPERATOR');

CREATE TABLE "restaurant_activation_acknowledgements" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "kind" "RestaurantActivationAcknowledgementKind" NOT NULL,
  "policyReference" TEXT NOT NULL,
  "acknowledgedById" TEXT NOT NULL,
  "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "restaurant_activation_acknowledgements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_activation_acknowledgements_policyReference_nonblank" CHECK (btrim("policyReference") <> '')
);

CREATE UNIQUE INDEX "restaurant_activation_acknowledgements_organizationId_kind_key"
  ON "restaurant_activation_acknowledgements"("organizationId", "kind");
CREATE INDEX "restaurant_activation_acknowledgements_organizationId_acknowledgedAt_idx"
  ON "restaurant_activation_acknowledgements"("organizationId", "acknowledgedAt");
CREATE INDEX "restaurant_activation_acknowledgements_acknowledgedById_acknowledgedAt_idx"
  ON "restaurant_activation_acknowledgements"("acknowledgedById", "acknowledgedAt");

ALTER TABLE "restaurant_activation_acknowledgements"
  ADD CONSTRAINT "restaurant_activation_acknowledgements_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_activation_acknowledgements"
  ADD CONSTRAINT "restaurant_activation_acknowledgements_acknowledgedById_fkey"
  FOREIGN KEY ("acknowledgedById") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "restaurant_activation_acknowledgements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_activation_acknowledgements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "restaurant_activation_acknowledgements"
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
