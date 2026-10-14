-- Retain printer inventory and all historical routes/jobs.
ALTER TABLE "restaurant_printers" ADD COLUMN "retiredAt" TIMESTAMP(3);
