-- Prevent concurrent note saves from silently overwriting one another.
ALTER TABLE "notes" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
