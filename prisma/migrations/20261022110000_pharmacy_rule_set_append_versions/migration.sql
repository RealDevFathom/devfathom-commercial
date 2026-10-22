-- Confirm/revert operations append immutable effective-dated versions. An
-- earlier open-ended version is retained as historical evidence, so overlap is
-- resolved by readers choosing the greatest effectiveFrom at their timestamp.
ALTER TABLE "pharmacy_jurisdiction_rule_sets"
  DROP CONSTRAINT "pharmacy_jurisdiction_rule_sets_no_overlap";
