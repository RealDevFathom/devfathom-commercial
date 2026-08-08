# 011 — Azure staging infrastructure for Meetings

Template: `infra/meetings.bicep`. Parameters: `infra/meetings.staging.bicepparam`.

**Nothing in this document has been provisioned.** The template builds, validates
and what-ifs cleanly against `rg-devfathom-staging-uaenorth`. Provisioning waits
on approval after [014-cost-model.md](014-cost-model.md) is reviewed.

## Shape

One Ubuntu 24.04 VM in UAE North running LiveKit OSS and its built-in TURN
server, behind a Standard static public IP, fronted by Caddy for TLS. LiveKit and
TURN are the same process on the same host in the same region, so media never
crosses a region boundary on our side of the wire.

Explicitly absent: Front Door, Application Gateway, AKS, Redis, Egress,
autoscaling, VNet peering. Each is a real product with a real bill, and none of
them make a single-node SFU work better. Redis in particular exists in LiveKit to
coordinate *multiple* nodes; with one node it is a second thing to keep alive for
no gain. LiveKit's own generator bundles Redis by default and we deliberately
diverge from that.

## Port layout, and where it comes from

The generator is the authority for what LiveKit needs open. Run captured
2026-08-03 with `livekit/generate` at
`sha256:6bbb3cdc829d4eabfb2bc63ce56fd3ed154e8a5428264e52362507c2f997d02a`:

```
Please ensure the following ports are accessible on the server
 * 443 - primary HTTPS and TURN/TLS
 * 80 - for TLS issuance
 * 7881 - for WebRTC over TCP
 * 3478/UDP - for TURN/UDP
 * 50000-60000/UDP - for WebRTC over UDP

Server URL: wss://meet-staging.devfathom.com
API Key: <redacted>
API Secret: <redacted>
```

The key pair that run printed was discarded. It never left a scratch directory
and is not the pair staging will use.

The generated `livekit.yaml` from the same run:

```yaml
port: 7880
bind_addresses:
    - ""
rtc:
    tcp_port: 7881
    port_range_start: 50000
    port_range_end: 60000
    use_external_ip: true
turn:
    enabled: true
    domain: turn-staging.devfathom.com
    tls_port: 5349
    udp_port: 3478
    external_tls: true
```

and the generated `caddy.yaml`, which is the reason 5349 stays private:

```yaml
  layer4:
    servers:
      main:
        listen: [":443"]
        routes:
          - match:
            - tls:
                sni:
                  - "turn-staging.devfathom.com"
            handle:
              - handler: tls
              - handler: proxy
                upstreams:
                  - dial: ["localhost:5349"]
          - match:
              - tls:
                  sni:
                    - "meet-staging.devfathom.com"
            handle:
              - handler: tls
                connection_policies:
                  - alpn: ["http/1.1"]
              - handler: proxy
                upstreams:
                  - dial: ["localhost:7880"]
```

Caddy's layer4 app owns `:443` and SNI-routes to `localhost:5349` for TURN/TLS
and `localhost:7880` for signalling. Both upstreams are loopback. The NSG
therefore ships:

| Rule | Port | Protocol | Why |
| --- | --- | --- | --- |
| `acme-http` | 80 | TCP | ACME HTTP-01 issuance and renewal |
| `https-and-turn-tls` | 443 | TCP | HTTPS/WSS and TURN/TLS via the generated SNI/L4 split |
| `ice-tcp-fallback` | 7881 | TCP | WebRTC over TCP for UDP-hostile networks |
| `ice-udp-mux` | 7882–7889 | UDP | ICE/UDP mux |
| `turn-udp` | 3478 | UDP | TURN/UDP relay |

And deliberately does **not** ship:

- **3478/TCP.** The generator does not list it. LiveKit's TURN listens on
  3478/UDP and 5349/TCP-TLS; nothing dials plaintext TURN over TCP. Opening it
  would be a port with no traffic and a nonzero attack surface.
- **5349/TCP.** TURN/TLS arrives on public 443 and is proxied to loopback. If
  5349 were also public, a client could reach TURN/TLS on a port with no
  certificate automation attached to it and no reason to exist.
