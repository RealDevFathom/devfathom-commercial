-- AskFathom chat only; deterministic reports and module AI keep their own permissions.
ALTER TABLE "organizations" ADD COLUMN "askFathomEnabled" BOOLEAN NOT NULL DEFAULT true;
