#!/usr/bin/env bash
set -euo pipefail

# DEV-341: fail closed before any Azure command unless an authorized operator has reviewed the
# current staging what-if and recorded an approval bound to these exact infrastructure files.
# shellcheck source=infra/staging-review-guard.sh
source "$(dirname "${BASH_SOURCE[0]}")/staging-review-guard.sh"
staging_review_require_approval

location=uaenorth
shared_group=rg-devfathom-shared-uaenorth
staging_group=rg-devfathom-staging-uaenorth

az group create --name "$shared_group" --location "$location" --output none
az group create --name "$staging_group" --location "$location" --output none

az deployment group create \
  --resource-group "$shared_group" \
  --template-file infra/shared.bicep \
  --name shared \
  --output none

export DEVFATHOM_REGISTRY_NAME
DEVFATHOM_REGISTRY_NAME=$(az deployment group show \
  --resource-group "$shared_group" \
  --name shared \
  --query properties.outputs.registryName.value \
  --output tsv)

if [[ -z ${DEVFATHOM_STAGING_IMAGE:-} ]]; then
  image_tag="bootstrap-$(git rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)"
  az acr build \
    --registry "$DEVFATHOM_REGISTRY_NAME" \
    --image "devfathom-commercial:$image_tag" \
    --platform linux/amd64 \
    .
  image_digest=$(az acr repository show \
    --name "$DEVFATHOM_REGISTRY_NAME" \
    --image "devfathom-commercial:$image_tag" \
    --query digest \
    --output tsv)
  export DEVFATHOM_STAGING_IMAGE="$DEVFATHOM_REGISTRY_NAME.azurecr.io/devfathom-commercial@$image_digest"
fi

export DEVFATHOM_STAGING_POSTGRES_PASSWORD="$(openssl rand -base64 48 | tr -d '/+=' | cut -c1-40)"
export DEVFATHOM_STAGING_APP_DATABASE_PASSWORD="$(openssl rand -base64 48 | tr -d '/+=' | cut -c1-40)"
export DEVFATHOM_STAGING_AUTH_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
export DEVFATHOM_STAGING_PLATFORM_ENCRYPTION_KEY="$(openssl rand -base64 32 | tr -d '\n')"
export DEVFATHOM_STAGING_CAMERA_CREDENTIAL_KEY="$(openssl rand -base64 32 | tr -d '\n')"
export DEVFATHOM_STAGING_CRON_SECRET="$(openssl rand -base64 48 | tr -d '\n')"

generate_initialization_credential() {
  local environment_variable=$1
  local generated_value
  generated_value=$(openssl rand -base64 48 | tr -d '/+=' | cut -c1-32)
  printf -v "$environment_variable" '%s' "$generated_value"
  export "$environment_variable"
}

unset DEVFATHOM_STAGING_SEED_PASSWORD
unset DEVFATHOM_STAGING_ADMIN_PASSWORD
unset DEVFATHOM_STAGING_PLATFORM_ADMIN_PASSWORD
unset DEVFATHOM_STAGING_CREATE_INITIALIZATION_SECRETS

if ! vault_lookup=$(az keyvault list \
  --resource-group "$staging_group" \
  --query "[?starts_with(name, 'df-stg-') && ends_with(name, '-kv')].id" \
  --output tsv 2>&1); then
  printf 'Failed to discover staging Key Vault. Aborting without changing initialization credentials.\n' >&2
  exit 1
fi

key_vault_ids=()
while IFS= read -r key_vault_id; do
  [[ -n $key_vault_id ]] && key_vault_ids+=("$key_vault_id")
done <<< "$vault_lookup"

if (( ${#key_vault_ids[@]} > 1 )); then
  printf 'Multiple DevFathom staging Key Vaults found. Aborting without changing initialization credentials.\n' >&2
  exit 1
fi

initialization_secret_missing=false
if (( ${#key_vault_ids[@]} == 0 )); then
  generate_initialization_credential DEVFATHOM_STAGING_SEED_PASSWORD
  generate_initialization_credential DEVFATHOM_STAGING_ADMIN_PASSWORD
  generate_initialization_credential DEVFATHOM_STAGING_PLATFORM_ADMIN_PASSWORD
  initialization_secret_missing=true
else
  key_vault_id=${key_vault_ids[0]}

  ensure_initialization_credential() {
    local secret_name=$1
    local environment_variable=$2
    local secret_lookup

    if secret_lookup=$(az resource show \
      --ids "$key_vault_id/secrets/$secret_name" \
      --api-version 2023-07-01 \
      --output none 2>&1); then
      :
    elif [[ $secret_lookup == *ResourceNotFound* ]]; then
      generate_initialization_credential "$environment_variable"
      initialization_secret_missing=true
    else
      printf 'Failed to inspect Key Vault secret %s. Aborting without changing initialization credentials.\n' "$secret_name" >&2
      exit 1
    fi
  }

  ensure_initialization_credential seed-password DEVFATHOM_STAGING_SEED_PASSWORD
  ensure_initialization_credential admin-password DEVFATHOM_STAGING_ADMIN_PASSWORD
  ensure_initialization_credential platform-admin-password DEVFATHOM_STAGING_PLATFORM_ADMIN_PASSWORD
fi

if [[ $initialization_secret_missing == true ]]; then
  export DEVFATHOM_STAGING_CREATE_INITIALIZATION_SECRETS=true
fi

az deployment group create \
  --resource-group "$staging_group" \
  --parameters infra/staging.bicepparam \
  --name staging \
  --output none

app_name=$(az deployment group show --resource-group "$staging_group" --name staging --query properties.outputs.appName.value --output tsv)
app_fqdn=$(az deployment group show --resource-group "$staging_group" --name staging --query properties.outputs.appFqdn.value --output tsv)
job_name=$(az deployment group show --resource-group "$staging_group" --name staging --query properties.outputs.migrationJobName.value --output tsv)

az containerapp update --resource-group "$staging_group" --name "$app_name" --set-env-vars "VERCEL_URL=$app_fqdn" --output none
az containerapp job start --resource-group "$staging_group" --name "$job_name" --output none

printf 'Staging resources deployed. Wait for migration job, then verify https://%s/api/health\n' "$app_fqdn"
