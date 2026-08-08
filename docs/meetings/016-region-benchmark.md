# 016 — Region benchmark: UAE North vs West Europe

A repeatable procedure for deciding which region hosts **production** media.

## Status and scope

- **Nothing here has been run.** No environment was provisioned, no probe was
  executed against any host, no measurement was taken.
- This gates the **production-region decision only**. It does not gate this pull
  request, and it does not gate UAE North staging. Staging goes to UAE North
  because the team is there and the feedback loop is short.
- Execution belongs to the QA/cutover phase, **after** provisioning approval,
  from real target connections including Pakistan.
- Cowork reviews the evidence independently. The procedure is written to be
  runnable by someone who did not write it and produce numbers they can check.

## Why the question exists

[014-cost-model.md](014-cost-model.md) shows UAE North egress at $0.181/GB
against $0.087/GB for West Europe and East US — **roughly 2.1× at our volumes**.
At `P = 25, H = 100` that is $348/month versus $167/month, a difference larger
than the VM itself.

Against that, every millisecond of one-way latency is a millisecond of
conversational delay for a real-time medium. Geography favours UAE North for Gulf
users; the bill favours West Europe. Neither wins on assertion. The benchmark
decides it with numbers.

Pakistan matters specifically because routing from Karachi and Lahore to Dubai is
not obviously shorter in *time* than to Amsterdam or Frankfurt — regional transit
often traverses Europe regardless. If that is true here, the cost argument wins
uncontested. If it is not, it does not. This is exactly the kind of thing that
must be measured rather than reasoned about from a map.

## What gets measured

| Metric | Threshold | Why |
| --- | --- | --- |
| Median RTT | — | Baseline |
| p95 RTT | **< 150 ms** | Above this, turn-taking degrades noticeably |
| p99 RTT | **< 250 ms** | Tail latency is what users remember |
| Jitter (mean deviation) | **< 30 ms** | Drives jitter-buffer depth, which adds delay |
| UDP packet loss | **< 1%** | Above this, retransmission cost and quality both bite |
| TURN relay fraction | report | Directly multiplies egress cost — [014](014-cost-model.md) |
| Monthly egress cost at measured volume | report | The other half of the decision |

Origins to test, minimum: **Dubai/Abu Dhabi (UAE)**, **Karachi (PK)**,
**Lahore (PK)**. Add any origin with more than 10% of expected users.

## Decision rule, agreed before any data is collected

Fixing this in advance is the point. A rule invented after seeing the numbers is
a rationalisation.

1. If **both** regions meet every latency threshold from **every** origin →
   choose **West Europe**. Cost decides, because quality is already adequate and
   the saving is real.
2. If **only one** region meets the thresholds from every origin → choose that
   region. Quality decides.
3. If **neither** meets the thresholds from every origin → choose the region with
   the lower p95 from the **worst-performing origin**, and record the shortfall
   as a known limitation.
4. If the p95 difference between regions is **under 20 ms from every origin** →
   treat them as equivalent on latency and choose on cost.

Ties on latency go to cost. Ties on cost go to UAE North, for data-residency
simplicity.

## Procedure

Run each phase from **every** origin, on a wired connection where possible, and
repeat once on typical mobile — mobile is where TURN relay and loss show up.

### Phase 0 — prerequisites

Two LiveKit deployments, one per region, from the same
`infra/meetings.bicep` at the same commit, same SKU, same image digest.
Differences in the deployment invalidate the comparison.

```bash
# Neither of these has been run. Both require provisioning approval.
az deployment group create --resource-group rg-devfathom-bench-uaenorth \
  --parameters infra/meetings.staging.bicepparam \
  --parameters meetHost=bench-uae.devfathom.com turnHost=bench-uae-turn.devfathom.com

az deployment group create --resource-group rg-devfathom-bench-westeurope \
  --parameters infra/meetings.staging.bicepparam \
  --parameters meetHost=bench-eu.devfathom.com turnHost=bench-eu-turn.devfathom.com
```

Tear both down immediately after the benchmark. They are not environments; they
are instruments.

### Phase 1 — network path

```bash
#!/usr/bin/env bash
# 016-phase1-path.sh — network-layer baseline. Run from each origin.
set -euo pipefail
ORIGIN="${1:?usage: $0 <origin-label>}"
OUT="bench-${ORIGIN}-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"

for host in bench-uae.devfathom.com bench-eu.devfathom.com; do
  echo "== $host =="
  # 300 samples at 1/s — enough for a stable p95, short enough to sit through.
  ping -c 300 -i 1 "$host" | tee "$OUT/ping-$host.txt"
  # Path and where the time is spent. mtr is preferred; traceroute is the fallback.
  if command -v mtr >/dev/null; then
    mtr --report --report-cycles 100 --tcp --port 443 "$host" | tee "$OUT/mtr-$host.txt"
  else
    traceroute -T -p 443 "$host" | tee "$OUT/traceroute-$host.txt"
  fi
done
echo "results in $OUT"
```

Percentiles from the raw samples — `ping`'s own summary reports min/avg/max, not
p95:

