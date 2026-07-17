BEGIN;

DO $$ BEGIN
  CREATE TYPE "MailboxType" AS ENUM ('GMAIL', 'OUTLOOK', 'HOSTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS mailboxes (
  id text PRIMARY KEY,
  "userId" text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type "MailboxType" NOT NULL,
  "emailAddress" text NOT NULL,
  "displayName" text,
  credentials text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  "lastSyncedAt" timestamp(3),
  "createdAt" timestamp(3) NOT NULL DEFAULT current_timestamp,
  "updatedAt" timestamp(3) NOT NULL
);

CREATE INDEX IF NOT EXISTS mailboxes_user_id_idx ON mailboxes ("userId");

CREATE TABLE IF NOT EXISTS email_messages (
  id text PRIMARY KEY,
  "mailboxId" text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  "providerMessageId" text NOT NULL,
  "threadId" text,
  "fromAddr" text NOT NULL,
  "toAddrs" jsonb NOT NULL,
  "ccAddrs" jsonb,
  subject text,
  snippet text,
  "bodyHtml" text,
  "bodyText" text,
  "isRead" boolean NOT NULL DEFAULT false,
  "hasAttachments" boolean NOT NULL DEFAULT false,
  "sentAt" timestamp(3) NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT current_timestamp,
  CONSTRAINT email_messages_mailbox_provider_unique UNIQUE ("mailboxId", "providerMessageId")
);

CREATE INDEX IF NOT EXISTS email_messages_mailbox_sent_idx
  ON email_messages ("mailboxId", "sentAt");

CREATE TABLE IF NOT EXISTS assistant_approval_uses (
  jti text PRIMARY KEY,
  "userId" text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "toolName" text NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS assistant_approval_uses_created_at_idx
  ON assistant_approval_uses ("createdAt");

COMMIT;
