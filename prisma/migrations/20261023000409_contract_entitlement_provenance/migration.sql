-- Contract synchronization may only supersede grants it can prove it owns.
ALTER TABLE "organization_modules"
  ADD COLUMN "sourceContractId" TEXT;

CREATE INDEX "organization_modules_sourceContractId_idx"
  ON "organization_modules"("sourceContractId");

ALTER TABLE "organization_modules"
  ADD CONSTRAINT "organization_modules_sourceContractId_fkey"
  FOREIGN KEY ("sourceContractId") REFERENCES "platform_contracts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
