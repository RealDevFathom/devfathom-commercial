BEGIN;

-- DEV-957 phase 2: an enrolled pharmacy counter's device secret expires on the server.
--
-- "secretExpiresAt" is when the server stops accepting this counter's secret for anything that
-- would let it keep selling offline: a fresh signed price list, a receipt-number block or a
-- stock quota. Sales the counter already signed while the secret was valid still replay, and a
-- counter that is online renews (rotates) its own secret before this time, which moves it 30 days
-- on. A manager's rotation in Settings, Counter computers moves it 30 days on as well.
--
-- Additive and idempotent: one column with a default, so no row is read or rewritten here (the
-- default is evaluated once, at this migration, for the counters already enrolled, which gives
-- each of them a full 30 days). The table keeps its forced row-level security and policies.

ALTER TABLE "pharmacy_registered_devices"
  ADD COLUMN IF NOT EXISTS "secretExpiresAt" TIMESTAMP(3) NOT NULL
  DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days');

COMMIT;
