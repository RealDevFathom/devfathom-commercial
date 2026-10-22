-- QA-304 follow-up: intentionally preserve every organization-level override.
--
-- The schema has no provenance that can distinguish a DISABLED row written by the
-- former contract sync from an intentional administrator-authored row with the same
-- values. Deleting on shape alone could therefore broaden tenant access. This
-- migration deliberately performs no data repair; ambiguous rows require audited,
-- tenant-specific review rather than an authorization-broadening bulk deletion.
SELECT 1;
