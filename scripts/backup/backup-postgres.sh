#!/usr/bin/env bash
# Run with libpq PG* environment variables; never pass a database URL on argv.
set +x
set -euo pipefail
umask 077
export LC_ALL=C
export AWS_PAGER=''

fail() { printf 'Backup refused: %s\n' "$*" >&2; exit 1; }

[[ $# -eq 0 ]] || fail 'configure using environment variables only'
: "${PGHOST:?Set PGHOST}" "${PGPORT:?Set PGPORT}" "${PGUSER:?Set PGUSER}"
: "${PGDATABASE:?Set PGDATABASE}" "${PGPASSFILE:?Set PGPASSFILE}"
: "${BACKUP_S3_URI:?Set BACKUP_S3_URI to s3://bucket/prefix}"
[[ "$PGDATABASE" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ && ${#PGDATABASE} -le 63 ]] ||
  fail 'PGDATABASE must be a plain database name, at most 63 bytes'
[[ -f "$PGPASSFILE" && -r "$PGPASSFILE" ]] || fail 'PGPASSFILE is not readable'
[[ "$BACKUP_S3_URI" =~ ^s3://[a-z0-9][a-z0-9.-]+/[a-zA-Z0-9/_-]+$ ]] ||
  fail 'BACKUP_S3_URI must contain a bucket and a plain prefix'

kms_arn_re='^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$'
[[ -z "${BACKUP_KMS_KEY_ID:-}" || "$BACKUP_KMS_KEY_ID" =~ $kms_arn_re ]] ||
  fail 'BACKUP_KMS_KEY_ID must be a full KMS key ARN (not a key ID or alias)'

encryption=(--sse AES256)
if [[ -n "${BACKUP_KMS_KEY_ID:-}" ]]; then
  encryption=(--sse aws:kms --sse-kms-key-id "$BACKUP_KMS_KEY_ID")
fi

work_dir=$(mktemp -d)
trap 'rm -rf -- "$work_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
filename="postgres-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
archive="$work_dir/$filename"
pg_dump --no-password --format=custom --compress=6 --file "$archive"
pg_restore --list "$archive" > /dev/null
(cd "$work_dir" && sha256sum "$filename" > "$filename.sha256")

destination="${BACKUP_S3_URI%/}/$filename"
aws s3 cp "$archive" "$destination" "${encryption[@]}" --only-show-errors
# The checksum is the completion marker; publish it only after the dump upload succeeds.
aws s3 cp "$archive.sha256" "$destination.sha256" "${encryption[@]}" --only-show-errors
printf 'Backup complete: %s (dump validated; SHA-256 sidecar uploaded)\n' "$destination"
