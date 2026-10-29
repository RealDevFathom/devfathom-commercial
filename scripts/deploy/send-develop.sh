#!/usr/bin/env bash
set -euo pipefail
: "${DEPLOY_SHA:?}" "${DEVELOP_ARTIFACT_BUCKET:?}" "${DEVELOP_INSTANCE_ID:?}" "${AWS_REGION:?}"
[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$DEVELOP_ARTIFACT_BUCKET" =~ ^[a-z0-9][a-z0-9.-]+[a-z0-9]$ ]]
[[ "$DEVELOP_INSTANCE_ID" =~ ^i-[0-9a-f]+$ ]]
[[ "$AWS_REGION" =~ ^[a-z0-9-]+$ ]]
parameters=$(mktemp)
trap 'rm -f "$parameters"' EXIT
# Base64 transports reviewed shell source without interpolating it into JSON.
python3 - "$parameters" <<'PY'
import base64, json, os, shlex, sys
from pathlib import Path
source = base64.b64encode(Path('scripts/deploy/activate-develop.sh').read_bytes()).decode()
args = ' '.join(shlex.quote(os.environ[k]) for k in ('DEVELOP_ARTIFACT_BUCKET', 'DEPLOY_SHA', 'AWS_REGION'))
command = f"printf '%s' '{source}' | base64 -d | runuser -u deploy -- bash -s -- {args}"
Path(sys.argv[1]).write_text(json.dumps({'commands': [command], 'executionTimeout': ['2400']}))
PY
command_id=$(aws ssm send-command --instance-ids "$DEVELOP_INSTANCE_ID" \
  --document-name AWS-RunShellScript --timeout-seconds 120 \
  --parameters "file://$parameters" --query Command.CommandId --output text)
# A delivery timeout plus execution timeout fits within this bounded poll.
for ((attempt=0; attempt<270; attempt++)); do
  if result=$(aws ssm get-command-invocation --command-id "$command_id" \
    --instance-id "$DEVELOP_INSTANCE_ID" --output json 2>"$parameters"); then
    status=$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Status"])')
    case "$status" in
      Pending|InProgress|Delayed) ;;
      *)
        printf '%s' "$result" | python3 -c 'import json,sys; r=json.load(sys.stdin); print("SSM status:",r["Status"]); print(r.get("StandardOutputContent","")); print(r.get("StandardErrorContent",""))'
        [[ "$status" == Success ]]
        exit
        ;;
    esac
  elif ! rg -q InvocationDoesNotExist "$parameters"; then
    cat "$parameters" >&2
    exit 1
  fi
  sleep 10
done
echo "SSM command $command_id exceeded the 45-minute wait bound." >&2
aws ssm get-command-invocation --command-id "$command_id" --instance-id "$DEVELOP_INSTANCE_ID" \
  --query '{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}' --output json || true
exit 1
