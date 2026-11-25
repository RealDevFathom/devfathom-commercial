# Running a Pakistani university on DevFathom

## Provision and open an intake

1. In the platform console, create an organization with the University vertical and the University Integrated package. Set its tenant host, PKR currency, Asia/Karachi time zone and staff and active-student allowances. The integrated package starts at 250 staff seats and 25,000 active students. Complete the platform activation checks. Configure the organization’s transactional email sender before inviting applicants.
2. On the tenant host, open **University offices**. Invite staff with the appropriate university role. Under **Faculties and staff access**, assign explicit institution, campus or faculty/department coverage. Institution-wide coverage is required for admitting students against the commercial allowance, migration sign-off, financial close and census. Assign an independent finance approver and an independent grade moderator.
3. The registrar creates campuses with recognition evidence, programs with PQR and accreditation references, and intakes with dates, seats, curriculum version, grading bands and course requirements. Assign programs to their academic departments. Record the applicable seat categories, qualification and admission-test weights, course tuition and elective or research requirements. Publish only approved intakes.
4. The bursar configures the collection account. The public tenant paths are `/apply` and `/student`. Both support English and Urdu. Applicants sign in with a short-lived code sent to their verified email address. Staff review supporting documents through the Admissions office. The registrar matriculates an accepted offer, and the student registers for an eligible section.

Keep the authoritative HEC campus, qualification and policy references alongside the version the university adopted for each intake. Independently retain the academic and bank evidence required by the institution’s retention policy. [HEC policies](https://www.hec.gov.pk/english/policies/Pages/default.aspx) · [Pakistan Qualification Register](https://www.hec.gov.pk/english/services/universities/pqr/Pages/default.aspx)

## Reconcile external systems

The bursar can import bank statement lines from the Student Finance office. Use a stable bank transaction identifier, challan reference, PKR amount and value date. Unknown references enter the unmatched queue. A separate settlement records the bank value actually received. The accounting system returns the journal reference and amount for each student-subledger posting.

For automated providers, issue a scoped API token from organization settings and assign its exact event or command kinds in **Integration deliveries**. Assign the token to an institutional account with the office and coverage required for the operation. Keep LMS, bank and accounting credentials separate.

| HTTP interface                                          | Behavior                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/university/events?kind=student.registered` | Returns up to 100 pending events for the assigned kind. The receiver deduplicates by event ID before applying the change.                                                                                                                                                        |
| `POST /api/v1/university/events`                        | Accepts an event ID, kind, status and provider reference. Use `ACKNOWLEDGED` after successful delivery or `FAILED` for an exception. Staff can replay a failed event.                                                                                                            |
| `POST /api/v1/university/commands`                      | Accepts `version` 1, `kind`, a stable `externalId` and a typed `payload`. Supported commands are `grade.draft`, `bank.collection`, `bank.settlement` and `finance.gl-acknowledgment`. Money inputs use integer paisa. Reusing an ID with different evidence produces a conflict. |

Use `Authorization: Bearer <token>` on the provider requests. The following example records an acknowledged bank collection against an existing challan.

```json
{
  "version": 1,
  "kind": "bank.collection",
  "externalId": "statement-17-line-83",
  "payload": {
    "provider": "contracted-bank",
    "transactionId": "bank-transaction-83",
    "reference": "CHALLAN-83",
    "amountPaisa": 1250000,
    "valueDate": "2026-11-26"
  }
}
```

For 1BILL or Raast collections, obtain the institution’s merchant or biller agreement, implement the provider-specific authentication and mapping at the connector, and reconcile a test payment, settlement and refund before enabling that channel. A university signs off its own awards and records the externally issued HEC attestation reference. HEDR exports require the focal person to map the source figures to the current official return, submit through the authorized channel and retain the receipt. [SBP merchant onboarding](https://www.sbp.org.pk/our-subsidiaries/raast/join-raast) · [HEC attestation process](https://www.hec.gov.pk/english/services/students/das/Pages/Degree-Attestation.aspx)

## Cut over and operate

- **Migration.** In Historical Imports, obtain the manifest example, provide source IDs and the digest of the exact source text, and stage a representative cohort. Validate transcripts, participation dates, enrollment counts, opening debits/credits and references. Have independent academic and finance reviewers approve before finalizing. Cancel a staged batch to restart. Retain the signed source and prior system archive.
- **First cohort.** Compare accepted offers with matriculated people, section seats with acknowledged LMS rosters, challans with bank receipts, and settlements with GL journal references. Give every unresolved exception an owner.
- **Term close.** Publish moderated grades, resolve outstanding appeals, review holds and transfer credit, reproduce degree audits and issue transcripts. Confirm any thesis requirement, library clearance and award verification.
- **Institutional close.** Reconcile the student ledger to accounting, sign off the payroll exchange and sponsored expenditure, freeze a census revision, approve its CSV and record the authority’s acknowledgment. Preserve prior exports and transcript revisions.
- **Retention.** In Retention and Operations, record the institutional authority, record type, retention period and effective date. A second administrator approves the policy. Place any applicable legal holds before previewing a batch. A second reviewer approves the preview, and execution rechecks current eligibility. The operations view reports outstanding deliveries and cleanup counts.
- **Recovery.** Pause incoming writes during restoration. Restore the database and encryption key material through the institution’s established backup process. Compare restored event IDs with connector receipts, replay outstanding deliveries, and reconcile student headcounts, financial balances and issued awards before resuming writes.

Run University tests with `bun run test src/lib/university`. For the integrated pilot test, set `TEST_DATABASE_URL` to a migrated, catalog-synchronized disposable PostgreSQL database using its non-owner application role. Set `TEST_MIGRATION_DATABASE_URL` to the disposable setup role for the isolated academic role tests. The registration benchmark uses a separate local database ending in `_test` and a setup role permitted to create isolated test fixtures. Run `node --conditions=react-server --import tsx scripts/benchmark-university-registration.ts --run` there. It models 2,500 active sessions across a 25,000-student registry for ten minutes. Exercise the tenant web entry points and external providers on representative infrastructure before opening a registration window. Staff coverage, learner authentication, connector contracts and production load are separate acceptance checks.

### Authenticated registration load

Start a local production build with its normal application role on a migrated PostgreSQL database whose name ends in `_test`. Synchronize the catalog and provision an active university with a package that includes academic registration. Set `TEST_MIGRATION_DATABASE_URL` to that same disposable database using its fixture setup role.

Run the 30-second check against the server’s loopback origin. Replace `pilot` with the provisioned university slug and use the server’s listening port.

```sh
node scripts/benchmark-university-registration-http.mjs --run --origin=http://127.0.0.1:3000 --template=pilot
```

For the ten-minute acceptance run, append `--seconds=600`. The probe creates a dedicated test university with 25,000 student records and 2,500 learner sessions. At the default 100 requests per second, the ten-minute run sends 60,000 registrations through the tenant’s HTTP endpoint. It checks session isolation, origin validation, module revocation, receipts, committed enrollments, waitlists, capacity and replay behavior. A lost registration response triggers one retry. The report records first-attempt transport errors and successful recoveries alongside final per-submission outcomes. It includes HTTP p95 and p99 by minute and the time until an independent database connection first observes each new enrollment. Visibility sampling runs every 50 milliseconds. The probe removes the generated tenant and its fixtures after completion.
