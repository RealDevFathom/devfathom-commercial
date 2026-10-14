-- Nullable references preserve legacy raw-address routes and jobs unchanged.
CREATE UNIQUE INDEX "restaurant_printers_organizationId_branchId_id_key"
  ON "restaurant_printers" ("organizationId", "branchId", "id");
ALTER TABLE "restaurant_print_routes" ADD COLUMN "registeredPrinterId" TEXT;
ALTER TABLE "restaurant_print_jobs" ADD COLUMN "registeredPrinterId" TEXT;
CREATE INDEX "restaurant_print_routes_org_branch_registered_printer_idx"
  ON "restaurant_print_routes" ("organizationId", "branchId", "registeredPrinterId");
CREATE INDEX "restaurant_print_jobs_org_branch_registered_printer_idx"
  ON "restaurant_print_jobs" ("organizationId", "branchId", "registeredPrinterId");
-- RESTRICT prevents a deleted registry entry from becoming a legacy branch-wide job.
ALTER TABLE "restaurant_print_routes" ADD CONSTRAINT "restaurant_print_routes_registered_printer_fkey"
  FOREIGN KEY ("organizationId", "branchId", "registeredPrinterId")
  REFERENCES "restaurant_printers" ("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "restaurant_print_jobs" ADD CONSTRAINT "restaurant_print_jobs_registered_printer_fkey"
  FOREIGN KEY ("organizationId", "branchId", "registeredPrinterId")
  REFERENCES "restaurant_printers" ("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
