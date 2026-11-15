BEGIN;

-- A card tender confirmed by the cashier from a standalone card machine. The
-- MOCK provider no longer settles real organizations, so this is the production
-- card path until a real provider is connected.
ALTER TYPE "RestaurantPaymentProvider" ADD VALUE IF NOT EXISTS 'MANUAL';

COMMIT;
