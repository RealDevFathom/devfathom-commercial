-- Intentionally the only SQL statement in this migration. A multi-statement
-- query or enclosing BEGIN makes procedure COMMIT fail with PostgreSQL 2D000.
CALL pharmacy_backfill_sale_line_gross_minor();
