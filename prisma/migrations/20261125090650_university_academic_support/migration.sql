CREATE TABLE university_advising_assignments (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, student_program_id text NOT NULL,
  advisor_id text NOT NULL, assigned_by text NOT NULL, assigned_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz,
  PRIMARY KEY(organization_id,id),
  FOREIGN KEY(organization_id,student_program_id) REFERENCES university_student_programs(organization_id,id),
  FOREIGN KEY(organization_id,advisor_id) REFERENCES users("organizationId",id),
  FOREIGN KEY(organization_id,assigned_by) REFERENCES users("organizationId",id)
);
CREATE UNIQUE INDEX university_current_advisor ON university_advising_assignments(organization_id,student_program_id) WHERE released_at IS NULL;
CREATE TABLE university_academic_holds (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, student_program_id text NOT NULL,
  scope text NOT NULL CHECK(scope IN ('REGISTRATION','CONFERRAL','BOTH')), message text NOT NULL,
  placed_by text NOT NULL, placed_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz, released_by text, release_reference text,
  PRIMARY KEY(organization_id,id), FOREIGN KEY(organization_id,student_program_id) REFERENCES university_student_programs(organization_id,id),
  FOREIGN KEY(organization_id,placed_by) REFERENCES users("organizationId",id), FOREIGN KEY(organization_id,released_by) REFERENCES users("organizationId",id)
);
CREATE INDEX university_live_holds ON university_academic_holds(organization_id,student_program_id,scope) WHERE released_at IS NULL;
CREATE TABLE university_study_interruptions (
  organization_id text NOT NULL,id text NOT NULL DEFAULT gen_random_uuid()::text,student_program_id text NOT NULL,
  starts_on date NOT NULL, expected_return date NOT NULL CHECK(expected_return>starts_on),
  leave_reference text NOT NULL, approved_by text NOT NULL, returned_on date CHECK(returned_on>=starts_on), return_reference text, returned_by text,
  PRIMARY KEY(organization_id,id), FOREIGN KEY(organization_id,student_program_id) REFERENCES university_student_programs(organization_id,id),
  FOREIGN KEY(organization_id,approved_by) REFERENCES users("organizationId",id), FOREIGN KEY(organization_id,returned_by) REFERENCES users("organizationId",id)
);
CREATE UNIQUE INDEX university_open_interruption ON university_study_interruptions(organization_id,student_program_id) WHERE returned_on IS NULL;
CREATE TABLE university_credit_recognitions (
  organization_id text NOT NULL,id text NOT NULL DEFAULT gen_random_uuid()::text,student_program_id text NOT NULL,course_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('TRANSFER','SUBSTITUTION')),source_reference text NOT NULL,substitute_course_id text,
  mark integer CHECK(mark BETWEEN 0 AND 100),evidence_reference text NOT NULL,approved_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,id),UNIQUE(organization_id,student_program_id,course_id),UNIQUE(organization_id,student_program_id,source_reference),
  UNIQUE(organization_id,student_program_id,substitute_course_id),
  CHECK((kind='TRANSFER' AND substitute_course_id IS NULL) OR (kind='SUBSTITUTION' AND substitute_course_id IS NOT NULL AND substitute_course_id<>course_id)),
  FOREIGN KEY(organization_id,student_program_id) REFERENCES university_student_programs(organization_id,id),
  FOREIGN KEY(organization_id,course_id) REFERENCES university_courses(organization_id,id),
  FOREIGN KEY(organization_id,substitute_course_id) REFERENCES university_courses(organization_id,id),
  FOREIGN KEY(organization_id,approved_by) REFERENCES users("organizationId",id)
);
CREATE TABLE university_course_prerequisites (
  organization_id text NOT NULL,id text NOT NULL DEFAULT gen_random_uuid()::text,course_id text NOT NULL,prerequisite_course_id text NOT NULL,
  PRIMARY KEY(organization_id,id),UNIQUE(organization_id,course_id,prerequisite_course_id),CHECK(course_id<>prerequisite_course_id),
  FOREIGN KEY(organization_id,course_id) REFERENCES university_courses(organization_id,id),
  FOREIGN KEY(organization_id,prerequisite_course_id) REFERENCES university_courses(organization_id,id)
);
CREATE TABLE university_exam_sittings (
  organization_id text NOT NULL,id text NOT NULL DEFAULT gen_random_uuid()::text,section_id text NOT NULL,campus_id text NOT NULL,
  assessment text NOT NULL, room text NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
  scheduled_by text NOT NULL, PRIMARY KEY(organization_id,id), UNIQUE(organization_id,section_id,assessment),
  FOREIGN KEY(organization_id,section_id) REFERENCES university_sections(organization_id,id),
  FOREIGN KEY(organization_id,campus_id) REFERENCES university_campuses(organization_id,id),
  FOREIGN KEY(organization_id,scheduled_by) REFERENCES users("organizationId",id)
);
CREATE INDEX university_exam_conflict ON university_exam_sittings(organization_id,starts_at,ends_at);
CREATE TABLE university_assessment_attendance (
  organization_id text NOT NULL,id text NOT NULL DEFAULT gen_random_uuid()::text,exam_id text NOT NULL,person_id text NOT NULL,
  status text NOT NULL CHECK(status IN ('PRESENT','ABSENT','EXCUSED')),marked_by text NOT NULL,marked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,id), UNIQUE(organization_id,exam_id,person_id),
  FOREIGN KEY(organization_id,exam_id) REFERENCES university_exam_sittings(organization_id,id),
  FOREIGN KEY(organization_id,person_id) REFERENCES university_people(organization_id,id),
  FOREIGN KEY(organization_id,marked_by) REFERENCES users("organizationId",id)
);
CREATE TABLE university_accommodation_cases (
  organization_id text NOT NULL,id text NOT NULL DEFAULT gen_random_uuid()::text,student_program_id text NOT NULL,
  evidence_reference text NOT NULL, reviewed_by text NOT NULL,reviewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,id), FOREIGN KEY(organization_id,student_program_id) REFERENCES university_student_programs(organization_id,id),
  FOREIGN KEY(organization_id,reviewed_by) REFERENCES users("organizationId",id)
);
CREATE TABLE university_exam_adjustments (
  organization_id text NOT NULL,id text NOT NULL DEFAULT gen_random_uuid()::text,case_id text NOT NULL,exam_id text NOT NULL,person_id text NOT NULL,
  instruction text NOT NULL,additional_minutes integer NOT NULL CHECK(additional_minutes BETWEEN 0 AND 240),approved_by text NOT NULL,
  PRIMARY KEY(organization_id,id),UNIQUE(organization_id,exam_id,person_id),
  FOREIGN KEY(organization_id,case_id) REFERENCES university_accommodation_cases(organization_id,id),
  FOREIGN KEY(organization_id,exam_id) REFERENCES university_exam_sittings(organization_id,id),
  FOREIGN KEY(organization_id,person_id) REFERENCES university_people(organization_id,id),
  FOREIGN KEY(organization_id,approved_by) REFERENCES users("organizationId",id)
);
DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['university_advising_assignments','university_academic_holds','university_study_interruptions',
    'university_credit_recognitions','university_course_prerequisites','university_exam_sittings','university_assessment_attendance',
    'university_accommodation_cases','university_exam_adjustments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT USING (organization_id=NULLIF(current_setting(''app.current_organization_id'',true),''''))',tab);
    EXECUTE format('CREATE POLICY tenant_insert ON %I FOR INSERT WITH CHECK (organization_id=NULLIF(current_setting(''app.current_organization_id'',true),''''))',tab);
  END LOOP;
  FOREACH tab IN ARRAY ARRAY['university_advising_assignments','university_academic_holds','university_study_interruptions','university_assessment_attendance'] LOOP
    EXECUTE format('CREATE POLICY tenant_update ON %I FOR UPDATE USING (organization_id=NULLIF(current_setting(''app.current_organization_id'',true),'''')) WITH CHECK (organization_id=NULLIF(current_setting(''app.current_organization_id'',true),''''))',tab);
  END LOOP;
