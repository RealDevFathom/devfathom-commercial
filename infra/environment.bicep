@allowed(['staging', 'production'])
param environmentName string
param location string = resourceGroup().location
param sharedResourceGroupName string
param registryName string
param initialImage string
@description('Canonical host the app is served on. Drives AUTH_URL and NEXT_PUBLIC_APP_URL.')
param tenantHost string

@description('Control-plane host. Must be admin.<baseDomain>.')
param platformHost string

@description('''
Host-routing base domain (the routing suffix) that tenant and platform hosts hang off. Drives
PLATFORM_BASE_DOMAIN. Not necessarily a registrable domain — staging routes off
staging.devfathom.com, which is a subdomain of the registrable devfathom.com.
Deliberately NOT the same parameter as tenantHost, and must not be re-merged with it: the
canonical app URL can carry a label of its own (www.devfathom.com) while host classification
in src/lib/tenancy/host-routing.ts and src/proxy.ts only recognises admin.<baseDomain> and
<slug>.<baseDomain>. Setting this to tenantHost makes admin.devfathom.com classify as a tenant
and strips the slug off every tenant host. In staging the two happen to be equal; that is a
coincidence of the DNS layout, not an invariant.
''')
param baseDomain string
param seedDatabase bool
@description('Run the one-time production bootstrap after migrations. Keep false for routine deployments.')
param bootstrapDatabase bool = false
param emailDeliveryMode string
@minValue(0)
@maxValue(1)
param minReplicas int = 0

@description('Hostname binding served by an existing managed certificate.')
type customDomainBinding = {
  @description('Hostname to bind, for example staging.devfathom.com.')
  name: string

  @description('Resource id of the managed certificate that serves the hostname.')
  certificateId: string
}

@description('''
Custom domain bindings for the app ingress. A deployment replaces the whole ingress configuration,
so a hostname bound out of band is dropped unless it is declared here. Leave empty for an
environment that is only served on its default Container Apps hostname.
''')
param customDomains customDomainBinding[] = []

@description('''
Comma-separated allow-list for the azure.extensions server parameter. Azure Database for PostgreSQL
refuses CREATE EXTENSION for anything absent from it, so this must cover every extension the
migrations and prisma/prepare-extensions.ts create, or the migration job fails before applying any
migration. The current required set is btree_gist,pg_trgm.
''')
param postgresExtensions string

@secure()
param postgresAdminPassword string
@secure()
@description('Password for the restricted PostgreSQL login used only by the web application.')
param appDatabasePassword string
@secure()
param authSecret string
@secure()
param platformEncryptionKey string
@secure()
param cameraCredentialKey string
@secure()
param cronSecret string
@secure()
param seedPassword string = ''
@secure()
param adminPassword string = ''
@secure()
param platformAdminPassword string = ''
@description('Allow guarded bootstrap scripts to create missing initialization secrets. Keep false for direct deployments.')
param createInitializationSecrets bool = false

param adminEmail string = 'admin@staging.devfathom.com'
param platformAdminEmail string = 'platform-admin@staging.devfathom.com'
param aiModelName string = 'gpt-5-mini'
param aiModelVersion string = '2025-08-07'
param aiDeploymentName string = 'ask-fathom-gpt-5-mini'
param aiCapacity int = 10

