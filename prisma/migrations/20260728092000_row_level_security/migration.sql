-- PostgreSQL is the final tenant-isolation boundary. Application code must
-- set app.current_organization_id transaction-locally for tenant work, or
-- app.is_platform_admin=true for an authorized control-plane transaction.

ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_isolation" ON "organizations" USING (current_setting('app.is_platform_admin', true) = 'true' OR "id" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "id" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "users" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "resignations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resignations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "resignations" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invitations" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "password_reset_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_reset_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "password_reset_tokens" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "review_cycles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_cycles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "review_cycles" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reviews" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "reviews" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clients" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "clients" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "client_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_contacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "client_contacts" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "contracts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contracts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "contracts" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "projects" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "project_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_members" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "project_members" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "boards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "boards" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "boards" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "columns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "columns" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "columns" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "column_default_assignees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "column_default_assignees" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "column_default_assignees" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "labels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labels" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "labels" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tasks" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "task_blockers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_blockers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "task_blockers" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "task_assignees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_assignees" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "task_assignees" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "task_labels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_labels" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "task_labels" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "task_checklists" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_checklists" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "task_checklists" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "task_checklist_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_checklist_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "task_checklist_items" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "task_comments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_comments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "task_comments" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "task_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_attachments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "task_attachments" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "time_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "time_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "time_entries" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invoices" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payments" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transactions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "transactions" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "recurring_expenses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recurring_expenses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "recurring_expenses" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "channels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channels" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "channels" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "channel_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_members" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "channel_members" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "messages" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "message_edits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_edits" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "message_edits" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "message_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_attachments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "message_attachments" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "message_reactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_reactions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "message_reactions" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "message_mentions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_mentions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "message_mentions" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "pinned_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pinned_messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "pinned_messages" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "saved_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saved_messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "saved_messages" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "leave_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leave_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "leave_requests" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "performance_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "performance_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "performance_notes" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "documents" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "project_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_files" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "project_files" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "milestones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "milestones" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "milestones" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "activities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "activities" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "activities" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "notifications" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "audit_logs" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "meetings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meetings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "meetings" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "meeting_attendees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meeting_attendees" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "meeting_attendees" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "meeting_attendance_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meeting_attendance_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "meeting_attendance_log" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "api_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "api_tokens" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "notes" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "note_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "note_revisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "note_revisions" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "leave_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leave_balances" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "leave_balances" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "webhooks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhooks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "webhooks" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "webhook_deliveries" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "two_factor_recovery_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "two_factor_recovery_codes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "two_factor_recovery_codes" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "note_mentions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "note_mentions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "note_mentions" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "note_shares" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "note_shares" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "note_shares" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "note_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "note_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "note_links" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "mailboxes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mailboxes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "mailboxes" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "email_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "email_messages" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "organization_modules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_modules" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "organization_modules" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "organization_limits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_limits" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "organization_limits" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "organization_usage_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_usage_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "organization_usage_counters" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "organization_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "organization_roles" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "organization_role_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_role_permissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "organization_role_permissions" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "user_permission_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_permission_overrides" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "user_permission_overrides" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "organization_brands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_brands" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "organization_brands" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "organization_email_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_email_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "organization_email_settings" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "organization_domains" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_domains" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "organization_domains" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "organization_identity_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_identity_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "organization_identity_connections" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "organization_scim_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_scim_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "organization_scim_tokens" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "organization_scim_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_scim_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "organization_scim_events" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "organization_deployments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_deployments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "organization_deployments" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "organization_lifecycle_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_lifecycle_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "organization_lifecycle_events" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "platform_users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_users" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_users" USING (current_setting('app.is_platform_admin', true) = 'true') WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "platform_modules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_modules" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_modules" USING (current_setting('app.is_platform_admin', true) = 'true') WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "platform_packages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_packages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_packages" USING (current_setting('app.is_platform_admin', true) = 'true') WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "platform_package_modules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_package_modules" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_package_modules" USING (current_setting('app.is_platform_admin', true) = 'true') WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "platform_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_accounts" USING (current_setting('app.is_platform_admin', true) = 'true') WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "platform_leads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_leads" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_leads" USING (current_setting('app.is_platform_admin', true) = 'true') WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "platform_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_contacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_contacts" USING (current_setting('app.is_platform_admin', true) = 'true') WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "platform_opportunities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_opportunities" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_opportunities" USING (current_setting('app.is_platform_admin', true) = 'true') WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "platform_opportunity_stage_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_opportunity_stage_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_opportunity_stage_events" USING (current_setting('app.is_platform_admin', true) = 'true') WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "platform_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_proposals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_proposals" USING (current_setting('app.is_platform_admin', true) = 'true') WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "platform_follow_ups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_follow_ups" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_follow_ups" USING (current_setting('app.is_platform_admin', true) = 'true') WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "platform_contracts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_contracts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_contracts" USING (current_setting('app.is_platform_admin', true) = 'true') WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "platform_contract_modules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_contract_modules" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_contract_modules" USING (current_setting('app.is_platform_admin', true) = 'true') WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "platform_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_invoices" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_invoices" USING (current_setting('app.is_platform_admin', true) = 'true') WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "platform_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_payments" USING (current_setting('app.is_platform_admin', true) = 'true') WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "platform_renewals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_renewals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_renewals" USING (current_setting('app.is_platform_admin', true) = 'true') WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "platform_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_jobs" USING (current_setting('app.is_platform_admin', true) = 'true') WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "platform_support_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_support_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_support_sessions" USING (current_setting('app.is_platform_admin', true) = 'true') WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "platform_audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_audit_logs" USING (current_setting('app.is_platform_admin', true) = 'true') WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
