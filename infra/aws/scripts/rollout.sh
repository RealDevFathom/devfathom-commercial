#!/usr/bin/env bash
# Register task definitions for one image tag, run prisma migrate, then roll
# the web and Evolution services. Does not run `cdk deploy`.
#
# Required environment:
#   AWS_REGION, IMAGE_TAG, CLUSTER, PRIVATE_SUBNETS, APP_SECURITY_GROUP
#   MIGRATE_FAMILY, WEB_FAMILY, EVOLUTION_FAMILY
#   WEB_SERVICE, EVOLUTION_SERVICE
#   WEB_REPOSITORY_URI, MIGRATE_REPOSITORY_URI, EVOLUTION_REPOSITORY_URI
#   IMAGE_TAG_PARAMETER, MIGRATE_LOG_GROUP
set -euo pipefail

: "${AWS_REGION:?}"
: "${IMAGE_TAG:?}"
: "${CLUSTER:?}"
: "${PRIVATE_SUBNETS:?}"
: "${APP_SECURITY_GROUP:?}"
: "${MIGRATE_FAMILY:?}"
: "${WEB_FAMILY:?}"
: "${EVOLUTION_FAMILY:?}"
: "${WEB_SERVICE:?}"
: "${EVOLUTION_SERVICE:?}"
: "${WEB_REPOSITORY_URI:?}"
: "${MIGRATE_REPOSITORY_URI:?}"
: "${EVOLUTION_REPOSITORY_URI:?}"
: "${IMAGE_TAG_PARAMETER:?}"
: "${MIGRATE_LOG_GROUP:?}"

if ! printf '%s' "$IMAGE_TAG" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'; then
  echo "IMAGE_TAG must match the ECR tag pattern" >&2
  exit 1
fi

register_with_image() {
  local family="$1"
  local container="$2"
  local image="$3"
  local tmp
  tmp="$(mktemp)"
  aws ecs describe-task-definition \
    --region "$AWS_REGION" \
    --task-definition "$family" \
    --query taskDefinition \
    --output json \
    | jq --arg container "$container" --arg image "$image" '
        del(
          .taskDefinitionArn,
          .revision,
          .status,
          .requiresAttributes,
          .compatibilities,
          .registeredAt,
          .registeredBy,
          .deregisteredAt
        )
        | .containerDefinitions |= map(if .name == $container then .image = $image else . end)
      ' >"$tmp"
  aws ecs register-task-definition \
    --region "$AWS_REGION" \
    --cli-input-json "file://${tmp}" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text
  rm -f "$tmp"
}

echo "Registering task definitions for ${IMAGE_TAG}"
MIGRATE_ARN="$(register_with_image "$MIGRATE_FAMILY" migrate "${MIGRATE_REPOSITORY_URI}:${IMAGE_TAG}")"
WEB_ARN="$(register_with_image "$WEB_FAMILY" web "${WEB_REPOSITORY_URI}:${IMAGE_TAG}")"
EVOLUTION_ARN="$(register_with_image "$EVOLUTION_FAMILY" evolution "${EVOLUTION_REPOSITORY_URI}:${IMAGE_TAG}")"

echo "Running migration task"
RUN_JSON="$(aws ecs run-task \
  --region "$AWS_REGION" \
  --cluster "$CLUSTER" \
  --launch-type FARGATE \
  --task-definition "$MIGRATE_ARN" \
  --network-configuration "awsvpcConfiguration={subnets=[${PRIVATE_SUBNETS}],securityGroups=[${APP_SECURITY_GROUP}],assignPublicIp=DISABLED}" \
  --output json)"
TASK_ARN="$(printf '%s' "$RUN_JSON" | jq -r '.tasks[0].taskArn // empty')"
if [ -z "$TASK_ARN" ]; then
  printf '%s' "$RUN_JSON" | jq '.failures'
  echo "ecs run-task did not start a migration" >&2
  exit 1
fi

deadline=$((SECONDS + 1800))
status="PENDING"
while [ "$status" != "STOPPED" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "Migration ${TASK_ARN} did not stop within 30 minutes" >&2
    exit 1
  fi
  sleep 15
  status="$(aws ecs describe-tasks \
    --region "$AWS_REGION" \
    --cluster "$CLUSTER" \
    --tasks "$TASK_ARN" \
    --query 'tasks[0].lastStatus' \
    --output text)"
  echo "Migration status: ${status}"
done

exit_code="$(aws ecs describe-tasks \
  --region "$AWS_REGION" \
  --cluster "$CLUSTER" \
  --tasks "$TASK_ARN" \
  --query "tasks[0].containers[?name=='migrate'].exitCode | [0]" \
  --output text)"
if [ "$exit_code" != "0" ]; then
  aws ecs describe-tasks \
    --region "$AWS_REGION" \
    --cluster "$CLUSTER" \
    --tasks "$TASK_ARN" \
    --query 'tasks[0].stoppedReason' \
    --output text >&2 || true
  task_id="${TASK_ARN##*/}"
  aws logs get-log-events \
    --region "$AWS_REGION" \
    --log-group-name "$MIGRATE_LOG_GROUP" \
    --log-stream-name "migrate/migrate/${task_id}" \
    --limit 80 \
    --query 'events[].message' \
    --output text >&2 || true
  echo "Migration exited ${exit_code}" >&2
  exit 1
fi

echo "Updating services"
aws ecs update-service \
  --region "$AWS_REGION" \
  --cluster "$CLUSTER" \
  --service "$WEB_SERVICE" \
  --task-definition "$WEB_ARN" \
  --query 'service.serviceName' \
  --output text >/dev/null
aws ecs update-service \
  --region "$AWS_REGION" \
  --cluster "$CLUSTER" \
  --service "$EVOLUTION_SERVICE" \
  --task-definition "$EVOLUTION_ARN" \
  --query 'service.serviceName' \
  --output text >/dev/null

aws ssm put-parameter \
  --region "$AWS_REGION" \
  --name "$IMAGE_TAG_PARAMETER" \
  --type String \
  --value "$IMAGE_TAG" \
  --overwrite \
  --query 'Version' \
  --output text >/dev/null

echo "Recorded ${IMAGE_TAG} at ${IMAGE_TAG_PARAMETER}"
