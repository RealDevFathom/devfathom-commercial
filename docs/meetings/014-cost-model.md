# 014 — Cost model

**This is a model, not a promise.** Every number below is an arithmetic
consequence of stated assumptions. Real bills depend on what participants
actually do — cameras on or off, screens shared, networks that force TURN relay,
packets that need retransmitting — and none of that is knowable before the load
test. Treat this as the shape of the cost, and the thing to check the first real
invoice against.

**Self-hosting can cost more than a hosted tier at low utilisation.** The idle
floor below is paid whether or not a single meeting happens. A hosted SFU with
per-minute pricing charges nothing on a quiet month. The crossover is real and it
is stated at the end of this document.

This document is the gate for provisioning. Nothing is provisioned until it has
been reviewed.

## Parameters

Everything downstream is a function of these. Change one, recompute.

| Symbol | Meaning | Default |
| --- | --- | --- |
| `P` | Participants in a room | 10 / 25 / 50 |
| `B_speaker` | Active-speaker video bitrate | 1.0 Mbps |
| `B_thumb` | Thumbnail video bitrate | 0.1 Mbps |
| `T` | Visible tiles per client (1 speaker + thumbnails) | 9 |
| `H` | Meeting-hours per month | 50 / 100 / 200 |
| `R` | Azure source region | UAE North / West Europe / East US |
| `Routing` | Public IP routing preference | Microsoft Premium (default) |

`T = 9` is the selective-subscription policy: each client subscribes to the
active speaker at full rate plus up to eight thumbnails, regardless of room size.
This is the single most important number in the model. Without it, egress grows
with `P²`; with it, per-recipient egress is constant above ten participants and
total egress grows linearly with `P`.

## Formulas

Per recipient:

```
B_recipient(P) = B_speaker + B_thumb × min(T − 1, P − 2)
```

Room egress rate (the SFU sends one stream set to each of `P` clients):

```
B_room(P) = P × B_recipient(P)
```

Volume, with 1 GB = 10⁹ bytes as Azure bills it:

```
GB_per_hour(P) = B_room(P) × 3600 / 8 / 1000
GB_per_month(P, H) = GB_per_hour(P) × H
```

Client-to-SFU traffic is **ingress** and Azure does not charge for it. Only the
SFU-to-client direction is billed.

### Resulting rates

| `P` | Mbps per recipient | Room Mbps | GB/hour |
| --- | --- | --- | --- |
| 10 | 1.8 | 18.0 | 8.10 |
| 25 | 1.8 | 45.0 | 20.25 |
| 50 | 1.8 | 90.0 | 40.50 |

Per-recipient bitrate is identical at 10, 25 and 50 because the tile cap binds at
`P ≥ 10`. That flatness is the policy working.

## Egress pricing: free allowance and tiers, not a flat rate

Azure bandwidth is tiered with a monthly free allowance. Rates below are the
retail prices for **Microsoft Premium routing** (the default when no
`RoutingPreference` IP tag is set — which is what `infra/meetings.bicep` does),
retrieved from the Azure Retail Prices API on 2026-08-03, USD.

| Monthly egress tier | UAE North $/GB | West Europe $/GB | East US $/GB |
| --- | --- | --- | --- |
| First 100 GB | **0.00** | **0.00** | **0.00** |
| 100 GB – 10 TB | 0.181 | 0.087 | 0.087 |
| 10 – 50 TB | 0.175 | 0.083 | 0.083 |
| 50 – 150 TB | 0.170 | 0.070 | 0.070 |
| 150 – 500 TB | 0.160 | 0.050 | 0.050 |
| Over 500 TB | 0.160 | 0.050 | 0.050 |

**UAE North egress costs roughly 2.1× West Europe or East US at our volumes.**
That is the largest single cost lever in this document and it is a property of
the region, not of anything we build.