END $$;

-- Use the user's tenant permissions, including on amended grade versions.
CREATE VIEW university_passed_courses WITH (security_invoker=true) AS
SELECT e.organization_id,e.person_id,s.course_id,max(grade.mark)::int AS mark
FROM university_enrollments e
JOIN university_sections s ON (s.organization_id,s.id)=(e.organization_id,e.section_id)
JOIN university_intakes i ON (i.organization_id,i.id)=(s.organization_id,s.intake_id)
JOIN LATERAL (SELECT g.mark FROM university_grades g WHERE g.organization_id=e.organization_id AND g.enrollment_id=e.id
  AND g.status='PUBLISHED' ORDER BY g.revision DESC LIMIT 1) grade ON true
WHERE grade.mark>=i.pass_mark GROUP BY e.organization_id,e.person_id,s.course_id;

CREATE VIEW university_recognized_courses WITH (security_invoker=true) AS
SELECT r.organization_id,r.student_program_id,s.person_id,r.course_id,coalesce(p.mark,r.mark) AS mark,r.source_reference,r.kind,r.substitute_course_id
FROM university_credit_recognitions r JOIN university_student_programs s ON (s.organization_id,s.id)=(r.organization_id,r.student_program_id)
LEFT JOIN university_passed_courses p ON (p.organization_id,p.person_id,p.course_id)=(r.organization_id,s.person_id,r.substitute_course_id)
WHERE r.kind='TRANSFER' OR p.course_id IS NOT NULL;

-- Registration and waitlist promotion use one tenant-scoped policy decision source.
CREATE FUNCTION university_registration_rule_flags(
  p_org text, p_student_program_id text, p_course_id text, p_section_id text
) RETURNS TABLE(held boolean,on_leave boolean,prerequisites boolean,exams boolean)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT
    EXISTS(SELECT 1 FROM university_academic_holds h WHERE h.organization_id=p_org
      AND h.student_program_id=p_student_program_id AND h.scope IN ('REGISTRATION','BOTH') AND h.released_at IS NULL),
    EXISTS(SELECT 1 FROM university_study_interruptions l WHERE l.organization_id=p_org
      AND l.student_program_id=p_student_program_id AND l.starts_on<=(now() AT TIME ZONE 'Asia/Karachi')::date
      AND (l.returned_on IS NULL OR l.returned_on>(now() AT TIME ZONE 'Asia/Karachi')::date)),
    EXISTS(SELECT 1 FROM university_course_prerequisites r WHERE r.organization_id=p_org AND r.course_id=p_course_id),
    EXISTS(SELECT 1 FROM university_exam_sittings e WHERE e.organization_id=p_org AND e.section_id=p_section_id);
$$;