var shortEnvironment = environmentName == 'production' ? 'prd' : 'stg'
var suffix = uniqueString(resourceGroup().id)
var identityName = 'df-${shortEnvironment}-${suffix}-id'
var vaultName = 'df-${shortEnvironment}-${suffix}-kv'
var storageName = 'df${shortEnvironment}${suffix}st'
var postgresName = 'df-${shortEnvironment}-${suffix}-pg'
var openAIName = 'df-${shortEnvironment}-${suffix}-ai'
var appEnvironmentName = 'df-${shortEnvironment}-${suffix}-cae'
var appName = 'devfathom-${shortEnvironment}'
var migrationJobName = 'devfathom-${shortEnvironment}-migrate'
var databaseUrl = 'postgresql://devfathomadmin:${uriComponent(postgresAdminPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/devfathom?sslmode=verify-full'
var appDatabaseUrl = 'postgresql://devfathom_app:${uriComponent(appDatabasePassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/devfathom?sslmode=verify-full'
var migrateDatabaseCommand = 'bun prisma/prepare-extensions.ts && bunx prisma migrate deploy && bun prisma/prepare-runtime-role.ts && bun prisma/sync-catalog.ts'
var migrationCommand = seedDatabase && bootstrapDatabase
  ? fail('seedDatabase and bootstrapDatabase cannot both be enabled.')
  : seedDatabase
    ? environmentName != 'staging'
      ? fail('Database seeding is only supported in staging.')
      : '${migrateDatabaseCommand} && bun prisma/seed.ts'
    : bootstrapDatabase
      ? environmentName != 'production'
        ? fail('Production bootstrap is only supported in production.')
        : (!empty(adminPassword) && length(trim(adminPassword)) < 12) || (!empty(platformAdminPassword) && length(trim(platformAdminPassword)) < 12)
          ? fail('Explicitly supplied production administrator passwords must be at least 12 characters.')
          : '${migrateDatabaseCommand} && bun prisma/bootstrap.ts'
      : migrateDatabaseCommand

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
  scope: resourceGroup(sharedResourceGroupName)
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'df-${shortEnvironment}-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.42.0.0/21'] }
    subnets: [
      {
        name: 'container-apps'
        properties: {
          addressPrefix: '10.42.0.0/23'
          delegations: [
            {
              name: 'Microsoft.App-environments'
              properties: { serviceName: 'Microsoft.App/environments' }
            }
          ]
        }
      }
      {
        name: 'postgres'
        properties: {
          addressPrefix: '10.42.2.0/24'
          delegations: [
            {
              name: 'Microsoft.DBforPostgreSQL-flexibleServers'
              properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' }
            }
          ]
        }
      }
    ]
  }
}

resource postgresSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: 'postgres'
}

resource containerAppsSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: 'container-apps'
}

resource postgresDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'private.postgres.database.azure.com'
  location: 'global'
}

resource postgresDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: postgresDns
  name: 'df-${shortEnvironment}-vnet-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresName
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    administratorLogin: 'devfathomadmin'
    administratorLoginPassword: postgresAdminPassword
    version: '16'
    storage: {
      storageSizeGB: 32
      autoGrow: 'Disabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
    network: {
      publicNetworkAccess: 'Disabled'
      delegatedSubnetResourceId: postgresSubnet.id
      privateDnsZoneArmResourceId: postgresDns.id
    }
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
  }
  dependsOn: [postgresDnsLink]
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'devfathom'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource postgresExtensionAllowList 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgres
  name: 'azure.extensions'
  properties: {
    value: postgresExtensions
    source: 'user-override'
  }
  dependsOn: [database]
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enabledForTemplateDeployment: true
    publicNetworkAccess: 'Enabled'
    softDeleteRetentionInDays: 7
  }
}

resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'database-url'
  properties: { value: databaseUrl }
}
resource appDatabaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'app-database-url'
  properties: { value: appDatabaseUrl }
}
resource authSecretResource 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'auth-secret'
  properties: { value: authSecret }
}
resource platformEncryptionSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'platform-encryption-key'
  properties: { value: platformEncryptionKey }
}
resource cameraCredentialSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'camera-credential-key'
  properties: { value: cameraCredentialKey }
}
resource cronSecretResource 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'cron-secret'
  properties: { value: cronSecret }
}
resource seedPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (createInitializationSecrets && !empty(seedPassword)) {
  parent: vault
  name: 'seed-password'
  properties: { value: seedPassword }
}
resource adminPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (createInitializationSecrets && !empty(adminPassword)) {
  parent: vault
  name: 'admin-password'
  properties: { value: adminPassword }
}
resource platformAdminPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (createInitializationSecrets && !empty(platformAdminPassword)) {
  parent: vault
  name: 'platform-admin-password'
  properties: { value: platformAdminPassword }
}
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource uploads 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'uploads'
  properties: { publicAccess: 'None' }
}

resource openAI 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: openAIName
  location: location
  kind: 'OpenAI'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: openAIName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource openAIDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openAI
  name: aiDeploymentName
  sku: {
    name: 'GlobalStandard'
    capacity: aiCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: aiModelName
      version: aiModelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'df-${shortEnvironment}-${suffix}-logs'
  location: location
  properties: {
    retentionInDays: 30
    sku: { name: 'PerGB2018' }
    workspaceCapping: { dailyQuotaGb: json('0.1') }
  }
}

resource appEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: appEnvironmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: containerAppsSubnet.id
      internal: false
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

var openAIUserRole = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
)
var blobContributorRole = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)
var keyVaultSecretsUserRole = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

