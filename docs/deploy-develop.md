# Develop continuous deployment

`deploy-develop.yml` builds the exact current `develop` SHA after a successful **push** run
of `.github/workflows/qa.yml`. It verifies workflow ID, path, repository, branch, SHA, successful
run and successful **WHA-1125 automated gate** and **WHA-1132 browser gate** jobs in that run.
QA now runs for pushes to develop. A manual deploy from develop uses the same gate; manually
dispatched QA runs cannot satisfy it (their optional checkout SHA can differ from the run SHA).
Stale commits are rejected before build and again before upload. Workflow concurrency queues
deployments; a server `flock` also serializes all activation work, including rollback and cleanup.

The Ubuntu runner uses Node 22 and Bun 1.4.2, frozen installs, Prisma generation and Next standalone
build. Module evaluation requires AUTH_SECRET, so the build generates an ephemeral value in memory;
the dedicated service must supply its own runtime secret. No server credentials are used to build.
`scripts/deploy/package-develop.sh` packages only standalone output, staged static/public
assets, startup script, package manifest, frozen lockfile, Prisma schema/migrations and config.
The public app URL is set to `https://develop.devfathom.com` at build time; any additional
`NEXT_PUBLIC_*` settings must likewise be configured at build time rather than only in systemd.
Nested traced `node_modules` are retained; root dependencies, checkout secrets and `.env*` files
are excluded. Uploads are excluded. Startup skips copies for the packaged `.assets-staged` marker;
older layouts still copy public/static as before. Build on the same Linux architecture as the host.

GitHub OIDC credentials upload `develop/<sha>.tar.gz` to S3 and submit `AWS-RunShellScript` to one
SSM-managed instance. The document executes the reviewed activation script through `runuser -u deploy`;
download, extraction, production frozen install and migrations all run as deploy. Root only performs
the user transition; deploy can sudo exactly the dedicated service restart. Prisma and dotenv must
remain production dependencies, and the locally installed Prisma executable is used without bunx.
The instance needs registry access for the production install; no build runs there.

The server prepares each attempt under `/home/app/releases/.staging/<sha>.<random>`. Only after
production install, migrations, permissions, cache and uploads setup succeed does it promote to the
literal `/home/app/releases/<sha>`. A retry of the current SHA performs only a bounded health check:
it never overwrites files, reinstalls dependencies, migrates or restarts, and fails if unhealthy.
An existing inactive SHA directory is replaced only after preparation under the server lock; the
currently running predecessor is preserved for rollback. SHA-path symlink aliases are refused.
Stale `.current-next` links left by SIGKILL are removed under that same lock before any switch.
`/home/app/web` is a stable link to
`/home/app/releases/current`; replacing `current` with `mv -T` atomically changes the release reached
through web without allowing deploy to modify `/home/app` itself. After migrations, activation
restarts **only `devfathom-develop.service`** and probes `http://127.0.0.1:3001/` up to twelve times
(HTTP 200 or 307). Restart failure, unhealthy response or interruption restores the prior link and
restarts that same unit, then reports failure. Database migrations are forward-only: rollback does
not undo schema changes. Use backward-compatible expand/contract migrations. Initial deployments
require an existing healthy predecessor, including its persistent uploads links.

The active release and predecessor plus three other newest directories are retained after success
(about five), excluding `.staging`. Normal exits clean the temporary staging directory and archive.
A SIGKILL can leave staging debris; an administrator may remove orphaned `.staging` entries while
holding `.deploy.lock` and after confirming no SSM deployment is active. Never remove an active or
rollback release during that cleanup. SSM delivery timeout is
120 seconds, execution timeout 2400 seconds and polling is bounded to 45 minutes. The runner prints
terminal SSM stdout/stderr/status and fails for every non-success status or timeout. A runner timeout
does not prove the remote command stopped: inspect SSM before attempting operator recovery. Never
enable shell tracing, print environment files or put credentials in SSM parameters/logs.

## GitHub environment

