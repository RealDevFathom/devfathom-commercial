# Pharmacy EC2 PostgreSQL backup and restore drill

DEV-94 / GitHub #715. These scripts cover the PostgreSQL database, including Prisma migration
history. They do not back up uploaded prescription files, EC2 volumes, application secrets, or
external services. Track those recovery assets separately before accepting complete service recovery.

## Recovery status

The earlier cloud commit `06e5694` was unavailable in the local object stores checked during recovery;
GitHub retrieval had previously returned 404. This implementation was reconstructed on `develop`.
Historical checks recorded passing on the earlier bytes were:

- `bun x vitest run tests/postgres-backup.test.ts`
- `bash -n scripts/backup/*.sh`
- `git diff --check`
- Prettier check of `tests/postgres-backup.test.ts`

**None of those checks were executed on these reconstructed bytes.** Tests, syntax, lint, format,
build and diff checks were deliberately not run in this recovery lane. Historical passes do not
validate this implementation. No live EC2/S3 backup or restore was executed; credentials and the
target environment were unavailable. DEV-94 operational acceptance remains pending a real drill.

## Prerequisites and boundaries

- Linux EC2 host with Bash, GNU coreutils (`sha256sum`), AWS CLI, and PostgreSQL client utilities
  (`pg_dump`, `pg_restore`, `psql`, `createdb`). Use the same PostgreSQL major version as the source
  server; validate version compatibility before the first drill. No application dependency changes.
- Dedicated backup login with CONNECT, schema USAGE and SELECT on every required table/sequence,
  including `public._prisma_migrations`. Ensure future objects are readable. For tenant RLS, the
  operator must arrange an approved full-database backup role; do not silently disable row security
  or accept partial tenant dumps. `pg_dump` failures must alert.
- Dedicated restore-drill login with CONNECT to the source and CREATEDB on the selected cluster.
  It owns the fresh target. Do not use a superuser or the application's normal login. Source and
  target are on the same configured cluster; a separate isolated clone is preferable for drills
  against sensitive data. Never route application traffic to the disposable database.
- Private database connectivity. Use certificate-verified TLS for remote connections. Do not expose
  PostgreSQL publicly to make the backup service work. Configure `PGSSLMODE`/`PGSSLROOTCERT` for the
  environment's actual certificate and endpoint.
- A private S3 bucket with public access blocked, TLS-only access, versioning and retention/lifecycle
  managed by the owner. Use a dedicated `pharmacy/postgres` prefix. Retain at least the agreed
  recovery window; keep quarterly drill evidence separately. Scripts never delete S3 objects.
- Restore only trusted archives from the controlled backup prefix. SHA-256 detects corruption;
  it is not a signature against an actor who can replace both dump and sidecar. Restoring a
  PostgreSQL archive executes SQL. Restrict writers and restore-role privileges accordingly.

## Install on EC2 (operator action, not performed during recovery)

Provision a dedicated OS account `devfathom-backup`. Copy the reviewed scripts to a stable path
outside release directories so a release cleanup cannot remove the scheduled job:

```sh
sudo install -d -m 0755 /opt/devfathom/ops/backup
sudo install -o root -g root -m 0755 scripts/backup/backup-postgres.sh \
  scripts/backup/restore-postgres.sh /opt/devfathom/ops/backup/
sudo install -d -o root -g devfathom-backup -m 0750 /etc/devfathom-backup
```

Create `/etc/devfathom-backup/backup.env` owned by root, group `devfathom-backup`, mode `0640`.
Replace the examples with verified deployment values. Use plain PostgreSQL identifiers (letters,
digits and underscores; no URI/connection string), at most 63 bytes:

```ini
PGHOST=private-database-hostname
PGPORT=5432
PGUSER=pharmacy_backup
PGDATABASE=pharmacy
PGPASSFILE=/etc/devfathom-backup/backup.pgpass
PGSSLMODE=verify-full
PGSSLROOTCERT=/etc/devfathom-backup/database-ca.pem
AWS_REGION=us-east-1
BACKUP_S3_URI=s3://YOUR-BACKUP-BUCKET/pharmacy/postgres
# Optional: exact key ARN, not an alias, for both backup and restore verification.
# BACKUP_KMS_KEY_ID=arn:aws:kms:us-east-1:ACCOUNT_ID:key/KEY_ID
```

