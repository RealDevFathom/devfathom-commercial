#!/usr/bin/env bash
# Human infrastructure deploy. Reads the image tag CI published and passes it
# as the ImageTag parameter so a deploy does not reset the services to `bootstrap`.
# Do not call this from GitHub Actions. The CI role cannot deploy stacks.
#
# Required: AWS_REGION, AWS_ACCOUNT_ID
# Optional: STAGE (staging|production), IMAGE_TAG (defaults to the SSM parameter)
set -euo pipefail

STAGE="${STAGE:-staging}"
: "${AWS_REGION:?}"
: "${AWS_ACCOUNT_ID:?}"

case "$STAGE" in
  staging | production) ;;
  *)
    echo "STAGE must be staging or production" >&2
    exit 1
    ;;
esac
case "$AWS_REGION" in
  ap-south-1 | me-central-1) ;;
  *)
    echo "AWS_REGION must be ap-south-1 or me-central-1" >&2
    exit 1
    ;;
esac
if ! printf '%s' "$AWS_ACCOUNT_ID" | grep -Eq '^[0-9]{12}$'; then
  echo "AWS_ACCOUNT_ID must be 12 digits" >&2
  exit 1
fi

if [ -z "${IMAGE_TAG:-}" ]; then
  IMAGE_TAG="$(aws ssm get-parameter \
    --region "$AWS_REGION" \
    --name "/devfathom/${STAGE}/deployed-image-tag" \
    --query 'Parameter.Value' \
    --output text)"
fi
if ! printf '%s' "$IMAGE_TAG" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'; then
  echo "IMAGE_TAG must match the ECR tag pattern" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
exec npx cdk deploy "DevFathom-${STAGE}" \
  --strict \
  --require-approval never \
  -c "stage=${STAGE}" \
  -c "account=${AWS_ACCOUNT_ID}" \
  -c "region=${AWS_REGION}" \
  --parameters "DevFathom-${STAGE}:ImageTag=${IMAGE_TAG}"
