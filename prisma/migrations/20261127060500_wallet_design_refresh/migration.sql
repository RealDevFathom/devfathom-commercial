BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE SEQUENCE IF NOT EXISTS wallet_managed_revision START WITH 1000000;
CREATE OR REPLACE FUNCTION wallet_set_managed_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."contentRevision"=nextval('wallet_managed_revision');
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER wallet_managed_revision BEFORE UPDATE OF "issuerMode","contentRevision" ON restaurant_wallet_passes
 FOR EACH ROW WHEN (NEW."issuerMode"='LIVE' AND NEW.platform='APPLE') EXECUTE FUNCTION wallet_set_managed_revision();

CREATE OR REPLACE FUNCTION wallet_refresh_design() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO restaurant_wallet_pass_updates (id,"organizationId","passId",reason,"nextAttemptAt","updatedAt")
  SELECT gen_random_uuid()::text,"organizationId",id,'PROGRAM',now(),now() FROM restaurant_wallet_passes
  WHERE "organizationId"=NEW."organizationId" AND status='ACTIVE' AND "issuerMode" IN ('LIVE','DEMO')
  ON CONFLICT ("passId") WHERE status='PENDING' DO UPDATE SET reason='PROGRAM',"nextAttemptAt"=now(),"updatedAt"=now();
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER wallet_refresh_design AFTER UPDATE OF "programDisplayName","logoPng","backgroundColor","foregroundColor",enabled
 ON restaurant_wallet_tenant_config FOR EACH ROW WHEN (NEW.enabled) EXECUTE FUNCTION wallet_refresh_design();

CREATE OR REPLACE FUNCTION wallet_advance_apple_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE restaurant_wallet_passes SET "contentRevision"="contentRevision"+1,"updatedAt"=now()
    WHERE id=NEW."passId" AND "organizationId"=NEW."organizationId" AND "issuerMode"='LIVE' AND platform='APPLE';
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER wallet_advance_apple_revision AFTER INSERT OR UPDATE OF reason,"nextAttemptAt" ON restaurant_wallet_pass_updates
 FOR EACH ROW WHEN (NEW.status='PENDING') EXECUTE FUNCTION wallet_advance_apple_revision();
COMMIT;
