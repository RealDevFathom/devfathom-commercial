-- An earlier partial tender must not be refunded while the bill has an
-- unresolved collection. The invoker guard holds the same sale-row lock and
-- increases the revision, just as it does for a new tender.
CREATE TRIGGER pharmacy_payment_refund BEFORE INSERT ON pharmacy_refunds
 FOR EACH ROW EXECUTE FUNCTION pharmacy_payment_tender_guard();
