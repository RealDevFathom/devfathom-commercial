using './environment.bicep'

param environmentName = 'staging'
param sharedResourceGroupName = 'rg-devfathom-shared-uaenorth'
param registryName = readEnvironmentVariable('DEVFATHOM_REGISTRY_NAME')
param initialImage = readEnvironmentVariable('DEVFATHOM_STAGING_IMAGE')
param tenantHost = 'staging.devfathom.com'
param platformHost = 'admin.staging.devfathom.com'
param seedDatabase = true
param emailDeliveryMode = 'capture'
param postgresAdminPassword = readEnvironmentVariable('DEVFATHOM_STAGING_POSTGRES_PASSWORD')
param authSecret = readEnvironmentVariable('DEVFATHOM_STAGING_AUTH_SECRET')
param platformEncryptionKey = readEnvironmentVariable('DEVFATHOM_STAGING_PLATFORM_ENCRYPTION_KEY')
param cronSecret = readEnvironmentVariable('DEVFATHOM_STAGING_CRON_SECRET')
param seedPassword = readEnvironmentVariable('DEVFATHOM_STAGING_SEED_PASSWORD')
param adminPassword = readEnvironmentVariable('DEVFATHOM_STAGING_ADMIN_PASSWORD')
param platformAdminPassword = readEnvironmentVariable('DEVFATHOM_STAGING_PLATFORM_ADMIN_PASSWORD')
