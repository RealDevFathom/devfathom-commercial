CREATE TABLE university_campuses (
  organization_id text NOT NULL REFERENCES organizations(id), id text NOT NULL DEFAULT gen_random_uuid()::text,
  name text NOT NULL, recognition_ref text NOT NULL, PRIMARY KEY (organization_id,id), UNIQUE (organization_id,name)
);
CREATE TABLE university_programs (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, campus_id text NOT NULL,
  name text NOT NULL, code text NOT NULL, pqr_reference text NOT NULL, accreditation_reference text NOT NULL,
  valid_from date NOT NULL, valid_to date NOT NULL CHECK (valid_to >= valid_from),
  PRIMARY KEY (organization_id,id), UNIQUE (organization_id,campus_id,code,valid_from),
  FOREIGN KEY (organization_id,campus_id) REFERENCES university_campuses(organization_id,id)
);
CREATE TABLE university_intakes (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, program_id text NOT NULL,
  label text NOT NULL, curriculum_version text NOT NULL, grade_scale jsonb NOT NULL DEFAULT '[[85,4],[80,3.7],[75,3.3],[70,3],[65,2.7],[60,2.3],[55,2],[50,1],[0,0]]',
  minimum_cgpa numeric(4,2) NOT NULL DEFAULT 0 CHECK (minimum_cgpa BETWEEN 0 AND 4), merit_version text NOT NULL DEFAULT '1', school_weight integer NOT NULL DEFAULT 100 CHECK(school_weight BETWEEN 0 AND 100), required_credits integer NOT NULL CHECK (required_credits>0),
  research_required boolean NOT NULL DEFAULT false, tuition_paisa bigint NOT NULL DEFAULT 0 CHECK(tuition_paisa>=0),
  pass_mark integer NOT NULL CHECK (pass_mark BETWEEN 1 AND 100), capacity integer NOT NULL CHECK (capacity>0),
  opens_on date NOT NULL, closes_on date NOT NULL CHECK (closes_on>=opens_on),
  starts_on date NOT NULL CHECK (starts_on>=closes_on),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','CLOSED')),
  approved_by text, PRIMARY KEY (organization_id,id), UNIQUE (organization_id,program_id,label),
  FOREIGN KEY (organization_id,program_id) REFERENCES university_programs(organization_id,id),
  FOREIGN KEY (organization_id,approved_by) REFERENCES users("organizationId",id)
);
CREATE TABLE university_courses (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, intake_id text NOT NULL,
  code text NOT NULL, name text NOT NULL, credits integer NOT NULL CHECK (credits>0), required boolean NOT NULL,
  PRIMARY KEY (organization_id,id), UNIQUE (organization_id,intake_id,code), UNIQUE (organization_id,id,intake_id),
  FOREIGN KEY (organization_id,intake_id) REFERENCES university_intakes(organization_id,id)
);
CREATE TABLE university_seat_categories (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, intake_id text NOT NULL, label text NOT NULL, capacity integer NOT NULL CHECK(capacity>0),
  PRIMARY KEY (organization_id,id), UNIQUE(organization_id,intake_id,label), UNIQUE(organization_id,intake_id,id),
  FOREIGN KEY(organization_id,intake_id) REFERENCES university_intakes(organization_id,id)
);
CREATE TABLE university_applications (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, person_id text NOT NULL, intake_id text NOT NULL,
  status text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','ASSESSED','OFFERED','ACCEPTED','MATRICULATED','DECLINED','REJECTED')),
  category_id text, decision_by text, offered_list_id text, offered_rank integer, assessed_at timestamptz,
  school_percent numeric(6,3), entry_test_percent numeric(6,3), merit_score numeric(6,3) CHECK (merit_score BETWEEN 0 AND 100), qualification text, equivalence_reference text,
  decision_reason text, submitted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,person_id,intake_id), FOREIGN KEY (organization_id,decision_by) REFERENCES users("organizationId",id),
  FOREIGN KEY(organization_id,intake_id,category_id) REFERENCES university_seat_categories(organization_id,intake_id,id),
  FOREIGN KEY (organization_id,person_id) REFERENCES university_people(organization_id,id),
  FOREIGN KEY (organization_id,intake_id) REFERENCES university_intakes(organization_id,id)
);
CREATE TABLE university_merit_lists (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, intake_id text NOT NULL, version integer NOT NULL CHECK (version>0),
  formula_version text NOT NULL, school_weight integer NOT NULL, candidates jsonb NOT NULL, published_at timestamptz NOT NULL DEFAULT now(), published_by text NOT NULL,
  PRIMARY KEY (organization_id,id), UNIQUE(organization_id,intake_id,version),
  FOREIGN KEY(organization_id,intake_id) REFERENCES university_intakes(organization_id,id),
  FOREIGN KEY(organization_id,published_by) REFERENCES users("organizationId",id)
);
ALTER TABLE university_applications ADD FOREIGN KEY (organization_id,offered_list_id) REFERENCES university_merit_lists(organization_id,id);
CREATE TABLE university_admission_appeals (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, application_id text NOT NULL, reason text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','UPHELD','REOPENED')), decision text, decided_by text, submitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,id), FOREIGN KEY (organization_id,application_id) REFERENCES university_applications(organization_id,id),
  FOREIGN KEY (organization_id,decided_by) REFERENCES users("organizationId",id)
);
CREATE UNIQUE INDEX university_open_admission_appeal ON university_admission_appeals(organization_id,application_id) WHERE status='OPEN';
CREATE TABLE university_roll_counters (
  organization_id text PRIMARY KEY REFERENCES organizations(id), last_number bigint NOT NULL CHECK(last_number>0)
);
CREATE TABLE university_student_programs (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, person_id text NOT NULL, intake_id text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','WITHDRAWN','GRADUATED')), matriculated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz, roll_number text NOT NULL, UNIQUE(organization_id,roll_number), PRIMARY KEY (organization_id,id), UNIQUE (organization_id,person_id,intake_id),
  FOREIGN KEY (organization_id,person_id,intake_id) REFERENCES university_applications(organization_id,person_id,intake_id)
);
CREATE FUNCTION university_assign_roll_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE serial bigint;
BEGIN
  IF NEW.roll_number IS NULL THEN
    LOOP
      INSERT INTO university_roll_counters(organization_id,last_number) VALUES(NEW.organization_id,1)
        ON CONFLICT (organization_id) DO UPDATE SET last_number=university_roll_counters.last_number+1
        RETURNING last_number INTO serial;
      NEW.roll_number := 'U-' || CASE WHEN serial<1000000 THEN lpad(serial::text,6,'0') ELSE serial::text END;
      EXIT WHEN NOT EXISTS(SELECT 1 FROM university_student_programs WHERE organization_id=NEW.organization_id AND roll_number=NEW.roll_number);
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER university_student_roll BEFORE INSERT ON university_student_programs FOR EACH ROW EXECUTE FUNCTION university_assign_roll_number();
CREATE TABLE university_sections (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, intake_id text NOT NULL, course_id text NOT NULL,
  instructor_id text NOT NULL, term text NOT NULL, label text NOT NULL, room text NOT NULL,
  weekday integer NOT NULL CHECK (weekday BETWEEN 1 AND 7), start_minute integer NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute integer NOT NULL CHECK (end_minute>start_minute AND end_minute<=1440),
  capacity integer NOT NULL CHECK (capacity>0), PRIMARY KEY (organization_id,id), UNIQUE (organization_id,course_id,term,label),
  FOREIGN KEY (organization_id,course_id,intake_id) REFERENCES university_courses(organization_id,id,intake_id),
  FOREIGN KEY (organization_id,instructor_id) REFERENCES users("organizationId",id)
);
CREATE TABLE university_enrollments (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, person_id text NOT NULL, section_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('ENROLLED','WAITLISTED','WITHDRAWN')),
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(), revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY (organization_id,id), UNIQUE (organization_id,person_id,section_id),
  FOREIGN KEY (organization_id,person_id) REFERENCES university_people(organization_id,id),
  FOREIGN KEY (organization_id,section_id) REFERENCES university_sections(organization_id,id)
);
CREATE INDEX university_section_roster ON university_enrollments (organization_id,section_id,status,queued_at,id);
CREATE TABLE university_grades (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, enrollment_id text NOT NULL,
  revision integer NOT NULL CHECK(revision>0), mark integer NOT NULL CHECK(mark BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PUBLISHED')),
  submitted_by text NOT NULL, approved_by text, published_at timestamptz,
  PRIMARY KEY (organization_id,id), UNIQUE (organization_id,enrollment_id,revision),
  FOREIGN KEY (organization_id,enrollment_id) REFERENCES university_enrollments(organization_id,id),
  FOREIGN KEY (organization_id,submitted_by) REFERENCES users("organizationId",id),
  FOREIGN KEY (organization_id,approved_by) REFERENCES users("organizationId",id),
  CHECK (status <> 'PUBLISHED' OR (approved_by IS NOT NULL AND approved_by<>submitted_by AND published_at IS NOT NULL))
);
CREATE TABLE university_grade_appeals (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, grade_id text NOT NULL, reason text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','PENDING_AMENDMENT','UPHELD','AMENDED')), decision text, decided_by text,
  PRIMARY KEY (organization_id,id), UNIQUE (organization_id,grade_id),
  FOREIGN KEY (organization_id,grade_id) REFERENCES university_grades(organization_id,id),
  FOREIGN KEY (organization_id,decided_by) REFERENCES users("organizationId",id)
);
CREATE TABLE university_transcripts (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, student_program_id text NOT NULL,
  snapshot jsonb NOT NULL, issued_at timestamptz NOT NULL DEFAULT now(), issued_by text NOT NULL,
  PRIMARY KEY (organization_id,id), FOREIGN KEY (organization_id,student_program_id) REFERENCES university_student_programs(organization_id,id),
  FOREIGN KEY (organization_id,issued_by) REFERENCES users("organizationId",id)
);
CREATE TABLE university_awards (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, student_program_id text NOT NULL,
  transcript_id text NOT NULL, credential_number text NOT NULL, issued_at timestamptz NOT NULL DEFAULT now(), issued_by text NOT NULL,
  PRIMARY KEY (organization_id,id), UNIQUE (organization_id,student_program_id), UNIQUE (organization_id,credential_number),
  FOREIGN KEY (organization_id,student_program_id) REFERENCES university_student_programs(organization_id,id),
  FOREIGN KEY (organization_id,transcript_id) REFERENCES university_transcripts(organization_id,id),
  FOREIGN KEY (organization_id,issued_by) REFERENCES users("organizationId",id)
);
DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['university_campuses','university_programs','university_intakes','university_courses','university_applications','university_merit_lists','university_seat_categories','university_admission_appeals','university_roll_counters','university_student_programs','university_sections','university_enrollments','university_grades','university_grade_appeals','university_transcripts','university_awards'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'',true)=''true'' OR organization_id=NULLIF(current_setting(''app.current_organization_id'',true),'''')) WITH CHECK (current_setting(''app.is_platform_admin'',true)=''true'' OR organization_id=NULLIF(current_setting(''app.current_organization_id'',true),''''))',tab);
  END LOOP;
END $$;

CREATE FUNCTION university_conflict_free_program(tenant text, learner text, target university_sections)
RETURNS text LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT sp.id FROM university_student_programs sp
    WHERE sp.organization_id=tenant AND sp.person_id=learner AND sp.intake_id=target.intake_id AND sp.status='ACTIVE'
    AND NOT EXISTS(SELECT 1 FROM university_enrollments e JOIN university_sections other ON (other.organization_id,other.id)=(e.organization_id,e.section_id)
      WHERE e.organization_id=tenant AND e.person_id=learner AND e.status='ENROLLED' AND other.id<>target.id AND other.term=target.term
      AND (other.course_id=target.course_id OR (other.weekday=target.weekday AND other.start_minute<target.end_minute AND other.end_minute>target.start_minute)))
$$;

-- This routine uses the caller's RLS context. Its SQL plans are reused by PostgreSQL.
-- A single client round trip acquires the section lock followed by person locks in ID order.
CREATE FUNCTION university_registration_context(tenant text, learner text, target text, releasing boolean)
RETURNS TABLE(existing_id text,existing_status text,student_program_id text,course_id text,has_queue boolean)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE section university_sections%ROWTYPE; queued text[]; affected text; available integer;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('university-academics:'||tenant,0));
  SELECT * INTO section FROM university_sections s WHERE s.organization_id=tenant AND s.id=target FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT section.capacity-count(*) INTO available FROM university_enrollments e
    WHERE e.organization_id=tenant AND e.section_id=target AND e.status='ENROLLED';
  IF releasing OR available>0 THEN
    SELECT array_agg(e.person_id) INTO queued FROM university_enrollments e
      WHERE e.organization_id=tenant AND e.section_id=target AND e.status='WAITLISTED';
  END IF;
  has_queue:=coalesce(cardinality(queued),0)>0;
  FOR affected IN SELECT DISTINCT u.id FROM unnest(coalesce(queued,ARRAY[]::text[])||ARRAY[learner]) u(id) ORDER BY u.id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('university-person:'||tenant||':'||affected,0));
  END LOOP;
  SELECT e.id,e.status INTO existing_id,existing_status FROM university_enrollments e
    WHERE e.organization_id=tenant AND e.person_id=learner AND e.section_id=target;
  course_id:=section.course_id;
  IF NOT releasing AND (existing_status IS NULL OR existing_status='WITHDRAWN') THEN
    student_program_id:=university_conflict_free_program(tenant,learner,section);
  END IF;
  RETURN NEXT;
