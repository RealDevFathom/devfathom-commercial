CREATE TABLE university_people (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id text NOT NULL DEFAULT gen_random_uuid()::text,
  email text NOT NULL CHECK (email = lower(btrim(email))),
  full_name text NOT NULL DEFAULT '', nationality text NOT NULL DEFAULT '',
  identity_kind text CHECK (identity_kind IN ('CNIC', 'NICOP', 'CRC', 'PASSPORT')),
  identity_ciphertext text,
  staff_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id), UNIQUE (organization_id, email), UNIQUE (organization_id, staff_user_id),
  FOREIGN KEY (organization_id, staff_user_id) REFERENCES users("organizationId", id)
);
CREATE TABLE university_portal_challenges (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id text NOT NULL, email text NOT NULL, code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL, PRIMARY KEY (organization_id, id)
);
CREATE INDEX university_challenges_expiry ON university_portal_challenges(organization_id, expires_at);
CREATE TABLE university_portal_sessions (
  organization_id text NOT NULL, token_hash text NOT NULL, person_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, token_hash), FOREIGN KEY (organization_id,person_id) REFERENCES university_people(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX university_sessions_expiry ON university_portal_sessions(organization_id, expires_at);
CREATE TABLE university_application_drafts (
  organization_id text NOT NULL, person_id text NOT NULL, intake_id text NOT NULL,
  qualification text NOT NULL DEFAULT '', equivalence_reference text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (organization_id,person_id,intake_id),
  FOREIGN KEY (organization_id,person_id) REFERENCES university_people(organization_id,id) ON DELETE CASCADE
);
CREATE TABLE university_documents (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, person_id text NOT NULL,
  label text NOT NULL, filename text NOT NULL, mime text NOT NULL,
  file_hash text NOT NULL, byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  complete boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,id), UNIQUE(organization_id,person_id,file_hash,label),
  FOREIGN KEY (organization_id,person_id) REFERENCES university_people(organization_id,id) ON DELETE CASCADE
);
CREATE TABLE university_document_parts (
  organization_id text NOT NULL, document_id text NOT NULL, part integer NOT NULL CHECK (part BETWEEN 0 AND 19), ciphertext text NOT NULL,
  PRIMARY KEY (organization_id,document_id,part), FOREIGN KEY (organization_id,document_id) REFERENCES university_documents(organization_id,id) ON DELETE CASCADE
);
CREATE TABLE university_document_reads (
  organization_id text NOT NULL, document_id text NOT NULL, actor_id text NOT NULL, actor_realm text NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY (organization_id,document_id) REFERENCES university_documents(organization_id,id) ON DELETE CASCADE
);
DO $$ DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['university_people','university_portal_challenges','university_portal_sessions','university_application_drafts','university_documents','university_document_parts','university_document_reads'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY university_tenant ON %I USING (organization_id = NULLIF(current_setting(''app.current_organization_id'',true),'''')) WITH CHECK (organization_id = NULLIF(current_setting(''app.current_organization_id'',true),''''))',t);
  END LOOP;
END $$;
