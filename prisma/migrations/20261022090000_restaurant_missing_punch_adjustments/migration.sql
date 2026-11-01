-- Missing punches are represented by an immutable adjustment whose null
-- original timestamp preserves the fact that no source punch existed.
ALTER TABLE "restaurant_time_adjustments"
  ALTER COLUMN "originalAt" DROP NOT NULL;