```bash
#!/usr/bin/env bash
# 016-percentiles.sh — p50/p95/p99 and jitter from a ping log.
set -euo pipefail
grep -oE 'time=[0-9.]+' "${1:?usage: $0 <ping-log>}" | cut -d= -f2 | python3 -c '
import sys, statistics
v = sorted(float(x) for x in sys.stdin)
if not v: sys.exit("no samples")
def pct(p): return v[min(len(v)-1, int(round(p/100*len(v)))-1)]
jitter = statistics.mean(abs(b-a) for a, b in zip(v, v[1:])) if len(v) > 1 else 0.0
print(f"n={len(v)} p50={pct(50):.1f}ms p95={pct(95):.1f}ms p99={pct(99):.1f}ms "
      f"jitter={jitter:.1f}ms min={v[0]:.1f} max={v[-1]:.1f}")
'
```

Packet loss is on `ping`'s summary line. Record it verbatim; do not round it.

### Phase 2 — WebRTC path

Network-layer RTT is a lower bound, not the user experience. Measure the actual
media path.

```bash
#!/usr/bin/env bash
# 016-phase2-webrtc.sh — media-layer measurement via livekit-cli.
# Requires: lk (livekit-cli), and API credentials for the benchmark deployment.
set -euo pipefail
ORIGIN="${1:?usage: $0 <origin-label>}"

for r in uae eu; do
  url="wss://bench-${r}.devfathom.com"
  echo "== $r =="
  # load-test reports publisher/subscriber RTT, jitter and loss as seen by WebRTC.
  lk load-test \
    --url "$url" \
    --api-key "$LIVEKIT_BENCH_API_KEY" \
    --api-secret "$LIVEKIT_BENCH_API_SECRET" \
    --room "bench-${ORIGIN}-${r}" \
    --publishers 1 --subscribers 4 --duration 120s \
    | tee "webrtc-${ORIGIN}-${r}.txt"
done
```

From the same run, record from `chrome://webrtc-internals` or the browser stats
API:

- `candidate-pair.currentRoundTripTime` — p50/p95/p99 over the session
- `inbound-rtp.jitter`
- `inbound-rtp.packetsLost / packetsReceived`
- **Selected ICE candidate type** — `host`/`srflx` means direct, `relay` means
  TURN. The fraction of sessions landing on `relay` is the TURN relay fraction
  that [014-cost-model.md](014-cost-model.md) leaves as a measured unknown.

Repeat five sessions per origin per region. One session measures one moment.

### Phase 3 — cost at measured volume

```bash
#!/usr/bin/env bash
# 016-phase3-cost.sh — egress cost for both regions at an observed monthly volume.
python3 - "${1:?usage: $0 <monthly-GB>}" <<'PY'
import sys
gb = float(sys.argv[1])
TIERS = {  # Microsoft Premium routing, retrieved 2026-08-03
  "uaenorth":   [(0,0.0),(100,0.181),(10240,0.175),(51200,0.17),(153600,0.16),(512000,0.16)],
  "westeurope": [(0,0.0),(100,0.087),(10240,0.083),(51200,0.07),(153600,0.05),(512000,0.05)],
}
def cost(gb, region):
    t, total = TIERS[region], 0.0
    for i, (lo, price) in enumerate(t):
        hi = t[i+1][0] if i+1 < len(t) else float("inf")
        if gb > lo: total += (min(gb, hi) - lo) * price
    return total
u, e = cost(gb, "uaenorth"), cost(gb, "westeurope")
print(f"{gb:,.0f} GB/month")
print(f"  UAE North   ${u:,.2f}")
print(f"  West Europe ${e:,.2f}")
print(f"  saving      ${u-e:,.2f}/month  ({(u-e)/u*100 if u else 0:.0f}%)")
PY
```

Re-fetch the tiers before running this; the constants above are a snapshot, and
[014-cost-model.md](014-cost-model.md) carries the query that refreshes them.

## Reporting

One markdown table per origin, raw logs attached. Report every number measured,
including runs that went badly — a discarded outlier is a decision someone else
should get to check.

```
### Origin: Karachi, PK — 2026-XX-XX, wired

| Metric | UAE North | West Europe | Threshold | Pass |
| --- | --- | --- | --- | --- |
| p50 RTT (network) |  |  | — | — |
| p95 RTT (network) |  |  | < 150 ms |  |
| p99 RTT (network) |  |  | < 250 ms |  |
| p95 RTT (WebRTC)  |  |  | < 150 ms |  |
| Jitter            |  |  | < 30 ms  |  |
| Packet loss       |  |  | < 1%     |  |
| TURN relay fraction |  |  | report | — |
```

Then, once: the phase 3 cost comparison at the measured volume, the decision rule
applied step by step, and the resulting region.

## Repeatability requirements

- Same commit, same SKU, same image digest in both regions.
- Same time of day for both regions from a given origin — regional transit
  congestion is diurnal, and testing UAE at 03:00 against EU at 19:00 measures
  the clock, not the region.
- Minimum three origins, five WebRTC sessions each.
- Wired and mobile from at least one origin.
- Raw logs retained and attached, not just summaries.
- Both benchmark deployments torn down afterwards.

If any of those cannot be met, say so in the report rather than quietly
proceeding. A benchmark whose limitations are stated is usable; one whose
limitations are hidden is worse than none.
