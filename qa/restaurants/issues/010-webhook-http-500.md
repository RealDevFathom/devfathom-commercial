[QA][Restaurants][SEV3] An http webhook URL returns Internal server error instead of a validation error
Labels: qa, restaurants, sev3-minor

## Environment

Local VM. Branch `qa/pharmacy-restaurants-agencies`, commit `fa3658b715bf2e672f7e38f983b558d8d86b5a75`. Bun 1.4.3, Next.js 16.2.12, PostgreSQL 16. Tenant `http://qa-karahi-house.localhost:3000`, signed in as the restaurant administrator. Executed 2026-10-21.

## Test case

NTF-01. NTF-02 (HTTPS save and test) passed and is the control.

## Steps

1. Open restaurant notification settings.
2. Submit `restaurantNotifications.configureWebhook` with a blank URL.
3. Submit the same command with `http://example.com/hook`.
4. Submit `https://example.com/qa-restaurant-hook`, then call the webhook test procedure.

## Expected

A non-HTTPS URL is rejected with HTTP 400 and a message the operator can act on. A blank URL is also a validation error. An HTTPS URL saves, and the test call succeeds.

## Actual

The blank URL returned HTTP 400 `Endpoint Url: Too small: expected string to have >=1 characters`. The HTTP URL returned HTTP 500 with message `Webhook endpoint must use HTTPS.` The operator sees an internal error for a validation rule. The HTTPS URL saved with HTTP 200 and the test call returned HTTP 200.

## Evidence

- `qa/restaurants/evidence/api-results.json` record `NTF-02`: `blank 400 ...; http 500 Webhook endpoint must use HTTPS.; https 200 ; test 200`.
- `qa/restaurants/evidence/ntf-01.png` (notifications settings).

## Suspected code

`restaurantNotifications.configureWebhook` and `assertSafeWebhookUrl`, which throw a plain error instead of a `TRPCError` with code `BAD_REQUEST`. No fix is proposed here.