END $$;

CREATE FUNCTION university_reject_academic_record_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published academic records are immutable. Record an authorized revision instead.';
END $$;
CREATE TRIGGER university_transcript_immutable BEFORE UPDATE OR DELETE ON university_transcripts
  FOR EACH ROW EXECUTE FUNCTION university_reject_academic_record_change();
CREATE TRIGGER university_award_immutable BEFORE UPDATE OR DELETE ON university_awards
  FOR EACH ROW EXECUTE FUNCTION university_reject_academic_record_change();
CREATE TRIGGER university_merit_list_immutable BEFORE UPDATE OR DELETE ON university_merit_lists
  FOR EACH ROW EXECUTE FUNCTION university_reject_academic_record_change();
CREATE TRIGGER university_grade_immutable BEFORE UPDATE OR DELETE ON university_grades
  FOR EACH ROW WHEN (OLD.status='PUBLISHED') EXECUTE FUNCTION university_reject_academic_record_change();
CREATE FUNCTION university_preserve_cohort_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status<>'DRAFT' AND (to_jsonb(OLD)-'status' <> to_jsonb(NEW)-'status' OR NEW.status='DRAFT') THEN
    RAISE EXCEPTION 'Approved cohort rules are immutable.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER university_cohort_rules_immutable BEFORE UPDATE ON university_intakes
  FOR EACH ROW EXECUTE FUNCTION university_preserve_cohort_rules();

