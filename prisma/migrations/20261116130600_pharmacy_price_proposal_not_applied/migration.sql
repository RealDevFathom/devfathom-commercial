BEGIN;

-- DEV-803: a DRAP price proposal can no longer be confirmed (DEV-693). Give the
-- ones that were still pending a clear end state instead of leaving them PROPOSED.
ALTER TYPE "PharmacyPriceChangeStatus" ADD VALUE IF NOT EXISTS 'NOT_APPLIED';

COMMIT;
