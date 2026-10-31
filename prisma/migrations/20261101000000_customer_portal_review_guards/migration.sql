-- A completed dispensing sale may fulfil only one customer request.
CREATE UNIQUE INDEX pharmacy_customer_requests_fulfilled_sale_key
  ON pharmacy_customer_requests ("organizationId", "branchId", "fulfilledSaleId");

-- Row triggers cannot protect TRUNCATE; it requires a statement trigger.
CREATE TRIGGER pharmacy_customer_portal_event_no_truncate
  BEFORE TRUNCATE ON pharmacy_customer_portal_events
  FOR EACH STATEMENT EXECUTE FUNCTION pharmacy_customer_portal_event_immutable();
