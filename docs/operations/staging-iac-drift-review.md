# Staging IaC drift review gate (DEV-341)

Linear: [DEV-341](https://linear.app/devfathom/issue/DEV-341/reconcile-staging-iac-what-if-drift-before-next-full-environment)

## Status

**The live review is outstanding.** As measured on 2026-08-05, staging differs from
`infra/environment.bicep` in 12 `Modify` resources. Nobody has yet decided which differences are harmless
service defaults and which are real removals. The container app and the migration job both have image and
environment-variable differences, and those are the most costly to get wrong. This repository change does not
reconcile that drift and makes no claim that it is reconciled. It only makes sure a full deployment cannot run
until an authorized operator has done the review.

## What the gate does

`infra/deploy-staging.sh` runs `az deployment group create` with the whole staging template. That applies
**every** outstanding what-if change at once. The script now sources `infra/staging-review-guard.sh` and calls
`staging_review_require_approval` before its first Azure command. If any of these checks fails, the script
exits non-zero and never runs `az`:

| check | refused when |
| -- | -- |
| Approval present | `.staging-review/approval` (or `$DEVFATHOM_STAGING_REVIEW_APPROVAL`) is missing, empty, a symlink, or unreadable |
| Well-formed | a line is not `key=value`, a key is unknown or repeated, or a required key is missing or malformed |
| Explicit decision | `decision` is not `all-modify-and-delete-properties-reviewed` |
| Fresh | `reviewed_at` is more than 24 hours old or more than 5 minutes in the future |
| Bound to the IaC | the SHA-256 digest of `deploy-staging.sh`, `staging-review-guard.sh`, `shared.bicep`, `environment.bicep`, `acr-pull.bicep` and `staging.bicepparam` differs from `iac_sha256` |
| Bound to the reviewed what-if | the local what-if output (`whatif-staging.json`, or `$DEVFATHOM_STAGING_WHATIF_FILE`) is missing, empty, or its SHA-256 differs from `whatif_sha256` |
| Right directory | the script is not run from the repository root, so the hashed files might not be the deployed ones |

The approval file is parsed, never sourced or executed. No environment variable or flag skips the gate. Do not
edit the scripts to get around it. Any edit to a bound file invalidates every existing approval.

The staging GitHub workflow does not run this script and does not deploy Bicep. It updates the image of the
existing container app and job only, so the gate does not affect normal releases.

## Operator procedure

Only an operator authorized for the staging resource group does this, on their own machine.

1. Check out the exact commit you intend to deploy. Work from the repository root.
2. Export the same values `infra/staging.bicepparam` reads, using the values staging was **actually deployed
   with**. Do not generate fresh random secrets for the what-if: that creates differences that are not real
   drift. `deploy-staging.sh` itself generates new database, Auth.js, encryption, camera and cron secrets on
   every run, so a full deployment also rotates them. Plan for that.
3. Generate the what-if locally. The output stays on your machine:

   ```bash
   az deployment group what-if \
     --resource-group rg-devfathom-staging-uaenorth \
     --parameters infra/staging.bicepparam \
     --name staging \
     --no-pretty-print > whatif-staging.json
   ```

   `whatif-staging.json` and `.staging-review/` are git-ignored. The what-if contains full resource IDs, which
   include the subscription GUID, and may contain resource names and connection-string-shaped values. Do not
   commit it, attach it to an issue or PR, or paste it into chat. Share only resource types and counts.
4. Walk every `Modify` and every `Delete` property. For each one, either change the template to match the
   deployed reality, or decide to accept the change on purpose. Write down the decisions without identifiers
   (on DEV-341, as types and counts).
5. If you changed any template, commit it, then repeat steps 3 and 4 until every remaining change is intended.
6. Record the review. This command never calls Azure:

   ```bash
   infra/record-staging-review.sh --reviewer "Your Name" --confirm-every-modify-and-delete-reviewed
   ```

   It writes `.staging-review/approval` with mode `0600`. The approval binds the current infrastructure digest
   and the SHA-256 of your `whatif-staging.json`. It expires after 24 hours.
7. Run `./infra/deploy-staging.sh` from the repository root before the approval expires. If it refuses,
   regenerate the what-if and review again. Do not edit the approval.
8. After deployment, delete `whatif-staging.json` and `.staging-review/approval`.

## What this gate cannot prove

- It cannot prove a person actually read the what-if. It records an explicit, named, time-bounded statement
  bound to exact files, so a stale or accidental run cannot pass.
- It cannot detect drift that appears in Azure after the what-if was generated. The 24-hour expiry limits that
  window. Regenerate the what-if if anything else changed staging, such as a workflow release.
- Anyone who can edit the scripts can remove the gate. Repository review protects the gate itself.
