-- DEV-928: a pack price row keeps who proposed it as well as who approved it.
-- createdById stays the approver (the member whose approval wrote the row); proposedById is
-- the member who proposed the price. Older rows keep it empty. No new table, so no new RLS.
BEGIN;
ALTER TABLE "pharmacy_pack_prices" ADD COLUMN IF NOT EXISTS "proposedById" TEXT;
COMMIT;
