-- prepare-extensions removes PUBLIC execution from extension functions. The
-- medicine catalogue's `%` operator calls this pg_trgm implementation function,
-- so grant only that function to the restricted application role.
GRANT EXECUTE ON FUNCTION public.similarity_op(text, text) TO devfathom_app;
