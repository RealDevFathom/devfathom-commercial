# Pakistan restaurant tax source pack

> Research cutoff and retrieval date: **2026-08-29**. This is implementation
> research, not legal or accounting advice. Only primary sources published by a
> Pakistan government or revenue authority are used. A rate is not treated as
> current where the official material available at the cutoff did not establish
> continuity through 2026.

## Status and use

This pack supports a future, jurisdiction-neutral Pakistan tax profile. It does
not publish or approve one. Repository contracts remain authoritative for data
shape: `paymentCategory` is a non-empty `String`, while `priceMode` accepts only
`EXCLUSIVE` or `INCLUSIVE` in `src/lib/restaurant/tax-contracts.ts` and
`prisma/schema.prisma`. Currency snapshots use a string; the profile must use
ISO 4217 code `PKR` and present money as `PKR 1,234.56` (two decimal places),
unless product localization later adopts a separately approved display format.

“Verified current” below means the cited official source states the rule and no
later official instrument found by the cutoff displaced it. It does not replace
professional advice or branch-specific classification.

## Verified current rules

### Islamabad Capital Territory — FBR

- **Jurisdiction:** Islamabad Capital Territory. **Instrument/reference:**
  Islamabad Capital Territory (Tax on Services) Ordinance, 2001, section 3 and
  Table 1, serial 1(ii), consolidated through 30 June 2025. **Effective date:**
  restaurant payment split inserted by Finance Act 2023; the consolidated text
  remained FBR's current ICT ordinance at retrieval. **Rule:** restaurant,
  cafe, food-parlor, coffee-shop and similar prepared/ready-to-eat food services
  are 5% when payment is received through debit card, credit card, mobile wallet,
  or QR scan, without input-tax adjustment/refund; cash is 15%. **Retrieved:**
  2026-08-29. **Source:** [FBR consolidated ICT Ordinance](https://download1.fbr.gov.pk/Docs/2025711172945966ICTOUpdatedupto30.06.2025.pdf).
- **Registration/filing/records:** section 3(3) applies Sales Tax Act, 1990
  provisions and rules, mutatis mutandis, to payment, registration and
  deregistration, records/audit, enforcement, penalties, and ancillary matters.
  **Effective date:** present in the retrieved consolidation. **Retrieved:**
  2026-08-29. **Source:** same FBR ordinance. Exact restaurant invoice and
  real-time integration procedure after Finance Act 2025 remains unresolved.
- **2026 continuity:** FBR lists Finance Act 2026 as enacted; no restaurant-rate
  amendment was located in that Act during this pass. **Effective date:** 1 July
  2026 where the Act provides. **Retrieved:** 2026-08-29. **Source:** [FBR
  Finance Acts index](https://www.fbr.gov.pk/Categ/Finance-Acts/620). This is
  negative research evidence, not a guarantee that no notification applies.
- **Price basis/service charge/invoice:** current official text retrieved does
  not establish whether menu prices must be tax-inclusive, whether a separately
  stated service charge enters the restaurant taxable value, or the exact fiscal
  receipt fields. These are unresolved; do not infer `priceMode` from the rate.

### Sindh — SRB

- **Jurisdiction:** Sindh. **Instrument/reference:** SRB Circular 04/2024,
  tariff heading 9801.2000 and the cited reduced-rate notification. **Effective
  date:** 2024-07-01. **Rule:** restaurant services are 15%; invoices paid by
  debit card, credit card, mobile wallet, or QR scan are 8% without input-tax
  credit/adjustment. An eligible provider may charge 15% on those digital modes
  only after written SRB approval; the dispensation applies to approved branches
  whose POS is integrated with SRB. **Retrieved:** 2026-08-29. **Sources:** [SRB
  Circular 04/2024](https://www.srb.gos.pk/srb/wp-content/uploads/2024/06/30-06-2024.pdf),
  [SRB current restaurant guidance](https://www.srb.gos.pk/srb/other-services/),
  and [SRB approval lists](https://www.srb.gos.pk/srb/restaurant-list/).
- **POS/fiscal reporting:** SRB says online integration covers, among others,
  restaurants in hotels, international franchises, multi-branch restaurants,
  outlets in air-conditioned malls, marketplace sellers, and restaurants whose
  preceding-twelve-period turnover exceeded PKR 5 million. **Instrument:** Sindh
  Sales Tax Special Procedure (Online Integration of Business) Rules, 2022,
  as summarized by SRB. **Effective date:** rules effective before cutoff;
  consolidated rules updated through 2026-07-01. **Retrieved:** 2026-08-29.
  **Sources:** [SRB POS FAQ](https://www.srb.gos.pk/srb/faq/) and [SRB current
  Acts and Rules index](https://www.srb.gos.pk/srb/acts-rules-amendments/).
  Scope must be tested per legal entity and branch before configuration.
- **Registration/filing:** SRB's restaurant guidance links registration, return,
  payment, POS-invoice verification, and active-taxpayer services. **Retrieved:**
  2026-08-29. **Source:** SRB current restaurant guidance above. Exact due dates
  and return fields were not verified in this bounded pass and remain unresolved.
- **Price basis/service charge:** Circular 04/2024 describes tax as a percentage
  of restaurant services/invoice value but does not settle mandatory
  inclusive/exclusive menu presentation or all service-charge treatments.
  Do not infer either.

### Khyber Pakhtunkhwa — KPRA

- **Jurisdiction:** Khyber Pakhtunkhwa. **Instrument/reference:** Khyber
  Pakhtunkhwa Finance Act 2025 amendments to Schedule II of the Khyber
  Pakhtunkhwa Sales Tax on Services Act, 2022. **Effective date:** 2025-07-01.
  **Rule:** restaurant/hotel services paid through debit, credit or other prepaid
  cards, mobile wallets, or QR scan are 6% without input adjustment/refund;
  the cash rate remains unresolved. **Retrieved:** 2026-08-29. **Source:** [KP
  Finance Act 2025](https://kpra.gov.pk/wp-content/uploads/2025/07/kp-finance-act-2025.pdf).
  KPRA's January 2026 official complaint decisions administratively confirm a
  10% restaurant cash rate, but they do not establish the governing activation
  instrument or its effective date and therefore do not verify a current cash
  rate for configuration. **Sources:** [KPRA decision 898](https://grs.kpra.gov.pk/reports/complaint_details?complaintID=898)
  and [KPRA decision 908](https://grs.kpra.gov.pk/reports/complaint_details?complaintID=908).
- **Invoice/e-invoicing:** every restaurant, hotel, food business, or similar
  provider must integrate/install RIMS, invoice-management, prescribed
  e-invoicing, or another prescribed computerized system to issue sales-tax
  invoices. **Instrument/reference:** KP Finance Act 2025, Schedule II condition.
  **Effective date:** 2025-07-01. **Retrieved:** 2026-08-29. **Source:** KP Finance
  Act 2025 above. Exact technical onboarding and receipt payload remain unresolved.
- **Registration/filing, price basis, service charge:** not established by the
  official material verified in this pass. No default `priceMode` or service-
  charge tax treatment may be configured from this pack alone.

## Unresolved jurisdictions and questions

### Punjab — PRA

- PRA's published restaurant rules require every Punjab restaurant provider to
  register regardless of one or multiple outlets; an FBR-registered provider
  e-enrols, and registered hotels/clubs report restaurant services in their
  return. Rule 67 says tax is paid **out of** the gross billed/received amount,
  including table-service charges. Rules 68 onward govern menu/invoice handling.
  **Instrument/reference:** Punjab Sales Tax on Services Rules 2012, Chapter XIII,
  rules 65–68. **Original effective era:** 2012. **Retrieved:** 2026-08-29.
  **Source:** [PRA restaurant-services rules](https://reg.pra.punjab.gov.pk/ptms/SOP/Download/Rules/Restaurant%20services%20Rules%2009-10-2012.pdf).
- **Uncertainty:** PRA labels this chapter “Draft” on its rules index, and the
  official current-rate material retrievable in this pass did not expose a
  restaurant entry carried through the Punjab Finance Act 2026. Therefore no
  Punjab restaurant rate, payment-method distinction, inclusive-price default,
  filing deadline, invoice-integration duty, or Rule 67 service-charge treatment
  is approved as current. Obtain a current gazetted consolidated Act/rules and
  relevant notifications from PRA before publishing. The old chapter is useful
  only as a question list, not activation evidence.

### Balochistan — BRA

- BRA's Second Schedule amended by Finance Act 2023 described restaurant
  categories subject to 4% or a PKR 15,000 monthly minimum, with 2% for debit
  card, credit card, mobile-wallet, or QR payments without input adjustment.
  **Instrument/reference:** BSTS Second Schedule, heading 9801.2000. **Effective
  era:** Finance Act 2023. **Retrieved:** 2026-08-29. **Source:** [BRA Second
  Schedule amended by Finance Act 2023](https://bra.gob.pk/NewsDirectory/Downloads/Second_Schedule_Amended_by_Finance_Act_2023.pdf).
- BRA's 2018 rules require serial invoice reporting, service records, payment by
  the 15th day after the tax period, and return filing within three days after
  payment due date. **Instrument/reference:** Balochistan Sales Tax on Services
  Rules 2018, restaurant provisions. **Effective era:** 2018. **Retrieved:**
  2026-08-29. **Source:** [BRA Rules 2018](https://bra.gob.pk/NewsDirectory/Downloads/Balochistan_ST_onServicesRules2018.pdf).
- **Uncertainty:** BRA's accessible consolidated Act states amendment only
  through Finance Act 2024, while a Government of Balochistan index lists Finance
  Acts 2025 and 2026. Their effect on restaurant rates/rules was not authoritatively
  reconciled here. No Balochistan rate, minimum tax, payment split, filing date,
  inclusive/exclusive basis, service-charge rule, or invoice duty may be treated
  as current until BRA supplies consolidated post-2026 text. **Sources:** [BRA
  Act amended through 2024](https://bra.gob.pk/NewsDirectory/2015_BSTS_Act_Ver01.pdf)
  and [Government of Balochistan Acts index](https://excise.balochistan.gov.pk/acts-ordinance-and-rules/).

### Cross-jurisdiction questions

- **Khyber Pakhtunkhwa cash rate:** unresolved. January 2026 KPRA complaint
  decisions administratively confirm 10%, but the governing activation
  instrument and effective date were not established. Do not configure a
  candidate cash rate from those decisions alone.

- Does delivery, takeaway, catering, marketplace, hotel, club, franchise, or
  prepared-food supply fall under the same restaurant heading for this branch?
- Is a mandatory or discretionary service charge part of taxable value? Punjab's
  older Rule 67 says yes; current treatment elsewhere is unverified.
- Must displayed/menu prices include tax, or may tax be added at checkout? Legal
  invoice “value” and calculator `priceMode` are not interchangeable concepts.
- Which registration threshold, return period/due date, invoice fields, device
  certification, live-reporting endpoint, and outage procedure apply?
- How are split tender, mixed cash/digital tender, refund, tip, discount,
  complimentary item, rounding, and partial payment classified? No verified
  source here authorizes a blended or dominant-tender rate.
- Do later SROs/notifications, exemptions, branch approvals, or court orders
  change any listed rule? Search and legal confirmation remain mandatory.

## Proposals — not law

FBR's 2025–26 budget salient features proposed computerized-system integration
and a negative list for ICT services. **Instrument/reference:** Budget 2025–26
Salient Features. **Proposal date:** June 2025. **Retrieved:** 2026-08-29.
**Source:** [FBR budget salient features](https://www.fbr.gov.pk/Budget2025-26/SalientFeatures/Salient-Feature.pdf).
These proposals are not independent authority for a production rule. The enacted
Finance Act/consolidated ordinance and implementing General Order must control.

The federal Finance Bill 2026 was a proposal until enacted and cannot override
the Finance Act 2026. **Proposal date:** June 2026. **Retrieved:** 2026-08-29.
**Source:** [FBR Finance Bill 2026](https://fbr.gov.pk/Budget2026-27/FinanceBill/Finance-Bill-2026.pdf).

## Expired or superseded guidance

- **Jurisdiction:** Khyber Pakhtunkhwa. **Instrument/reference:** Khyber
  Pakhtunkhwa Sales Tax on Services Act, 2022, consolidation through Finance
  Act 2024. **Guidance:** the consolidation showed 13% for the broad hotel/
  restaurant class and preserved prior 8%, 5% RIMS, and 1% dhaba text only in
  amendment footnotes. **Effective date:** exact activation dates for those
  historical rates are unknown from the cited consolidation. **Supersession
  date:** 2025-07-01 for the verified 6% digital-payment rule enacted by Finance
  Act 2025; supersession of the historical material for cash is unknown.
  **Retrieved:** 2026-08-29. **Source:** [KP Act updated through 2024](https://kpra.gov.pk/wp-content/uploads/2024/07/KP-STS-ACT-2022-Updated-2024.pdf).
  **Uncertainty:** January 2026 KPRA complaint decisions administratively
  confirm 10% cash treatment but do not establish its governing activation
  instrument or effective date; do not use the historical consolidation or
  those decisions as a current cash-rate mapping.
- **Jurisdiction:** Sindh. **Instrument/reference:** SRB Circular 04/2024,
  tariff heading 9801.2000 and cited reduced-rate notification. **Guidance:**
  the pre-2024 13% standard restaurant rate is superseded. **Original effective
  date:** unknown from the cited circular. **Supersession date:** 2024-07-01.
  **Retrieved:** 2026-08-29. **Source:** [SRB Circular 04/2024](https://www.srb.gos.pk/srb/wp-content/uploads/2024/06/30-06-2024.pdf).
  **Uncertainty:** the circular establishes the replacement date, not the exact
  original activation date of the historical 13% rate; do not seed 13% from
  older guides.
- **Jurisdiction:** Punjab. **Instrument/reference:** Punjab Sales Tax on
  Services Rules 2012, Chapter XIII, rules 65–68, marked “Draft” by PRA.
  **Guidance:** historical restaurant registration, gross-bill, service-charge,
  menu, and invoice provisions. **Effective date:** unknown; the official source
  available here does not establish a final gazette activation date.
  **Supersession date:** unknown. **Retrieved:** 2026-08-29. **Source:** [PRA
  restaurant-services rules](https://reg.pra.punjab.gov.pk/ptms/SOP/Download/Rules/Restaurant%20services%20Rules%2009-10-2012.pdf).
  **Uncertainty:** draft status and lack of verified current-rate continuity
  prevent treating any provision as current.
- **Jurisdiction:** Balochistan. **Instrument/reference:** Balochistan Sales Tax
  on Services Second Schedule, heading 9801.2000, amended by Finance Act 2023.
  **Guidance:** historical 4%/minimum-tax and 2% digital-payment treatment.
  **Effective date:** exact activation date unknown from the cited source.
  **Supersession date:** unknown. **Retrieved:** 2026-08-29. **Source:** [BRA
  Second Schedule amended by Finance Act 2023](https://bra.gob.pk/NewsDirectory/Downloads/Second_Schedule_Amended_by_Finance_Act_2023.pdf).
  **Uncertainty:** effects of Finance Acts 2024–2026 were not authoritatively
  reconciled, so no historical rate or minimum is current guidance.
- **Jurisdiction:** Balochistan. **Instrument/reference:** Balochistan Sales Tax
  on Services Rules 2018, restaurant provisions. **Guidance:** historical serial
  invoice reporting, service records, payment, and return deadlines. **Effective
  date:** exact activation date unknown from the cited source. **Supersession
  date:** unknown. **Retrieved:** 2026-08-29. **Source:** [BRA Rules 2018](https://bra.gob.pk/NewsDirectory/Downloads/Balochistan_ST_onServicesRules2018.pdf).
  **Uncertainty:** no consolidated post-2026 rules were verified; do not treat
  these duties or deadlines as current.

## **NOT APPROVED — proposed machine mapping pending human legal/accounting sign-off**

The repository has no enum of `paymentCategory` values: exact field type is
`paymentCategory: String`. The strings below are proposed stable application
values, not existing law or approved seed data. Exact `priceMode` values are the
existing enum values `EXCLUSIVE` and `INCLUSIVE`.

| Jurisdiction | Proposed `paymentCategory` | Candidate rate | Required source/condition |
| --- | --- | ---: | --- |
| ICT | `CASH` | `0.150000` | FBR Table 1, restaurant cash |
| ICT | `DEBIT_CARD`, `CREDIT_CARD`, `MOBILE_WALLET`, `QR_SCAN` | `0.050000` | No input adjustment/refund |
| Sindh | `CASH` | `0.150000` | Circular 04/2024 |
| Sindh | `DEBIT_CARD`, `CREDIT_CARD`, `MOBILE_WALLET`, `QR_SCAN` | `0.080000` | Default digital treatment; no input adjustment |
| Sindh | same digital values | `0.150000` | Only branch-specific written SRB approval plus POS integration |
| KP | none (`CASH` unresolved) | unresolved | Governing cash-rate activation instrument and effective date missing; no candidate rate |
| KP | `DEBIT_CARD`, `CREDIT_CARD`, `PREPAID_CARD`, `MOBILE_WALLET`, `QR_SCAN` | `0.060000` | No input adjustment/refund; prescribed invoice system |
| Punjab | none | unresolved | Current gazetted rate/payment rules missing |
| Balochistan | none | unresolved | Post-Finance Act 2026 reconciliation missing |

Each comma-separated value means a separate `RestaurantTaxRuleVersion`; the
draft validator rejects duplicate mappings within one profile. Do not add an
`OTHER` fallback where law distinguishes specific digital modes: unsupported
methods must fail closed. Split tender must remain blocked until counsel supplies
an allocation rule.

For every proposed rule, set `priceMode` to `EXCLUSIVE` only when approved branch
evidence proves listed prices exclude tax; set it to `INCLUSIVE` only when that
evidence proves listed prices include tax. No jurisdiction-wide `priceMode` is
approved by this pack. Store direct URL, retrieval timestamp, content hash, exact
effective interval, authority code, and approval reference in the existing
official-source/profile/rule records. Use `PKR`; never floats or a `%` string for
`rate`.

## Required approvals and refresh cadence

Before publishing any Pakistan profile, obtain all of these exact approvals:

1. Written Pakistan tax-counsel approval for the legal entity, branch address,
   service classification, rate, payment mapping, taxable value/service charge,
   price display, effective interval, exemptions, and invoice/device obligations.
2. Written Pakistan chartered-accountant approval for input-tax treatment,
   registration, returns/payment calendar, chart-of-accounts posting, discounts,
   tips, rounding, refunds, minimum tax, and PKR presentation.
3. Written branch operations/finance-owner confirmation of menu price mode,
   enabled tenders, POS/device integration and authority registration identifiers.
4. Product tax-profile owner approval referencing immutable source hashes and
   counsel/accountant approval documents before status becomes `PUBLISHED`.

Refresh official sources **monthly**, and additionally within **two business
days** of any federal/provincial budget, Finance Act, Gazette notification,
SRO/rate notification, revenue-authority circular, court order, or authority
integration notice. Revalidate each profile at least **10 business days before
its effective date** and again on that date. If a source is unavailable,
conflicts, lacks a post-budget consolidation, or has passed its review date,
block publication and settlement under that profile; never carry a rate forward
by assumption.
