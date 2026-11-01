-- PR #683 review follow-up.
--
-- 1. Roster serialization without an organizations-row hot spot.
--    Migration 20261029102000 made every roster write in a pharmacy tenant lock and
--    rewrite its organizations row, so all roster writes queued on one row (and the
--    runtime role needed UPDATE on organizations). Roster writers now take a SHARED
--    transaction advisory lock per tenant: they never wait for one another and write
--    nothing. A solo-owner approval takes the EXCLUSIVE lock, so it still waits for
--    in-flight roster writes to commit and blocks new ones until the approval and
--    its audit commit. Under READ COMMITTED the eligibility query that follows the
--    lock runs on a fresh snapshot and sees the committed roster. An older
--    REPEATABLE READ/SERIALIZABLE snapshot cannot be refreshed, so it is refused
--    with a serialization failure instead of approving on stale eligibility.
--
-- 2. Solo eligibility again requires that no active, unlinked (PIN-only) staff
--    profile exists, as migration 20261029100000 did. 20261029104000 dropped that
--    rule, so one user account plus PIN-only staff counted as "solo".
BEGIN;

CREATE OR REPLACE FUNCTION pharmacy_lock_solo_roster(org text) RETURNS void
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 IF current_setting('transaction_isolation') <> 'read committed' THEN
   RAISE EXCEPTION 'solo owner approval must run at READ COMMITTED to see the committed roster'
     USING ERRCODE = '40001';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtext('pharmacy_solo_roster'), hashtext(org));
END $$;

CREATE OR REPLACE FUNCTION pharmacy_share_solo_roster(org text) RETURNS void
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtext('pharmacy_solo_roster'), hashtext(org));
END $$;

CREATE OR REPLACE FUNCTION pharmacy_serialize_solo_roster() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE old_org text; new_org text; org text;
BEGIN
 IF TG_OP <> 'INSERT' THEN old_org := OLD."organizationId"; END IF;
 IF TG_OP <> 'DELETE' THEN new_org := NEW."organizationId"; END IF;
 -- Stable ordering also covers privileged cross-organization moves.
 FOR org IN SELECT DISTINCT value FROM unnest(ARRAY[old_org, new_org]) AS t(value)
            WHERE value IS NOT NULL AND EXISTS (SELECT 1 FROM organizations o WHERE o.id=value AND o.vertical='PHARMACY') ORDER BY value
 LOOP
   PERFORM pharmacy_share_solo_roster(org);
 END LOOP;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;

-- Owner-assignment recomputation must still run one at a time per tenant (a branch
-- insert racing a demotion must not re-grant the demoted user), so it keeps its own
-- exclusive advisory lock, plus the shared roster lock, instead of the row lock.
CREATE OR REPLACE FUNCTION pharmacy_assign_branch_owners() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id=NEW."organizationId" AND vertical='PHARMACY') THEN RETURN NEW; END IF;
  PERFORM pharmacy_share_solo_roster(NEW."organizationId");
  PERFORM pg_advisory_xact_lock(hashtext('pharmacy_owner_assignments'), hashtext(NEW."organizationId"));
  UPDATE pharmacy_branch_assignments a SET active=false, "updatedAt"=CURRENT_TIMESTAMP
  WHERE a."organizationId"=NEW."organizationId" AND a."ownerManaged"
    AND NOT EXISTS (SELECT 1 FROM users u LEFT JOIN organization_roles r
      ON r.id=u."organizationRoleId" AND r."organizationId"=u."organizationId"
      WHERE u.id=a."userId" AND u."organizationId"=a."organizationId"
        AND u.status='ACTIVE' AND (r.key='owner' AND r."isSystem" AND EXISTS (SELECT 1 FROM organizations o WHERE o.id=u."organizationId" AND o.vertical='PHARMACY')));
  INSERT INTO pharmacy_branch_assignments (id, "organizationId", "branchId", "userId", active, "ownerManaged", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, b."organizationId", b.id, u.id, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM pharmacy_branches b JOIN users u ON u."organizationId"=b."organizationId"
  LEFT JOIN organization_roles r ON r.id=u."organizationRoleId" AND r."organizationId"=u."organizationId"
  WHERE b."organizationId"=NEW."organizationId" AND b.active AND u.status='ACTIVE'
    AND (r.key='owner' AND r."isSystem" AND EXISTS (SELECT 1 FROM organizations o WHERE o.id=u."organizationId" AND o.vertical='PHARMACY'))
  ON CONFLICT ("organizationId","branchId","userId") DO UPDATE SET active=true, "ownerManaged"=(pharmacy_branch_assignments."ownerManaged" OR NOT pharmacy_branch_assignments.active), "updatedAt"=CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION pharmacy_solo_owner_eligible(org text, branch text, actor text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (SELECT 1 FROM users u
 JOIN organizations o ON o.id=u."organizationId" AND o.vertical='PHARMACY'
 JOIN organization_roles r ON r.id=u."organizationRoleId" AND r."organizationId"=org
 WHERE u.id=actor AND u."organizationId"=org AND u.status='ACTIVE' AND r.key='owner' AND r."isSystem")
 AND (SELECT count(*) FROM users u WHERE u."organizationId"=org AND u.status='ACTIVE')=1
 AND (branch IS NULL OR EXISTS (SELECT 1 FROM pharmacy_branches b
 WHERE b.id=branch AND b."organizationId"=org AND b.active))
 -- PIN-only staff are a second person: their presence means the pharmacy is staffed.
 AND NOT EXISTS (SELECT 1 FROM restaurant_staff_profiles s
 WHERE s."organizationId"=org AND s.status='ACTIVE' AND s."userId" IS NULL)
$$;

COMMIT;