- **22/TCP.** See "Administrative access".

### Why 7882–7889 instead of 50000–60000

The generator's default ICE range is 10,001 UDP ports. As an NSG rule that is
legal but as an operational surface it is absurd. LiveKit supports UDP mux, where
every peer connection shares a small set of sockets; LiveKit's guidance is a mux
range at least as wide as the host's vCPU count so the kernel can spread receive
work across cores.

`infra/meetings.bicep` derives the range from `vmSize` rather than hardcoding it:

```bicep
var vcpuBySize = { Standard_F4s_v2: 4, Standard_F8s_v2: 8, Standard_D4s_v5: 4, Standard_D8s_v5: 8 }
var udpMuxPortCount = vcpuBySize[vmSize] < 8 ? 8 : vcpuBySize[vmSize]
var udpMuxPortEnd = (udpMuxPortStart + udpMuxPortCount) - 1
```

The floor of 8 keeps the published range at 7882–7889 across both the four- and
eight-vCPU options, so resizing the VM does not change a client-visible port
list. If a future SKU with more than eight vCPUs is chosen, the range widens
automatically and the NSG rule follows.

Net effect: 10,001 ports become 8, and one NSG rule still covers every case.

## Network decision: a separate VNet, no peering

The application VNet is `df-stg-vnet` at `infra/environment.bicep:59`. It carries
two delegated subnets: `container-apps` (10.42.0.0/23) and `postgres`
(10.42.2.0/24). Postgres is deployed with `publicNetworkAccess: 'Disabled'` and a
private DNS zone. That network exists to keep the database unreachable from the
internet.

The SFU is the opposite kind of thing. It must accept UDP from arbitrary clients
on arbitrary networks, it terminates TLS for anonymous participants, and it runs
a TURN relay whose entire job is to forward traffic on behalf of strangers. It is
the most exposed component we will operate.

Meetings therefore gets its own VNet, `10.60.0.0/24`, with a single `sfu` subnet
at `10.60.0.0/26`, **not peered** to `df-stg-vnet`.

Reasons, in order of weight:

1. **Blast radius.** A compromised SFU on a peered network can reach the Postgres
   subnet at the IP layer. Unpeered, it cannot address it at all. The database is
   protected by the absence of a route, not by a rule someone might edit.
2. **No shared need.** The SFU stores nothing and queries nothing. Room state is
   in memory; token validation is a signature check against a key in Key Vault.
   There is no call path from the SFU to Postgres, so peering would buy zero
   function.
3. **Independent change.** `infra/environment.bicep` belongs to the application
   workstream. Keeping meetings in its own VNet in its own template means neither
   side can break the other's network by editing their own file.
4. **NSG legibility.** The `sfu` subnet's NSG is five inbound rules and every one
   of them is media. Mixed into the application VNet, those rules would sit
   beside Container Apps and Postgres rules and the reviewer's job gets harder
   for no benefit.

The application talks to LiveKit the way any client does — over `wss://` to the
public hostname, authenticated by a signed token. That is already an
internet-facing contract; giving it a private path as well would add a second
code path to secure with no gain.

The two sets of resources do share a resource group,
`rg-devfathom-staging-uaenorth`. That is a billing and lifecycle convenience, not
a network relationship, and `az deployment group what-if` confirms the meetings
deployment leaves all 14 existing application resources untouched.

## VM sizing: four SKUs compared

Current UAE North list prices, retrieved from the Azure Retail Prices API on
2026-08-03, Linux pay-as-you-go, 730 hours/month:

| SKU | vCPU | RAM | Family | $/hour | $/month | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Standard_F4s_v2 | 4 | 8 GB | Compute-optimised | 0.211 | 154.03 | Cheapest of the four. **Not orderable in UAE North** — see below |
| Standard_F8s_v2 | 8 | 16 GB | Compute-optimised | 0.422 | 308.06 | **Not orderable in UAE North** |
| Standard_D4s_v5 | 4 | 16 GB | General purpose | 0.235 | 171.55 | Available. +11% over F4s_v2 |
| Standard_D8s_v5 | 8 | 32 GB | General purpose | 0.471 | 343.83 | Available. 2× the four-vCPU cost |

