#!/usr/bin/env bash
# DEV-341: record an authorized operator's staging what-if review.
#
# Run this only after you have personally walked every Modify and Delete property in the current
# staging what-if and either reconciled the template or deliberately accepted the change. It writes a
# local, git-ignored approval bound to the exact infrastructure files and what-if output you reviewed.
# It never calls Azure. See docs/operations/staging-iac-drift-review.md.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=infra/staging-review-guard.sh
source "$script_dir/staging-review-guard.sh"

usage() {
  cat >&2 <<'USAGE'
Usage: infra/record-staging-review.sh --reviewer NAME --confirm-every-modify-and-delete-reviewed

Run from the repository root. Reads the what-if from $DEVFATHOM_STAGING_WHATIF_FILE
(default whatif-staging.json) and writes $DEVFATHOM_STAGING_REVIEW_APPROVAL
(default .staging-review/approval). The approval expires after 24 hours and is invalidated by any
change to the bound infrastructure files or the what-if output.
USAGE
}

reviewer=''
confirmed=false
while (( $# > 0 )); do
  case $1 in
    --reviewer)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      reviewer=$2
      shift 2
      ;;
    --confirm-every-modify-and-delete-reviewed)
      confirmed=true
      shift
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ $confirmed != true ]]; then
  printf 'Refusing to record a review without --confirm-every-modify-and-delete-reviewed.\n' >&2
  usage
  exit 2
fi
reviewer_pattern='^[A-Za-z0-9][A-Za-z0-9._@ -]{1,99}$'
if [[ ! $reviewer =~ $reviewer_pattern ]]; then
  printf 'A reviewer name (2-100 letters, digits, space, . _ @ -) is required.\n' >&2
  exit 2
fi

staging_review_require_repository_root

whatif_file=$(staging_review_whatif_file)
if [[ ! -f $whatif_file || -L $whatif_file || ! -s $whatif_file ]]; then
  printf 'What-if output %s is missing or empty. Generate it locally first.\n' "$whatif_file" >&2
  exit 1
fi
if git ls-files --error-unmatch -- "$whatif_file" >/dev/null 2>&1; then
  printf 'What-if output %s is tracked by git. It must stay local; remove it from the index first.\n' \
    "$whatif_file" >&2
  exit 1
fi

iac_sha256=$(staging_review_iac_digest)
whatif_sha256=$(staging_review_sha256 "$whatif_file")
reviewed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

approval_file=$(staging_review_approval_file)
umask 077
mkdir -p "$(dirname "$approval_file")"
temporary_file=$(mktemp "$approval_file.XXXXXX")
trap 'rm -f "$temporary_file"' EXIT
printf '%s\n' \
  "version=$STAGING_REVIEW_APPROVAL_VERSION" \
  "decision=$STAGING_REVIEW_DECISION" \
  "iac_sha256=$iac_sha256" \
  "whatif_sha256=$whatif_sha256" \
  "reviewer=$reviewer" \
  "reviewed_at=$reviewed_at" > "$temporary_file"
mv -f "$temporary_file" "$approval_file"
trap - EXIT

printf 'Recorded staging review by %s at %s in %s (valid for 24 hours).\n' \
  "$reviewer" "$reviewed_at" "$approval_file" >&2