Create a protected environment **develop** and add these **environment secrets**. Restrict deployment
refs to develop for dispatch and the trusted default branch for workflow_run (GitHub runs that
workflow on the default-branch ref). If develop is the default, only develop is needed. The inline
gate independently enforces the actual deploy branch and exact SHA. Protect both trusted refs:

| Secret | Meaning |
| --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | Dedicated GitHub OIDC deploy role |
| `AWS_REGION` | Region containing bucket and managed instance |
| `DEVELOP_ARTIFACT_BUCKET` | Dedicated private artifact bucket name |
| `DEVELOP_INSTANCE_ID` | The single develop EC2 managed instance ID |

No SSH keys, inbound SSH or long-lived AWS access keys are required. Protect develop and workflow
changes through repository review rules. The deploy role can execute arbitrary shell commands as
root through this SSM document, so workflow/environment protection is a critical trust boundary.

## One-time server setup (administrator, out of band)

These are setup instructions, not commands executed by CI. Use a dedicated develop instance, or
first confirm no other environment uses `/home/app/web`, `/home/app/releases`, the uploads directory
or port 3001. Do not replace or restart an existing production/shared service. If those paths are
shared, isolate that service first during a separately approved maintenance window. Install AWS CLI,
SSM Agent, system-wide Node 22 at `/usr/bin/node`, Bun 1.4.2 at
`/home/deploy/.bun/bin/bun`, tar, curl, GNU coreutils/findutils, util-linux (flock/runuser) and sudo.
Install Bun as deploy with `BUN_INSTALL=/home/deploy/.bun` and ensure deploy owns its home and Bun
installation; do not reuse `/home/app/.bun` or a private administrator installation. The app uses
system-wide Node, so it needs no access to deploy's home or Bun. Ripgrep is only used by the GitHub
runner's send script, not by the instance activation script. Ensure the
SSM agent has outbound HTTPS to SSM/ssmmessages and the instance can reach S3 and the package registry.
No inbound deployment ports are necessary.

Create users `app` and `deploy` if absent. Add deploy to group app. `/home/app` must allow deploy
traversal but remain administrator-owned and not writable by deploy. For a fresh isolated host:

```bash
sudo usermod -aG app deploy
# New runuser sessions pick up this supplementary group; primary group may remain deploy.
sudo -u deploy -H id
sudo -u deploy -H /home/deploy/.bun/bin/bun --version
sudo -u app /usr/bin/node --version
sudo chown root:app /home/app
sudo chmod 0750 /home/app
sudo install -d -o deploy -g app -m 2750 /home/app/releases
sudo install -d -o root -g app -m 0750 /home/app/shared
sudo install -d -o app -g app -m 2770 /home/app/shared/private-uploads
sudo install -d -o root -g deploy -m 0750 /etc/devfathom
# Provision the environment securely, then set its ownership/mode. Never echo its contents.
sudo chown root:deploy /etc/devfathom/develop.env
sudo chmod 0640 /etc/devfathom/develop.env
# Provision a separate runtime-only file, without the migration URL.
sudo chown root:root /etc/devfathom/develop-runtime.env
sudo chmod 0600 /etc/devfathom/develop-runtime.env
sudo ln -s /etc/devfathom/develop.env /home/app/develop.env
```

Use shell-compatible quoted assignments in `develop.env` (no command substitutions) for
develop-only `MIGRATION_DATABASE_URL` and any migration tooling settings. This file is available to
deploy, not the app account. Put `NODE_ENV=production`, `PORT=3001`, `HOSTNAME=127.0.0.1`, runtime
`DATABASE_URL` and develop auth/application settings in `develop-runtime.env` using systemd-compatible
assignments. Do not put the migration URL in the runtime file. Use an isolated develop database and
identity; the app database role stays NOSUPERUSER NOBYPASSRLS. Systemd reads the root-owned runtime
file before changing user. The migration URL is elevated only as far as required for the develop
schema. Never reuse production environment files. Keep application logs free of credentials.