The free 100 GB is per subscription per month and is shared with the application.
The tables below apply it in full to meetings, which is optimistic; if the
application is already consuming it, add `100 × tier_1_rate` to each figure.

## Monthly egress cost

Video only, tile-capped, one active speaker.

### 50 meeting-hours/month

| `P` | GB/month | UAE North | West Europe | East US |
| --- | --- | --- | --- | --- |
| 10 | 405 | $55.20 | $26.53 | $26.53 |
| 25 | 1,012 | $165.16 | $79.39 | $79.39 |
| 50 | 2,025 | $348.43 | $167.47 | $167.47 |

### 100 meeting-hours/month

| `P` | GB/month | UAE North | West Europe | East US |
| --- | --- | --- | --- | --- |
| 10 | 810 | $128.51 | $61.77 | $61.77 |
| 25 | 2,025 | $348.43 | $167.47 | $167.47 |
| 50 | 4,050 | $714.95 | $343.65 | $343.65 |

### 200 meeting-hours/month

| `P` | GB/month | UAE North | West Europe | East US |
| --- | --- | --- | --- | --- |
| 10 | 1,620 | $275.12 | $132.24 | $132.24 |
| 25 | 4,050 | $714.95 | $343.65 | $343.65 |
| 50 | 8,100 | $1,448.00 | $696.00 | $696.00 |

Read these as "a room of `P` people running for `H` hours a month", not as total
platform usage. For a mixed workload, compute `GB_per_hour` for each room size,
multiply by that size's hours, sum, then apply the tiers **once** to the total —
tiers are cumulative across the subscription, so summing per-room costs
overcharges.

## Overheads stated separately, not folded in

The headline is video egress for one active speaker with capped thumbnails.
Everything below is real, additive, and **must be measured rather than
guessed**. Folding an estimate of these into the headline would produce a number
that looks precise and is not.

| Overhead | Expected shape | Why it is not in the headline |
| --- | --- | --- |
| **Audio** | ~32–40 kbps per subscribed publisher; every participant is audible, so this scales with `P` per recipient rather than being tile-capped | Roughly 2–4% of video at `P = 10`, but it is the one component that does grow with `P²`. At `P = 50` with all mics live it is no longer negligible. Measure it. |
| **Screen sharing** | A second video track, typically 1.5–2.5 Mbps, sent to every recipient while active | Can exceed the entire camera budget on its own. Duration-driven and completely usage-dependent. |
| **Retransmissions (NACK/RTX)** | A percentage uplift on all video, driven by loss rate | Typically low single digits on good networks, materially higher on mobile. It is a multiplier on the headline, not an addition to it. |
| **TURN relay** | Relayed media traverses the VM **twice** — in and out — so a relayed participant's egress is charged once for the relay leg on top of the normal send | Fraction of participants needing TURN is a property of their networks, not ours. Restrictive corporate NATs push it up. |
| **Simulcast layers** | Publishers send multiple qualities upstream | Ingress. Not billed. Noted so nobody adds it. |
| **Log Analytics** | Capped at 0.5 GB/day ingest at $3.29/GB | Worst case $49/month; realistic syslog volume for one VM is nearer $10/month. |

The load test in [011-azure-infrastructure.md](011-azure-infrastructure.md) is
where these stop being adjectives and become numbers. Until then, planning should
carry a stated contingency on top of the tables above rather than a revised
headline.

## Idle cost — paid regardless of usage

This is the floor. It does not depend on `P`, `H`, or whether anyone joins.

| Component | Rate | $/month (730 h) |
| --- | --- | --- |
| VM `Standard_D4s_v5` (deployed default) | $0.235/h | $171.55 |
| Standard static public IPv4 | $0.005/h | $3.65 |
| OS disk, 64 GB Premium SSD (P6) | — | $11.14 |
| **Idle total** | | **$186.34** |

Alternatives for the VM line:

