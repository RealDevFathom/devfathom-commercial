ALTER TABLE stored_value_journals
  DROP CONSTRAINT stored_value_journals_adjustment_reason_check,
  ADD CONSTRAINT stored_value_journals_adjustment_reason_check
    CHECK ("kind" <> 'ADJUSTMENT' OR ("reason" IS NOT NULL AND length(trim("reason")) > 0));
