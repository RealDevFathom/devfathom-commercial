#!/usr/bin/env bash
# DEV-341: fail-closed review gate for full staging IaC deployments.
#
# `infra/deploy-staging.sh` runs `az deployment group create` with the whole staging template, which
# applies every outstanding what-if modification at once. Staging has known, unreviewed drift, so a
# full deployment must not start until an authorized operator has reviewed the current what-if and
# recorded an approval bound to the exact infrastructure files that will be deployed.
#
# This file only defines functions. It never calls Azure. Source it, then call
# `staging_review_require_approval` before the first Azure command.
#
# Approval file (local, git-ignored, never committed), one `key=value` per line, every key exactly once:
#   version=1
#   decision=all-modify-and-delete-properties-reviewed
#   iac_sha256=<staging_review_iac_digest output>
#   whatif_sha256=<sha256 of the local what-if JSON that was reviewed>
#   reviewer=<operator name>
#   reviewed_at=<UTC timestamp, YYYY-MM-DDTHH:MM:SSZ>
#
# There is intentionally no environment variable or flag that skips this gate.

STAGING_REVIEW_APPROVAL_VERSION=1
STAGING_REVIEW_DECISION=all-modify-and-delete-properties-reviewed
STAGING_REVIEW_MAX_AGE_SECONDS=$((24 * 60 * 60))
STAGING_REVIEW_MAX_CLOCK_SKEW_SECONDS=300

# Every file whose content decides what the full staging deployment does. Changing any of them
# invalidates an existing approval.
STAGING_REVIEW_BOUND_FILES=(
  infra/deploy-staging.sh
  infra/staging-review-guard.sh
  infra/shared.bicep
  infra/environment.bicep
  infra/acr-pull.bicep
  infra/staging.bicepparam
)

staging_review_fail() {
  printf 'DEV-341 staging review gate: %s\n' "$1" >&2
  printf 'Refusing to run any Azure command. See docs/operations/staging-iac-drift-review.md.\n' >&2
  return 1
}

staging_review_sha256() {
  local file=$1 output
  if command -v sha256sum >/dev/null 2>&1; then
    output=$(sha256sum -- "$file") || return 1
  elif command -v shasum >/dev/null 2>&1; then
    output=$(shasum -a 256 -- "$file") || return 1
  else
    return 1
  fi
  printf '%s\n' "${output%% *}"
}

staging_review_sha256_stdin() {
  local output
  if command -v sha256sum >/dev/null 2>&1; then
    output=$(sha256sum) || return 1
  elif command -v shasum >/dev/null 2>&1; then
    output=$(shasum -a 256) || return 1
  else
    return 1
  fi
  printf '%s\n' "${output%% *}"
}

# Must run from the repository root, so the files hashed are the files `az` will deploy.
staging_review_require_repository_root() {
  local script_root
  script_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P) || {
    staging_review_fail 'cannot resolve the repository root.'
    return 1
  }
  if [[ $(pwd -P) != "$script_root" ]]; then
    staging_review_fail "run from the repository root ($script_root)."
    return 1
  fi
}

staging_review_iac_digest() {
  local file file_digest manifest=''
  for file in "${STAGING_REVIEW_BOUND_FILES[@]}"; do
    if [[ ! -f $file || -L $file ]]; then
      printf 'DEV-341 staging review gate: bound file %s is missing or a symlink.\n' "$file" >&2
      return 1
    fi
    file_digest=$(staging_review_sha256 "$file") || return 1
    manifest+="$file_digest  $file"$'\n'
  done
  printf '%s' "$manifest" | staging_review_sha256_stdin
}

staging_review_epoch() {
  local timestamp=$1
  date -u -d "$timestamp" +%s 2>/dev/null && return 0
  date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$timestamp" +%s 2>/dev/null
}

staging_review_approval_file() {
  printf '%s\n' "${DEVFATHOM_STAGING_REVIEW_APPROVAL:-.staging-review/approval}"
}

staging_review_whatif_file() {
  printf '%s\n' "${DEVFATHOM_STAGING_WHATIF_FILE:-whatif-staging.json}"
}

