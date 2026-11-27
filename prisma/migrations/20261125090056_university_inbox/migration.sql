CREATE TABLE university_command_inbox (
  organization_id text NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK(kind IN ('grade.draft','bank.collection','bank.settlement','finance.gl-acknowledgment')),
  external_id text NOT NULL, payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
  actor_id text NOT NULL, token_id text NOT NULL, result jsonb NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,kind,external_id),
  FOREIGN KEY(organization_id,actor_id) REFERENCES users("organizationId", id)
);
ALTER TABLE university_command_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE university_command_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY university_command_read ON university_command_inbox FOR SELECT
  USING (organization_id=current_setting('app.current_organization_id',true));
CREATE POLICY university_command_insert ON university_command_inbox FOR INSERT
  WITH CHECK (organization_id=current_setting('app.current_organization_id',true) AND actor_id=current_setting('app.current_user_id',true));
