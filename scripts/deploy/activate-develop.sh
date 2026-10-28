#!/usr/bin/env bash
# Invoked by SSM as deploy. No build or privileged application code runs as root.
set -Eeuo pipefail
umask 0027
bucket=${1:?bucket required}
sha=${2:?commit required}
region=${3:?region required}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$bucket" =~ ^[a-z0-9][a-z0-9.-]+[a-z0-9]$ ]]
[[ "$region" =~ ^[a-z0-9-]+$ ]]
base=${DEVELOP_APP_ROOT:-/home/app}
releases="$base/releases"
export PATH="/home/deploy/.bun/bin:$PATH"
exec 9>"$releases/.deploy.lock"
flock -w 1200 9
# A SIGKILL can leave this link behind; only remove it while holding the lock.
rm -f "$releases/.current-next"
previous=$(readlink -f "$base/web")
test -L "$base/web"
test -d "$previous"
# web is a stable administrator-owned link to releases/current.
test "$(readlink "$base/web")" = "$releases/current"
target="$releases/$sha"
# Refuse leaf aliases; compare canonical paths before any replacement.
test ! -L "$target"
canonical_target=$(readlink -m "$target")
check_health() {
  for ((attempt=0; attempt<12; attempt++)); do
    status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
      --connect-timeout 3 --max-time 5 http://127.0.0.1:3001/ || true)
    case "$status" in 200|307) return 0 ;; esac
    sleep 5
  done
  return 1
}
# Never reinstall, replace or delete the running release, even on a failed retry.
if [[ "$previous" == "$canonical_target" ]]; then
  check_health
  echo "Develop release $sha is already current and healthy."
  exit 0
fi
mkdir -p "$releases/.staging"
staged=$(mktemp -d "$releases/.staging/$sha.XXXXXXXX")
archive=$(mktemp "$releases/.artifact.XXXXXXXX.tar.gz")
trap 'rm -f -- "$archive"; rm -rf -- "$staged"' EXIT
aws s3 cp "s3://$bucket/develop/$sha.tar.gz" "$archive" --region "$region" --only-show-errors
tar -xzf "$archive" -C "$staged" --no-same-owner --no-overwrite-dir
cd "$staged"
test -f .next/standalone/server.js
test -f .next/standalone/.assets-staged
test -d .next/standalone/.next/static
# Environment remains outside the release. Do not trace or print its values.
set -a
# shellcheck disable=SC1091
. "$base/develop.env"
set +a
bun install --frozen-lockfile --production
# These must resolve locally: bunx must never fetch migration tooling at deploy time.
test -x node_modules/.bin/prisma
test -d node_modules/dotenv
bun node_modules/.bin/prisma migrate deploy
# Every extracted/installed file belongs to deploy (tar --no-same-owner).
# Correct the group explicitly: deploy's primary group need not be app.
# GNU chmod -R ignores nested symlinks; chgrp -hR -P changes links, not targets.
# Do this before introducing the persistent uploads links.
chgrp -hR -P app "$staged"
chmod -R g+rX "$staged"
chmod 2750 "$staged"
mkdir -p .next/standalone/.next/cache
chgrp -hR -P app .next/standalone/.next/cache
chmod -R g+rwX .next/standalone/.next/cache
chmod 2770 .next/standalone/.next/cache
# Existing uploads must be migrated to shared storage during one-time setup.
test -d "$base/shared/uploads"
test -w "$base/shared/uploads"
rm -rf .next/standalone/public/uploads
ln -s "$base/shared/uploads" .next/standalone/public/uploads
mkdir -p public
chgrp app public
chmod g+rX public
ln -s "$base/shared/uploads" public/uploads
# Preparation is complete. The current predecessor is a different path and is
# preserved for rollback. Replace only an inactive exact-SHA directory under lock.
if [[ -e "$target" ]]; then rm -rf -- "$target"; fi
mv -T "$staged" "$target"
cd "$target"
switch_release() {
  ln -s "$1" "$releases/.current-next"
  mv -Tf "$releases/.current-next" "$releases/current"
}
rollback() {
  trap - ERR INT TERM
  echo 'Develop activation failed; restoring previous release.' >&2
  rm -f "$releases/.current-next"
  switch_release "$previous"
  sudo /usr/bin/systemctl restart devfathom-develop.service || echo 'Rollback restart failed; operator intervention required.' >&2
  exit 1
}
# Arm before the switch, including restart failures and interrupted health checks.
trap rollback ERR INT TERM
switch_release "$target"
sudo /usr/bin/systemctl restart devfathom-develop.service
check_health
trap - ERR INT TERM
# Retain active and predecessor plus the three newest other releases.
kept=0
while IFS= read -r candidate; do
  if [[ "$candidate" == "$target" || "$(readlink -f "$candidate")" == "$previous" ]]; then continue; fi
  kept=$((kept + 1))
  if ((kept > 3)); then rm -rf -- "$candidate"; fi
done < <(find "$releases" -mindepth 1 -maxdepth 1 -type d ! -name '.staging' -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
echo "Develop release $sha activated."