staging_review_require_approval() {
  local approval_file whatif_file
  approval_file=$(staging_review_approval_file)
  whatif_file=$(staging_review_whatif_file)

  staging_review_require_repository_root || return 1

  if [[ ! -e $approval_file ]]; then
    staging_review_fail "no review approval at $approval_file. An authorized operator must review the staging what-if first."
    return 1
  fi
  if [[ ! -f $approval_file || -L $approval_file || ! -r $approval_file ]]; then
    staging_review_fail "approval $approval_file is not a readable regular file."
    return 1
  fi

  local line key value
  local version='' decision='' iac_sha256='' whatif_sha256='' reviewer='' reviewed_at=''
  local seen=' '
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ -z $line ]] && continue
    if [[ $line != *=* ]]; then
      staging_review_fail 'approval is malformed (expected key=value lines).'
      return 1
    fi
    key=${line%%=*}
    value=${line#*=}
    if [[ $seen == *" $key "* ]]; then
      staging_review_fail 'approval repeats a key.'
      return 1
    fi
    seen+="$key "
    case $key in
      version) version=$value ;;
      decision) decision=$value ;;
      iac_sha256) iac_sha256=$value ;;
      whatif_sha256) whatif_sha256=$value ;;
      reviewer) reviewer=$value ;;
      reviewed_at) reviewed_at=$value ;;
      *)
        staging_review_fail 'approval contains an unknown key.'
        return 1
        ;;
    esac
  done < "$approval_file"

  if [[ $version != "$STAGING_REVIEW_APPROVAL_VERSION" ]]; then
    staging_review_fail 'approval version is missing or unsupported.'
    return 1
  fi
  if [[ $decision != "$STAGING_REVIEW_DECISION" ]]; then
    staging_review_fail 'approval does not record that every Modify and Delete property was reviewed.'
    return 1
  fi
  if [[ ! $iac_sha256 =~ ^[0-9a-f]{64}$ || ! $whatif_sha256 =~ ^[0-9a-f]{64}$ ]]; then
    staging_review_fail 'approval digests are missing or malformed.'
    return 1
  fi
  local reviewer_pattern='^[A-Za-z0-9][A-Za-z0-9._@ -]{1,99}$'
  if [[ ! $reviewer =~ $reviewer_pattern ]]; then
    staging_review_fail 'approval reviewer is missing or malformed.'
    return 1
  fi
  if [[ ! $reviewed_at =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
    staging_review_fail 'approval reviewed_at is missing or not a UTC timestamp.'
    return 1
  fi

  local reviewed_epoch now age
  if ! reviewed_epoch=$(staging_review_epoch "$reviewed_at"); then
    staging_review_fail 'approval reviewed_at is not a valid date.'
    return 1
  fi
  now=$(date -u +%s)
  age=$((now - reviewed_epoch))
  if (( age < -STAGING_REVIEW_MAX_CLOCK_SKEW_SECONDS )); then
    staging_review_fail 'approval reviewed_at is in the future.'
    return 1
  fi
  if (( age > STAGING_REVIEW_MAX_AGE_SECONDS )); then
    staging_review_fail 'approval is stale (older than 24 hours). Regenerate and re-review the what-if.'
    return 1
  fi

  local current_iac
  if ! current_iac=$(staging_review_iac_digest); then
    staging_review_fail 'cannot compute the infrastructure digest.'
    return 1
  fi
  if [[ $current_iac != "$iac_sha256" ]]; then
    staging_review_fail 'infrastructure files changed since the review. Regenerate and re-review the what-if.'
    return 1
  fi

  if [[ ! -f $whatif_file || -L $whatif_file || ! -s $whatif_file ]]; then
    staging_review_fail "the reviewed what-if output $whatif_file is missing or empty."
    return 1
  fi
  local current_whatif
  if ! current_whatif=$(staging_review_sha256 "$whatif_file"); then
    staging_review_fail 'cannot hash the what-if output.'
    return 1
  fi
  if [[ $current_whatif != "$whatif_sha256" ]]; then
    staging_review_fail 'the local what-if output is not the one that was reviewed.'
    return 1
  fi

  printf 'DEV-341 staging review gate: approval by %s at %s matches the current infrastructure files.\n' \
    "$reviewer" "$reviewed_at" >&2
}
