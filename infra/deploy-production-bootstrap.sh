#!/usr/bin/env bash
set -euo pipefail

production_group=rg-devfathom-production-uaenorth

generate_initialization_credential() {
  local environment_variable=$1
  local generated_value
  generated_value=$(openssl rand -base64 48 | tr -d '/+=' | cut -c1-32)
  printf -v "$environment_variable" '%s' "$generated_value"
  export "$environment_variable"
}

unset DEVFATHOM_PRODUCTION_ADMIN_PASSWORD
unset DEVFATHOM_PRODUCTION_PLATFORM_ADMIN_PASSWORD
unset DEVFATHOM_PRODUCTION_CREATE_INITIALIZATION_SECRETS

if ! vault_lookup=$(az keyvault list \
  --resource-group "$production_group" \
  --query "[?starts_with(name, 'df-prd-') && ends_with(name, '-kv')].id" \
  --output tsv 2>&1); then
  printf 'Failed to discover production Key Vault. Aborting without changing initialization credentials.\n' >&2
  exit 1
fi

key_vault_ids=()
while IFS= read -r key_vault_id; do
  [[ -n $key_vault_id ]] && key_vault_ids+=("$key_vault_id")
done <<< "$vault_lookup"

if (( ${#key_vault_ids[@]} > 1 )); then
  printf 'Multiple DevFathom production Key Vaults found. Aborting without changing initialization credentials.\n' >&2
  exit 1
fi

initialization_secret_missing=false
if (( ${#key_vault_ids[@]} == 0 )); then
  generate_initialization_credential DEVFATHOM_PRODUCTION_ADMIN_PASSWORD
  generate_initialization_credential DEVFATHOM_PRODUCTION_PLATFORM_ADMIN_PASSWORD
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

  ensure_initialization_credential admin-password DEVFATHOM_PRODUCTION_ADMIN_PASSWORD
  ensure_initialization_credential platform-admin-password DEVFATHOM_PRODUCTION_PLATFORM_ADMIN_PASSWORD
fi

if [[ $initialization_secret_missing == true ]]; then
  export DEVFATHOM_PRODUCTION_CREATE_INITIALIZATION_SECRETS=true
fi

az deployment group create \
  --resource-group "$production_group" \
  --parameters infra/production.bootstrap.bicepparam \
  --name production-bootstrap \
  --output none
