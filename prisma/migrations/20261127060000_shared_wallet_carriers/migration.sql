BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE restaurant_wallet_passes
  ALTER COLUMN "customerId" DROP NOT NULL,
  ALTER COLUMN "loyaltyAccountId" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "pharmacyCardId" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid='restaurant_wallet_passes'::regclass AND conname='wallet_pass_carrier') THEN
    ALTER TABLE restaurant_wallet_passes ADD CONSTRAINT wallet_pass_carrier CHECK (
      ("pharmacyCardId" IS NULL AND "customerId" IS NOT NULL AND "loyaltyAccountId" IS NOT NULL)
      OR ("pharmacyCardId" IS NOT NULL AND "customerId" IS NULL AND "loyaltyAccountId" IS NULL)
    );
    ALTER TABLE restaurant_wallet_passes ADD CONSTRAINT wallet_pass_pharmacy_card_fk
      FOREIGN KEY ("organizationId","pharmacyCardId") REFERENCES pharmacy_loyalty_cards ("organizationId",id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS wallet_pass_pharmacy_platform ON restaurant_wallet_passes ("pharmacyCardId",platform);

CREATE OR REPLACE FUNCTION wallet_check_pharmacy_card() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."pharmacyCardId" IS NOT NULL AND NEW.status = 'ACTIVE' THEN
    PERFORM id FROM pharmacy_loyalty_cards WHERE id=NEW."pharmacyCardId" AND "organizationId"=NEW."organizationId" AND "revokedAt" IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Working pharmacy card required' USING ERRCODE='23503'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER wallet_check_pharmacy_card BEFORE INSERT OR UPDATE OF status,"pharmacyCardId","organizationId"
ON restaurant_wallet_passes FOR EACH ROW EXECUTE FUNCTION wallet_check_pharmacy_card();

CREATE OR REPLACE FUNCTION wallet_revoke_pharmacy_card() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH revoked AS (
    UPDATE restaurant_wallet_passes SET status='REVOKED',"revokedAt"=NEW."revokedAt",
      "contentRevision"="contentRevision"+1,"updatedAt"=now()
    WHERE "organizationId"=NEW."organizationId" AND "pharmacyCardId"=NEW.id AND status='ACTIVE'
    RETURNING id,"organizationId"
  )
  INSERT INTO restaurant_wallet_pass_updates (id,"organizationId","passId",reason,"nextAttemptAt","updatedAt")
    SELECT gen_random_uuid()::text,"organizationId",id,'REVOKE',now(),now() FROM revoked
    ON CONFLICT ("passId") WHERE status='PENDING' DO UPDATE SET reason='REVOKE',"nextAttemptAt"=now(),"updatedAt"=now();
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER wallet_revoke_pharmacy_card AFTER UPDATE OF "revokedAt" ON pharmacy_loyalty_cards
FOR EACH ROW WHEN (OLD."revokedAt" IS NULL AND NEW."revokedAt" IS NOT NULL) EXECUTE FUNCTION wallet_revoke_pharmacy_card();
COMMIT;
