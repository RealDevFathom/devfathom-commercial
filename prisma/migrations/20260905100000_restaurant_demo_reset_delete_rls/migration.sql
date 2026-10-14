CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_daily_close_tender_totals"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_daily_closes"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_drawer_movements"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_job_executions"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_notification_deliveries"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_order_events"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_payment_events"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_refunds"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_sop_escalation_events"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_sop_evidence"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_sop_verifications"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_staff_capability_audits"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_stock_movements"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_tax_refund_allocations"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_tenders"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_terminal_reconciliations"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));
