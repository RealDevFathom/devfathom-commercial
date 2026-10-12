-- Backfill every legacy row into the existing DevFathom organization. The
-- setting also supplies the fail-closed default while required tenant columns
-- are added. Runtime requests replace it transaction-locally.
SELECT set_config('app.current_organization_id', 'org_devfathom', false);

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('SUPER_ADMIN', 'OPERATIONS', 'SALES', 'FINANCE', 'SUPPORT', 'AUDITOR');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('PROSPECT', 'ONBOARDING', 'ACTIVE', 'GRACE', 'SUSPENDED', 'TERMINATED', 'PURGING', 'PURGED');

-- CreateEnum
CREATE TYPE "OrganizationDeploymentMode" AS ENUM ('SHARED', 'DEDICATED');

-- CreateEnum
CREATE TYPE "OrganizationModuleStatus" AS ENUM ('ENABLED', 'DISABLED', 'TRIAL', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PermissionEffect" AS ENUM ('ALLOW', 'DENY');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'QUALIFIED', 'DISQUALIFIED', 'CONVERTED');

-- CreateEnum
CREATE TYPE "OpportunityStage" AS ENUM ('DISCOVERY', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CommercialContractStatus" AS ENUM ('DRAFT', 'ACTIVE', 'GRACE', 'EXPIRED', 'TERMINATED', 'RENEWAL_DUE');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'QUARTERLY', 'ANNUAL', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PlatformInvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID');

-- CreateEnum
CREATE TYPE "PlatformPaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "RenewalStatus" AS ENUM ('UPCOMING', 'IN_PROGRESS', 'RENEWED', 'LOST');

-- CreateEnum
CREATE TYPE "DomainVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "IdentityProtocol" AS ENUM ('OIDC', 'SAML');

-- CreateEnum
CREATE TYPE "IdentityConnectionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DISABLED', 'ERROR');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('PENDING', 'PROVISIONING', 'READY', 'DEGRADED', 'FAILED', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "PlatformJobType" AS ENUM ('PROVISION_SHARED', 'PROVISION_DEDICATED', 'CONFIGURE_DOMAIN', 'APPLY_BRAND', 'SYNC_IDENTITY', 'EXPORT_DATA', 'PURGE_DATA', 'SUSPEND', 'RESUME');

-- CreateEnum
CREATE TYPE "PlatformJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SupportSessionStatus" AS ENUM ('ACTIVE', 'ENDED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "LifecycleAction" AS ENUM ('CREATED', 'ACTIVATED', 'ENTERED_GRACE', 'SUSPENDED', 'RESUMED', 'TERMINATED', 'PURGE_SCHEDULED', 'PURGED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
ADD COLUMN     "organizationRoleId" TEXT;

-- AlterTable
ALTER TABLE "resignations" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "invitations" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "password_reset_tokens" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "review_cycles" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "reviews" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "client_contacts" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "project_members" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "boards" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "columns" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "column_default_assignees" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "labels" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "task_blockers" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "task_assignees" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "task_labels" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "task_checklists" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "task_checklist_items" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "task_comments" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "task_attachments" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "time_entries" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "recurring_expenses" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "channels" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "channel_members" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "message_edits" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "message_attachments" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "message_reactions" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "message_mentions" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "pinned_messages" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "saved_messages" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "leave_requests" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "performance_notes" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "project_files" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "milestones" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "activities" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "meetings" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "meeting_attendees" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "meeting_attendance_log" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "api_tokens" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "notes" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "note_revisions" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "leave_balances" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "webhooks" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "webhook_deliveries" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "two_factor_recovery_codes" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "note_mentions" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "note_shares" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "note_links" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "mailboxes" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- AlterTable
ALTER TABLE "email_messages" ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ONBOARDING',
    "deploymentMode" "OrganizationDeploymentMode" NOT NULL DEFAULT 'SHARED',
    "packageId" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "seatLimit" INTEGER NOT NULL DEFAULT 1,
    "gracePeriodDays" INTEGER NOT NULL DEFAULT 0,
    "activatedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "terminatedAt" TIMESTAMP(3),
    "purgeScheduledAt" TIMESTAMP(3),
    "dataResidency" TEXT,
    "primaryContactName" TEXT,
    "primaryContactEmail" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

INSERT INTO "organizations" (
    "id",
    "slug",
    "legalName",
    "displayName",
    "status",
    "deploymentMode",
    "timezone",
    "locale",
    "currency",
    "seatLimit",
    "gracePeriodDays",
    "activatedAt",
    "createdAt",
    "updatedAt"
) VALUES (
    'org_devfathom',
    'devfathom',
    'DevFathom',
    'DevFathom',
    'ACTIVE',
    'SHARED',
    'Asia/Karachi',
    'en',
    'USD',
    1000,
    14,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "platform_users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "PlatformRole" NOT NULL DEFAULT 'AUDITOR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "mfaRequired" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_modules" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "routePrefix" TEXT,
    "icon" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_packages" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "defaultSeats" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_package_modules" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "limits" JSONB,

    CONSTRAINT "platform_package_modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_modules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "moduleId" TEXT NOT NULL,
    "status" "OrganizationModuleStatus" NOT NULL DEFAULT 'ENABLED',
    "seatLimit" INTEGER,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "overrides" JSONB,
    "reason" TEXT,
    "changedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_limits" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "period" TEXT,
    "source" TEXT NOT NULL DEFAULT 'CONTRACT',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_usage_counters" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "key" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_usage_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_roles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_role_permissions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "organizationRoleId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "effect" "PermissionEffect" NOT NULL DEFAULT 'ALLOW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_permission_overrides" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "userId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "effect" "PermissionEffect" NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_permission_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_accounts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "website" TEXT,
    "industry" TEXT,
    "country" TEXT,
    "ownerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROSPECT',
    "source" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_leads" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "companyName" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "source" TEXT,
    "ownerId" TEXT,
    "notes" TEXT,
    "convertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_contacts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "title" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_opportunities" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "convertedOrganizationId" TEXT,
    "name" TEXT NOT NULL,
    "stage" "OpportunityStage" NOT NULL DEFAULT 'DISCOVERY',
    "estimatedValue" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "probability" INTEGER NOT NULL DEFAULT 10,
    "ownerId" TEXT,
    "expectedCloseAt" TIMESTAMP(3),
    "wonAt" TIMESTAMP(3),
    "lostAt" TIMESTAMP(3),
    "lossReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_opportunity_stage_events" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "fromStage" "OpportunityStage",
    "toStage" "OpportunityStage" NOT NULL,
    "reason" TEXT,
    "changedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_opportunity_stage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_proposals" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "total" DECIMAL(14,2) NOT NULL,
    "lineItems" JSONB NOT NULL,
    "validUntil" TIMESTAMP(3),
    "fileUrl" TEXT,
    "sentAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_follow_ups" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "leadId" TEXT,
    "opportunityId" TEXT,
    "ownerId" TEXT,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'OPEN',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_contracts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "CommercialContractStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "value" DECIMAL(14,2) NOT NULL,
    "billingInterval" "BillingInterval" NOT NULL DEFAULT 'ANNUAL',
    "seatLimit" INTEGER NOT NULL DEFAULT 1,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "graceUntil" TIMESTAMP(3),
    "autoRenew" BOOLEAN NOT NULL DEFAULT false,
    "signedAt" TIMESTAMP(3),
    "ownerId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_contract_modules" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "seatLimit" INTEGER,
    "limits" JSONB,

    CONSTRAINT "platform_contract_modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_invoices" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contractId" TEXT,
    "number" TEXT NOT NULL,
    "status" "PlatformInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "subtotal" DECIMAL(14,2) NOT NULL,
    "tax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "lineItems" JSONB NOT NULL,
    "issuedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_payments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "status" "PlatformPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "method" TEXT,
    "externalRef" TEXT,
    "idempotencyKey" TEXT,
    "paidAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_renewals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "status" "RenewalStatus" NOT NULL DEFAULT 'UPCOMING',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "ownerId" TEXT,
    "proposedValue" DECIMAL(14,2),
    "proposedSeats" INTEGER,
    "notes" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_renewals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_brands" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "logoUrl" TEXT,
    "markUrl" TEXT,
    "primaryColor" TEXT NOT NULL DEFAULT '#111110',
    "accentColor" TEXT NOT NULL DEFAULT '#FF684F',
    "supportEmail" TEXT,
    "fromName" TEXT,
    "faviconUrl" TEXT,
    "tokens" JSONB,
    "customCss" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_email_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'PLATFORM',
    "fromName" TEXT,
    "fromAddress" TEXT,
    "replyTo" TEXT,
    "encryptedApiKey" TEXT,
    "domainVerifiedAt" TIMESTAMP(3),
    "configuration" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_email_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_domains" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'APP',
    "verificationStatus" "DomainVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verificationToken" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_identity_connections" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "protocol" "IdentityProtocol" NOT NULL,
    "status" "IdentityConnectionStatus" NOT NULL DEFAULT 'DRAFT',
    "issuer" TEXT,
    "clientId" TEXT,
    "encryptedClientSecret" TEXT,
    "discoveryUrl" TEXT,
    "ssoUrl" TEXT,
    "entityId" TEXT,
    "certificate" TEXT,
    "domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowJit" BOOLEAN NOT NULL DEFAULT true,
    "enforceSso" BOOLEAN NOT NULL DEFAULT false,
    "roleMappings" JSONB,
    "configuration" JSONB,
    "lastTestedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_identity_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_scim_tokens" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_scim_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_scim_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "identityConnectionId" TEXT,
    "externalId" TEXT,
    "idempotencyKey" TEXT,
    "operation" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_scim_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_deployments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'production',
    "mode" "OrganizationDeploymentMode" NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL DEFAULT 'VERCEL',
    "projectId" TEXT,
    "region" TEXT,
    "url" TEXT,
    "databaseRef" TEXT,
    "edgeConfigRef" TEXT,
    "version" TEXT,
    "health" JSONB,
    "lastHealthyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_jobs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "type" "PlatformJobType" NOT NULL,
    "status" "PlatformJobStatus" NOT NULL DEFAULT 'QUEUED',
    "payload" JSONB,
    "result" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "idempotencyKey" TEXT,
    "requestedById" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_lifecycle_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "action" "LifecycleAction" NOT NULL,
    "fromStatus" "OrganizationStatus",
    "toStatus" "OrganizationStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "metadata" JSONB,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_lifecycle_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_support_sessions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "platformUserId" TEXT NOT NULL,
    "tenantUserId" TEXT,
    "reason" TEXT NOT NULL,
    "status" "SupportSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_support_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_logs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "actorPlatformUserId" TEXT,
    "actorTenantUserId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "requestId" TEXT,
    "reason" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organizations_status_idx" ON "organizations"("status");

-- CreateIndex
CREATE INDEX "organizations_deploymentMode_idx" ON "organizations"("deploymentMode");

-- CreateIndex
CREATE INDEX "organizations_packageId_idx" ON "organizations"("packageId");

-- CreateIndex
CREATE UNIQUE INDEX "platform_users_email_key" ON "platform_users"("email");

-- CreateIndex
CREATE INDEX "platform_users_role_active_idx" ON "platform_users"("role", "active");

-- CreateIndex
CREATE UNIQUE INDEX "platform_modules_key_key" ON "platform_modules"("key");

-- CreateIndex
CREATE INDEX "platform_modules_category_active_idx" ON "platform_modules"("category", "active");

-- CreateIndex
CREATE UNIQUE INDEX "platform_packages_key_key" ON "platform_packages"("key");

-- CreateIndex
CREATE INDEX "platform_packages_active_idx" ON "platform_packages"("active");

-- CreateIndex
CREATE INDEX "platform_package_modules_moduleId_idx" ON "platform_package_modules"("moduleId");

-- CreateIndex
CREATE UNIQUE INDEX "platform_package_modules_packageId_moduleId_key" ON "platform_package_modules"("packageId", "moduleId");

-- CreateIndex
CREATE INDEX "organization_modules_organizationId_status_idx" ON "organization_modules"("organizationId", "status");

-- CreateIndex
CREATE INDEX "organization_modules_moduleId_idx" ON "organization_modules"("moduleId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_modules_organizationId_moduleId_key" ON "organization_modules"("organizationId", "moduleId");

-- CreateIndex
CREATE INDEX "organization_limits_organizationId_idx" ON "organization_limits"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_limits_organizationId_key_key" ON "organization_limits"("organizationId", "key");

-- CreateIndex
CREATE INDEX "organization_usage_counters_organizationId_key_idx" ON "organization_usage_counters"("organizationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "organization_usage_counters_organizationId_key_periodStart__key" ON "organization_usage_counters"("organizationId", "key", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "organization_roles_organizationId_idx" ON "organization_roles"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_roles_organizationId_key_key" ON "organization_roles"("organizationId", "key");

-- CreateIndex
CREATE INDEX "organization_role_permissions_organizationId_idx" ON "organization_role_permissions"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_role_permissions_organizationRoleId_capability_key" ON "organization_role_permissions"("organizationRoleId", "capability");

-- CreateIndex
CREATE INDEX "user_permission_overrides_organizationId_idx" ON "user_permission_overrides"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "user_permission_overrides_userId_capability_key" ON "user_permission_overrides"("userId", "capability");

-- CreateIndex
CREATE INDEX "platform_accounts_organizationId_idx" ON "platform_accounts"("organizationId");

-- CreateIndex
CREATE INDEX "platform_accounts_status_idx" ON "platform_accounts"("status");

-- CreateIndex
CREATE INDEX "platform_leads_status_createdAt_idx" ON "platform_leads"("status", "createdAt");

-- CreateIndex
CREATE INDEX "platform_leads_accountId_idx" ON "platform_leads"("accountId");

-- CreateIndex
CREATE INDEX "platform_contacts_accountId_idx" ON "platform_contacts"("accountId");

-- CreateIndex
CREATE INDEX "platform_opportunities_accountId_stage_idx" ON "platform_opportunities"("accountId", "stage");

-- CreateIndex
CREATE INDEX "platform_opportunities_convertedOrganizationId_idx" ON "platform_opportunities"("convertedOrganizationId");

-- CreateIndex
CREATE INDEX "platform_opportunities_expectedCloseAt_idx" ON "platform_opportunities"("expectedCloseAt");

-- CreateIndex
CREATE INDEX "platform_opportunity_stage_events_opportunityId_createdAt_idx" ON "platform_opportunity_stage_events"("opportunityId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "platform_proposals_number_key" ON "platform_proposals"("number");

-- CreateIndex
CREATE INDEX "platform_proposals_opportunityId_status_idx" ON "platform_proposals"("opportunityId", "status");

-- CreateIndex
CREATE INDEX "platform_follow_ups_ownerId_status_dueAt_idx" ON "platform_follow_ups"("ownerId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "platform_follow_ups_accountId_idx" ON "platform_follow_ups"("accountId");

-- CreateIndex
CREATE INDEX "platform_follow_ups_leadId_idx" ON "platform_follow_ups"("leadId");

-- CreateIndex
CREATE INDEX "platform_follow_ups_opportunityId_idx" ON "platform_follow_ups"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "platform_contracts_number_key" ON "platform_contracts"("number");

-- CreateIndex
CREATE INDEX "platform_contracts_organizationId_status_idx" ON "platform_contracts"("organizationId", "status");

-- CreateIndex
CREATE INDEX "platform_contracts_endDate_idx" ON "platform_contracts"("endDate");

-- CreateIndex
CREATE INDEX "platform_contract_modules_moduleId_idx" ON "platform_contract_modules"("moduleId");

-- CreateIndex
CREATE UNIQUE INDEX "platform_contract_modules_contractId_moduleId_key" ON "platform_contract_modules"("contractId", "moduleId");

-- CreateIndex
CREATE UNIQUE INDEX "platform_invoices_number_key" ON "platform_invoices"("number");

-- CreateIndex
CREATE INDEX "platform_invoices_organizationId_status_idx" ON "platform_invoices"("organizationId", "status");

-- CreateIndex
CREATE INDEX "platform_invoices_contractId_idx" ON "platform_invoices"("contractId");

-- CreateIndex
CREATE INDEX "platform_invoices_dueAt_idx" ON "platform_invoices"("dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "platform_payments_idempotencyKey_key" ON "platform_payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "platform_payments_organizationId_status_idx" ON "platform_payments"("organizationId", "status");

-- CreateIndex
CREATE INDEX "platform_payments_invoiceId_idx" ON "platform_payments"("invoiceId");

-- CreateIndex
CREATE INDEX "platform_renewals_organizationId_status_idx" ON "platform_renewals"("organizationId", "status");

-- CreateIndex
CREATE INDEX "platform_renewals_dueAt_idx" ON "platform_renewals"("dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "organization_brands_organizationId_key" ON "organization_brands"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_email_settings_organizationId_key" ON "organization_email_settings"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_domains_host_key" ON "organization_domains"("host");

-- CreateIndex
CREATE UNIQUE INDEX "organization_domains_verificationToken_key" ON "organization_domains"("verificationToken");

-- CreateIndex
CREATE INDEX "organization_domains_organizationId_verificationStatus_idx" ON "organization_domains"("organizationId", "verificationStatus");

-- CreateIndex
CREATE INDEX "organization_identity_connections_organizationId_status_idx" ON "organization_identity_connections"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "organization_scim_tokens_tokenHash_key" ON "organization_scim_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "organization_scim_tokens_organizationId_idx" ON "organization_scim_tokens"("organizationId");

-- CreateIndex
CREATE INDEX "organization_scim_tokens_prefix_idx" ON "organization_scim_tokens"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "organization_scim_events_idempotencyKey_key" ON "organization_scim_events"("idempotencyKey");

-- CreateIndex
CREATE INDEX "organization_scim_events_organizationId_createdAt_idx" ON "organization_scim_events"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "organization_scim_events_externalId_idx" ON "organization_scim_events"("externalId");

-- CreateIndex
CREATE INDEX "organization_deployments_status_idx" ON "organization_deployments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "organization_deployments_organizationId_environment_key" ON "organization_deployments"("organizationId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "platform_jobs_idempotencyKey_key" ON "platform_jobs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "platform_jobs_status_scheduledAt_idx" ON "platform_jobs"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "platform_jobs_organizationId_idx" ON "platform_jobs"("organizationId");

-- CreateIndex
CREATE INDEX "organization_lifecycle_events_organizationId_createdAt_idx" ON "organization_lifecycle_events"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "platform_support_sessions_organizationId_status_idx" ON "platform_support_sessions"("organizationId", "status");

-- CreateIndex
CREATE INDEX "platform_support_sessions_platformUserId_status_idx" ON "platform_support_sessions"("platformUserId", "status");

-- CreateIndex
CREATE INDEX "platform_audit_logs_organizationId_createdAt_idx" ON "platform_audit_logs"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "platform_audit_logs_actorPlatformUserId_createdAt_idx" ON "platform_audit_logs"("actorPlatformUserId", "createdAt");

-- CreateIndex
CREATE INDEX "platform_audit_logs_action_createdAt_idx" ON "platform_audit_logs"("action", "createdAt");

-- CreateIndex
CREATE INDEX "platform_audit_logs_requestId_idx" ON "platform_audit_logs"("requestId");

-- CreateIndex
CREATE INDEX "users_organizationId_idx" ON "users"("organizationId");

-- CreateIndex
CREATE INDEX "resignations_organizationId_idx" ON "resignations"("organizationId");

-- CreateIndex
CREATE INDEX "invitations_organizationId_idx" ON "invitations"("organizationId");

-- CreateIndex
CREATE INDEX "password_reset_tokens_organizationId_idx" ON "password_reset_tokens"("organizationId");

-- CreateIndex
CREATE INDEX "review_cycles_organizationId_idx" ON "review_cycles"("organizationId");

-- CreateIndex
CREATE INDEX "reviews_organizationId_idx" ON "reviews"("organizationId");

-- CreateIndex
CREATE INDEX "clients_organizationId_idx" ON "clients"("organizationId");

-- CreateIndex
CREATE INDEX "client_contacts_organizationId_idx" ON "client_contacts"("organizationId");

-- CreateIndex
CREATE INDEX "contracts_organizationId_idx" ON "contracts"("organizationId");

-- CreateIndex
CREATE INDEX "projects_organizationId_idx" ON "projects"("organizationId");

-- CreateIndex
CREATE INDEX "project_members_organizationId_idx" ON "project_members"("organizationId");

-- CreateIndex
CREATE INDEX "boards_organizationId_idx" ON "boards"("organizationId");

-- CreateIndex
CREATE INDEX "columns_organizationId_idx" ON "columns"("organizationId");

-- CreateIndex
CREATE INDEX "column_default_assignees_organizationId_idx" ON "column_default_assignees"("organizationId");

-- CreateIndex
CREATE INDEX "labels_organizationId_idx" ON "labels"("organizationId");

-- CreateIndex
CREATE INDEX "tasks_organizationId_idx" ON "tasks"("organizationId");

-- CreateIndex
CREATE INDEX "task_blockers_organizationId_idx" ON "task_blockers"("organizationId");

-- CreateIndex
CREATE INDEX "task_assignees_organizationId_idx" ON "task_assignees"("organizationId");

-- CreateIndex
CREATE INDEX "task_labels_organizationId_idx" ON "task_labels"("organizationId");

-- CreateIndex
CREATE INDEX "task_checklists_organizationId_idx" ON "task_checklists"("organizationId");

-- CreateIndex
CREATE INDEX "task_checklist_items_organizationId_idx" ON "task_checklist_items"("organizationId");

-- CreateIndex
CREATE INDEX "task_comments_organizationId_idx" ON "task_comments"("organizationId");

-- CreateIndex
CREATE INDEX "task_attachments_organizationId_idx" ON "task_attachments"("organizationId");

-- CreateIndex
CREATE INDEX "time_entries_organizationId_idx" ON "time_entries"("organizationId");

-- CreateIndex
CREATE INDEX "invoices_organizationId_idx" ON "invoices"("organizationId");

-- CreateIndex
CREATE INDEX "payments_organizationId_idx" ON "payments"("organizationId");

-- CreateIndex
CREATE INDEX "transactions_organizationId_idx" ON "transactions"("organizationId");

-- CreateIndex
CREATE INDEX "recurring_expenses_organizationId_idx" ON "recurring_expenses"("organizationId");

-- CreateIndex
CREATE INDEX "channels_organizationId_idx" ON "channels"("organizationId");

-- CreateIndex
CREATE INDEX "channel_members_organizationId_idx" ON "channel_members"("organizationId");

-- CreateIndex
CREATE INDEX "messages_organizationId_idx" ON "messages"("organizationId");

-- CreateIndex
CREATE INDEX "message_edits_organizationId_idx" ON "message_edits"("organizationId");

-- CreateIndex
CREATE INDEX "message_attachments_organizationId_idx" ON "message_attachments"("organizationId");

-- CreateIndex
CREATE INDEX "message_reactions_organizationId_idx" ON "message_reactions"("organizationId");

-- CreateIndex
CREATE INDEX "message_mentions_organizationId_idx" ON "message_mentions"("organizationId");

-- CreateIndex
CREATE INDEX "pinned_messages_organizationId_idx" ON "pinned_messages"("organizationId");

-- CreateIndex
CREATE INDEX "saved_messages_organizationId_idx" ON "saved_messages"("organizationId");

-- CreateIndex
CREATE INDEX "leave_requests_organizationId_idx" ON "leave_requests"("organizationId");

-- CreateIndex
CREATE INDEX "performance_notes_organizationId_idx" ON "performance_notes"("organizationId");

-- CreateIndex
CREATE INDEX "documents_organizationId_idx" ON "documents"("organizationId");

-- CreateIndex
CREATE INDEX "project_files_organizationId_idx" ON "project_files"("organizationId");

-- CreateIndex
CREATE INDEX "milestones_organizationId_idx" ON "milestones"("organizationId");

-- CreateIndex
CREATE INDEX "activities_organizationId_idx" ON "activities"("organizationId");

-- CreateIndex
CREATE INDEX "notifications_organizationId_idx" ON "notifications"("organizationId");

-- CreateIndex
CREATE INDEX "audit_logs_organizationId_idx" ON "audit_logs"("organizationId");

-- CreateIndex
CREATE INDEX "meetings_organizationId_idx" ON "meetings"("organizationId");

-- CreateIndex
CREATE INDEX "meeting_attendees_organizationId_idx" ON "meeting_attendees"("organizationId");

-- CreateIndex
CREATE INDEX "meeting_attendance_log_organizationId_idx" ON "meeting_attendance_log"("organizationId");

-- CreateIndex
CREATE INDEX "api_tokens_organizationId_idx" ON "api_tokens"("organizationId");

-- CreateIndex
CREATE INDEX "notes_organizationId_idx" ON "notes"("organizationId");

-- CreateIndex
CREATE INDEX "note_revisions_organizationId_idx" ON "note_revisions"("organizationId");

-- CreateIndex
CREATE INDEX "leave_balances_organizationId_idx" ON "leave_balances"("organizationId");

-- CreateIndex
CREATE INDEX "webhooks_organizationId_idx" ON "webhooks"("organizationId");

-- CreateIndex
CREATE INDEX "webhook_deliveries_organizationId_idx" ON "webhook_deliveries"("organizationId");

-- CreateIndex
CREATE INDEX "two_factor_recovery_codes_organizationId_idx" ON "two_factor_recovery_codes"("organizationId");

-- CreateIndex
CREATE INDEX "note_mentions_organizationId_idx" ON "note_mentions"("organizationId");

-- CreateIndex
CREATE INDEX "note_shares_organizationId_idx" ON "note_shares"("organizationId");

-- CreateIndex
CREATE INDEX "note_links_organizationId_idx" ON "note_links"("organizationId");

-- CreateIndex
CREATE INDEX "mailboxes_organizationId_idx" ON "mailboxes"("organizationId");

-- CreateIndex
CREATE INDEX "email_messages_organizationId_idx" ON "email_messages"("organizationId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organizationRoleId_fkey" FOREIGN KEY ("organizationRoleId") REFERENCES "organization_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "platform_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_package_modules" ADD CONSTRAINT "platform_package_modules_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "platform_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_package_modules" ADD CONSTRAINT "platform_package_modules_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "platform_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_modules" ADD CONSTRAINT "organization_modules_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_modules" ADD CONSTRAINT "organization_modules_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "platform_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_limits" ADD CONSTRAINT "organization_limits_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_usage_counters" ADD CONSTRAINT "organization_usage_counters_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_roles" ADD CONSTRAINT "organization_roles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_role_permissions" ADD CONSTRAINT "organization_role_permissions_organizationRoleId_fkey" FOREIGN KEY ("organizationRoleId") REFERENCES "organization_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_accounts" ADD CONSTRAINT "platform_accounts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_leads" ADD CONSTRAINT "platform_leads_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "platform_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_contacts" ADD CONSTRAINT "platform_contacts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "platform_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_opportunities" ADD CONSTRAINT "platform_opportunities_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "platform_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_opportunities" ADD CONSTRAINT "platform_opportunities_convertedOrganizationId_fkey" FOREIGN KEY ("convertedOrganizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_opportunity_stage_events" ADD CONSTRAINT "platform_opportunity_stage_events_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "platform_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_proposals" ADD CONSTRAINT "platform_proposals_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "platform_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_follow_ups" ADD CONSTRAINT "platform_follow_ups_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "platform_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_follow_ups" ADD CONSTRAINT "platform_follow_ups_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "platform_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_follow_ups" ADD CONSTRAINT "platform_follow_ups_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "platform_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_contracts" ADD CONSTRAINT "platform_contracts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_contracts" ADD CONSTRAINT "platform_contracts_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "platform_opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_contract_modules" ADD CONSTRAINT "platform_contract_modules_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "platform_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_contract_modules" ADD CONSTRAINT "platform_contract_modules_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "platform_modules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "platform_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_payments" ADD CONSTRAINT "platform_payments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_payments" ADD CONSTRAINT "platform_payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "platform_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_renewals" ADD CONSTRAINT "platform_renewals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_renewals" ADD CONSTRAINT "platform_renewals_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "platform_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_brands" ADD CONSTRAINT "organization_brands_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_email_settings" ADD CONSTRAINT "organization_email_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_domains" ADD CONSTRAINT "organization_domains_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_identity_connections" ADD CONSTRAINT "organization_identity_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_scim_tokens" ADD CONSTRAINT "organization_scim_tokens_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_scim_events" ADD CONSTRAINT "organization_scim_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_scim_events" ADD CONSTRAINT "organization_scim_events_identityConnectionId_fkey" FOREIGN KEY ("identityConnectionId") REFERENCES "organization_identity_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_deployments" ADD CONSTRAINT "organization_deployments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_jobs" ADD CONSTRAINT "platform_jobs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_lifecycle_events" ADD CONSTRAINT "organization_lifecycle_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_support_sessions" ADD CONSTRAINT "platform_support_sessions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