CREATE INDEX university_recent_applications ON university_applications(organization_id,submitted_at DESC,id);
CREATE INDEX university_recent_students ON university_student_programs(organization_id,matriculated_at DESC,id);
CREATE INDEX university_recent_enrollments ON university_enrollments(organization_id,queued_at DESC,id);

-- Call after section/person locks and policy checks. Shared by ordinary registration
-- and the service path which must first promote waiters or evaluate individual rules.
CREATE FUNCTION university_store_registration(tenant text,learner text,target text)
RETURNS TABLE(enrollment_id text,enrollment_status text) LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE seat university_enrollments%ROWTYPE;
BEGIN
  INSERT INTO university_enrollments AS e(organization_id,person_id,section_id,status)
    SELECT tenant,learner,s.id,
      CASE WHEN (SELECT count(*) FROM university_enrollments existing WHERE existing.organization_id=tenant
        AND existing.section_id=target AND existing.status='ENROLLED')<s.capacity THEN 'ENROLLED' ELSE 'WAITLISTED' END
    FROM university_sections s WHERE s.organization_id=tenant AND s.id=target
    ON CONFLICT (organization_id,person_id,section_id) DO UPDATE SET status=EXCLUDED.status,queued_at=clock_timestamp(),revision=e.revision+1
    RETURNING e.* INTO STRICT seat;
  PERFORM university_emit_event(tenant,CASE WHEN seat.status='ENROLLED' THEN 'student.registered' ELSE 'student.waitlisted' END,
    seat.id||':'||seat.revision,jsonb_build_object('personId',learner,'sectionId',target,'enrollmentId',seat.id,'status',seat.status));
  RETURN QUERY SELECT seat.id,seat.status;
