# Owner digest WhatsApp template

Before setting `PHARMACY_WHATSAPP_TEMPLATE_OWNER_DIGEST`, submit the following fixed
body as a Meta utility template and obtain approval for the configured language.
The environment value must name that approved template, with exactly these 21
positional body variables. Do not configure the earlier single-variable template.
DevFathom cannot create or approve a Meta template from the digest job.

```text
Daily owner business briefing · {{1}}
Sales {{2}} · cash {{3}}
Lost demand estimate {{4}} · walk-outs {{5}}
Top stock gap estimate {{6}} · draft PO ready: {{7}}
Recovered demand estimate {{8}} · expiry at risk (30 days) {{9}}
Khata due {{10}}

Weekly owner business briefing · {{11}} to {{12}}
Sales {{13}} · cash {{14}}
Lost demand estimate {{15}} · walk-outs {{16}}
Top stock gap estimate {{17}} · draft PO ready: {{18}}
Recovered demand estimate {{19}} · expiry at risk (30 days) {{20}}
Khata due {{21}}
View details in Reports.
```

Dates are ISO calendar dates in the workspace timezone. Money values include PKR
and two decimal places, or `Not available` when the ledger value is unknown. Counts
are decimal integers and draft PO readiness is `Yes` or `No`. Each figure is its
own single-line value. Line breaks and fixed labels live only in the approved body;
no branch, product, ingredient or category names are sent as parameters.

The sender is restricted to `PHARMACY_WHATSAPP_ORGANIZATION_ID`. Existing digest
settings authorize in-app capture only. Owners explicitly enable WhatsApp per
branch on Reports and confirm their profile phone. Consent stores only a hash of
the normalized phone; changing that phone stops sending until the owner opts in
again. Unchecking WhatsApp and saving revokes consent without disabling capture.
When the owner has consented at capture time, the capture row stores the 21
template variables as pending WhatsApp work in the same transaction as the capture
and schedule advance. The job then drains pending work: one transaction locks the
owner, the digest setting and the capture, rechecks authorization, consent and the
current phone, reserves the message-log claim and clears the pending work. Meta is
contacted only after that commits. A consent revocation or phone edit therefore
either commits first and wins, or waits until the reservation commits. A failure
before the reservation rolls back and the next run retries it; once reserved, a
send is never retried. Pending work older than 24 hours is dropped unsent. A
failure for one owner is counted in the job's `failed` result and does not abort
the batch.
