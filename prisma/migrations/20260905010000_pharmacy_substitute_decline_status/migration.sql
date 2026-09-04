-- AI-05 / POS-10: a declined substitute closes demand without falsely marking it recovered.
ALTER TYPE "PharmacyDemandStatus" ADD VALUE 'CLOSED';
ALTER TABLE "pharmacy_unfulfilled_demand_events" ADD COLUMN "closedAt" TIMESTAMP(3);
