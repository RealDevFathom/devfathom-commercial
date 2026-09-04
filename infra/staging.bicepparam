using './environment.bicep'

param environmentName = 'staging'
param sharedResourceGroupName = 'rg-devfathom-shared-uaenorth'
param registryName = readEnvironmentVariable('DEVFATHOM_REGISTRY_NAME')
param initialImage = readEnvironmentVariable('DEVFATHOM_STAGING_IMAGE')
param tenantHost = 'staging.devfathom.com'
param platformHost = 'admin.staging.devfathom.com'
param baseDomain = 'staging.devfathom.com'
param seedDatabase = true
param bootstrapDatabase = false
param emailDeliveryMode = 'capture'
param postgresAdminPassword = readEnvironmentVariable('DEVFATHOM_STAGING_POSTGRES_PASSWORD')
param appDatabasePassword = readEnvironmentVariable('DEVFATHOM_STAGING_APP_DATABASE_PASSWORD')
param authSecret = readEnvironmentVariable('DEVFATHOM_STAGING_AUTH_SECRET')
param platformEncryptionKey = readEnvironmentVariable('DEVFATHOM_STAGING_PLATFORM_ENCRYPTION_KEY')
param cameraCredentialKey = readEnvironmentVariable('DEVFATHOM_STAGING_CAMERA_CREDENTIAL_KEY')
param cronSecret = readEnvironmentVariable('DEVFATHOM_STAGING_CRON_SECRET')
param seedPassword = readEnvironmentVariable('DEVFATHOM_STAGING_SEED_PASSWORD', '')
param adminPassword = readEnvironmentVariable('DEVFATHOM_STAGING_ADMIN_PASSWORD', '')
param platformAdminPassword = readEnvironmentVariable('DEVFATHOM_STAGING_PLATFORM_ADMIN_PASSWORD', '')
param createInitializationSecrets = readEnvironmentVariable('DEVFATHOM_STAGING_CREATE_INITIALIZATION_SECRETS', 'false') == 'true'
param customDomains = [
  {
    name: 'staging.devfathom.com'
    certificateId: '/subscriptions/8f456d9c-74ac-4a21-aaa3-2d65719120c5/resourceGroups/rg-devfathom-staging-uaenorth/providers/Microsoft.App/managedEnvironments/df-stg-7azfl6tid4bb4-cae/managedCertificates/mc-df-stg-7azfl6t-staging-devfatho-0983'
  }
  {
    name: 'admin.staging.devfathom.com'
    certificateId: '/subscriptions/8f456d9c-74ac-4a21-aaa3-2d65719120c5/resourceGroups/rg-devfathom-staging-uaenorth/providers/Microsoft.App/managedEnvironments/df-stg-7azfl6tid4bb4-cae/managedCertificates/mc-df-stg-7azfl6t-admin-staging-de-6237'
  }
]
param postgresExtensions = 'btree_gist,pg_trgm'
