using './environment.bicep'

param environmentName = 'production'
param sharedResourceGroupName = 'rg-devfathom-shared-uaenorth'
param registryName = readEnvironmentVariable('DEVFATHOM_REGISTRY_NAME')
param initialImage = readEnvironmentVariable('DEVFATHOM_PRODUCTION_IMAGE')
param tenantHost = 'www.devfathom.com'
param platformHost = 'admin.devfathom.com'
param baseDomain = 'devfathom.com'
param seedDatabase = false
param bootstrapDatabase = true
param emailDeliveryMode = 'capture'
param minReplicas = 1
param adminEmail = 'admin@devfathom.com'
param platformAdminEmail = 'platform-admin@devfathom.com'
param postgresAdminPassword = readEnvironmentVariable('DEVFATHOM_PRODUCTION_POSTGRES_PASSWORD')
param authSecret = readEnvironmentVariable('DEVFATHOM_PRODUCTION_AUTH_SECRET')
param platformEncryptionKey = readEnvironmentVariable('DEVFATHOM_PRODUCTION_PLATFORM_ENCRYPTION_KEY')
param cronSecret = readEnvironmentVariable('DEVFATHOM_PRODUCTION_CRON_SECRET')
param adminPassword = readEnvironmentVariable('DEVFATHOM_PRODUCTION_ADMIN_PASSWORD')
param platformAdminPassword = readEnvironmentVariable('DEVFATHOM_PRODUCTION_PLATFORM_ADMIN_PASSWORD')
