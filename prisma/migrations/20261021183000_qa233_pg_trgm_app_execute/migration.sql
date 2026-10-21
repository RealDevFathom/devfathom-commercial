BEGIN;

-- Extension preparation intentionally revokes PUBLIC EXECUTE. Restore only the
-- text search entry points needed by the application. PostgreSQL checks EXECUTE
-- on the backing functions when %, <%, %>, <<%, and %>> operators are used.
-- GRANT is idempotent; do not restore PUBLIC access or grant all extension functions.
GRANT EXECUTE ON FUNCTION
  public.similarity(text, text),
  public.similarity_op(text, text),
  public.word_similarity(text, text),
  public.word_similarity_op(text, text),
  public.word_similarity_commutator_op(text, text),
  public.strict_word_similarity(text, text),
  public.strict_word_similarity_op(text, text),
  public.strict_word_similarity_commutator_op(text, text)
TO devfathom_app;

COMMIT;
