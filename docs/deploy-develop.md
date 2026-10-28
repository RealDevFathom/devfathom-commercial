# Develop continuous deployment

`.github/workflows/deploy-develop.yml` deploys a gated `develop` commit to
`https://develop.devfathom.com`. The workflow is triggered after the **QA gate**
workflow completes on `develop`; that workflow contains both the WHA-1125 automated gate and the
dependent WHA-1132 browser gate. Before deployment, the workflow queries the GitHub Actions API and
requires a successful QA gate run for the exact commit. A manual run is also allowed, but only when
dispatched from the `develop` branch and only after the same gate has succeeded.

The runner checks out that exact commit, installs with Bun 1.4.2, generates Prisma Client, and makes
the standalone Next build. It uploads an immutable release under `/home/app/releases`, applies
pending migrations with `/home/app/app.env`, atomically changes the release selected through
`/home/app/web`, and restarts `devfathom.service`. Both HTTP 200 and 307 are healthy. If the public Caddy endpoint does not become
healthy, the workflow checks Next directly on `127.0.0.1:3000`; if neither check succeeds, it restores
the prior application release and restarts the unit. Database migrations are forward-only and are
not reversed by an application rollback. The active and previous releases plus one additional recent
release are retained.

## GitHub environment and secrets

Create a protected GitHub environment named `develop`. Add these environment secrets (not repository
variables):

| Secret                    | Value                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `DEVELOP_SSH_HOST`        | SSH host name or IP address of the develop EC2 instance                                                       |
| `DEVELOP_SSH_USER`        | Unprivileged deployment account, normally `deploy`                                                            |
| `DEVELOP_SSH_KEY`         | Private key for that account, including its BEGIN/END lines                                                   |
| `DEVELOP_SSH_KNOWN_HOSTS` | Pinned `known_hosts` entry for the host (generate it out of band and verify its fingerprint before saving it) |

The workflow writes the key and host entry to mode-0600 files and never prints their contents. Do not
use an unverified `ssh-keyscan` result from the deployment job: pinning a previously verified host key
is what protects the connection from interception.

## One-time Ubuntu server setup

Run these steps as an administrator on the EC2 instance. Substitute the public key paired with
`DEVELOP_SSH_KEY` for the placeholder. The application account, Bun installation,
`/home/app/app.env`, Caddy configuration, local Postgres database, and `devfathom.service` are assumed
to exist already.

```bash
sudo apt-get update
sudo apt-get install --yes acl
sudo adduser --disabled-password --gecos '' deploy
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
sudo sh -c "printf '%s\n' 'ssh-ed25519 REPLACE_WITH_VERIFIED_DEPLOY_PUBLIC_KEY github-develop-deploy' > /home/deploy/.ssh/authorized_keys"
sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys
sudo chmod 600 /home/deploy/.ssh/authorized_keys

# The deploy account owns release storage. /home/app/web remains a stable,
# administrator-owned link; deploy atomically replaces releases/current.
sudo install -d -m 755 -o deploy -g app /home/app/releases
sudo setfacl -m u:deploy:r /home/app/app.env

# Convert the existing plain deployment into the initial rollback release.
sudo systemctl stop devfathom.service
sudo mv /home/app/web /home/app/releases/initial
sudo chown -R deploy:app /home/app/releases/initial
sudo -u deploy ln -s /home/app/releases/initial /home/app/releases/current
sudo ln -s /home/app/releases/current /home/app/web
sudo systemctl start devfathom.service

# Permit only the service restart needed by the workflow.
printf '%s\n' 'deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart devfathom.service' | sudo tee /etc/sudoers.d/devfathom-deploy
sudo chmod 440 /etc/sudoers.d/devfathom-deploy
sudo visudo -cf /etc/sudoers.d/devfathom-deploy
```

Keep `/home/app/app.env` compatible with both systemd `EnvironmentFile` syntax and POSIX shell
assignment syntax (one quoted `NAME=value` assignment per line, with no command substitutions). The
read-only ACL lets the deployment process export those values for Prisma without printing them. Do
not grant unrestricted `systemctl`, a shell, or general passwordless sudo. Finally, confirm that
`devfathom.service` retains this layout:

```ini
User=app
WorkingDirectory=/home/app/web
EnvironmentFile=/home/app/app.env
ExecStart=/home/app/.bun/bin/bun scripts/start-standalone.mjs
```

Caddy should continue proxying `develop.devfathom.com` to `127.0.0.1:3000`.