module acrPull 'acr-pull.bicep' = {
  name: 'acr-pull-${shortEnvironment}'
  scope: resourceGroup(sharedResourceGroupName)
  params: {
    registryName: registryName
    principalId: identity.properties.principalId
    identityResourceId: identity.id
  }
}

resource openAIUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(openAI.id, identity.id, openAIUserRole)
  scope: openAI
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: openAIUserRole
  }
}

resource blobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, identity.id, blobContributorRole)
  scope: storage
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobContributorRole
  }
}

resource vaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identity.id, keyVaultSecretsUserRole)
  scope: vault
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRole
  }
}

var vaultBaseUrl = 'https://${vault.name}${environment().suffixes.keyvaultDns}/secrets'
var runtimeKeyVaultSecrets = [
  { name: 'app-database-url', keyVaultUrl: '${vaultBaseUrl}/app-database-url', identity: identity.id }
  { name: 'auth-secret', keyVaultUrl: '${vaultBaseUrl}/auth-secret', identity: identity.id }
  { name: 'platform-encryption-key', keyVaultUrl: '${vaultBaseUrl}/platform-encryption-key', identity: identity.id }
  { name: 'camera-credential-key', keyVaultUrl: '${vaultBaseUrl}/camera-credential-key', identity: identity.id }
  { name: 'cron-secret', keyVaultUrl: '${vaultBaseUrl}/cron-secret', identity: identity.id }
]

var migrationSecrets = concat(
  [
    { name: 'database-url', keyVaultUrl: '${vaultBaseUrl}/database-url', identity: identity.id }
    { name: 'app-database-url', keyVaultUrl: '${vaultBaseUrl}/app-database-url', identity: identity.id }
  ],
  seedDatabase
    ? [{ name: 'seed-password', keyVaultUrl: '${vaultBaseUrl}/seed-password', identity: identity.id }]
    : [],
  seedDatabase || bootstrapDatabase
    ? [
        { name: 'admin-password', keyVaultUrl: '${vaultBaseUrl}/admin-password', identity: identity.id }
        { name: 'platform-admin-password', keyVaultUrl: '${vaultBaseUrl}/platform-admin-password', identity: identity.id }
      ]
    : []
)

var webEnvironment = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'DATABASE_URL', secretRef: 'app-database-url' }
  { name: 'AUTH_SECRET', secretRef: 'auth-secret' }
  { name: 'AUTH_URL', value: 'https://${tenantHost}' }
  { name: 'AUTH_TRUST_HOST', value: 'true' }
  { name: 'NEXT_PUBLIC_APP_URL', value: 'https://${tenantHost}' }
  // Base domain, not the app URL. See the baseDomain parameter for why these differ.
  { name: 'PLATFORM_BASE_DOMAIN', value: baseDomain }
  { name: 'PLATFORM_ENCRYPTION_KEY', secretRef: 'platform-encryption-key' }
  { name: 'CAMERA_CREDENTIAL_KEY', secretRef: 'camera-credential-key' }
  { name: 'CRON_SECRET', secretRef: 'cron-secret' }
  { name: 'DEFAULT_ORGANIZATION_ID', value: 'org_devfathom' }
  { name: 'EMAIL_DELIVERY_MODE', value: emailDeliveryMode }
  { name: 'AI_PROVIDER', value: 'azure' }
  { name: 'AI_MODEL', value: aiDeploymentName }
  { name: 'AZURE_OPENAI_RESOURCE_NAME', value: openAI.name }
  { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
  { name: 'AZURE_STORAGE_ACCOUNT_NAME', value: storage.name }
  { name: 'AZURE_STORAGE_CONTAINER', value: uploads.name }
]

