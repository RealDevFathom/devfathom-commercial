BEGIN;

-- DEV-175: extracted sizes (variants) are OCR output. A reviewer now confirms
-- every size name and price explicitly; commit imports only these confirmed
-- sizes, never the raw extractedVariants. NULL means "not confirmed yet".
-- The table already has row-level security; a new column inherits it.
ALTER TABLE "restaurant_menu_import_lines"
  ADD COLUMN IF NOT EXISTS "reviewedVariants" JSONB;

COMMIT;
