BEGIN;
CREATE UNIQUE INDEX university_api_token_tenant_id ON api_tokens ("organizationId", id);
CREATE TABLE university_connector_topics (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL,
  token_id text NOT NULL,
  PRIMARY KEY (organization_id, kind),
  FOREIGN KEY (organization_id, token_id) REFERENCES api_tokens("organizationId", id) ON DELETE CASCADE
);
ALTER TABLE university_connector_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE university_connector_topics FORCE ROW LEVEL SECURITY;
CREATE POLICY university_connector_topics_tenant ON university_connector_topics
  USING (organization_id = current_setting('app.current_organization_id',true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id',true));
COMMIT;
