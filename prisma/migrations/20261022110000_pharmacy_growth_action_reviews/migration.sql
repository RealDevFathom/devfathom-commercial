-- Pharmacy loyalty reviews still create marketing drafts. Inventory-cost
-- recommendations are review-only and must never manufacture a campaign merely
-- to satisfy the original retail-only shape.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  WHERE c.conrelid = 'pharmacy_growth_reviews'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%campaignId%'
    AND pg_get_constraintdef(c.oid) LIKE '%decision%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE pharmacy_growth_reviews DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE pharmacy_growth_reviews
  ADD CONSTRAINT pharmacy_growth_reviews_decision_shape_ck CHECK (
    (decision = 'APPROVE' AND ("campaignId" IS NULL OR settings IS NOT NULL))
    OR (decision <> 'APPROVE' AND "campaignId" IS NULL)
  );

CREATE OR REPLACE FUNCTION pharmacy_growth_validate_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recommendation_action text;
BEGIN
  SELECT action_row->>'kind' INTO recommendation_action
  FROM growth_insights g
  CROSS JOIN LATERAL jsonb_array_elements(g.snapshot->'actions') action_row
  WHERE g."organizationId"=NEW."organizationId" AND g."branchId"=NEW."branchId"
    AND g.id=NEW."insightId" AND g.vertical='PHARMACY' AND g.status='READY'
    AND action_row->>'ref'=g.output->'recommendations'->NEW.recommendation->>'actionRef';
  IF recommendation_action NOT IN ('RETAIL_REVIEW','LOYALTY_REVIEW','INVENTORY_COST_REVIEW')
  THEN RAISE EXCEPTION 'Ready authorized recommendation required' USING ERRCODE='23514'; END IF;
  IF NEW.decision='APPROVE' AND recommendation_action IN ('RETAIL_REVIEW','LOYALTY_REVIEW')
    AND (NEW."campaignId" IS NULL OR NEW.settings IS NULL)
  THEN RAISE EXCEPTION 'Campaign recommendation approval requires a draft' USING ERRCODE='23514'; END IF;
  IF recommendation_action='INVENTORY_COST_REVIEW' AND NEW."campaignId" IS NOT NULL
  THEN RAISE EXCEPTION 'Inventory-cost review cannot create a campaign' USING ERRCODE='23514'; END IF;
  IF NEW."campaignId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pharmacy_campaigns c WHERE c."organizationId"=NEW."organizationId"
      AND c."branchId"=NEW."branchId" AND c.id=NEW."campaignId" AND c.status='DRAFT')
  THEN RAISE EXCEPTION 'Matching draft required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