var migrationEnvironment = concat(
  [
    { name: 'NODE_ENV', value: 'production' }
    { name: 'DATABASE_URL', secretRef: 'database-url' }
    { name: 'EXTENSION_ADMIN_DATABASE_URL', secretRef: 'database-url' }
    { name: 'APP_DATABASE_URL', secretRef: 'app-database-url' }
    { name: 'AUTH_URL', value: 'https://${tenantHost}' }
    { name: 'DEFAULT_ORGANIZATION_ID', value: 'org_devfathom' }
  ],
  seedDatabase
    ? [
        { name: 'SEED_PASSWORD', secretRef: 'seed-password' }
        { name: 'ADMIN_NAME', value: 'Workspace Administrator' }
        { name: 'ADMIN_EMAIL', value: adminEmail }
        { name: 'ADMIN_PASSWORD', secretRef: 'admin-password' }
        { name: 'ADMIN_DEPARTMENT', value: 'LEADERSHIP' }
        { name: 'ADMIN_TITLE', value: 'Administrator' }
        { name: 'PLATFORM_ADMIN_EMAIL', value: platformAdminEmail }
        { name: 'PLATFORM_ADMIN_PASSWORD', secretRef: 'platform-admin-password' }
      ]
    : bootstrapDatabase
      ? [
          { name: 'ADMIN_NAME', value: 'Workspace Administrator' }
          { name: 'ADMIN_EMAIL', value: adminEmail }
          { name: 'ADMIN_PASSWORD', secretRef: 'admin-password' }
          { name: 'ADMIN_TITLE', value: 'Administrator' }
          { name: 'PLATFORM_ADMIN_EMAIL', value: platformAdminEmail }
          { name: 'PLATFORM_ADMIN_PASSWORD', secretRef: 'platform-admin-password' }
        ]
      : []
)

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: appEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 3000
        transport: 'auto'
        customDomains: [
          for domain in customDomains: {
            name: domain.name
            certificateId: domain.certificateId
            bindingType: 'SniEnabled'
          }
        ]
      }
      registries: [
        { server: registry.properties.loginServer, identity: identity.id }
      ]
      secrets: runtimeKeyVaultSecrets
    }
    template: {
      containers: [
        {
          name: 'web'
          image: initialImage
          env: webEnvironment
          resources: { cpu: json('0.5'), memory: '1Gi' }
          // DEV-339 / GitHub #321: every probe is explicit so no Azure platform default
          // judges a booting container. Sized against the measured 35.92 s cold start
          // (scale-to-zero, staging revision devfathom-stg--0000013):
          // - Startup: 10 s + 10 x 10 s = 110 s window (~3x the measured boot).
          //   Liveness and Readiness do not run until Startup succeeds.
          // - Liveness: 60 s initial delay (> 35.92 s even without Startup gating),
          //   then 3 x 30 s = 90 s of consecutive failures before a restart.
          // - Readiness: 10 s + 12 x 10 s = 130 s before giving up on /api/ready.
          // tests/production-deployment-contract.test.ts locks these margins; re-measure
          // the cold start after any change that moves boot time.
          probes: [
            {
              type: 'Startup'
              tcpSocket: { port: 3000 }
              initialDelaySeconds: 10
              periodSeconds: 10
              failureThreshold: 10
              timeoutSeconds: 5
            }
            {
              type: 'Liveness'
              tcpSocket: { port: 3000 }
              initialDelaySeconds: 60
              periodSeconds: 30
              failureThreshold: 3
              timeoutSeconds: 5
            }
            {
              type: 'Readiness'
              httpGet: { path: '/api/ready', port: 3000, scheme: 'HTTP' }
              initialDelaySeconds: 10
              periodSeconds: 10
              failureThreshold: 12
              timeoutSeconds: 5
            }
          ]
        }
      ]
      scale: { minReplicas: minReplicas, maxReplicas: 1 }
    }
  }
  dependsOn: [acrPull, vaultSecretsUser, openAIUser, blobContributor, appDatabaseUrlSecret, authSecretResource, platformEncryptionSecret, cameraCredentialSecret, cronSecretResource]
}

resource migrationJob 'Microsoft.App/jobs@2024-03-01' = {
  name: migrationJobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    environmentId: appEnvironment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 1
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [
        { server: registry.properties.loginServer, identity: identity.id }
      ]
      secrets: migrationSecrets
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: initialImage
          command: ['/bin/sh']
          args: ['-c', migrationCommand]
          env: migrationEnvironment
          resources: { cpu: json('0.5'), memory: '1Gi' }
        }
      ]
    }
  }
  dependsOn: [acrPull, vaultSecretsUser, database, databaseUrlSecret, appDatabaseUrlSecret, seedPasswordSecret, adminPasswordSecret, platformAdminPasswordSecret]
}

output appName string = app.name
output appFqdn string = app.properties.configuration.ingress.fqdn
output customDomainVerificationId string = app.properties.customDomainVerificationId
output migrationJobName string = migrationJob.name
output keyVaultName string = vault.name
output postgresName string = postgres.name
output storageName string = storage.name
output openAIName string = openAI.name
output aiDeploymentName string = openAIDeployment.name
output identityClientId string = identity.properties.clientId
output tenantHost string = tenantHost
output platformHost string = platformHost
