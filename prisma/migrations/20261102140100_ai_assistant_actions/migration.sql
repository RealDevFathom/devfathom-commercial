-- DEV-576: the confirmed-write ledger for Ask Fathom.
--
-- Every write tool needs a person's approval. The server records a PROPOSED row
-- each time it emits a `tool-approval-request`; the wrapped tool `execute` then
-- runs only against a matching row (same organization, user, tool call id, tool
-- name and input hash), moving it PROPOSED -> EXECUTING -> SUCCEEDED / FAILED.
-- A forged or modified approval finds no matching row and is refused; a resent
-- approval or a provider failover finds SUCCEEDED and gets the stored result
-- back instead of running the write again.
--
-- "id" is the idempotency key (64 hex characters): SHA-256, or HMAC-SHA-256 keyed
-- from AUTH_SECRET, over organization, user, tool call id, tool name and the
-- canonical input. The input itself is never stored (it can hold a new password);
-- "result" holds redacted, JSON-safe tool output.

CREATE TYPE "AIAssistantActionStatus" AS ENUM ('PROPOSED', 'EXECUTING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "ai_assistant_actions" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "userId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "toolCallId" TEXT NOT NULL,
  "approvalId" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "status" "AIAssistantActionStatus" NOT NULL DEFAULT 'PROPOSED',
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ai_assistant_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_assistant_actions_organizationId_fkey" FOREIGN KEY ("organizationId")
    REFERENCES "organizations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_assistant_actions_id_format" CHECK ("id" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ai_assistant_actions_payload_hash_format" CHECK ("payloadHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ai_assistant_actions_identifier_lengths" CHECK (
    char_length("userId") BETWEEN 1 AND 191
    AND char_length("toolName") BETWEEN 1 AND 128
    AND char_length("toolCallId") BETWEEN 1 AND 256
    AND char_length("approvalId") BETWEEN 1 AND 256
  )
);

CREATE UNIQUE INDEX "ai_assistant_actions_organizationId_toolCallId_key"
  ON "ai_assistant_actions" ("organizationId", "toolCallId");
CREATE INDEX "ai_assistant_actions_organizationId_createdAt_idx"
  ON "ai_assistant_actions" ("organizationId", "createdAt");

ALTER TABLE "ai_assistant_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_assistant_actions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ai_assistant_actions"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
