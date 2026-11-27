# Pharmacy and restaurant wallet loyalty cards

A pharmacy shopper can carry the same loyalty card on paper, in Apple Wallet or in Google Wallet. Each QR carries the working pharmacy card code. Points come from the customer’s organization-wide pharmacy ledger. Replacing or revoking the card immediately invalidates its code at the counter and queues an update to its wallet passes. A phone receives the visual update when its wallet next synchronizes.

## Launch a business programme

1. A tenant admin opens **Settings → Wallet loyalty card** in a business licensed for pharmacy CRM or restaurant loyalty. New programmes start off. The admin sets the programme name, PNG logo, background and text colours, checks the preview, enables the programme and saves. A support session cannot change branding, switch the programme on or off, or create a poster.
2. The admin chooses an active branch and prints its QR poster. The poster opens on the business’s tenant host. Turning the programme off closes public enrolment and poster generation. Existing physical cards follow their own lifecycle.
3. A shopper scans the poster, accepts loyalty enrolment and verifies their phone with a one-time code. A pharmacy shopper with an existing record provides their working card code and verifies the phone on that record. A new shopper receives a new card. Lost cards can be replaced by authorized pharmacy staff. The phone sender must be configured and approved independently of wallet issuance. The public flow refuses enrolment if it cannot deliver the challenge.
4. The shopper downloads unsigned samples in TEST or adds an available issuer-backed pass in DEMO or LIVE. Pharmacy staff issuing a physical card can download the enabled programme’s unsigned preview. Its QR resolves to the same account. Existing restaurant email enrolment links continue to work.

Apple can display both owner colours. Google exposes a class background colour and controls text rendering. The Google class carries the programme name and logo. [Google loyalty class reference](https://developers.google.com/wallet/reference/rest/v1/loyaltyclass)

## Modes and issuer ownership

| Effective mode | What the shopper receives | What the operator needs |
| --- | --- | --- |
| TEST (default) | Apple and Google JSON marked TEST. The QR can be scanned at the counter. The files contain an issuance-time balance. | No issuer account or credential. Missing mode-specific issuer configuration falls back to TEST. |
| DEMO | A Google Save link from a dedicated demo issuer. The verified phone must be on the application test list. Google separately restricts which accounts can save the pass. | A Google Wallet issuer still in demo mode, an authorized service account and issuer test accounts. |
| LIVE | A signed Apple pass, a Google Save link, or both, according to the providers configured. | A company-owned authorized issuer for each enabled provider, its agreements, and the corresponding environment credentials. Google public issuance requires publishing access. |

Google Wallet has been available in Pakistan since **March 2025**. The outstanding step is the operator’s issuer account and approvals. The consumer launch does not establish publishing access for a particular company. [Bank Alfalah’s March 2025 launch announcement](https://bankalfalah.com/news-room/pr-106/) · [Google Wallet country availability](https://support.google.com/wallet/answer/12060037?co=ADWORDS.BillingCountryCode%3DPK&hl=en) · [Google issuer demo and publishing access](https://developers.google.com/wallet/retail/loyalty-cards/test-and-go-live/request-publishing-access)

The operator selects the environment with `WALLET_MODE`. Google reads the corresponding `WALLET_GOOGLE_DEMO_ISSUER_ID` and `WALLET_GOOGLE_DEMO_SERVICE_ACCOUNT`, or the equivalent `WALLET_GOOGLE_LIVE_*` pair. DEMO additionally requires `WALLET_DEMO_TEST_PHONES`. Keep demo and publishing issuers separate. The verified-phone list supplements Google’s account restrictions.

For Apple LIVE, the operator supplies the Pass Type ID and team ID, pass certificate and private key, WWDR certificate, and APNs key ID and signing key through the environment. The application signing secret is also required. For both providers, business settings contain design data only. [Apple Wallet identifiers and certificates](https://developer.apple.com/help/account/capabilities/create-wallet-identifiers-and-certificates/)

## Balances and privacy

Sales, refunds and adjustments that post points queue a projection of the new ledger balance. This includes eligible khata repayments under the existing pharmacy earning policy. The delivery worker patches the Google object or sends an empty APNs wake-up so the Apple device can fetch its signed pass. Failed deliveries retry independently of the sale. A revoked Google object expires and a refreshed Apple pass is marked void. Unsigned JSON downloads remain snapshots.

The only shopper data in a pass are the opaque barcode and the points balance. Branding and opaque issuer and pass identifiers support display and delivery. Phone verification stays on the server. Passes and updates omit the shopper’s name, phone, purchases, medicines, prescriptions and health data. The pharmacy database keeps a hash of the card code. Google objects omit `accountName` and `accountId`.

[Desktop and mobile settings screenshots](../qa/dev-1064/)

## Open owner decisions

- Whether the card should carry a “powered by” line.
- Whether Google requires separate review of each business’s design under the operator’s issuer arrangement.
