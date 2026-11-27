BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE restaurant_wallet_enrollment_links ALTER COLUMN "branchId" DROP NOT NULL,
 ADD COLUMN IF NOT EXISTS "pharmacyBranchId" text,
 ADD COLUMN IF NOT EXISTS "phoneJoin" boolean NOT NULL DEFAULT false;
ALTER TABLE restaurant_wallet_enrollment_attempts ALTER COLUMN "branchId" DROP NOT NULL,
 ADD COLUMN IF NOT EXISTS "pharmacyBranchId" text,
 ADD COLUMN IF NOT EXISTS "linkId" text;
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname='wallet_link_pharmacy_branch_fk') THEN
  ALTER TABLE restaurant_wallet_enrollment_links ADD CONSTRAINT wallet_link_pharmacy_branch_fk FOREIGN KEY ("organizationId","pharmacyBranchId") REFERENCES pharmacy_branches ("organizationId",id),
    ADD CONSTRAINT wallet_link_one_branch CHECK (num_nonnulls("branchId","pharmacyBranchId")=1 AND ("pharmacyBranchId" IS NULL OR "phoneJoin"));
  ALTER TABLE restaurant_wallet_enrollment_attempts ADD CONSTRAINT wallet_attempt_pharmacy_branch_fk FOREIGN KEY ("organizationId","pharmacyBranchId") REFERENCES pharmacy_branches ("organizationId",id),
    ADD CONSTRAINT wallet_attempt_one_branch CHECK (num_nonnulls("branchId","pharmacyBranchId")=1),
    ADD CONSTRAINT wallet_attempt_link_fk FOREIGN KEY ("organizationId","linkId") REFERENCES restaurant_wallet_enrollment_links ("organizationId",id);
 END IF;
END $$;
-- Old email posters can coexist with a phone poster for the same restaurant.
DROP INDEX IF EXISTS "restaurant_wallet_enrollment_links_active_branch_key";
CREATE UNIQUE INDEX IF NOT EXISTS wallet_active_restaurant_poster ON restaurant_wallet_enrollment_links ("organizationId","branchId","phoneJoin") WHERE active;
CREATE UNIQUE INDEX IF NOT EXISTS wallet_active_pharmacy_poster ON restaurant_wallet_enrollment_links ("organizationId","pharmacyBranchId") WHERE active;
COMMIT;
