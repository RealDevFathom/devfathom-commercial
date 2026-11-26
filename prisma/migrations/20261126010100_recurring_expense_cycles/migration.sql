BEGIN;
SET LOCAL lock_timeout = '10s';
-- The owner is subject to FORCE RLS. Use the migration's transaction-local
-- platform scope to initialize all tenants, including inactive schedules.
SELECT set_config('app.is_platform_admin', 'true', true);

ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS "billingDay" smallint
  CONSTRAINT recurring_expenses_billing_day_check CHECK ("billingDay" BETWEEN 1 AND 31);
-- UTC midnight is the legacy date-only encoding. Other timestamps represent
-- instants in the workspace zone. Match the application's UTC fallback.
WITH zones AS MATERIALIZED (
  SELECT o.id, COALESCE(z.name, 'UTC') AS zone
  FROM organizations o LEFT JOIN pg_timezone_names z ON lower(z.name) = lower(o.timezone)
)
UPDATE recurring_expenses e SET "billingDay" = EXTRACT(DAY FROM
  CASE WHEN e."nextDueDate"::time = time '00:00' THEN e."nextDueDate"
       ELSE (e."nextDueDate" AT TIME ZONE 'UTC') AT TIME ZONE
         COALESCE((SELECT zone FROM zones WHERE id = e."organizationId"), 'UTC')
  END)
WHERE e."billingDay" IS NULL;
ALTER TABLE recurring_expenses ALTER COLUMN "billingDay" SET NOT NULL;

CREATE TABLE IF NOT EXISTS recurring_expense_postings (
  "organizationId" text NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "recurringExpenseId" text NOT NULL,
  "dueDate" date NOT NULL,
  PRIMARY KEY ("organizationId", "recurringExpenseId", "dueDate"),
  FOREIGN KEY ("organizationId", "recurringExpenseId") REFERENCES recurring_expenses ("organizationId", id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE recurring_expense_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_expense_postings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON recurring_expense_postings;
CREATE POLICY tenant_isolation ON recurring_expense_postings
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
COMMIT;
