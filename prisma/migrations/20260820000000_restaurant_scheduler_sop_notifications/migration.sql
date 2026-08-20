-- M7-L1 — Scheduler primitive, SOP compliance engine, and notifications: the
-- org-scoped durable job queue + APPEND-ONLY execution history, an inbound
-- webhook inbox, SOP templates/versions/steps, branch assignments, dated
-- occurrences (pinning the template version) + per-step completion, APPEND-ONLY
-- evidence, APPEND-ONLY verification decisions, escalation policies/steps +
-- APPEND-ONLY escalation events, in-app notifications + the channel-setting
-- matrix + APPEND-ONLY delivery records for the Restaurant vertical
-- (restaurant/m7-scheduler-sop-notifications).
--
-- Additive and org-scoped. Every new table carries a bare, RLS-guarded
-- organizationId (defaulting from the transaction-local setting so an INSERT
-- cannot omit or forge it) and gets forced org-level RLS with the exact clause
-- used by 20260728092000_row_level_security / M1-L1 … M6-L1 (including the
-- app.is_platform_admin control-plane escape). NO pre-M7 table is altered.
--
-- Binding design constraints (WHA-77/WHA-78 plan / §11.5 / D13/D21 defaults):
--   Append-only ledgers   restaurant_job_executions, restaurant_sop_evidence,
--                         restaurant_sop_verifications,
--                         restaurant_sop_escalation_events and
--                         restaurant_notification_deliveries receive SELECT +
--                         INSERT RLS policies ONLY (the M5/M6 append-only ledger
--                         pattern). With forced RLS and no UPDATE/DELETE policy
--                         the unprivileged app role cannot mutate or delete a
--                         row; a correction is a NEW row referencing the
--                         original context.
--   Scheduler primitive   restaurant_jobs is the org-scoped durable work queue;
--                         src/lib/restaurant/scheduler.ts claims a due job with
--                         FOR UPDATE SKIP LOCKED and appends one immutable
--                         execution per attempt. Bounded retries with backoff
--                         move a terminally-failing job to DEAD (D13).
--   Version pinning       an occurrence references the template VERSION it was
--                         generated against with ON DELETE RESTRICT, so recorded
--                         compliance history is never rewritten by a later edit.
--   UTC storage           dueAt/windowEndsAt are UTC instants derived from the
--                         branch-local due time; branch-local rendering happens
--                         at read time — no local value is recomputed from UTC.
--
-- The CREATE TABLE / index / single-column FK section below is the curated
-- output of `prisma migrate diff` for these models (schema-datamodel to
-- schema-datamodel — Prisma 7 renamed the flags to --from-schema/--to-schema —
-- so it carries no phantom drift for pre-existing tables). The security section
-- that follows is hand-authored because it uses migration-only constructs
-- (deferred composite tenant FKs, (organizationId, id) uniques, CHECKs, forced
-- RLS incl. the append-only policy omission) that Prisma cannot express, so an
-- auto-generated diff would try to DROP them as phantom drift.

-- CreateEnum
CREATE TYPE "RestaurantJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "RestaurantJobExecutionOutcome" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "RestaurantWebhookVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "RestaurantWebhookInboxStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "RestaurantSopTemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "RestaurantSopOccurrenceStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'SUBMITTED', 'VERIFIED', 'REJECTED', 'LATE', 'MISSED', 'WAIVED');

-- CreateEnum
CREATE TYPE "RestaurantSopVerificationAction" AS ENUM ('VERIFY', 'REJECT', 'WAIVE');

