param location string = resourceGroup().location
param registryName string = 'dfacr${uniqueString(subscription().id)}'

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    dataEndpointEnabled: false
    publicNetworkAccess: 'Enabled'
    zoneRedundancy: 'Disabled'
  }
}

output registryName string = registry.name
output loginServer string = registry.properties.loginServer