| SKU | $/month | Idle total |
| --- | --- | --- |
| Standard_F4s_v2 (recommended, unavailable in UAE North) | $154.03 | $168.82 |
| **Standard_D4s_v5 (deployed)** | **$171.55** | **$186.34** |
| Standard_F4as_v6 (available, compute-optimised) | $246.01 | $260.80 |
| Standard_D8s_v5 | $343.83 | $358.62 |

Deallocating the VM outside working hours removes the VM line but **not** the
public IP or the disk — those bill while allocated regardless of VM power state.
A drain-aware deallocation schedule is in
[015-staging-operations.md](015-staging-operations.md); it must never be a blind
timer.

Key Vault, Log Analytics ingestion, the action group and the metric alert are
small but nonzero. Budget $10–15/month for them combined at staging volumes,
$49/month if the Log Analytics daily cap is ever actually reached.

## Total, staging, illustrative

`P = 25`, `H = 100`, UAE North, `Standard_D4s_v5`, video only:

```
idle                              $186.34
egress (2,025 GB, tiered)         $348.43
observability (estimate)           $12.00
                                  --------
                                  $546.77   before audio, screen share,
                                            retransmissions and TURN relay
```

## When self-hosting loses

The idle floor is $186/month at zero usage. A hosted SFU billed per
participant-minute charges nothing in a month with no meetings.

At `P = 25`, `H = 100` — 2,500 participant-hours, or 150,000 participant-minutes
— the modelled self-hosted total is $546.77, about $0.0036 per participant-minute.
Published hosted per-participant-minute rates in the same ballpark make the two
roughly comparable at this volume, with self-hosting winning as volume rises and
losing as it falls, because our cost is dominated by a fixed floor and theirs is
not.

Concretely:

- **Below roughly 50 meeting-hours/month of 25-person rooms**, the fixed floor
  dominates and a hosted tier is very likely cheaper.
- **Above that**, self-hosting improves, and improves faster in a cheaper egress
  region.
- **Moving the SFU to West Europe or East US halves the egress line** and changes
  nothing about the floor. At `P = 25, H = 100` that is $181/month saved — more
  than the VM costs. This is the finding that
  [016-region-benchmark.md](016-region-benchmark.md) has to weigh against
  latency for UAE and Pakistan users, and it is why that benchmark exists.

Neither of those is an argument against provisioning staging. Staging exists to
produce the measurements this model is currently guessing at.

## Reproducing these numbers

Prices move. Regenerate before any decision that relies on them.

```bash
# Egress tiers for a region, Microsoft Premium routing
python3 - <<'PY'
import urllib.request, urllib.parse, json
region = "uaenorth"
url = "https://prices.azure.com/api/retail/prices?" + urllib.parse.urlencode({
    "currencyCode": "USD",
    "$filter": f"serviceName eq 'Bandwidth' and armRegionName eq '{region}' "
               f"and meterName eq 'Standard Data Transfer Out'",
})
for i in json.load(urllib.request.urlopen(url))["Items"]:
    print(f"{i['tierMinimumUnits']:>9} GB  ${i['retailPrice']:<8} {i['productName']}")
PY

# VM list price for a SKU in a region (Linux row is the cheaper of the pair)
az vm list-skus --location uaenorth --resource-type virtualMachines \
  --query "[?name=='Standard_D4s_v5'].{name:name, restrictions:restrictions}" -o json
```

After provisioning, check the model against reality with a tag-filtered cost
query — this is what the `workload=meetings` tag on every resource is for:

```bash
az consumption usage list --start-date 2026-09-01 --end-date 2026-09-30 \
  --query "[?tags.workload=='meetings'].{name:instanceName, cost:pretaxCost, meter:meterDetails.meterName}" \
  -o table
```

A first invoice that lands within ±25% of this model means the assumptions hold.
Outside that, the assumption that broke is almost certainly the tile cap, the
TURN relay fraction, or screen-share duration — check those three first.
