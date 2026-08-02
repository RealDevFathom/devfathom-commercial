#!/usr/bin/env bash
set -euo pipefail

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
export DEVFATHOM_STAGING_AUTH_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
export DEVFATHOM_STAGING_PLATFORM_ENCRYPTION_KEY="$(openssl rand -base64 32 | tr -d '\n')"
export DEVFATHOM_STAGING_CRON_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
export DEVFATHOM_STAGING_SEED_PASSWORD="$(openssl rand -base64 48 | tr -d '/+=' | cut -c1-32)"
export DEVFATHOM_STAGING_ADMIN_PASSWORD="$(openssl rand -base64 48 | tr -d '/+=' | cut -c1-32)"
export DEVFATHOM_STAGING_PLATFORM_ADMIN_PASSWORD="$(openssl rand -base64 48 | tr -d '/+=' | cut -c1-32)"

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
