#!/usr/bin/env bash
# This drill creates a new database and never drops, reuses, or overwrites one.
set +x
set -euo pipefail
umask 077
export LC_ALL=C
export AWS_PAGER=''

fail() { printf 'Restore refused: %s\n' "$*" >&2; exit 1; }

[[ $# -eq 2 ]] || fail 'usage: restore-postgres.sh s3://bucket/prefix/archive.dump devfathom_restore_NAME'
[[ "${ALLOW_DISPOSABLE_RESTORE:-}" == 1 ]] || fail 'set ALLOW_DISPOSABLE_RESTORE=1 explicitly'
source_uri=$1
target=$2
[[ "$target" =~ ^devfathom_restore_[a-z0-9_]+$ && ${#target} -le 63 ]] ||
  fail 'target must match devfathom_restore_[a-z0-9_]+ and be at most 63 bytes'
: "${PGHOST:?Set PGHOST}" "${PGPORT:?Set PGPORT}" "${PGUSER:?Set PGUSER}"
: "${PGDATABASE:?Set PGDATABASE to the source database}" "${PGPASSFILE:?Set PGPASSFILE}"
[[ "$PGDATABASE" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ && ${#PGDATABASE} -le 63 ]] ||
  fail 'PGDATABASE must be a plain database name, at most 63 bytes'
[[ -f "$PGPASSFILE" && -r "$PGPASSFILE" ]] || fail 'PGPASSFILE is not readable'
[[ "$target" != "$PGDATABASE" ]] || fail 'target is the source database'
[[ "$source_uri" =~ ^s3://([a-z0-9][a-z0-9.-]+)/([a-zA-Z0-9/_-]+\.dump)$ ]] ||
  fail 'source must be an S3 dump URI with a plain key'
bucket=${BASH_REMATCH[1]}
key=${BASH_REMATCH[2]}
filename=${key##*/}

source_database=$(psql --no-password --no-psqlrc --tuples-only --no-align \
  --set=ON_ERROR_STOP=1 --command='SELECT current_database();')
[[ "$source_database" == "$PGDATABASE" ]] || fail 'connected source does not match PGDATABASE'
[[ "$target" != "$source_database" ]] || fail 'target is the connected source database'

work_dir=$(mktemp -d)
trap 'rm -rf -- "$work_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

download_encrypted() {
  local object_key=$1 output=$2 metadata encryption kms_key
  # Verify metadata from the same GET that downloads the bytes (no HEAD/GET race).
  metadata=$(aws s3api get-object --bucket "$bucket" --key "$object_key" "$output" \
    --query '[ServerSideEncryption, SSEKMSKeyId]' --output text)
  read -r encryption kms_key <<< "$metadata"
  case "$encryption" in
    AES256) [[ -z "${BACKUP_KMS_KEY_ID:-}" ]] || fail 'expected SSE-KMS, received SSE-S3' ;;
    aws:kms)
      [[ -n "$kms_key" && "$kms_key" != None ]] || fail 'SSE-KMS object has no key identity'
      if [[ -n "${BACKUP_KMS_KEY_ID:-}" && "$kms_key" != "$BACKUP_KMS_KEY_ID" ]]; then
        fail 'SSE-KMS key does not match BACKUP_KMS_KEY_ID (use a key ARN)'
      fi
      ;;
    *) fail 'S3 object is not encrypted with SSE-S3 or SSE-KMS' ;;
  esac
}

download_encrypted "$key" "$work_dir/$filename"
download_encrypted "$key.sha256" "$work_dir/$filename.sha256"
checksum_line=$(cat "$work_dir/$filename.sha256")
digest=${checksum_line%% *}
[[ "$digest" =~ ^[a-f0-9]{64}$ && "$checksum_line" == "$digest  $filename" ]] ||
  fail 'checksum sidecar must contain only the SHA-256 and expected dump basename'
(cd "$work_dir" && sha256sum --check --status "$filename.sha256") || fail 'SHA-256 mismatch'
pg_restore --list "$work_dir/$filename" > /dev/null

# CREATE DATABASE must succeed atomically; an existing target is never eligible.
createdb --no-password --maintenance-db="$PGDATABASE" --template=template0 -- "$target"
printf 'Created disposable database: %s; retain for inspection and manual cleanup on failure.\n' "$target"
PGDATABASE="$target" pg_restore --no-password --exit-on-error --single-transaction \
  --no-owner --no-privileges --dbname="$target" "$work_dir/$filename"
migration_count=$(PGDATABASE="$target" psql --no-password --no-psqlrc --tuples-only --no-align \
  --set=ON_ERROR_STOP=1 --command='SELECT count(*) FROM public."_prisma_migrations"
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM public."_prisma_migrations"
        WHERE finished_at IS NULL AND rolled_back_at IS NULL);')
[[ "$migration_count" =~ ^[1-9][0-9]*$ ]] || fail 'Prisma history is empty or has unresolved migrations'
printf 'Restore drill complete: %s; successful Prisma migrations: %s\n' "$target" "$migration_count"