For this `NODE_ENV=production` service, explicitly configure the supported S3 adapter in
`develop-runtime.env` (use the actual private upload bucket and its region):

```ini
STORAGE_ADAPTER=s3
S3_UPLOADS_BUCKET=your-develop-private-uploads-bucket
AWS_REGION=us-east-1
```

The runtime instance role needs narrowly scoped upload-bucket `s3:GetObject`, `s3:PutObject`, and
`s3:DeleteObject` permissions, separately from its artifact download permissions. Block public bucket
access. The app stores objects at `<organizationId>/<filename>` and serves authorized requests via
`/api/files/[name]`. `LOCAL_UPLOADS_DIR` does not enable local storage in production.

Before first activation, use this packager to stage a known healthy develop release (including
`.assets-staged`) at `/home/app/releases/<bootstrap-sha>`, owned deploy:app with group read/traverse
permissions. Install its frozen production dependencies as deploy, then apply the same recursive
`chgrp -hR -P app` and `chmod -R g+rX` preparation as activation, before adding uploads links.
Create `.next/standalone/.next/cache` with group app and mode 2770, including group-write access to
any existing cache files. Never recursively follow uploads symlinks when adjusting permissions.
Inventory existing uploads in a maintenance window, including old `public/uploads` and
`/home/app/shared/uploads` data. Before importing a legacy flat filename, establish its authoritative
tenant provenance from scoped database attachment/evidence records and verify the associated access
policy. Import only verified files into the correct `<organizationId>/<filename>` key in the
configured private S3 bucket (or the equivalent local directory layout in permitted local modes).
Never blindly copy flat filenames into an organization-prefixed store or infer tenant ownership from
a filename. Quarantine ambiguous, conflicting, or unreferenced files outside all public directories
for operator review. Verify integrity and authorized tenant reads before removing legacy data.

For `NODE_ENV=development` or `test` only, a local process can explicitly use shared persistence:

```ini
STORAGE_ADAPTER=local
LOCAL_UPLOADS_DIR=/home/app/shared/private-uploads
```

`LOCAL_UPLOADS_DIR` must be absolute and outside public directories; public paths and symlinks into
them are rejected. With the variable unset, the default remains `<process.cwd()>/private-uploads`.
For that default, link both `<bootstrap-sha>/.next/standalone/private-uploads` and
`<bootstrap-sha>/private-uploads` to `/home/app/shared/private-uploads`, outside `public`.
Only verified tenant-prefixed data belongs there; set group app, directories 2770 and files 0660.
These compatibility links do not make the local adapter available to the production-mode service.

After verifying migration, remove obsolete `public/uploads` and `public/private-uploads` paths
from the release root and standalone tree, including aliases under other names; unlink symlinks
without following them. Packaging excludes these directories and all public symlinks; unstaged
startup applies the same filter. Never expose persisted uploads through public assets. `/uploads`
and `/private-uploads`, including encoded variants, return 404; authorized reads continue through
`/api/files/[name]`. Then create:

```bash
# Set INITIAL_SHA to the verified 40-character bootstrap commit, not a secret.
[[ "$INITIAL_SHA" =~ ^[0-9a-f]{40}$ ]]
sudo -u deploy ln -s "/home/app/releases/$INITIAL_SHA" /home/app/releases/current
sudo ln -s /home/app/releases/current /home/app/web
```

Create `/etc/systemd/system/devfathom-develop.service`:

