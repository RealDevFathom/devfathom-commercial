BEGIN;

-- Serialize the one-time count with writers, including jobs already queued at rollout.
LOCK TABLE public.restaurant_jobs IN SHARE ROW EXCLUSIVE MODE;
SET LOCAL app.is_platform_admin = 'true';
CREATE SCHEMA IF NOT EXISTS restaurant_queue_private;
REVOKE ALL ON SCHEMA restaurant_queue_private FROM PUBLIC;

CREATE TABLE IF NOT EXISTS restaurant_queue_private.webhook_capacity (
  singleton boolean PRIMARY KEY CHECK (singleton),
  pending bigint NOT NULL CHECK (pending >= 0)
);
INSERT INTO restaurant_queue_private.webhook_capacity (singleton, pending)
SELECT true, count(*) FROM public.restaurant_jobs
WHERE type = 'webhook.process' AND status IN ('QUEUED', 'RUNNING')
ON CONFLICT (singleton) DO UPDATE SET pending = EXCLUDED.pending;

CREATE INDEX IF NOT EXISTS restaurant_jobs_pending_webhooks_org_idx
ON public.restaurant_jobs ("organizationId")
WHERE type = 'webhook.process' AND status IN ('QUEUED', 'RUNNING');

-- The trigger owns only the accounting operation. The runtime role has no
-- access to the private schema. Tenant lookups retain the caller's RLS scope.
CREATE OR REPLACE FUNCTION restaurant_queue_private.account_webhook_job()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  -- Deployment-wide admission policy. All totals include QUEUED and RUNNING.
  deployment_limit CONSTANT integer := 50000;
  payment_reserve CONSTANT integer := 10000;
  new_total bigint;
  was_pending boolean := false;
  is_pending boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    was_pending := OLD.type = 'webhook.process' AND OLD.status IN ('QUEUED', 'RUNNING');
  END IF;
  IF TG_OP <> 'DELETE' THEN
    is_pending := NEW.type = 'webhook.process' AND NEW.status IN ('QUEUED', 'RUNNING');
  END IF;
  IF was_pending AND NOT is_pending THEN
    UPDATE restaurant_queue_private.webhook_capacity SET pending = pending - 1 WHERE singleton;
  ELSIF is_pending AND NOT was_pending THEN
    -- Concurrent writers recheck the predicate on the locked row. The update
    -- and the actual job always commit or roll back in the same transaction.
    UPDATE restaurant_queue_private.webhook_capacity SET pending = pending + 1
    WHERE singleton AND pending < deployment_limit
    RETURNING pending INTO new_total;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'RW429', MESSAGE = 'Too many pending webhook jobs.';
    END IF;
    -- The public route has already authenticated the exact bytes and validated
    -- terminalEventSchema. Requeues must resolve to that same stored terminal
    -- event and its configured provider/device to qualify for reserved capacity.
    IF new_total > deployment_limit - payment_reserve AND NOT EXISTS (
      SELECT 1 FROM public.restaurant_webhook_inbox AS inbox
      JOIN public.restaurant_terminal_provider_configs AS provider
        ON provider."organizationId" = inbox."organizationId" AND provider.source = inbox.source
        AND provider."externalTerminalId" = inbox.payload->>'terminalId' AND provider.mode = 'WEBHOOK'
      WHERE inbox."organizationId" = NEW."organizationId" AND inbox.id = NEW.payload->>'inboxId'
        AND inbox.status = 'PENDING' AND inbox."verificationStatus" = 'VERIFIED' AND inbox."eventType" LIKE 'terminal.%'
        AND inbox.payload->>'status' IN ('initiated', 'approved', 'declined', 'voided')
        -- A repeated operator retry of the same dead job cannot take more
        -- reserved slots while an earlier payment attempt is still pending.
        AND NOT EXISTS (
          SELECT 1 FROM public.restaurant_jobs AS other
          WHERE other."organizationId" = NEW."organizationId" AND other.id <> NEW.id
            AND other.type = 'webhook.process' AND other.status IN ('QUEUED', 'RUNNING')
            AND other.payload->>'inboxId' = inbox.id
        )
      FOR SHARE OF provider
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'RW429', MESSAGE = 'Too many pending webhook jobs.';
    END IF;
  END IF;
  -- A platform-side transfer of a pending job also changes tenant capacity.
  IF was_pending AND is_pending AND OLD."organizationId" <> NEW."organizationId" THEN
    UPDATE restaurant_queue_private.webhook_capacity SET pending = pending WHERE singleton;
  END IF;
  IF is_pending AND (NOT was_pending OR OLD."organizationId" <> NEW."organizationId") THEN
    IF EXISTS (
      SELECT 1 FROM public.restaurant_jobs
      WHERE "organizationId" = NEW."organizationId" AND type = 'webhook.process'
        AND status IN ('QUEUED', 'RUNNING') OFFSET 1000
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'RW429', MESSAGE = 'Too many pending webhook jobs.';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION restaurant_queue_private.account_webhook_job() FROM PUBLIC;
CREATE OR REPLACE TRIGGER restaurant_webhook_capacity
AFTER INSERT OR DELETE OR UPDATE OF type, status, "organizationId" ON public.restaurant_jobs
FOR EACH ROW EXECUTE FUNCTION restaurant_queue_private.account_webhook_job();

COMMIT;
