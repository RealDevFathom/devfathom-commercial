-- Defense in depth for temporary authentication artifacts.
-- RLS prevents cross-organization access at runtime; these composite constraints
-- additionally prevent a privileged or defective writer from constructing a
-- cross-organization SSO state or login ticket.

ALTER TABLE "organization_sso_states"
  ADD CONSTRAINT "tenant_organization_sso_states_identityConnection_fk"
  FOREIGN KEY ("organizationId", "identityConnectionId")
  REFERENCES "organization_identity_connections" ("organizationId", "id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "tenant_sso_tickets"
  ADD CONSTRAINT "tenant_sso_tickets_user_fk"
  FOREIGN KEY ("organizationId", "userId")
  REFERENCES "users" ("organizationId", "id")
  DEFERRABLE INITIALLY DEFERRED;