Install the PostgreSQL server's CA certificate (verified out of band, e.g. against the database
host's configuration) at the `PGSSLROOTCERT` path and confirm the backup account can read it. Do not
enable the timer until this check succeeds:

```sh
sudo install -o root -g devfathom-backup -m 0640 /path/to/verified-database-ca.pem \
  /etc/devfathom-backup/database-ca.pem
sudo -u devfathom-backup test -r /etc/devfathom-backup/database-ca.pem && echo CA readable
```

Place credentials in `backup.pgpass`, owned by `devfathom-backup`, mode `0600`, using PostgreSQL's
`host:port:database:user:password` syntax. Escape `:` and `\` in credentials according to pgpass rules.
Use a separate protected pgpass file for the drill login, covering the source and disposable target.
The pgpass database field can be the exact target name or `*`; partial wildcard prefixes do not work.
Never put a database URL or password on command arguments. Do not enable shell tracing. Use an EC2
instance role for S3/KMS; do not store long-lived AWS access keys in the environment file.

Install `/etc/systemd/system/devfathom-postgres-backup.service`:

```ini
[Unit]
Description=DevFathom pharmacy PostgreSQL backup
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=devfathom-backup
Group=devfathom-backup
EnvironmentFile=/etc/devfathom-backup/backup.env
ExecStart=/opt/devfathom/ops/backup/backup-postgres.sh
UMask=0077
PrivateTmp=true
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
StateDirectory=devfathom-backup
Environment=TMPDIR=/var/lib/devfathom-backup
TimeoutStartSec=2h
```

Install `/etc/systemd/system/devfathom-postgres-backup.timer`:

```ini
[Unit]
Description=Nightly pharmacy PostgreSQL backup

[Timer]
OnCalendar=*-*-* 02:00:00 UTC
RandomizedDelaySec=15m
Persistent=true
Unit=devfathom-postgres-backup.service

