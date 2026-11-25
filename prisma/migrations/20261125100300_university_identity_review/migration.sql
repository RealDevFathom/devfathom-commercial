ALTER TABLE university_people ADD COLUMN identity_revision integer NOT NULL DEFAULT 1 CHECK(identity_revision>0);
CREATE TABLE university_identity_reviews (
  organization_id text NOT NULL,id text NOT NULL DEFAULT gen_random_uuid()::text,person_id text NOT NULL,
  actor_id text NOT NULL,revision integer NOT NULL,kind text NOT NULL CHECK(kind IN ('OPENED','VERIFIED','CORRECTION','LINKED')),
  review_id text,reason text NOT NULL,occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,id),
  FOREIGN KEY(organization_id,person_id) REFERENCES university_people(organization_id,id),
  FOREIGN KEY(organization_id,actor_id) REFERENCES users("organizationId",id),
  FOREIGN KEY(organization_id,review_id) REFERENCES university_identity_reviews(organization_id,id)
);
CREATE UNIQUE INDEX university_identity_review_decision ON university_identity_reviews(organization_id,review_id)
  WHERE kind IN ('VERIFIED','CORRECTION');
CREATE INDEX university_identity_review_history ON university_identity_reviews(organization_id,person_id,revision,occurred_at);
ALTER TABLE university_identity_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE university_identity_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY university_identity_audit_read ON university_identity_reviews FOR SELECT
USING(organization_id=current_setting('app.current_organization_id',true) AND EXISTS(SELECT FROM university_people p WHERE p.organization_id=university_identity_reviews.organization_id AND p.id=university_identity_reviews.person_id));
CREATE POLICY university_identity_audit_insert ON university_identity_reviews FOR INSERT
WITH CHECK(organization_id=current_setting('app.current_organization_id',true) AND actor_id=current_setting('app.current_user_id',true) AND EXISTS(SELECT FROM university_people p WHERE p.organization_id=university_identity_reviews.organization_id AND p.id=university_identity_reviews.person_id));
