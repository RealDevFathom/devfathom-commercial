BEGIN;

-- DEV-748: physical loyalty cards. Each card's QR holds only an opaque random code. The code is
-- never stored: only its SHA-256, unique within the organization, so a card from another
-- organization never resolves. A card is active while "revokedAt" is null; a lost card is
-- revoked and a new one issued, and the points balance (kept per customer) is unaffected.
-- Additive only: no existing row is changed.

CREATE TABLE IF NOT EXISTS "pharmacy_loyalty_cards" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "customerId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "issuedById" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedById" TEXT,
  "revokedAt" TIMESTAMP(3),
  "revokedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_loyalty_cards_pkey" PRIMARY KEY ("id"),
  -- A SHA-256 in lowercase hex: a plaintext card code can never be stored here by mistake.
  CONSTRAINT "pharmacy_loyalty_cards_code_hash_check" CHECK ("codeHash" ~ '^[0-9a-f]{64}$'),
  -- Revocation is all or nothing, and always says who revoked the card and why.
  CONSTRAINT "pharmacy_loyalty_cards_revocation_check" CHECK (
    ("revokedAt" IS NULL AND "revokedById" IS NULL AND "revokedReason" IS NULL) OR
    ("revokedAt" IS NOT NULL AND "revokedById" IS NOT NULL AND
      length(btrim("revokedReason")) BETWEEN 3 AND 200)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_loyalty_cards_organizationId_id_key"
  ON "pharmacy_loyalty_cards" ("organizationId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_loyalty_cards_organizationId_codeHash_key"
  ON "pharmacy_loyalty_cards" ("organizationId", "codeHash");
CREATE INDEX IF NOT EXISTS "pharmacy_loyalty_cards_organizationId_customerId_idx"
  ON "pharmacy_loyalty_cards" ("organizationId", "customerId");
-- At most one working card per customer: issuing a replacement revokes the old one first.
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_loyalty_cards_one_active_key"
  ON "pharmacy_loyalty_cards" ("organizationId", "customerId")
  WHERE "revokedAt" IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pharmacy_loyalty_cards_customer_fkey'
  ) THEN
    ALTER TABLE "pharmacy_loyalty_cards"
      ADD CONSTRAINT "pharmacy_loyalty_cards_customer_fkey"
      FOREIGN KEY ("organizationId", "customerId")
      REFERENCES "pharmacy_customers" ("organizationId", "id") ON DELETE RESTRICT;
  END IF;
END $$;

-- A card is never deleted, never moved to another customer or code, and a revoked card is never
-- brought back. The only change allowed is revoking an active card.
CREATE OR REPLACE FUNCTION pharmacy_loyalty_card_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharmacy loyalty cards are never deleted' USING ERRCODE = '55000';
  END IF;
  IF (NEW."id", NEW."organizationId", NEW."customerId", NEW."codeHash", NEW."issuedById", NEW."issuedAt", NEW."createdAt")
      IS DISTINCT FROM
     (OLD."id", OLD."organizationId", OLD."customerId", OLD."codeHash", OLD."issuedById", OLD."issuedAt", OLD."createdAt")
    OR OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'a pharmacy loyalty card can only be revoked once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pharmacy_loyalty_cards_guard') THEN
    CREATE TRIGGER pharmacy_loyalty_cards_guard
    BEFORE UPDATE OR DELETE ON "pharmacy_loyalty_cards"
    FOR EACH ROW EXECUTE FUNCTION pharmacy_loyalty_card_guard();
  END IF;
END $$;

ALTER TABLE "pharmacy_loyalty_cards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_loyalty_cards" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "pharmacy_loyalty_cards";
CREATE POLICY tenant_isolation ON "pharmacy_loyalty_cards"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

COMMIT;
