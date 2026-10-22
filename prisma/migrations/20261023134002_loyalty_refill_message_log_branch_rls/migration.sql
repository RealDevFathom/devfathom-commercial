-- Loyalty 5/6 hold fixes (security review of be119659).
--
-- 1. `STOP REFILL` is its own inbound intent. It is logged as REFILL_OPT_OUT and
--    never changes the customer-wide WhatsApp consent flag.
-- 2. Provider acknowledgements (sent / delivered / read / failed) advance the
--    outbound log through DELIVERED and READ, only forwards (FAILED only from
--    SENT), so a duplicate or older (stale) acknowledgement changes nothing.
--    statusAt / deliveredAt / readAt record the provider times.
-- 3. Branch-aware row-level security for the message log, which now carries
--    branch-tagged refill-reminder outbox rows (patient/capture links, due date,
--    template payload).
BEGIN;

ALTER TABLE "pharmacy_message_logs" DROP CONSTRAINT "pharmacy_message_logs_kind_check";
ALTER TABLE "pharmacy_message_logs" ADD CONSTRAINT "pharmacy_message_logs_kind_check"
  CHECK ("kind" IN (
    'REFILL_REMINDER', 'KHATA_REMINDER', 'ORDER_REQUEST', 'ORDER_CONFIRMATION',
    'ORDER_FALLBACK', 'OPT_OUT', 'OPT_IN', 'CONSENT_ACK', 'REFILL_OPT_OUT'
  ));

ALTER TABLE "pharmacy_message_logs" DROP CONSTRAINT "pharmacy_message_logs_status_check";
ALTER TABLE "pharmacy_message_logs" ADD CONSTRAINT "pharmacy_message_logs_status_check"
  CHECK ("status" IN (
    'PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'RECEIVED', 'IGNORED'
  ));

ALTER TABLE "pharmacy_message_logs"
  ADD COLUMN "statusAt" TIMESTAMP(3),
  ADD COLUMN "deliveredAt" TIMESTAMP(3),
  ADD COLUMN "readAt" TIMESTAMP(3);

-- Acknowledgements arrive keyed by the provider's message id.
CREATE INDEX "pharmacy_message_logs_provider_message_idx"
  ON "pharmacy_message_logs" ("organizationId", "providerMessageId");

-- Branch isolation, the standard pharmacy pattern for a nullable branchId:
-- * A branch-bound session (app.current_branch_id set) reads and writes only its
--   own branch's rows. Every reminder row carries the capture's or account's
--   branch, so another branch's reminder metadata is invisible to it, and it
--   cannot insert or move a row into another branch (WITH CHECK).
-- * Rows without a branch are organization-level intake: inbound STOP / START /
--   order messages arrive before any branch is known, and they describe the
--   tenant-wide customer record, which is itself organization-scoped. They stay
--   visible to the tenant's sessions, never to another tenant.
-- * The organization-wide service path is a session with the tenant set and no
--   branch bound. It is used by the refill scheduler's per-tenant transaction, the
--   khata reminder job, the signed WhatsApp webhook and acknowledgement handler,
--   and the organization-level marketing report, which all act for the tenant as
--   a whole. It still sees only that tenant's rows.
-- * Platform admin keeps the existing cross-tenant path used by the scheduler's
--   due-capture selection (withPlatformDb).
DROP POLICY "tenant_isolation" ON "pharmacy_message_logs";
CREATE POLICY "tenant_branch_isolation" ON "pharmacy_message_logs"
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND (
        "branchId" IS NULL OR
        NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
        "branchId" = current_setting('app.current_branch_id', true)
      )
    )
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND (
        "branchId" IS NULL OR
        NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
        "branchId" = current_setting('app.current_branch_id', true)
      )
    )
  );

COMMIT;
