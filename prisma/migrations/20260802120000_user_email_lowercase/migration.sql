-- D10: user emails become canonical (trimmed, lower-cased).
--
-- `users_organizationId_email_key` is a plain unique index on the raw string and
-- there is no citext extension or lower(email) functional index, so
-- `Alex@Company.com` and `alex@company.com` were two distinct identities within
-- one organization: a correctly-typed sign-in could fail to find its account,
-- and a differently-cased address could create a second row for the same person.
--
-- This migration ABORTS rather than resolving a collision. Two rows differing
-- only by case may be one duplicate or two real people, and only a human can
-- tell. `bun run report:email-collisions` prints the same report read-only so an
-- operator can resolve them and re-run.
DO $$
DECLARE
  collision RECORD;
  collisions INT := 0;
BEGIN
  FOR collision IN
    SELECT
      "organizationId",
      lower(btrim(email))          AS normalized,
      array_agg(id ORDER BY id)    AS ids,
      array_agg(email ORDER BY id) AS emails
    FROM "users"
    GROUP BY "organizationId", lower(btrim(email))
    HAVING count(*) > 1
  LOOP
    collisions := collisions + 1;
    RAISE WARNING
      'Email case collision — organizationId=% normalized=% ids=% emails=%',
      collision."organizationId", collision.normalized, collision.ids, collision.emails;
  END LOOP;

  IF collisions > 0 THEN
    RAISE EXCEPTION
      'Refusing to normalize user emails: % address(es) collide once lower-cased. '
      'The offending organizationId, user ids and raw emails are in the WARNING lines above. '
      'Resolve them by hand (they may be one duplicate or two real people), then re-run this migration. '
      'No row has been changed.',
      collisions;
  END IF;
END $$;

UPDATE "users"
SET "email" = lower(btrim("email"))
WHERE "email" <> lower(btrim("email"));

-- Derived copy of the same address; kept consistent so an invite record and its
-- user never disagree. No unique index here, so this cannot collide.
UPDATE "invitations"
SET "email" = lower(btrim("email"))
WHERE "email" <> lower(btrim("email"));

-- Stop the state regressing. Combined with the existing
-- ("organizationId", "email") unique index this makes tenant-local identity
-- effectively case-insensitive without adding a second index to maintain.
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_lowercase" CHECK ("email" = lower(btrim("email")));
