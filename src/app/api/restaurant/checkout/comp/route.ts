/**
 * Comps are intentionally unavailable in the MVP. Keep the historical comp fields in
 * read models for receipts and reporting, but fail closed at the mutation boundary so a
 * direct request cannot change a bill, loyalty balance, audit trail, or idempotency state.
 */
export async function POST(): Promise<Response> {
  return Response.json({ error: 'Comps are not available in the MVP.' }, { status: 403 });
}
