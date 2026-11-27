BEGIN;
CREATE TABLE university_units (
  organization_id text NOT NULL, campus_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text,
  name text NOT NULL, level text NOT NULL CHECK(level IN ('FACULTY','DEPARTMENT')), parent_id text,
  PRIMARY KEY (organization_id,id), UNIQUE(organization_id,campus_id,id), UNIQUE(organization_id,campus_id,name),
  FOREIGN KEY (organization_id,campus_id) REFERENCES university_campuses(organization_id,id),
  FOREIGN KEY (organization_id,campus_id,parent_id) REFERENCES university_units(organization_id,campus_id,id),
  CHECK ((level='FACULTY') = (parent_id IS NULL))
);
ALTER TABLE university_programs ADD COLUMN unit_id text,
  ADD FOREIGN KEY (organization_id,campus_id,unit_id) REFERENCES university_units(organization_id,campus_id,id);
CREATE TABLE university_staff_scopes (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, user_id text NOT NULL,
  level text NOT NULL CHECK(level IN ('INSTITUTION','CAMPUS','UNIT')), campus_id text, unit_id text,
  PRIMARY KEY(organization_id,id), UNIQUE NULLS NOT DISTINCT(organization_id,user_id,level,campus_id,unit_id),
  FOREIGN KEY(organization_id,user_id) REFERENCES users("organizationId",id) ON DELETE CASCADE,
  FOREIGN KEY(organization_id,campus_id) REFERENCES university_campuses(organization_id,id),
  FOREIGN KEY(organization_id,campus_id,unit_id) REFERENCES university_units(organization_id,campus_id,id),
  CHECK ((level='INSTITUTION' AND campus_id IS NULL AND unit_id IS NULL)
      OR (level='CAMPUS' AND campus_id IS NOT NULL AND unit_id IS NULL)
      OR (level='UNIT' AND campus_id IS NOT NULL AND unit_id IS NOT NULL))
);
ALTER TABLE university_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE university_units FORCE ROW LEVEL SECURITY;
ALTER TABLE university_staff_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE university_staff_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY institution ON university_units USING (organization_id=current_setting('app.current_organization_id',true));
CREATE POLICY institution ON university_staff_scopes USING (organization_id=current_setting('app.current_organization_id',true));

-- Only university staff transactions activate this additional restriction. Learner routes
-- derive person identity from their own session, and connector routes use assigned topics.
CREATE FUNCTION university_scoped_campus(org text,campus text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM university_staff_scopes s WHERE s.organization_id=org
    AND s.user_id=current_setting('app.current_user_id',true) AND s.campus_id=campus
    AND (s.level='CAMPUS' OR current_setting('app.university_office',true) IS DISTINCT FROM 'university-services'));
$$;
CREATE FUNCTION university_scoped_program(org text,campus text,unit text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM university_staff_scopes s WHERE s.organization_id=org
    AND s.user_id=current_setting('app.current_user_id',true) AND s.campus_id=campus AND
    (s.level='CAMPUS' OR current_setting('app.university_office',true) IS DISTINCT FROM 'university-services') AND
    (s.level='CAMPUS' OR s.unit_id=unit OR EXISTS(
       SELECT 1 FROM university_units u WHERE u.organization_id=org AND u.id=unit AND u.parent_id=s.unit_id)));
$$;

CREATE POLICY staff_campus ON university_campuses AS RESTRICTIVE
USING (current_setting('app.university_staff_scope',true) IS DISTINCT FROM 'bounded' OR university_scoped_campus(organization_id,id));
CREATE POLICY staff_program ON university_programs AS RESTRICTIVE
USING (current_setting('app.university_staff_scope',true) IS DISTINCT FROM 'bounded' OR university_scoped_program(organization_id,campus_id,unit_id));

-- The parent queries themselves run with RLS. Follow an acyclic path to the campus
-- and program so that direct reads, aggregate queries and writes share a scope.
DO $scope$
DECLARE link record;
BEGIN
  FOR link IN SELECT * FROM (VALUES
    ('university_intakes','program_id','university_programs'),
    ('university_courses','intake_id','university_intakes'),
    ('university_applications','intake_id','university_intakes'),
    ('university_student_programs','intake_id','university_intakes'),
    ('university_merit_lists','intake_id','university_intakes'),
    ('university_seat_categories','intake_id','university_intakes'),
    ('university_admission_appeals','application_id','university_applications'),
    ('university_sections','intake_id','university_intakes'),
    ('university_enrollments','section_id','university_sections'),
    ('university_grades','enrollment_id','university_enrollments'),
    ('university_grade_appeals','grade_id','university_grades'),
    ('university_transcripts','student_program_id','university_student_programs'),
    ('university_awards','student_program_id','university_student_programs'),
    ('university_service_resources','campus_id','university_campuses'),
    ('university_service_allocations','resource_id','university_service_resources'),
    ('university_facilities_cases','campus_id','university_campuses'),
    ('university_staff_appointments','campus_id','university_campuses'),
    ('university_teaching_loads','appointment_id','university_staff_appointments'),
    ('university_procurement_requests','campus_id','university_campuses'),
    ('university_library_loans','person_id','university_people'),
    ('university_advising_assignments','student_program_id','university_student_programs'),
    ('university_academic_holds','student_program_id','university_student_programs'),
    ('university_study_interruptions','student_program_id','university_student_programs'),
    ('university_credit_recognitions','student_program_id','university_student_programs'),
    ('university_course_prerequisites','course_id','university_courses'),
    ('university_exam_sittings','section_id','university_sections'),
    ('university_assessment_attendance','exam_id','university_exam_sittings'),
    ('university_accommodation_cases','student_program_id','university_student_programs'),
    ('university_exam_adjustments','exam_id','university_exam_sittings'),
    ('university_housing_waitlist','resource_id','university_service_resources'),
    ('university_dining_plans','campus_id','university_campuses'),
    ('university_dining_memberships','plan_id','university_dining_plans'),
    ('university_dining_redemptions','membership_id','university_dining_memberships'),
    ('university_private_cases','person_id','university_people'),
    ('university_alumni_preferences','person_id','university_people'),
    ('university_career_applications','person_id','university_people'),
    ('university_verification_requests','award_id','university_awards'),
    ('university_research_cases','student_program_id','university_student_programs'),
    ('university_research_decisions','case_id','university_research_cases'),
    ('university_award_verifications','award_id','university_awards'),
    ('university_hec_attestations','verification_id','university_award_verifications'),
    ('university_documents','person_id','university_people'),
    ('university_application_drafts','person_id','university_people')
  ) AS edges(child,source_column,parent) LOOP
    EXECUTE format('CREATE POLICY staff_records ON %I AS RESTRICTIVE USING (
        current_setting(''app.university_staff_scope'',true) IS DISTINCT FROM ''bounded'' OR
        EXISTS (SELECT FROM %I parent WHERE parent.organization_id=%I.organization_id AND parent.id=%I.%I))',
      link.child,link.parent,link.child,link.child,link.source_column);
  END LOOP;
END $scope$;
CREATE POLICY staff_person ON university_people AS RESTRICTIVE USING (
  current_setting('app.university_staff_scope',true) IS DISTINCT FROM 'bounded' OR
  EXISTS(SELECT FROM university_applications a WHERE a.organization_id=university_people.organization_id AND a.person_id=university_people.id)
);
COMMIT;
