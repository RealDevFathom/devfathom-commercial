BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION wallet_enqueue_pharmacy_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH changed AS (
    UPDATE restaurant_wallet_passes p SET "contentRevision"="contentRevision"+1,"updatedAt"=now()
    FROM pharmacy_loyalty_cards c WHERE c."organizationId"=NEW."organizationId" AND c."customerId"=NEW."customerId"
    AND c."revokedAt" IS NULL AND p."organizationId"=c."organizationId" AND p."pharmacyCardId"=c.id AND p.status='ACTIVE'
    RETURNING p.id,p."organizationId"
  )
  INSERT INTO restaurant_wallet_pass_updates (id,"organizationId","passId",reason,"nextAttemptAt","updatedAt")
  SELECT gen_random_uuid()::text,"organizationId",id,'LEDGER',now(),now() FROM changed
  ON CONFLICT ("passId") WHERE status='PENDING' DO UPDATE SET "nextAttemptAt"=LEAST(restaurant_wallet_pass_updates."nextAttemptAt",now()),"updatedAt"=now();
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER pharmacy_ledger_wallet_update AFTER INSERT ON pharmacy_loyalty_points_entries
FOR EACH ROW EXECUTE FUNCTION wallet_enqueue_pharmacy_balance();
COMMIT;