[Install]
WantedBy=timers.target
```

After environment review, the operator enables the timer using `systemctl daemon-reload` and
`systemctl enable --now devfathom-postgres-backup.timer`. `Persistent=true` may immediately start a
missed run; installation/activation is a live action outside this recovery task. Inspect timer state,
service exit status and journal after the first run. Forward failures and success markers to the
existing monitoring system; a timer being enabled does not prove any backup succeeded.

## Least-privilege S3 and KMS permissions

Attach this write statement to the backup instance role, replacing the bucket/prefix:

```json
{
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:AbortMultipartUpload"],
  "Resource": "arn:aws:s3:::YOUR-BACKUP-BUCKET/pharmacy/postgres/*"
}
```

The restore role needs only `s3:GetObject` for that resource. Neither script needs bucket-wide
listing or delete access. A monitoring role that lists backups needs `s3:ListBucket` on the bucket
with an `s3:prefix` condition limited to `pharmacy/postgres/*`. Enforce explicit server-side encryption
in the bucket policy, allowing `AES256` or the approved `aws:kms` key as appropriate. Both dump and
sidecar uploads explicitly request encryption; bucket defaults alone are not relied on.

For SSE-KMS, permit `kms:GenerateDataKey` and `kms:Decrypt` for the backup role (multipart uploads
require decryption permission), and `kms:Decrypt` for the restore role. Restrict the resource to the
exact key ARN in both IAM and the KMS key policy, with `kms:ViaService` matching
`s3.REGION.amazonaws.com`. Restrict `kms:EncryptionContext:aws:s3:arn` to the approved S3 prefix when
S3 Bucket Keys are off; with Bucket Keys enabled the context is the bucket ARN, so retain the strict
prefix restriction in S3 IAM. Keep the key enabled and available throughout backup retention.

By default restore accepts SSE-S3 or SSE-KMS and rejects missing/unknown encryption. Setting
`BACKUP_KMS_KEY_ID` to the exact key ARN also requires that key on **both** objects. Encryption metadata
comes from each `GetObject` response for the downloaded bytes, avoiding a separate HEAD/GET race.

## Nightly evidence and monitoring

The backup is a compressed custom-format dump (`pg_dump --format=custom --compress=6`). The script
lists its archive with `pg_restore`, writes a SHA-256 sidecar and uploads the dump followed by its
sidecar. A backup is complete only when both uploads succeeded. A dump without a sidecar is incomplete.

Alert on nonzero service exits, missing completion logs, missing object pairs, insufficient free
temporary disk, unexpected object sizes, access/KMS errors, or newest complete backup age over
26 hours. Record UTC start/end, service exit, dump URI, both object sizes, encryption/key metadata,
and retention policy. Monitor independently of the host so a dead EC2 instance cannot silently stop
both backups and alerts. Nightly cadence provides a target RPO of 24 hours only while successful
backups remain current; agree an RTO and measure it during the drill.

## Quarterly restore drill

1. Record the source deployment/commit, PostgreSQL major version, source database/host, expected
   Prisma migration set and approximate critical table counts from an authorized operator. Choose
   a complete recent backup pair; record object version IDs/checksums if available. Pause replacement
   of that object pair during the drill. The scripts use unique timestamp/PID names, but S3/IAM must
   still protect existing recovery data.
2. Configure the protected drill-role environment with `PGDATABASE` still naming the source,
   `PGPASSFILE` for the drill login, and the approved encryption setting. Export variables without
   printing them. Choose an unused name matching `devfathom_restore_[a-z0-9_]+`, at most 63 bytes.
3. Run the following only in the approved drill environment, substituting the recorded backup URI:

   ```sh
   ALLOW_DISPOSABLE_RESTORE=1 /opt/devfathom/ops/backup/restore-postgres.sh \
     s3://YOUR-BACKUP-BUCKET/pharmacy/postgres/postgres-TIMESTAMP-PID.dump \
     devfathom_restore_20261102
   ```

4. Require exit zero and the completion message. The script checks source identity, encryption on
   both downloads, exact checksum basename/digest, and archive readability **before** database
   creation. `createdb` must succeed; an existing target is refused atomically. No `--clean`,
   `--create`, database drop, or reuse path exists. Restore runs in one transaction, stops on SQL
   errors, omits original owners/grants, and verifies nonempty completed Prisma history with no
   unresolved migrations. Missing migration tables also fail the drill.
5. Independently compare exact migration names to the recorded source expectation, verify critical
   pharmacy table counts and tenant coverage, and exercise an isolated application against the
   disposable target if included in the acceptance plan. The script's archive listing and migration
   probe alone do not establish application recovery, roles/grants parity, or full tenant coverage.
6. Record elapsed backup age, download/restore duration, bytes/checksum/encryption, target identity,
   script exit status, migration result, application/data evidence and operator. Store evidence in
   an access-controlled location without row contents, patient data, or credentials. Link the record
   to DEV-94/#715 and the quarterly review. Acceptance requires this live evidence.

## Failure and cleanup

All temporary dump files are private and removed on normal exit or handled signals. A hard kill or
host failure can leave sensitive temporary files: inspect the service state directory after recovery,
then remove only confirmed abandoned job directories. Budget disk for a full compressed dump and
database disk for an entire restored copy.

A failed restore may leave its **newly created** disposable database. Preserve it for diagnosis;
choose a new name for the next run. Scripts never drop any database, including after failure.
After evidence approval, the DBA must verify the exact target against the successful creation log,
confirm its owner, disposable prefix, no application connections and inequality with the source,
then remove only that recorded disposable database through approved database tooling. Never use
wildcard cleanup or a generic source environment variable as the deletion target. Do not delete
backups as part of a drill; lifecycle retention is managed separately.

## Regression coverage

`tests/postgres-backup.test.ts` exercises encrypted uploads, validated archives and sidecars,
checksum/encryption failure before creation, strict names and allow flag, source/existing-target
refusal, target-directed restoration, migration probes and failure preservation. PostgreSQL and AWS
commands are mocked locally; even a future passing unit run will not substitute for a real EC2/S3
restore. These reconstructed tests remain unexecuted per recovery instructions.
