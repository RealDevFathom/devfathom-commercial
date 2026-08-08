# 012 — DNS and TLS

DNS lives at GoDaddy and is **not** managed by this repository. Nothing in
`infra/meetings.bicep` creates, reads, or modifies a DNS record. The steps below
are performed by a human, once, after the VM exists and its public IP is known.

## Hostnames

| Host                         | Purpose                      | Environment        |
| ---------------------------- | ---------------------------- | ------------------ |
| `meet-staging.devfathom.com` | Signalling — `wss://`, HTTPS | staging            |
| `turn-staging.devfathom.com` | TURN/TLS SNI target          | staging            |
| `meet.devfathom.com`         | Signalling                   | production (later) |
| `turn.devfathom.com`         | TURN/TLS SNI target          | production (later) |

All four labels are already reserved in `src/lib/tenancy/host-routing.ts`
(`RESERVED_HOST_LABELS`), so no tenant can register a subdomain that collides
with meeting infrastructure. That reservation landed on `main` via PR #21
(commit `417ff97`) and is a prerequisite for this document, not a consequence
of it.

Two hostnames are required, not one. Caddy's layer4 app distinguishes signalling
from TURN/TLS **by SNI on the same port 443** — see the generated `caddy.yaml`
quoted in [011-azure-infrastructure.md](011-azure-infrastructure.md). One
hostname would leave the router with nothing to switch on.

## Manual GoDaddy steps

Perform after provisioning, once `az deployment group show` reports the public IP.

1. Read the allocated address:

   ```
   az network public-ip show \
     --resource-group rg-devfathom-staging-uaenorth \
     --name df-mtg-stg-<suffix>-pip \
     --query ipAddress -o tsv
   ```

   The IP is a Standard **static** SKU, so it survives deallocation and reboot.
   It changes only if the public IP resource itself is deleted.

2. In the GoDaddy DNS manager for `devfathom.com`, add two records:

   | Type | Name           | Value                | TTL |
   | ---- | -------------- | -------------------- | --- |
   | A    | `meet-staging` | _the IP from step 1_ | 600 |
   | A    | `turn-staging` | _the same IP_        | 600 |

   Both point at the same host. LiveKit and TURN are the same process on the
   same VM; the second name exists for SNI routing, not for a second machine.

   Use a 600-second TTL until the address is settled, then raise it. A short TTL
   costs nothing here and makes a mistake cheap to undo.

3. Do not add AAAA records. The template allocates IPv4 only
   (`publicIPAddressVersion: 'IPv4'`). An AAAA record pointing nowhere produces
   clients that hang on a dead address family before falling back.

4. Do not add a CNAME for either name. ACME HTTP-01 and TURN/TLS both want the
   apex-of-service to resolve directly to the host address.

5. Confirm propagation before starting the stack:

   ```
   dig +short meet-staging.devfathom.com
   dig +short turn-staging.devfathom.com
   ```

   Both must return the IP from step 1 and nothing else.

## TLS

Certificates are issued and renewed by Caddy, using Let's Encrypt over ACME
HTTP-01. No certificate is ever committed, uploaded, or manually installed.

- Issuance requires **port 80/TCP open to the internet** — that is the entire
  reason `acme-http` exists in the NSG. Closing 80 after first issuance breaks
  renewal 60 days later, quietly, at 3am.
- Both hostnames are in Caddy's `tls.certificates.automate` list, so both get
  certificates on first start.
- Caddy persists its ACME state — account key, certificates, renewal timers — in
  `/opt/livekit/caddy_data`, bind-mounted from the VM's OS disk. That directory
  is the thing to back up; losing it means re-issuance, and re-issuance is rate
  limited by Let's Encrypt.
- Renewal is automatic at roughly one third of remaining lifetime. There is no
  cron job to write and none should be written.

### Ordering constraint

DNS must resolve **before** the stack first starts. Caddy will attempt issuance
on boot; if `meet-staging.devfathom.com` does not yet resolve to the VM, the ACME
challenge fails and Caddy backs off with increasing delay. Repeated failures also
count against Let's Encrypt's failed-validation rate limit.

Correct order:

1. Provision (after approval).
2. Read the public IP.
3. Create both A records. Wait for `dig` to confirm.
4. Start the stack, or reboot the VM so `cloud-init`'s `systemd` unit starts it.

If the stack was started before DNS existed, fix DNS and then restart Caddy
rather than waiting out the backoff:

```
az vm run-command invoke \
  --resource-group rg-devfathom-staging-uaenorth \
  --name df-mtg-stg-<suffix>-vm \
  --command-id RunShellScript \
  --scripts "docker compose -f /opt/livekit/docker-compose.yml restart caddy"
```

## Verification after cutover

```
# Certificate present and for the right name
openssl s_client -connect meet-staging.devfathom.com:443 \
  -servername meet-staging.devfathom.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -dates

# TURN/TLS answers on the same port under a different SNI
openssl s_client -connect turn-staging.devfathom.com:443 \
  -servername turn-staging.devfathom.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -dates

# Signalling health through the proxy
curl -fsS https://meet-staging.devfathom.com/
```

The third command must return `OK`. The first two must return distinct subjects
matching their respective hostnames — if both return the same subject, SNI
routing is misconfigured and TURN/TLS is being served by the signalling route.

## Production

Identical procedure with `meet.devfathom.com` and `turn.devfathom.com`, against
whatever region the benchmark in [016-region-benchmark.md](016-region-benchmark.md)
selects. Do not create production records before that decision is made; an A
record pointing at a region we then abandon is a stale record someone will trust.