```ini
[Unit]
Description=DevFathom develop workspace
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=app
Group=app
WorkingDirectory=/home/app/web
EnvironmentFile=/etc/devfathom/develop-runtime.env
ExecStart=/usr/bin/node scripts/start-standalone.mjs
UMask=0007
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

Activation explicitly assigns the prepared release tree to group app (`chgrp -hR -P app`), adds
group read/traverse access (`chmod -R g+rX`), and sets the release root to 2750 despite mktemp
initially using 0700. All extracted and installed files remain owned by deploy, not root. Permission
preparation happens before adding the persistent uploads links; nested symlink targets are not
traversed. The standalone `.next/cache` directory is app-group writable with mode 2770; its existing
contents also receive group-write access for image/runtime caches. The service runs only as app.
The app needs read access to releases and write access to cache and shared uploads. The 0007 service
umask
and setgid uploads directory preserve app-group write access for newly created uploads. Deploy must
not own shared uploads exclusively; group app is the persistence contract across release switches.

Permit exactly this command in `/etc/sudoers.d/devfathom-develop` (root-owned mode 0440), validating
with `visudo -cf` before use:

```sudoers
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart devfathom-develop.service
```

As administrator, run `systemctl daemon-reload`, enable/start only devfathom-develop.service, and
verify localhost:3001 before enabling CI. Configure the develop hostname's reverse proxy to port
3001; leave every other unit, port and environment untouched. A rollback restart failure is an
operator incident, reported in SSM output.

## AWS trust and least-privilege policies

Register GitHub's `https://token.actions.githubusercontent.com` OIDC provider with audience
`sts.amazonaws.com`. Replace ACCOUNT, OWNER, REPO, REGION, INSTANCE and BUCKET below. The role trust
must use exact environment subject and audience, not a repository wildcard:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Federated": "arn:aws:iam::ACCOUNT:oidc-provider/token.actions.githubusercontent.com"},
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {"StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:OWNER/REPO:environment:develop"
    }}
  }]
}
```

Attach this permissions policy to the GitHub role. GetCommandInvocation does not support resource
scoping, so its read-only wildcard is separate from the narrowly scoped SendCommand statement.
The runner does not need S3 GetObject, ListBucket, SSH, IAM mutation or other-instance permissions.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::BUCKET/develop/*"},
    {"Effect": "Allow", "Action": "ssm:SendCommand", "Resource": [
      "arn:aws:ec2:REGION:ACCOUNT:instance/INSTANCE",
      "arn:aws:ssm:REGION::document/AWS-RunShellScript"
    ]},
    {"Effect": "Allow", "Action": "ssm:GetCommandInvocation", "Resource": "*"}
  ]
}
```

The instance profile needs the SSM managed-instance core permissions plus only
`s3:GetObject` on `arn:aws:s3:::BUCKET/develop/*` for artifact access; do not grant it bucket writes.
Block all public bucket access, require TLS, enable encryption and bucket versioning, and configure
an artifact lifecycle appropriate to rollback/audit retention. Use default S3 encryption (SSE-S3),
or add narrowly scoped KMS encrypt/decrypt permissions if choosing a customer-managed key.
This deployment does not contact a host through SSH.

## Local regression checks

With a local-only DATABASE_URL set without printing it:

```bash
bunx vitest run tests/deploy-develop.test.ts tests/start-standalone.test.ts tests/production-deployment-contract.test.ts tests/proxy.test.ts src/lib/storage.test.ts 'src/app/api/files/[name]/route.test.ts' 'src/app/api/files/[name]/route.storage-unavailable.test.ts'
# Optional per-stage timings for the real Prisma generation/catalog bundle check:
DEPLOY_TEST_PROFILE=1 bunx vitest run tests/deploy-develop.test.ts
shellcheck scripts/deploy/*.sh
actionlint .github/workflows/deploy-develop.yml .github/workflows/qa.yml
scripts/deploy/package-develop.sh . /tmp/develop-dry-run.tar.gz
```

The last command needs an existing local standalone build. The packaging regression also performs
a complete fixture-based dry run, including nested dependencies, secret exclusion and staged assets.
Activation tests mock AWS, systemctl and health probes; they never contact a server. They verify
exact SHA promotion, current-SHA retry without replacement (healthy and unhealthy), inactive-SHA
replacement and rollback, stale-link recovery, real group/mode changes, writable cache and no
permission changes through uploads symlinks. Tests map the fixed app group to an available local
supplementary group so no system account changes are required.
