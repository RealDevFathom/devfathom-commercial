-- Tenant purge deletes every public table that has organizationId, which
-- covers growth_wa_settings, growth_wa_customers, growth_wa_messages, and
-- growth_wa_templates. Cascading this key also lets a direct organization
-- delete remove the settings row.
ALTER TABLE "growth_wa_settings" DROP CONSTRAINT "growth_wa_settings_organizationId_fkey";
ALTER TABLE "growth_wa_settings"
  ADD CONSTRAINT "growth_wa_settings_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
