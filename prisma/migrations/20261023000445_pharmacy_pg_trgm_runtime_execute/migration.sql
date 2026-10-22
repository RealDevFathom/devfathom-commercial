-- Extension hardening removes PUBLIC EXECUTE from pg_trgm. The catalogue's
-- similarity operator delegates to this one function, so grant only that
-- execution path to the restricted application role.
GRANT EXECUTE ON FUNCTION public.similarity_op(text, text) TO devfathom_app;
