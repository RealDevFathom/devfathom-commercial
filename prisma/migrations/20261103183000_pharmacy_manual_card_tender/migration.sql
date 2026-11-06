ALTER TABLE "pharmacy_tenders" ADD COLUMN "approvalCode" TEXT;

ALTER TABLE "pharmacy_tenders" ADD CONSTRAINT "pharmacy_tenders_manual_card_capture_check" CHECK (
  "type" <> 'CARD' OR "provider" <> 'MANUAL_TERMINAL' OR (
    "providerRef" IS NOT NULL AND length(btrim("providerRef")) BETWEEN 4 AND 120
    AND "approvalCode" IS NOT NULL AND length(btrim("approvalCode")) BETWEEN 1 AND 60
  )
);
