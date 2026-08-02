#!/usr/bin/env bash
set -euo pipefail

repo=WhatTheStack1/devfathom-commercial
display_name=devfathom-commercial-github
shared_group=rg-devfathom-shared-uaenorth
staging_group=rg-devfathom-staging-uaenorth

subscription_id=$(az account show --query id --output tsv)
tenant_id=$(az account show --query tenantId --output tsv)
app_id=$(az ad app list --display-name "$display_name" --query '[0].appId' --output tsv)
if [ -z "$app_id" ]; then
  app_id=$(az ad app create --display-name "$display_name" --query appId --output tsv)
fi

principal_id=$(az ad sp list --filter "appId eq '$app_id'" --query '[0].id' --output tsv)
if [ -z "$principal_id" ]; then
  principal_id=$(az ad sp create --id "$app_id" --query id --output tsv)
fi

ensure_federation() {
  local name=$1 subject=$2
  if ! az ad app federated-credential list --id "$app_id" --query "[?name=='$name'].name | [0]" --output tsv | rg -q .; then
    az ad app federated-credential create --id "$app_id" --parameters "$(jq -n \
      --arg name "$name" \
      --arg subject "$subject" \
      '{name:$name,issuer:"https://token.actions.githubusercontent.com",subject:$subject,audiences:["api://AzureADTokenExchange"]}')" --output none
  fi
}

ensure_federation main "repo:${repo}:ref:refs/heads/main"
ensure_federation production "repo:${repo}:environment:production"

staging_scope="/subscriptions/${subscription_id}/resourceGroups/${staging_group}"
registry_name=$(az deployment group show --resource-group "$shared_group" --name shared --query properties.outputs.registryName.value --output tsv)
registry_id=$(az acr show --resource-group "$shared_group" --name "$registry_name" --query id --output tsv)

az role assignment create --assignee-object-id "$principal_id" --assignee-principal-type ServicePrincipal --role Contributor --scope "$staging_scope" --output none
az role assignment create --assignee-object-id "$principal_id" --assignee-principal-type ServicePrincipal --role AcrPush --scope "$registry_id" --output none

gh variable set AZURE_CLIENT_ID --repo "$repo" --body "$app_id"
gh variable set AZURE_TENANT_ID --repo "$repo" --body "$tenant_id"
gh variable set AZURE_SUBSCRIPTION_ID --repo "$repo" --body "$subscription_id"
gh variable set AZURE_ACR_NAME --repo "$repo" --body "$registry_name"
gh variable set AZURE_SHARED_RESOURCE_GROUP --repo "$repo" --body "$shared_group"
gh variable set AZURE_STAGING_RESOURCE_GROUP --repo "$repo" --body "$staging_group"
gh variable set AZURE_CONTAINER_APP_NAME --repo "$repo" --body devfathom-stg
gh variable set AZURE_MIGRATION_JOB_NAME --repo "$repo" --body devfathom-stg-migrate

gh api --method PUT "repos/${repo}/environments/staging" --input - >/dev/null <<'JSON'
{"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false}}
JSON

reviewer_id=$(gh api user --jq .id)
if ! jq -n --argjson reviewer "$reviewer_id" '{reviewers:[{type:"User",id:$reviewer}],deployment_branch_policy:{protected_branches:true,custom_branch_policies:false}}' |
  gh api --method PUT "repos/${repo}/environments/production" --input - >/dev/null; then
  gh api --method PUT "repos/${repo}/environments/production" --input - >/dev/null <<'JSON'
{"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false}}
JSON
  printf 'Warning: GitHub billing plan does not support required environment reviewers; production remains workflow_dispatch-only.\n' >&2
fi

printf 'GitHub OIDC configured for %s.\n' "$repo"
