-- Repair webhook outbox payloads that retained credentials below the top level.
-- Objects inside arrays are traversed too, so every key named `secret` or `url` is removed.
CREATE OR REPLACE FUNCTION "scrub_outbound_effect_credentials"(value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  result jsonb;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT COALESCE(
        jsonb_object_agg(entry.key, "scrub_outbound_effect_credentials"(entry.value)),
        '{}'::jsonb
      )
      INTO result
      FROM jsonb_each(value) AS entry
      WHERE entry.key NOT IN ('secret', 'url');
    WHEN 'array' THEN
      SELECT COALESCE(
        jsonb_agg("scrub_outbound_effect_credentials"(entry.value) ORDER BY entry.ordinality),
        '[]'::jsonb
      )
      INTO result
      FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(value, ordinality);
    ELSE
      result := value;
  END CASE;

  RETURN result;
END;
$$;

-- outbound_effects uses FORCE ROW LEVEL SECURITY, including for its owner. Use the
-- existing platform-admin policy path for this transaction-scoped data repair.
SELECT set_config('app.is_platform_admin', 'true', true);

UPDATE "outbound_effects"
SET payload = "scrub_outbound_effect_credentials"(payload)
WHERE kind = 'webhook';

DROP FUNCTION "scrub_outbound_effect_credentials"(jsonb);
