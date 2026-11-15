-- DEV-76: owner-configured khata collection reminder schedule per branch.
-- Additive columns on the existing RLS-protected pharmacy_branches table; its
-- tenant isolation policies are unchanged. Defaults keep today's behaviour
-- (weekly, balance floor 100.00) until an owner saves a schedule.
BEGIN;

ALTER TABLE pharmacy_branches
  ADD COLUMN IF NOT EXISTS "khataReminderEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "khataReminderCadenceDays" INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS "khataReminderMinBalanceMinor" INTEGER NOT NULL DEFAULT 10000,
  ADD COLUMN IF NOT EXISTS "khataReminderRevision" INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pharmacy_branch_khata_reminder_schedule_check'
      AND conrelid = 'pharmacy_branches'::regclass
  ) THEN
    ALTER TABLE pharmacy_branches
      ADD CONSTRAINT pharmacy_branch_khata_reminder_schedule_check CHECK (
        "khataReminderCadenceDays" BETWEEN 1 AND 30
        AND "khataReminderMinBalanceMinor" BETWEEN 100 AND 100000000
        AND "khataReminderRevision" >= 0
      );
  END IF;
END $$;

COMMIT;
