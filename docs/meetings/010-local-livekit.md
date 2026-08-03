# 010 — Local LiveKit for development

Runs LiveKit OSS on your machine at `ws://localhost:7880`. No TURN, no TLS, no
Azure, no shared credentials.

## What it is not

- It is not staging. Staging is `infra/meetings.bicep`, is not provisioned, and
  needs approval first.
- It does not read the application `.env` or `.env.local`, and you must not copy
  either into `docker/livekit/`. The stack mints its own credentials.
- It shares no key material with any deployed environment.

## Bring it up

```
docker compose -f docker/livekit/docker-compose.yml up -d
```

On the first run a `keygen` service generates an API key pair with
`livekit-server generate-keys` and writes it to
`docker/livekit/livekit.dev.keys.yaml` with mode `0600`. That path is gitignored.
Later runs reuse the existing file, so restarts keep the same local key and only
`rm` regenerates it.

Observed first run:

```
 Container devfathom-livekit-dev-keygen-1  Started
 Container devfathom-livekit-dev-keygen-1  Waiting
 Container devfathom-livekit-dev-keygen-1  Exited
 Container devfathom-livekit-dev-livekit-1  Started

keygen-1  | livekit: generated new development credentials in docker/livekit/livekit.dev.keys.yaml
livekit-1 | INFO  livekit  routing/interfaces.go:181  using single-node routing
livekit-1 | INFO  livekit  service/server.go:292  starting LiveKit server
            {"portHttp": 7880, "version": "1.13.5", "rtc.portTCP": 7881,
             "rtc.portUDP": {"Start":7882,"End":0}}
```

There is no npm script for this and there will not be one. `package.json` is
owned by another workstream; the Compose command above is the interface.

## Verify

```
curl -fsS http://localhost:7880/
```

```
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8

OK
```

`GET /` is LiveKit's health endpoint and needs no token. `GET /rtc/validate`
returning `401` without a token is also correct behaviour, not a fault.

To read the local key pair when wiring an application client:

```
cat docker/livekit/livekit.dev.keys.yaml
```

Format is a single `APIkey: secret` line. Never paste it into a commit, an issue,
a chat message, or a `.env.example`.

## Tear down

```
docker compose -f docker/livekit/docker-compose.yml down
```

`down` leaves `livekit.dev.keys.yaml` in place. To start from a clean key pair:

```
docker compose -f docker/livekit/docker-compose.yml down
rm docker/livekit/livekit.dev.keys.yaml
```

## Ports

| Port | Protocol | Purpose |
| --- | --- | --- |
| 7880 | TCP | HTTP and WebSocket signalling |
| 7881 | TCP | ICE/TCP fallback |
| 7882 | UDP | ICE/UDP mux |

These come from `docker run --rm livekit/generate --local`, which emits exactly
`7880`, `tcp_port: 7881`, `udp_port: {Start: 7882}` and `use_external_ip: false`.
Staging widens the UDP mux to a range — see
[011-azure-infrastructure.md](011-azure-infrastructure.md).

## Image pinning

Both services run:

```
livekit/livekit-server:v1.13.5@sha256:3497163e15c48fef6e7830c78716f9e9d5edc28abf7aa90b61c86e93bbc306b1
```

The digest is what Docker enforces; the tag is there so a human can read the
version. `latest` is not used anywhere, in either the local stack or the VM's
cloud-init, because a media server that silently changes version between two
developers' machines produces bug reports nobody can reproduce.

To bump: pull the new tag, read the new index digest with
`docker buildx imagetools inspect livekit/livekit-server:<tag>`, and change both
`docker/livekit/docker-compose.yml` and the `livekitImage` parameter in
`infra/meetings.bicep` in the same commit.

## Known warning

```
WARN  rtcconfig/rtc_unix.go:31  UDP receive buffer is too small for a production
      set-up  {"current": 425984, "suggested": 5000000}
```

Expected on a laptop and harmless for local work. The staging VM raises
`net.core.rmem_max`; a development machine carrying one browser tab does not need
it.