-- CreateEnum
CREATE TYPE "RestaurantSopRecurrenceFrequency" AS ENUM ('ONCE', 'DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "RestaurantSopEscalationScope" AS ENUM ('ORG', 'BRANCH');

-- CreateEnum
CREATE TYPE "RestaurantSopEscalationEventKind" AS ENUM ('FIRED', 'ACKNOWLEDGED', 'STOPPED');

-- CreateEnum
CREATE TYPE "RestaurantNotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS', 'PUSH', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "RestaurantNotificationDeliveryStatus" AS ENUM ('DELIVERED_IN_APP', 'STUBBED', 'FAILED');

-- CreateTable
CREATE TABLE "restaurant_jobs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "RestaurantJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "lastError" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_job_executions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "jobId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "outcome" "RestaurantJobExecutionOutcome" NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_job_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_webhook_inbox" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "source" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "verificationStatus" "RestaurantWebhookVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "status" "RestaurantWebhookInboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_webhook_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_sop_templates" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_sop_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_sop_template_versions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "templateId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" "RestaurantSopTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_sop_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_sop_template_steps" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "templateVersionId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT,
    "requiresPhoto" BOOLEAN NOT NULL DEFAULT false,
    "requiresSignature" BOOLEAN NOT NULL DEFAULT false,
    "requiresNote" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_sop_template_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_sop_assignments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "frequency" "RestaurantSopRecurrenceFrequency" NOT NULL DEFAULT 'DAILY',
    "interval" INTEGER NOT NULL DEFAULT 1,
    "daysOfWeek" INTEGER[],
    "monthDay" INTEGER,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "dueTimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "windowMinutes" INTEGER NOT NULL DEFAULT 1440,
    "graceMinutes" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_sop_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_sop_occurrences" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "assignmentId" TEXT NOT NULL,
    "templateVersionId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "status" "RestaurantSopOccurrenceStatus" NOT NULL DEFAULT 'SCHEDULED',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "windowEndsAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_sop_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_sop_occurrence_steps" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "occurrenceId" TEXT NOT NULL,
    "templateStepId" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "completedByStaffProfileId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_sop_occurrence_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_sop_evidence" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "occurrenceId" TEXT NOT NULL,
    "occurrenceStepId" TEXT,
    "contentHash" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageRef" TEXT,
    "uploaderStaffProfileId" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_sop_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_sop_verifications" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "occurrenceId" TEXT NOT NULL,
    "action" "RestaurantSopVerificationAction" NOT NULL,
    "actorStaffProfileId" TEXT,
    "coAuthorizationId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_sop_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_sop_escalation_policies" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "name" TEXT NOT NULL,
    "scope" "RestaurantSopEscalationScope" NOT NULL DEFAULT 'ORG',
    "branchId" TEXT,
    "stopOnAcknowledged" BOOLEAN NOT NULL DEFAULT true,
    "stopOnVerified" BOOLEAN NOT NULL DEFAULT true,
    "quietHoursStartMinutes" INTEGER,
    "quietHoursEndMinutes" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_sop_escalation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_sop_escalation_steps" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "policyId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "delayMinutes" INTEGER NOT NULL DEFAULT 0,
    "target" TEXT NOT NULL,
    "channel" "RestaurantNotificationChannel" NOT NULL DEFAULT 'IN_APP',
    "maxAttempts" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_sop_escalation_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_sop_escalation_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "occurrenceId" TEXT NOT NULL,
    "escalationStepId" TEXT,
    "kind" "RestaurantSopEscalationEventKind" NOT NULL,
    "actorStaffProfileId" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_sop_escalation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_notifications" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "recipientStaffProfileId" TEXT NOT NULL,
    "branchId" TEXT,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_notification_channel_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT,
    "category" TEXT NOT NULL,
    "channel" "RestaurantNotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_notification_channel_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_notification_deliveries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "notificationId" TEXT NOT NULL,
    "channel" "RestaurantNotificationChannel" NOT NULL,
    "status" "RestaurantNotificationDeliveryStatus" NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "restaurant_jobs_organizationId_idx" ON "restaurant_jobs"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_jobs_status_nextAttemptAt_idx" ON "restaurant_jobs"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_jobs_organizationId_idempotencyKey_key" ON "restaurant_jobs"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "restaurant_job_executions_organizationId_idx" ON "restaurant_job_executions"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_job_executions_jobId_idx" ON "restaurant_job_executions"("jobId");

-- CreateIndex
CREATE INDEX "restaurant_webhook_inbox_organizationId_idx" ON "restaurant_webhook_inbox"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_webhook_inbox_status_idx" ON "restaurant_webhook_inbox"("status");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_webhook_inbox_organizationId_source_externalEven_key" ON "restaurant_webhook_inbox"("organizationId", "source", "externalEventId");

-- CreateIndex
CREATE INDEX "restaurant_sop_templates_organizationId_idx" ON "restaurant_sop_templates"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_sop_template_versions_organizationId_idx" ON "restaurant_sop_template_versions"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_sop_template_versions_templateId_idx" ON "restaurant_sop_template_versions"("templateId");

-- CreateIndex
CREATE INDEX "restaurant_sop_template_versions_status_idx" ON "restaurant_sop_template_versions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_sop_template_versions_templateId_versionNumber_key" ON "restaurant_sop_template_versions"("templateId", "versionNumber");

-- CreateIndex
CREATE INDEX "restaurant_sop_template_steps_organizationId_idx" ON "restaurant_sop_template_steps"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_sop_template_steps_templateVersionId_idx" ON "restaurant_sop_template_steps"("templateVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_sop_template_steps_templateVersionId_stepOrder_key" ON "restaurant_sop_template_steps"("templateVersionId", "stepOrder");

-- CreateIndex
CREATE INDEX "restaurant_sop_assignments_organizationId_idx" ON "restaurant_sop_assignments"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_sop_assignments_branchId_idx" ON "restaurant_sop_assignments"("branchId");

-- CreateIndex
CREATE INDEX "restaurant_sop_assignments_templateId_idx" ON "restaurant_sop_assignments"("templateId");

-- CreateIndex
CREATE INDEX "restaurant_sop_assignments_active_idx" ON "restaurant_sop_assignments"("active");

-- CreateIndex
CREATE INDEX "restaurant_sop_occurrences_organizationId_idx" ON "restaurant_sop_occurrences"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_sop_occurrences_assignmentId_idx" ON "restaurant_sop_occurrences"("assignmentId");

-- CreateIndex
CREATE INDEX "restaurant_sop_occurrences_templateVersionId_idx" ON "restaurant_sop_occurrences"("templateVersionId");

-- CreateIndex
CREATE INDEX "restaurant_sop_occurrences_branchId_idx" ON "restaurant_sop_occurrences"("branchId");

-- CreateIndex
CREATE INDEX "restaurant_sop_occurrences_status_idx" ON "restaurant_sop_occurrences"("status");

-- CreateIndex
CREATE INDEX "restaurant_sop_occurrences_businessDate_idx" ON "restaurant_sop_occurrences"("businessDate");

-- CreateIndex
CREATE INDEX "restaurant_sop_occurrences_dueAt_idx" ON "restaurant_sop_occurrences"("dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_sop_occurrences_assignmentId_businessDate_key" ON "restaurant_sop_occurrences"("assignmentId", "businessDate");

-- CreateIndex
CREATE INDEX "restaurant_sop_occurrence_steps_organizationId_idx" ON "restaurant_sop_occurrence_steps"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_sop_occurrence_steps_occurrenceId_idx" ON "restaurant_sop_occurrence_steps"("occurrenceId");

-- CreateIndex
CREATE INDEX "restaurant_sop_occurrence_steps_templateStepId_idx" ON "restaurant_sop_occurrence_steps"("templateStepId");

-- CreateIndex
CREATE INDEX "restaurant_sop_occurrence_steps_completedByStaffProfileId_idx" ON "restaurant_sop_occurrence_steps"("completedByStaffProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_sop_occurrence_steps_occurrenceId_templateStepId_key" ON "restaurant_sop_occurrence_steps"("occurrenceId", "templateStepId");

-- CreateIndex
CREATE INDEX "restaurant_sop_evidence_organizationId_idx" ON "restaurant_sop_evidence"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_sop_evidence_occurrenceId_idx" ON "restaurant_sop_evidence"("occurrenceId");

-- CreateIndex
CREATE INDEX "restaurant_sop_evidence_occurrenceStepId_idx" ON "restaurant_sop_evidence"("occurrenceStepId");

-- CreateIndex
CREATE INDEX "restaurant_sop_evidence_contentHash_idx" ON "restaurant_sop_evidence"("contentHash");

-- CreateIndex
CREATE INDEX "restaurant_sop_evidence_uploaderStaffProfileId_idx" ON "restaurant_sop_evidence"("uploaderStaffProfileId");

-- CreateIndex
CREATE INDEX "restaurant_sop_verifications_organizationId_idx" ON "restaurant_sop_verifications"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_sop_verifications_occurrenceId_idx" ON "restaurant_sop_verifications"("occurrenceId");

-- CreateIndex
CREATE INDEX "restaurant_sop_verifications_actorStaffProfileId_idx" ON "restaurant_sop_verifications"("actorStaffProfileId");

-- CreateIndex
CREATE INDEX "restaurant_sop_verifications_coAuthorizationId_idx" ON "restaurant_sop_verifications"("coAuthorizationId");

-- CreateIndex
CREATE INDEX "restaurant_sop_escalation_policies_organizationId_idx" ON "restaurant_sop_escalation_policies"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_sop_escalation_policies_branchId_idx" ON "restaurant_sop_escalation_policies"("branchId");

-- CreateIndex
CREATE INDEX "restaurant_sop_escalation_policies_active_idx" ON "restaurant_sop_escalation_policies"("active");

-- CreateIndex
CREATE INDEX "restaurant_sop_escalation_steps_organizationId_idx" ON "restaurant_sop_escalation_steps"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_sop_escalation_steps_policyId_idx" ON "restaurant_sop_escalation_steps"("policyId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_sop_escalation_steps_policyId_stepOrder_key" ON "restaurant_sop_escalation_steps"("policyId", "stepOrder");

-- CreateIndex
CREATE INDEX "restaurant_sop_escalation_events_organizationId_idx" ON "restaurant_sop_escalation_events"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_sop_escalation_events_occurrenceId_idx" ON "restaurant_sop_escalation_events"("occurrenceId");

-- CreateIndex
CREATE INDEX "restaurant_sop_escalation_events_escalationStepId_idx" ON "restaurant_sop_escalation_events"("escalationStepId");

-- CreateIndex
CREATE INDEX "restaurant_sop_escalation_events_actorStaffProfileId_idx" ON "restaurant_sop_escalation_events"("actorStaffProfileId");

-- CreateIndex
CREATE INDEX "restaurant_notifications_organizationId_idx" ON "restaurant_notifications"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_notifications_recipientStaffProfileId_idx" ON "restaurant_notifications"("recipientStaffProfileId");

-- CreateIndex
CREATE INDEX "restaurant_notifications_branchId_idx" ON "restaurant_notifications"("branchId");

-- CreateIndex
CREATE INDEX "restaurant_notifications_category_idx" ON "restaurant_notifications"("category");

-- CreateIndex
CREATE INDEX "restaurant_notifications_isRead_idx" ON "restaurant_notifications"("isRead");

-- CreateIndex
CREATE INDEX "restaurant_notification_channel_settings_organizationId_idx" ON "restaurant_notification_channel_settings"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_notification_channel_settings_branchId_idx" ON "restaurant_notification_channel_settings"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_notification_channel_settings_organizationId_bra_key" ON "restaurant_notification_channel_settings"("organizationId", "branchId", "category", "channel");

-- One organization-default row per category/channel. PostgreSQL treats NULLs as
-- distinct in the four-column key above, so the null branch scope needs its own key.
CREATE UNIQUE INDEX "restaurant_notification_channel_settings_org_default_key" ON "restaurant_notification_channel_settings"("organizationId", "category", "channel") WHERE "branchId" IS NULL;

-- CreateIndex
CREATE INDEX "restaurant_notification_deliveries_organizationId_idx" ON "restaurant_notification_deliveries"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_notification_deliveries_notificationId_idx" ON "restaurant_notification_deliveries"("notificationId");

-- CreateIndex
CREATE INDEX "restaurant_notification_deliveries_channel_idx" ON "restaurant_notification_deliveries"("channel");

-- AddForeignKey
ALTER TABLE "restaurant_job_executions" ADD CONSTRAINT "restaurant_job_executions_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "restaurant_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_template_versions" ADD CONSTRAINT "restaurant_sop_template_versions_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "restaurant_sop_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_template_steps" ADD CONSTRAINT "restaurant_sop_template_steps_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "restaurant_sop_template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_assignments" ADD CONSTRAINT "restaurant_sop_assignments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_assignments" ADD CONSTRAINT "restaurant_sop_assignments_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "restaurant_sop_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_occurrences" ADD CONSTRAINT "restaurant_sop_occurrences_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "restaurant_sop_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_occurrences" ADD CONSTRAINT "restaurant_sop_occurrences_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "restaurant_sop_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_occurrences" ADD CONSTRAINT "restaurant_sop_occurrences_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_occurrence_steps" ADD CONSTRAINT "restaurant_sop_occurrence_steps_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "restaurant_sop_occurrences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_occurrence_steps" ADD CONSTRAINT "restaurant_sop_occurrence_steps_templateStepId_fkey" FOREIGN KEY ("templateStepId") REFERENCES "restaurant_sop_template_steps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_occurrence_steps" ADD CONSTRAINT "restaurant_sop_occurrence_steps_completedByStaffProfileId_fkey" FOREIGN KEY ("completedByStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_evidence" ADD CONSTRAINT "restaurant_sop_evidence_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "restaurant_sop_occurrences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_evidence" ADD CONSTRAINT "restaurant_sop_evidence_occurrenceStepId_fkey" FOREIGN KEY ("occurrenceStepId") REFERENCES "restaurant_sop_occurrence_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_evidence" ADD CONSTRAINT "restaurant_sop_evidence_uploaderStaffProfileId_fkey" FOREIGN KEY ("uploaderStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_verifications" ADD CONSTRAINT "restaurant_sop_verifications_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "restaurant_sop_occurrences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_verifications" ADD CONSTRAINT "restaurant_sop_verifications_actorStaffProfileId_fkey" FOREIGN KEY ("actorStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_verifications" ADD CONSTRAINT "restaurant_sop_verifications_coAuthorizationId_fkey" FOREIGN KEY ("coAuthorizationId") REFERENCES "restaurant_co_authorizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_escalation_policies" ADD CONSTRAINT "restaurant_sop_escalation_policies_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_escalation_steps" ADD CONSTRAINT "restaurant_sop_escalation_steps_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "restaurant_sop_escalation_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_escalation_events" ADD CONSTRAINT "restaurant_sop_escalation_events_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "restaurant_sop_occurrences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_escalation_events" ADD CONSTRAINT "restaurant_sop_escalation_events_escalationStepId_fkey" FOREIGN KEY ("escalationStepId") REFERENCES "restaurant_sop_escalation_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sop_escalation_events" ADD CONSTRAINT "restaurant_sop_escalation_events_actorStaffProfileId_fkey" FOREIGN KEY ("actorStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_notifications" ADD CONSTRAINT "restaurant_notifications_recipientStaffProfileId_fkey" FOREIGN KEY ("recipientStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_notifications" ADD CONSTRAINT "restaurant_notifications_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_notification_channel_settings" ADD CONSTRAINT "restaurant_notification_channel_settings_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_notification_deliveries" ADD CONSTRAINT "restaurant_notification_deliveries_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "restaurant_notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Cross-tenant-safe composite integrity (matches M1-L1 … M6-L1): the
-- (organizationId, id) unique on every new table referenced by a composite FK,
-- so a child can only reference a parent inside its OWN organization. Only
-- composite-FK TARGET tables receive one (append-only leaves and settings are
-- never a composite parent).
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_jobs" ADD CONSTRAINT "restaurant_jobs_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_sop_templates" ADD CONSTRAINT "restaurant_sop_templates_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_sop_template_versions" ADD CONSTRAINT "restaurant_sop_template_versions_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_sop_template_steps" ADD CONSTRAINT "restaurant_sop_template_steps_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_sop_assignments" ADD CONSTRAINT "restaurant_sop_assignments_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_sop_occurrences" ADD CONSTRAINT "restaurant_sop_occurrences_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_sop_occurrence_steps" ADD CONSTRAINT "restaurant_sop_occurrence_steps_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_sop_escalation_policies" ADD CONSTRAINT "restaurant_sop_escalation_policies_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_sop_escalation_steps" ADD CONSTRAINT "restaurant_sop_escalation_steps_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_notifications" ADD CONSTRAINT "restaurant_notifications_organizationId_id_key" UNIQUE ("organizationId", "id");

-- ---------------------------------------------------------------------------
-- Business integrity the Prisma schema cannot express. Counts/attempts are
-- non-negative; a job must allow at least one attempt; recurrence intervals and
-- attempt caps are positive; minutes-of-day live in [0,1439]; an occurrence
-- window cannot end before it is due; an escalation policy's scope and branchId
-- agree; evidence size is non-negative.
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_jobs" ADD CONSTRAINT "restaurant_jobs_attempts_ck" CHECK ("attempts" >= 0 AND "maxAttempts" >= 1);
ALTER TABLE "restaurant_job_executions" ADD CONSTRAINT "restaurant_job_executions_attempt_ck" CHECK ("attempt" >= 1);
ALTER TABLE "restaurant_webhook_inbox" ADD CONSTRAINT "restaurant_webhook_inbox_attempts_ck" CHECK ("attempts" >= 0);
ALTER TABLE "restaurant_sop_template_versions" ADD CONSTRAINT "restaurant_sop_template_versions_version_ck" CHECK ("versionNumber" >= 1);
ALTER TABLE "restaurant_sop_template_steps" ADD CONSTRAINT "restaurant_sop_template_steps_order_ck" CHECK ("stepOrder" >= 0);
ALTER TABLE "restaurant_sop_assignments" ADD CONSTRAINT "restaurant_sop_assignments_recurrence_ck" CHECK ("interval" >= 1 AND "windowMinutes" >= 1 AND "graceMinutes" >= 0 AND "dueTimeMinutes" BETWEEN 0 AND 1439 AND ("monthDay" IS NULL OR "monthDay" BETWEEN 1 AND 31));
ALTER TABLE "restaurant_sop_occurrences" ADD CONSTRAINT "restaurant_sop_occurrences_window_ck" CHECK ("windowEndsAt" >= "dueAt");
ALTER TABLE "restaurant_sop_evidence" ADD CONSTRAINT "restaurant_sop_evidence_size_ck" CHECK ("sizeBytes" >= 0);
ALTER TABLE "restaurant_sop_escalation_policies" ADD CONSTRAINT "restaurant_sop_escalation_policies_scope_ck" CHECK (("scope" = 'BRANCH' AND "branchId" IS NOT NULL) OR ("scope" = 'ORG' AND "branchId" IS NULL));
ALTER TABLE "restaurant_sop_escalation_policies" ADD CONSTRAINT "restaurant_sop_escalation_policies_quiet_ck" CHECK (("quietHoursStartMinutes" IS NULL OR "quietHoursStartMinutes" BETWEEN 0 AND 1439) AND ("quietHoursEndMinutes" IS NULL OR "quietHoursEndMinutes" BETWEEN 0 AND 1439));
ALTER TABLE "restaurant_sop_escalation_steps" ADD CONSTRAINT "restaurant_sop_escalation_steps_ck" CHECK ("stepOrder" >= 0 AND "delayMinutes" >= 0 AND "maxAttempts" >= 1);
ALTER TABLE "restaurant_notification_deliveries" ADD CONSTRAINT "restaurant_notification_deliveries_attempt_ck" CHECK ("attempt" >= 1);

-- ---------------------------------------------------------------------------
-- Deferred composite tenant foreign keys. Every single-column FK to a table
-- carrying a (organizationId, id) unique is ALSO expressed as a
-- (organizationId, <fk>) composite so a cross-organization reference is
-- impossible even inside the platform scope. Nullable FK columns use MATCH
-- SIMPLE (the default), so the composite is checked only when the column is set.
-- (coAuthorizationId on restaurant_sop_verifications keeps a single-column FK
-- only — restaurant_co_authorizations carries no (organizationId, id) unique,
-- exactly the M5 refund/close precedent.)
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_job_executions" ADD CONSTRAINT "tenant_jobexec_jobId_fk" FOREIGN KEY ("organizationId", "jobId") REFERENCES "restaurant_jobs" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_template_versions" ADD CONSTRAINT "tenant_sopver_templateId_fk" FOREIGN KEY ("organizationId", "templateId") REFERENCES "restaurant_sop_templates" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_template_steps" ADD CONSTRAINT "tenant_sopstep_versionId_fk" FOREIGN KEY ("organizationId", "templateVersionId") REFERENCES "restaurant_sop_template_versions" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_assignments" ADD CONSTRAINT "tenant_sopasg_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_assignments" ADD CONSTRAINT "tenant_sopasg_templateId_fk" FOREIGN KEY ("organizationId", "templateId") REFERENCES "restaurant_sop_templates" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_occurrences" ADD CONSTRAINT "tenant_sopocc_assignmentId_fk" FOREIGN KEY ("organizationId", "assignmentId") REFERENCES "restaurant_sop_assignments" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_occurrences" ADD CONSTRAINT "tenant_sopocc_versionId_fk" FOREIGN KEY ("organizationId", "templateVersionId") REFERENCES "restaurant_sop_template_versions" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_occurrences" ADD CONSTRAINT "tenant_sopocc_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_occurrence_steps" ADD CONSTRAINT "tenant_soposc_occurrenceId_fk" FOREIGN KEY ("organizationId", "occurrenceId") REFERENCES "restaurant_sop_occurrences" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_occurrence_steps" ADD CONSTRAINT "tenant_soposc_stepId_fk" FOREIGN KEY ("organizationId", "templateStepId") REFERENCES "restaurant_sop_template_steps" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_occurrence_steps" ADD CONSTRAINT "tenant_soposc_staffId_fk" FOREIGN KEY ("organizationId", "completedByStaffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_evidence" ADD CONSTRAINT "tenant_sopev_occurrenceId_fk" FOREIGN KEY ("organizationId", "occurrenceId") REFERENCES "restaurant_sop_occurrences" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_evidence" ADD CONSTRAINT "tenant_sopev_stepId_fk" FOREIGN KEY ("organizationId", "occurrenceStepId") REFERENCES "restaurant_sop_occurrence_steps" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_evidence" ADD CONSTRAINT "tenant_sopev_staffId_fk" FOREIGN KEY ("organizationId", "uploaderStaffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_verifications" ADD CONSTRAINT "tenant_sopvrf_occurrenceId_fk" FOREIGN KEY ("organizationId", "occurrenceId") REFERENCES "restaurant_sop_occurrences" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_verifications" ADD CONSTRAINT "tenant_sopvrf_actorId_fk" FOREIGN KEY ("organizationId", "actorStaffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_escalation_steps" ADD CONSTRAINT "tenant_sopesc_policyId_fk" FOREIGN KEY ("organizationId", "policyId") REFERENCES "restaurant_sop_escalation_policies" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_escalation_events" ADD CONSTRAINT "tenant_sopesv_occurrenceId_fk" FOREIGN KEY ("organizationId", "occurrenceId") REFERENCES "restaurant_sop_occurrences" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_escalation_events" ADD CONSTRAINT "tenant_sopesv_stepId_fk" FOREIGN KEY ("organizationId", "escalationStepId") REFERENCES "restaurant_sop_escalation_steps" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_sop_escalation_events" ADD CONSTRAINT "tenant_sopesv_actorId_fk" FOREIGN KEY ("organizationId", "actorStaffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_notifications" ADD CONSTRAINT "tenant_notif_recipientId_fk" FOREIGN KEY ("organizationId", "recipientStaffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_notifications" ADD CONSTRAINT "tenant_notif_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_notification_channel_settings" ADD CONSTRAINT "tenant_notifset_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_notification_deliveries" ADD CONSTRAINT "tenant_notifdlv_notificationId_fk" FOREIGN KEY ("organizationId", "notificationId") REFERENCES "restaurant_notifications" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- Forced org-level RLS on every new mutable table, identical clause to
-- 20260728092000_row_level_security / M1-L1 … M6-L1 (incl. the
-- app.is_platform_admin control-plane escape).
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_jobs" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_webhook_inbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_webhook_inbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_webhook_inbox" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_sop_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_sop_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_sop_templates" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_sop_template_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_sop_template_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_sop_template_versions" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_sop_template_steps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_sop_template_steps" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_sop_template_steps" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_sop_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_sop_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_sop_assignments" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_sop_occurrences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_sop_occurrences" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_sop_occurrences" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_sop_occurrence_steps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_sop_occurrence_steps" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_sop_occurrence_steps" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_sop_escalation_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_sop_escalation_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_sop_escalation_policies" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_sop_escalation_steps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_sop_escalation_steps" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_sop_escalation_steps" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_notifications" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_notification_channel_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_notification_channel_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_notification_channel_settings" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

-- ---------------------------------------------------------------------------
-- C-append-only: the five DB-enforced APPEND-ONLY ledgers. SELECT + INSERT
-- policies ONLY — with forced RLS and no UPDATE/DELETE policy, the unprivileged
-- app role cannot mutate or delete any row (the operation matches zero rows). A
-- correction is observable only as a NEW row referencing the original context.
-- This is the M5/M6 append-only ledger pattern applied to the job-execution
-- history, SOP evidence, SOP verification decisions, escalation events, and
-- notification deliveries (§11.5 / D13 / D21).
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_job_executions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_job_executions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_job_executions" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_job_executions" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_sop_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_sop_evidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_sop_evidence" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_sop_evidence" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_sop_verifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_sop_verifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_sop_verifications" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_sop_verifications" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_sop_escalation_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_sop_escalation_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_sop_escalation_events" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_sop_escalation_events" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_notification_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_notification_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_notification_deliveries" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_notification_deliveries" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
