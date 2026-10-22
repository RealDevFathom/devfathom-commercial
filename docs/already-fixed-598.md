# GitHub issue #598: already fixed

Static verification against the current branch found that the reported Urdu WhatsApp order-confirmation omission is already fixed:

- `src/lib/pharmacy/whatsapp/messages.ts:255-260` renders the order reference, medicine, quantity, and collection branch in both the English and Urdu confirmation text.
- `src/lib/pharmacy/whatsapp/inbound.ts:255-264` passes the placed order reference, parsed quantity, placed medicine, and placed branch name to that formatter.
- `src/lib/pharmacy/whatsapp/messages.test.ts:5-18` is a focused regression test asserting that all four values occur in the Urdu line.

The security-review concern about enabling live delivery is also already covered by the production construction path:

- `src/app/api/pharmacy/whatsapp/webhook/route.ts:70-71` creates the provider through `createWhatsAppProvider` rather than constructing the Meta provider directly.
- `src/lib/pharmacy/whatsapp/provider.ts:279-297` keeps both live text and template sends blocked even when the environment selects Meta; environment configuration alone cannot enable a Graph API send.

No additional implementation change is needed. The fix is display-only and does not alter authorization, tenant scoping, permission precedence, exact-grant rules, database access, or logging.
