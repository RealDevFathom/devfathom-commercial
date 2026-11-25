BEGIN;

CREATE TABLE university_events (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id text NOT NULL DEFAULT gen_random_uuid()::text,
  kind text NOT NULL,
  source_key text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACKNOWLEDGED', 'FAILED')),
  acknowledgment text,
  acknowledged_at timestamptz,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, kind, source_key)
);
CREATE INDEX university_events_delivery ON university_events(organization_id, status, occurred_at, id);
ALTER TABLE university_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE university_events FORCE ROW LEVEL SECURITY;
CREATE POLICY university_events_tenant ON university_events
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- Shared by ordinary office mutations and the high-volume registration path.
CREATE FUNCTION university_emit_event(org text, event_kind text, event_key text, event_payload jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
BEGIN
  INSERT INTO university_events (organization_id, kind, source_key, payload)
  VALUES (org, event_kind, event_key, event_payload)
  ON CONFLICT (organization_id, kind, source_key) DO NOTHING;
  IF NOT FOUND AND NOT EXISTS (
    SELECT 1 FROM university_events
    WHERE organization_id = org AND kind = event_kind AND source_key = event_key AND payload = event_payload
  ) THEN
    RAISE EXCEPTION 'The event reference already belongs to a different change.' USING ERRCODE = '23505';
  END IF;
END;
$$;

COMMIT;