### Recommendation

**On merit: `Standard_F4s_v2`.** LiveKit recommends compute-optimised instances
because SFU work is packet handling and encryption, not memory residency — an SFU
does not transcode, so 8 GB is ample and the extra RAM in the D-series is paid
for and unused. Four vCPUs rather than eight because the research report's
8-vCPU estimate predates our selective-subscription policy: with a nine-tile
cap, the server forwards a bounded number of streams per recipient instead of
every stream to everybody, and forwarding cost is what drives SFU CPU.

**Deployed value: `Standard_D4s_v5`.** The recommendation is not currently
orderable. `az deployment group validate` against this subscription returns:

```
{"code": "SkuNotAvailable", "message": "The requested VM size for resource
'Following SKUs have failed for Capacity Restrictions: Standard_F4s_v2' is
currently not available in location 'UAENorth'."}
```

`az vm list-skus --location uaenorth --resource-type virtualMachines` confirms
why: of the 1001 SKUs offered in UAE North, **no FSv2-family SKU appears at all**.
The compute-optimised families that *are* offered are the newer AMD ones —
`Fasv6`, `Fasv7`, `Falsv6/v7` — plus `FXmsv2`. `Standard_F8s_v2` is therefore
equally unavailable, not just constrained. This contradicts the brief's
assumption that all four are orderable in UAE North; it is a capacity fact rather
than a design choice, so it is recorded here rather than argued with.

The obvious substitute — stay compute-optimised, use an available F-family SKU —
is *more* expensive, not less:

| Available compute-optimised alternative | vCPU | $/hour | $/month |
| --- | --- | --- | --- |
| Standard_F4as_v6 | 4 | 0.337 | 246.01 |
| Standard_F4as_v7 | 4 | 0.337 | 246.01 |
| Standard_F8as_v6 | 8 | 0.674 | 492.02 |

`Standard_D4s_v5` at $171.55/month is the cheapest four-vCPU machine actually
orderable in UAE North — $74.46/month below the nearest available
compute-optimised part, and $17.52/month above the unavailable F4s_v2.
`infra/meetings.staging.bicepparam` therefore pins `Standard_D4s_v5`. `vmSize`
keeps all four brief SKUs in its `@allowed` list so flipping back is a one-line
change once a capacity request for FSv2 in UAE North is granted.

What we give up by not being on a compute-optimised part is clock speed per core
and a better cache-to-core ratio, not core count. That shows up as headroom, not
as function, and it is exactly what the 50-participant load test below measures.
If D4s_v5 fails that test where an F-part would have passed, `Standard_F4as_v6`
is the next thing to try before jumping to eight vCPUs — same core count,
compute-optimised, +$74/month, versus `Standard_D8s_v5` at +$172/month.

D4s_v5 also carries a zone restriction on this subscription — zones 1 and 2 are
`NotAvailableForSubscription`, only zone 3 is offered. The template allocates the
VM and its public IP regionally (no zone pinned), which is what validate and
what-if accept. If a zonal deployment is ever wanted, it must be zone 3.

### The measurement that moves staging to eight vCPUs

Accept four vCPUs only if a **sustained 50-participant single-room** load test,
run under the actual launch subscription policy, holds all of:

- p95 CPU below 60%
- memory below 70%
- zero server-overload disconnects
- zero server-induced packet dropping in LiveKit's own metrics
- NIC throughput with clear headroom over the measured peak

Any one of those failing moves staging to `Standard_D8s_v5` (or `Standard_F8s_v2`
if FSv2 becomes available). p95 CPU is the figure to watch first; it is the one
that degrades call quality before it shows up as an error.

Two cautions:

- **Concurrent smaller rooms are a different workload.** Ten five-person rooms
  and one fifty-person room put different pressure on the same box: different
  connection counts, different forwarding fan-out, different lock contention.
  Passing one says nothing about the other. Test both, separately, and record
  both.
