-- Report range indexes. Tenant policies and FORCE RLS are unchanged.
CREATE INDEX "qa144_close_report_idx" ON "restaurant_daily_closes" ("organizationId", "branchId", "businessDate", "createdAt", "id");
CREATE INDEX "qa144_drawer_report_idx" ON "restaurant_drawer_sessions" ("organizationId", "branchId", "businessDate", "id");
CREATE INDEX "qa144_sop_report_idx" ON "restaurant_sop_occurrences" ("organizationId", "branchId", "businessDate");
