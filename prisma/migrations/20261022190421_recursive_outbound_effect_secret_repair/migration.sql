-- The earlier outbox repair removed only top-level webhook credentials. Recursively
-- remove credential keys from objects, including objects nested inside arrays.
-- Use pg_temp so the helper cannot become a persistent, publicly callable function.
SELECT set_config('app.is_platform_admin', 'true', true);

CREATE OR REPLACE FUNCTION pg_temp.scrub_webhook_credentials(value JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  result JSONB;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT COALESCE(
        jsonb_object_agg(entry.key, pg_temp.scrub_webhook_credentials(entry.value)),
        '{}'::jsonb
      )
      INTO result
      FROM jsonb_each(value) AS entry
      WHERE entry.key NOT IN ('secret', 'url');
    WHEN 'array' THEN
      SELECT COALESCE(
        jsonb_agg(pg_temp.scrub_webhook_credentials(element.value) ORDER BY element.ordinality),
        '[]'::jsonb
      )
      INTO result
      FROM jsonb_array_elements(value) WITH ORDINALITY AS element(value, ordinality);
    ELSE
      result := value;
  END CASE;

  RETURN result;
END;
$$;

UPDATE "outbound_effects"
SET payload = pg_temp.scrub_webhook_credentials(payload)
WHERE kind = 'webhook';

DROP FUNCTION pg_temp.scrub_webhook_credentials(JSONB);