- **The test must run under the real policy.** A load test with selective
  subscription disabled measures a server we are not shipping and will
  over-provision.

## Identity, secrets, and boot

The VM carries a user-assigned managed identity with **Key Vault Secrets User** on
a meetings-specific vault, `df-mtg-stg-<suffix>-kv`.

`LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` are **not** template parameters. They
are seeded once by an operator with `az keyvault secret set` and read at boot by
`/opt/livekit/fetch-keys.sh`, which exchanges an IMDS token for a Key Vault token
and writes `/opt/livekit/keys.yaml` at mode `0600`. `systemd` runs that script as
`ExecStartPre` on every boot, so a rotated secret is picked up by a restart with
no redeploy.

Consequences worth stating plainly:

- No secret value appears in this repository.
- No secret value appears in ARM deployment history, which is readable by anyone
  with reader access to the subscription and is the usual way `@secure()`
  parameters leak.
- No secret value is baked into a VM image or a container image.
- `cloud-init` customData contains the *instructions* to fetch a secret, never a
  secret. customData is readable from inside the VM and via the instance
  metadata service, so this distinction matters.

Rotation procedure: [013-secrets-and-rotation.md](013-secrets-and-rotation.md).

## Administrative access

**No NSG rule opens port 22.** The default administrative path is Azure Run
Command:

```
az vm run-command invoke \
  --resource-group rg-devfathom-staging-uaenorth \
  --name df-mtg-stg-<suffix>-vm \
  --command-id RunShellScript \
  --scripts "docker compose -f /opt/livekit/docker-compose.yml ps"
```

Run Command goes through the Azure control plane and the VM agent. It needs no
open port, it is logged in the activity log, and it is authorised by Azure RBAC
rather than by possession of a key file.

A public SSH key is still installed, and Serial Console is available, so a VM
whose agent is broken is not a VM that has to be rebuilt.

If interactive SSH is genuinely required, open it narrowly and close it
afterwards:

```
# open, for your current address only
MY_IP=$(curl -s https://ifconfig.me)
az network nsg rule create \
  --resource-group rg-devfathom-staging-uaenorth \
  --nsg-name df-mtg-stg-<suffix>-nsg \
  --name temp-ssh --priority 200 \
  --access Allow --protocol Tcp --direction Inbound \
  --source-address-prefixes "$MY_IP/32" \
  --destination-port-ranges 22

# ... do the work ...

# close, same session, not "later"
az network nsg rule delete \
  --resource-group rg-devfathom-staging-uaenorth \
  --nsg-name df-mtg-stg-<suffix>-nsg \
  --name temp-ssh
```

The rule is scoped to one address and removed in the same session that opened it.
A `temp-ssh` rule found in the NSG outside a maintenance window is an incident,
not a convenience.

## Observability

- **Log Analytics** workspace, 30-day retention, 0.5 GB/day ingestion cap. The
  cap is a spend ceiling, not a target.
- **Azure Monitor Linux Agent** plus a data collection rule shipping syslog
  (`daemon`, `syslog`, `user`, `auth`, `authpriv`) to that workspace. Docker logs
  to the journal, so LiveKit's output arrives without a second logging pipeline.
- **Boot diagnostics** enabled (managed, no storage account of our own).
- **VM availability alert**: `VmAvailabilityMetric < 1`, evaluated every minute
  over a five-minute window, severity 1, wired to an action group that emails
  `alertEmail`.

## Tags

Every resource carries `workload=meetings` and `env=staging`, applied from one
`var tags` object rather than repeated by hand. This is what makes the cost model
checkable after provisioning: a cost query filtered on `workload=meetings`
returns the meetings bill and nothing else.

## Verification performed

```
az bicep build --file infra/meetings.bicep      # exit 0, no warnings
az deployment group validate ...                # provisioningState: Succeeded
az deployment group what-if ...                 # 14 to create, 14 to ignore
```

`validate` and `what-if` are separate commands answering separate questions —
"would ARM accept this?" and "what would change?" — and both were run. Neither
deploys. Nothing was deployed.

Full outputs are in the pull request description.
