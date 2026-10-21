-- AI-03 / MED-04: OCR remains provenance-labelled proposal data. Posting is
-- refused by the domain until a human confirms every regulated line field.
ALTER TABLE "pharmacy_goods_receipts"
  ADD COLUMN "ocrDraftEvidence" JSONB;

ALTER TABLE "pharmacy_goods_receipt_lines"
  ADD COLUMN "ocrFieldEvidence" JSONB,
  ADD COLUMN "ocrRegulatedConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "ocrRegulatedConfirmedById" TEXT;

ALTER TABLE "pharmacy_goods_receipt_lines"
  ADD CONSTRAINT "pharmacy_grl_ocr_confirmation_complete_check" CHECK (
    ("ocrRegulatedConfirmedAt" IS NULL AND "ocrRegulatedConfirmedById" IS NULL)
    OR
    ("ocrRegulatedConfirmedAt" IS NOT NULL AND length(trim("ocrRegulatedConfirmedById")) > 0)
  );

-- Existing tenant + branch RLS policies cover these columns because they live
-- on the already FORCE-RLS receipt tables; no new relation is introduced.
