-- Scheduler discovery runs with platform scope; writes still require tenant scope.
CREATE POLICY chronic_refill_platform_scan ON "pharmacy_chronic_refill_subscriptions"
  FOR SELECT
  USING (current_setting('app.is_platform_admin', true) = 'true');
