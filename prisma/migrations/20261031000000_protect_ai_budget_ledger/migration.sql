-- Prices and provider budgets are platform-wide. Ordinary tenant scopes must
-- never be able to change another tenant's routing or rewrite recorded spend.
ALTER TABLE "ai_model_prices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_model_prices" FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_model_prices_platform ON "ai_model_prices"
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- TRUNCATE does not consult row policies, even when RLS is forced.
CREATE FUNCTION authorize_ai_price_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.is_platform_admin', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Platform scope is required to truncate AI prices'
      USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER ai_model_prices_platform_truncate
  BEFORE TRUNCATE ON "ai_model_prices"
  FOR EACH STATEMENT EXECUTE FUNCTION authorize_ai_price_truncate();

ALTER TABLE "ai_usage_ledger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_usage_ledger" FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_usage_ledger_platform_read ON "ai_usage_ledger"
  FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true');
CREATE POLICY ai_usage_ledger_platform_insert ON "ai_usage_ledger"
  FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- Immutable even in platform scope, or through an owner connection bypassing
-- RLS: corrections must never silently reduce the budget's source of truth.
CREATE FUNCTION refuse_ai_usage_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AI usage ledger is append-only: % is forbidden', TG_OP
    USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER ai_usage_ledger_append_only
  BEFORE UPDATE OR DELETE ON "ai_usage_ledger"
  FOR EACH ROW EXECUTE FUNCTION refuse_ai_usage_ledger_mutation();
CREATE TRIGGER ai_usage_ledger_no_truncate
  BEFORE TRUNCATE ON "ai_usage_ledger"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_ai_usage_ledger_mutation();
