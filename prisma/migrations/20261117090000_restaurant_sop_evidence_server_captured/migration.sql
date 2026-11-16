-- DEV-837 (security scan F16/F17): SOP proof provenance.
--
-- `serverCaptured` is true only for evidence rows written by a server capture
-- route that stored the bytes itself and computed the sha256 from them. Rows
-- created from caller-asserted metadata keep the default (false); the engine
-- no longer counts them as photo/signature proof and the file route no longer
-- lets them decide who may read a file.
--
-- No backfill: legacy rows cannot be told apart from forged metadata here.
-- Pharmacy proof with a capture receipt is recognised at runtime by its
-- receipt. Restaurant proof captured before this migration still governs file
-- reads by its server-issued blob name, but an occurrence still in progress at
-- deploy must re-capture photo/signature proof before its step is completed or
-- the occurrence is submitted.
--
-- restaurant_sop_evidence keeps its SELECT + INSERT-only forced RLS policies;
-- this migration adds a column only.
BEGIN;

ALTER TABLE "restaurant_sop_evidence"
  ADD COLUMN IF NOT EXISTS "serverCaptured" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
