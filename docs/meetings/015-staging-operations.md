# 015 — Staging operations

Applies to the meetings staging VM once it exists. It does not exist yet.

Throughout: `RG=rg-devfathom-staging-uaenorth`, `VM=df-mtg-stg-<suffix>-vm`,
`VAULT=df-mtg-stg-<suffix>-kv`. Every command goes through Azure Run Command;
port 22 is closed. See "Administrative access" in
[011-azure-infrastructure.md](011-azure-infrastructure.md).

## Maintenance window

**Sundays 02:00–04:00 Gulf Standard Time (UTC+4).**

Chosen because staging serves UAE and Pakistan working hours, and 02:00 GST is
also 01:00 PKT — outside both. Everything disruptive goes here: image bumps,
secret rotation, SKU changes, kernel patching reboots.

Azure automatic guest patching is enabled (`patchMode: AutomaticByPlatform`), so
routine OS patches install without our involvement. Patches requiring a reboot
wait for the window.

Announce anything that will end live meetings at least 24 hours ahead. Staging
has real users during demos, and "it's only staging" is how a demo gets ruined.

## Drain-aware deallocation

**Never deallocate on a timer.** A blind auto-shutdown schedule will eventually
fire at 02:00 on a night someone is running a cross-timezone demo, and it will
kill every room on the node with no warning and no recovery — LiveKit holds room
state in memory, so a deallocated SFU does not resume anything, it starts empty.

Deallocation is therefore always: **check, then act**.

### The drain check

```bash
#!/usr/bin/env bash
# Refuses to deallocate while LiveKit reports an active room.
set -euo pipefail
RG=rg-devfathom-staging-uaenorth
VM=df-mtg-stg-<suffix>-vm

rooms=$(az vm run-command invoke \
  --resource-group "$RG" --name "$VM" \
  --command-id RunShellScript \
  --scripts 'docker exec $(docker compose -f /opt/livekit/docker-compose.yml ps -q livekit) \
             /livekit-server list-nodes >/dev/null 2>&1; \
             curl -sS --unix-socket /dev/null http://localhost:7880/ >/dev/null 2>&1; \
             docker logs --since 5m $(docker compose -f /opt/livekit/docker-compose.yml ps -q livekit) \
             | grep -c "room started\|participant joined" || true' \
  --query "value[0].message" -o tsv | tail -1)

if [[ "$rooms" != "0" ]]; then
  echo "REFUSING to deallocate: LiveKit shows recent room activity ($rooms events in 5m)"
  exit 1
fi

echo "Drained. Deallocating."
az vm deallocate --resource-group "$RG" --name "$VM" --no-wait
```

The authoritative check is LiveKit's own room list via the server API, which
requires a signed admin token. Where an operator has one:

```bash
# Preferred: ask LiveKit directly. Empty list == safe to deallocate.
lk room list --url wss://meet-staging.devfathom.com \
             --api-key "$LIVEKIT_API_KEY" --api-secret "$LIVEKIT_API_SECRET"
```

Either way the rule is the same and it is not negotiable: **if the room list is
not empty, do not deallocate.** Retry at the next check interval. A staging VM
that stays up an extra hour costs $0.235; a killed demo costs more than that.

### Reallocation

```bash
az vm start --resource-group "$RG" --name "$VM"
```

`cloud-init` has already run, so start does not re-provision. The `livekit`
systemd unit runs `fetch-keys.sh` then `docker compose up -d --wait` on every
boot, so the stack comes back with current secrets and no manual step. The public
IP is static and does not change across deallocate/start. Caddy reloads its ACME
state from `/opt/livekit/caddy_data` and does not re-issue.

Verify after start:

```bash
curl -fsS https://meet-staging.devfathom.com/    # expect: OK
```

## Recovery

### Stack down, VM up

```bash
az vm run-command invoke --resource-group "$RG" --name "$VM" \
  --command-id RunShellScript \
  --scripts "systemctl status livekit --no-pager; \
             docker compose -f /opt/livekit/docker-compose.yml ps; \
             docker compose -f /opt/livekit/docker-compose.yml logs --tail 100"
```

Then, in order of increasing disruption:

```bash
# 1. Restart the stack (re-fetches secrets via ExecStartPre)
az vm run-command invoke --resource-group "$RG" --name "$VM" \
  --command-id RunShellScript --scripts "systemctl restart livekit"

# 2. Reboot the VM
az vm restart --resource-group "$RG" --name "$VM"
```

Common causes, in the order they actually occur:

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `livekit.service` failed at `ExecStartPre` | Key Vault unreachable, or a secret missing/renamed | Confirm both secrets exist; confirm the role assignment survived |
| Caddy restart loop, ACME errors in logs | DNS wrong or port 80 closed | [012-dns-and-tls.md](012-dns-and-tls.md) |
| Clients connect but no media | UDP mux range not open, or `use_external_ip` resolving wrongly | Compare NSG rules to `udpMuxRange` output |
| `OK` on `/` but joins rejected | Application and SFU disagree on the key pair | [013-secrets-and-rotation.md](013-secrets-and-rotation.md) |

