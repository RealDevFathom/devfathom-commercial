BEGIN;
SET LOCAL lock_timeout = '5s';

-- Card and ledger writers need only their original table privileges. These trigger-only
-- projections derive every target from an existing row authorized by its source table.
CREATE OR REPLACE FUNCTION wallet_revoke_pharmacy_card() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_RELID <> 'public.pharmacy_loyalty_cards'::regclass OR TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'Invalid wallet projection source' USING ERRCODE = '42501';
  END IF;
  IF OLD."revokedAt" IS NOT NULL OR NEW."revokedAt" IS NULL THEN RETURN NEW; END IF;
  WITH revoked AS (
    UPDATE public.restaurant_wallet_passes SET status='REVOKED',"revokedAt"=NEW."revokedAt",
      "contentRevision"="contentRevision"+1,"updatedAt"=now()
    WHERE "organizationId"=NEW."organizationId" AND "pharmacyCardId"=NEW.id AND status='ACTIVE'
    RETURNING id,"organizationId"
  )
  INSERT INTO public.restaurant_wallet_pass_updates (id,"organizationId","passId",reason,"nextAttemptAt","updatedAt")
    SELECT gen_random_uuid()::text,"organizationId",id,'REVOKE',now(),now() FROM revoked
    ON CONFLICT ("passId") WHERE status='PENDING' DO UPDATE SET reason='REVOKE',"nextAttemptAt"=now(),"updatedAt"=now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.wallet_revoke_pharmacy_card() FROM PUBLIC;

CREATE OR REPLACE FUNCTION wallet_enqueue_pharmacy_balance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_RELID <> 'public.pharmacy_loyalty_points_entries'::regclass OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Invalid wallet projection source' USING ERRCODE = '42501';
  END IF;
  WITH changed AS (
    UPDATE public.restaurant_wallet_passes p SET "contentRevision"="contentRevision"+1,"updatedAt"=now()
    FROM public.pharmacy_loyalty_cards c WHERE c."organizationId"=NEW."organizationId" AND c."customerId"=NEW."customerId"
    AND c."revokedAt" IS NULL AND p."organizationId"=c."organizationId" AND p."pharmacyCardId"=c.id AND p.status='ACTIVE'
    RETURNING p.id,p."organizationId"
  )
  INSERT INTO public.restaurant_wallet_pass_updates (id,"organizationId","passId",reason,"nextAttemptAt","updatedAt")
  SELECT gen_random_uuid()::text,"organizationId",id,'LEDGER',now(),now() FROM changed
  ON CONFLICT ("passId") WHERE status='PENDING' DO UPDATE SET "nextAttemptAt"=LEAST(restaurant_wallet_pass_updates."nextAttemptAt",now()),"updatedAt"=now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.wallet_enqueue_pharmacy_balance() FROM PUBLIC;

COMMIT;
