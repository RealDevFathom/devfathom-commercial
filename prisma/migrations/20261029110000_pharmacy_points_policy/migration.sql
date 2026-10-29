ALTER TABLE pharmacy_loyalty_settings
 ADD COLUMN "pointsEnabled" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "earnEveryMinor" INTEGER NOT NULL DEFAULT 100 CHECK ("earnEveryMinor" BETWEEN 1 AND 100000000),
 ADD COLUMN "pointValueMinor" INTEGER NOT NULL DEFAULT 100 CHECK ("pointValueMinor" BETWEEN 1 AND 1000000),
 ADD COLUMN "minimumRedeemPoints" INTEGER NOT NULL DEFAULT 1 CHECK ("minimumRedeemPoints" BETWEEN 1 AND 1000000);
ALTER TABLE pharmacy_loyalty_points_entries
 ADD COLUMN "earnEveryMinor" INTEGER CHECK ("earnEveryMinor" > 0),
 ADD COLUMN "pointValueMinor" INTEGER CHECK ("pointValueMinor" > 0);
-- Historical entries used the fixed one-point-per-100-paisa curve.
-- Keep their NULL snapshot as that explicit legacy curve; never rewrite ledger rows.
CREATE FUNCTION pharmacy_loyalty_policy_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Loyalty settings audit is append only'; END $$;
CREATE TRIGGER pharmacy_loyalty_policy_audit_immutable BEFORE UPDATE OR DELETE
 ON pharmacy_loyalty_settings_audits FOR EACH ROW EXECUTE FUNCTION pharmacy_loyalty_policy_audit_immutable();