### VM unrecoverable

Redeploy the template. It is idempotent, and the parts that carry state are
outside the VM:

```bash
export DEVFATHOM_MEETINGS_SSH_PUBLIC_KEY="$(cat ~/.ssh/devfathom-meetings.pub)"
az deployment group create --resource-group "$RG" \
  --parameters infra/meetings.staging.bicepparam --name meetings
```

Key Vault survives (soft delete plus purge protection). The public IP survives.
DNS is unchanged. What is lost is `/opt/livekit/caddy_data`, so Caddy re-issues
certificates on first boot — hence the backup below.

## Configuration backup

Only two things on that VM are not reproducible from this repository:

1. **`/opt/livekit/caddy_data`** — the ACME account key and issued certificates.
   Losing it forces re-issuance, and re-issuance is rate limited by Let's Encrypt.
2. **The Key Vault secret values** — which are backed up by Key Vault itself.

Everything else (`livekit.yaml`, `caddy.yaml`, `docker-compose.yml`,
`fetch-keys.sh`, the systemd unit) is generated by `cloud-init` from
`infra/meetings.bicep` and needs no backup. That is the point of putting it there.

Monthly, and before any image bump:

```bash
az vm run-command invoke --resource-group "$RG" --name "$VM" \
  --command-id RunShellScript \
  --scripts "tar czf - -C /opt/livekit caddy_data | base64 -w0" \
  --query "value[0].message" -o tsv > caddy_data.b64

# Store alongside other operational backups. It contains a private ACME account
# key — treat it as a secret, not as a config file.
```

Do not commit it. Do not attach it to a ticket.

## Certificate renewal

Automatic, by Caddy, at roughly one third of remaining lifetime. There is no cron
job and none should be added.

Renewal fails only if port 80 closes or DNS changes. Check quarterly:

```bash
openssl s_client -connect meet-staging.devfathom.com:443 \
  -servername meet-staging.devfathom.com </dev/null 2>/dev/null \
  | openssl x509 -noout -dates
```

`notAfter` more than 30 days out means renewal is working. Inside 30 days with no
renewal means investigate now, not at expiry.

## Secret rotation

Every 90 days, in the window, per
[013-secrets-and-rotation.md](013-secrets-and-rotation.md). Rotation restarts
LiveKit and ends every live meeting, so the drain check applies to rotation
exactly as it applies to deallocation.

## Scale-out threshold, and its hard limit

Consider a second SFU node when, over a sustained week:

- p95 CPU exceeds 60%, **or**
- memory exceeds 70%, **or**
- any server-overload disconnect or server-induced packet dropping appears in
  LiveKit's metrics

### What scaling out actually buys — read this before planning for it

**Adding SFU nodes distributes rooms, not participants.** LiveKit assigns a room
to a node; every participant in that room connects to that node. Two nodes do not
halve the load of one large meeting — they let two meetings run on separate
machines.

Two consequences that shape capacity planning:

1. **A single large room must always fit on one node.** There is no configuration
   in which a 200-person room is spread across two servers. The largest room the
   product will ever support sets the minimum size of a single VM, permanently.
   If the product needs 200-person rooms, that is a vertical-scaling problem, and
   no amount of horizontal scaling touches it.

2. **Losing a node kills every room on it.** Room state is in memory. A node
   failure does not fail over — participants are disconnected and must rejoin,
   landing on a surviving node in a fresh room. More nodes means more rooms
   survive any single failure; it does not mean any individual room survives.

So: scale **up** for bigger meetings, **out** for more simultaneous meetings.
They are different problems with different triggers and they must be measured
separately — as
[011-azure-infrastructure.md](011-azure-infrastructure.md) says of the load test,
one large room and many small rooms are different workloads.

Multi-node LiveKit also requires Redis for node coordination, which the current
design deliberately omits. Adding a second node is therefore not "deploy the
template twice" — it is a design change: Redis, a node-aware router, and a
revisited cost model. Do not plan it as an incremental step.

## Routine checks

| Cadence | Check | Command |
| --- | --- | --- |
| Continuous | VM availability alert | automatic, emails `alertEmail` |
| Daily | Health endpoint | `curl -fsS https://meet-staging.devfathom.com/` |
| Weekly | CPU/memory trend against thresholds | Azure Monitor metrics |
| Monthly | `caddy_data` backup | above |
| Monthly | Cost against [014-cost-model.md](014-cost-model.md) | tag-filtered cost query |
| Quarterly | Certificate expiry | above |
| Quarterly | Image version vs current Ubuntu/LiveKit releases | window job |
| 90 days | Secret rotation | [013](013-secrets-and-rotation.md) |
