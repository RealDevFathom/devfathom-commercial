# Privacy-aware pharmacy camera anomaly alerts: planning (DEV-749)

Status: **planning only.** No code, provider, device, footage or spend is authorised. Saad
confirmed on 4 Nov that camera AI stays planning-only until he changes that instruction.
Nothing here claims a camera, DVR, gateway or detector works. The DVR (Dahua DH-XVR1B16-I V2)
has no camera attached and no hardware test has run (see `hardware-acceptance-matrix.md`).

Items marked **SIGN-OFF REQUIRED** need an explicit owner or legal decision before any build.

## 1. Question and recommendation

Question: can AI watch pharmacy cameras for anomalies, and how heavy would usage be?

Recommendation: do not run continuous AI over video. Use an opt-in **event-triage** design:
cheap local or DVR-side filtering picks a few moments, and only those moments (a redacted
still or a short redacted clip) may be sent for rate-limited analysis, capped per camera and
per month. A person reviews every alert. Phase 0 (below) needs no AI at all.

## 2. Prerequisites (do not start before these are ready)

- Live camera work (#1398, DEV-740) and real evidence stills (#1403, DEV-745) must be accepted
  on real hardware. Today: live view is `UNTESTED` on hardware; real snapshots are not wired
  to a DVR (`docs/pharmacy/camera-snapshot-evidence-DEV-745.md`).
- Owner answers the clarifications in section 10.

## 3. What is and is not detected

Candidate event types (none approved; the owner picks): after-hours motion in a stockroom,
a door or zone open longer than a set time, a camera going dark or blurred (tamper/health),
and a counter camera showing no one present during an open session. These are **observations
about the scene**, phrased neutrally ("motion in stockroom at 02:14").

Never detected or stated:

- facial identification or recognition, or any biometric template;
- intent, theft, "suspicious behaviour" or accusations about a named person;
- reading labels, prescriptions, patient screens or medicine names from video;
- clinical judgement, or automatic disciplinary, clinical or stock action.

Unknown is a first-class state: low confidence, a missing frame, a camera offline or a failed
analysis shows **Unknown / Not analysed**, never "all clear".

## 4. Separate from ledger anomalies (DEV-69)

DEV-69 shrinkage, fake-return and void-abuse signals come from recorded ledger and sale data
(for example the leakage report in `src/server/routers/pharmacy-finance.ts`, which states it
is "recorded ledger leakage ... not inferred causation"). They are **not** video AI and the UI
must never label them as such. Camera alerts may link to an existing evidence still (DEV-745)
but must not change a ledger anomaly's score or state.

## 5. Architecture sketch

1. **Local filter first.** Gateway or DVR motion/tamper events only. No cloud call per frame.
2. **Select and redact.** At most N frames or one short clip per event, with faces and screens
   masked on the gateway host before anything leaves the premises (redaction quality is
   unproven: needs a synthetic-footage test).
3. **Rate-limited analysis (optional, off by default).** A per-camera hourly limit, a
   per-camera and per-organisation monthly spend cap, and a hard stop when a cap is reached
   (state shown as "Cap reached", not silent failure). Provider choice is a separate
   approval; no Azure.
4. **Dedup.** One alert per camera + event type + window (for example 10 minutes); repeats
   increment a count on the open alert.
5. **Human review.** An alert is `Needs review` until a permitted user marks it
   `Reviewed - no action`, `Reviewed - follow up` or `False alarm`. The model never closes it.
6. **Usage measurement.** Every analysis call records camera, event, frames, provider units
   and cost estimate in a tenant-scoped table, visible to the owner, so spend is transparent
   before and after caps bite. Estimates are labelled as estimates until reconciled to an
   invoice.

Reuse: camera scope and privacy settings (`src/lib/cameras/privacy.ts`, 1 to 90 day retention),
snapshot evidence storage, tenant RLS and the existing audit annotations. Tenant-scoped
tables for alerts and usage need RLS and a migration when built; none is added now.

## 6. Notifications

Previews carry no sensitive detail: no image, no staff or customer name, no medicine, salt or
category, no accusation. Allowed shape: "Camera alert needs review - Branch 1". Details only
after sign-in. WhatsApp text never names a drug, salt or medicine category, and receives only
the generic line above.

## 7. Who sees what

| Role | Alert list | Redacted still/clip | Settings and caps | Usage and spend |
| --- | --- | --- | --- | --- |
| Owner | yes | yes | yes | yes |
| Manager (branch) | own branch | own branch | no | no |
| Pharmacist / cashier | no by default | no | no | no |

Server-side checks on every read (tenant, branch, role); viewing a still or clip writes an
audit record (who, when, which alert). Solo pharmacy: the owner or sole pharmacist is both
configurer and reviewer, so self-review is allowed with a fresh PIN re-authentication and an
audit record; where a second reviewer would normally be needed the same self-approval applies.

**SIGN-OFF REQUIRED:** the exact role matrix, and whether managers may see clips.

## 8. Retention and audit

- Redacted stills/clips: proposed default 7 days, never above the camera gateway's configured
  `retentionDays`; existing legal and fiscal holds still apply. Alert metadata (type, time,
  review outcome, no image) may outlive media for audit; proposed 12 months.
- Usage rows are kept for billing reconciliation.
- Audit every setting change, cap change, view, review outcome, export and deletion.
- Nothing is sent to a provider if retention terms with that provider are unreviewed.

**SIGN-OFF REQUIRED:** retention periods for media and metadata.

## 9. Privacy, notice and legal

Employee and customer notice, signage, consent, workplace-monitoring rules, cross-border
processing and biometric/redaction duties vary by jurisdiction. This document makes no claim
that the design is lawful anywhere.

- **SIGN-OFF REQUIRED (legal):** employee and customer notice wording and signage for AI
  analysis, not just recording.
- **SIGN-OFF REQUIRED (legal/owner):** whether any frames may leave the premises, and to which
  provider and region.
- **SIGN-OFF REQUIRED (owner):** that alerts are never used for automatic discipline; any
  staff action is a human decision with its own process.
- Camera AI is opt-in per organisation and per camera, default off, with a visible indicator.

## 10. Questions for the owner (decide before implementation)

1. Which use cases from section 3, if any? (**SIGN-OFF REQUIRED**)
2. How many cameras and which areas? Which hours are monitored? (**SIGN-OFF REQUIRED**)
3. Alert recipients and delivery channel. (**SIGN-OFF REQUIRED**)
4. Monthly budget per camera and overall. (**SIGN-OFF REQUIRED**)
5. Retention (section 8) and provider/region (section 9).

## 11. Usage estimate (illustrative, not approved)

Cost scales with analysed items, not camera count: items = events passing the local filter x
frames per event. Capping items per camera per hour bounds spend regardless of footage volume.
Real figures need a measured event rate from the actual DVR and a provider price; none is
assumed here.

## 12. Phased plan

- **Phase 0 (no AI):** DVR/gateway health and tamper alerts, using existing evidence work.
- **Phase 1:** local event filtering, dedup, human review queue, audit. Synthetic or
  owner-authorised non-sensitive test footage only.
- **Phase 2 (separate approval):** redaction plus capped provider analysis, usage dashboard.

Each phase needs its own owner approval. No real footage upload, device connection,
credential, provider enablement, paid inference, network or security change without it.

## 13. Test and acceptance (when built)

Synthetic footage only. Verify: dedup, cap stop, "Unknown" states, redaction on masked fixtures,
notification previews free of sensitive text, role and branch isolation, retention purge,
audit rows, solo self-review with PIN. Hardware claims stay `UNTESTED` until run on a device.
