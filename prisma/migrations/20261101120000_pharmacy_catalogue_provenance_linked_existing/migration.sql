-- Platform default medicine catalogue: link, don't copy, hand-entered duplicates.
--
-- When a catalogue item is a likely duplicate of a medicine the pharmacy entered
-- by hand, the apply records a provenance row naming the existing medicine
-- instead of creating a copy. `linkedExisting` marks those rows, so the medicine
-- stays a match candidate on every re-run (keeping the apply idempotent) and is
-- distinguishable from medicines the catalogue created.
ALTER TABLE "pharmacy_medicine_catalogue_provenance"
  ADD COLUMN "linkedExisting" BOOLEAN NOT NULL DEFAULT false;
