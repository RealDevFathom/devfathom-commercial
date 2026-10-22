#!/bin/bash
# Codex Cloud task bootstrap: Bun 1.4.2 + native Postgres + DATABASE_URL. Idempotent.
set -x
cat /etc/codex/network-policy.json 2>&1 | head -40
env | grep -i proxy
curl -sS -m 10 -o /dev/null -w 'npmjs %{http_code}\n' https://registry.npmjs.org/ 2>&1
curl -sS -m 10 --noproxy '*' -o /dev/null -w 'npmjs-direct %{http_code}\n' https://registry.npmjs.org/ 2>&1
npm ping 2>&1 | tail -2
command -v bun >/dev/null && bun --version
if ! bun --version 2>/dev/null | grep -q '^1\.4'; then
  npm i -g bun@1.4.2 2>&1 | tail -2 || curl -fsSL https://bun.sh/install | bash -s bun-v1.4.2 2>&1 | tail -2
  export PATH=$HOME/.bun/bin:$PATH
fi
bun --version
if ! command -v pg_isready >/dev/null; then
  (sudo -n apt-get update -qq && sudo -n apt-get install -y -qq postgresql) 2>&1 | tail -2
fi
ls /usr/lib/postgresql 2>&1
PGBIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)
if [ -n "$PGBIN" ]; then export PATH=$PGBIN:$PATH; D=$HOME/pgdata
  [ -d $D ] || initdb -D $D -U postgres --auth=trust >/dev/null
  pg_ctl -D $D -l $HOME/pg.log -o "-k /tmp -c listen_addresses=localhost" start; sleep 2
  createdb -h localhost -U postgres devfathom 2>/dev/null
  export DATABASE_URL=postgresql://postgres@localhost:5432/devfathom
fi
pg_isready -h localhost; echo DATABASE_URL=$DATABASE_URL
