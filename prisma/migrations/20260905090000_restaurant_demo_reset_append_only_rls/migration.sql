CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_customer_interactions"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_customer_consents"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_loyalty_points_entries"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_labour_cost_facts"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));