END $$;

CREATE FUNCTION university_try_registration(tenant text,learner text,target text)
RETURNS TABLE(enrollment_id text,enrollment_status text,review_required boolean,has_queue boolean,program_id text,target_course text)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE context record; flags record;
BEGIN
  SELECT * INTO context FROM university_registration_context(tenant,learner,target,false);
  IF NOT FOUND THEN RETURN; END IF;
  enrollment_id:=context.existing_id; enrollment_status:=context.existing_status; has_queue:=context.has_queue;
  program_id:=context.student_program_id; target_course:=context.course_id; review_required:=false;
  IF enrollment_status IN ('ENROLLED','WAITLISTED') THEN
    review_required:=(enrollment_status='WAITLISTED' AND has_queue);
  ELSIF program_id IS NULL THEN
    enrollment_status:='INELIGIBLE';
  ELSIF has_queue THEN
    review_required:=true;
  ELSE
    SELECT * INTO STRICT flags FROM university_registration_rule_flags(tenant,program_id,target_course,target);
    IF flags.held THEN
      enrollment_status:='ON_HOLD';
    ELSIF flags.on_leave THEN
      enrollment_status:='ON_LEAVE';
    ELSIF flags.prerequisites OR flags.exams THEN
      review_required:=true;
    ELSE
      SELECT saved.enrollment_id,saved.enrollment_status INTO STRICT enrollment_id,enrollment_status
        FROM university_store_registration(tenant,learner,target) saved;
    END IF;
  END IF;
  RETURN NEXT;
END $$;
