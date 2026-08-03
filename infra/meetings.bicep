// DevFathom Meetings — LiveKit SFU + TURN, single VM, UAE North.
//
// This template is AUTHORED ONLY. Nothing here has been provisioned. Provisioning
// requires explicit approval after docs/meetings/014-cost-model.md is reviewed.
//
// Deliberately NOT here: Front Door, Application Gateway, AKS, Redis, Egress,
// autoscaling, VNet peering to the application network. See
// docs/meetings/011-azure-infrastructure.md for the reasoning behind each omission.

@allowed(['staging', 'production'])
param environmentName string = 'staging'

param location string = resourceGroup().location

// The four SKUs compared in docs/meetings/011-azure-infrastructure.md.
// F4s_v2 is the staging default: LiveKit recommends compute-optimised instances,
// and the selective-subscription policy makes the SFU far less CPU-hungry than
// the 8-vCPU figure the original research report assumed.
@allowed([
  'Standard_F4s_v2'
  'Standard_F8s_v2'
  'Standard_D4s_v5'
  'Standard_D8s_v5'
])
param vmSize string = 'Standard_F4s_v2'

// Pinned image. Never 'latest'. Bump deliberately, record the bump in
// docs/meetings/015-staging-operations.md.
param imagePublisher string = 'Canonical'
param imageOffer string = 'ubuntu-24_04-lts'
param imageSku string = 'server'
param imageVersion string = '24.04.202608020'

// Public hostnames. These labels are reserved in src/lib/tenancy/host-routing.ts
// so no tenant can ever claim them.
param meetHost string = 'meet-staging.devfathom.com'
param turnHost string = 'turn-staging.devfathom.com'

// A public SSH key is not a secret; it is committed deliberately so the operator
// has a break-glass path via Serial Console. No NSG rule opens 22 — see
// docs/meetings/011-azure-infrastructure.md, "Administrative access".
param adminUsername string = 'devfathom'
param adminPublicKey string

// Where the VM availability alert lands.
param alertEmail string

// LiveKit pinned by digest, matching docker/livekit/docker-compose.yml.
param livekitImage string = 'livekit/livekit-server:v1.13.5@sha256:3497163e15c48fef6e7830c78716f9e9d5edc28abf7aa90b61c86e93bbc306b1'
param caddyImage string = 'livekit/caddyl4:v2.11.3@sha256:9dd090159a6042a907dbff0ce9dda27a21d2a559dc7b03b60a8e6b1b60b8348e'

// UDP mux replaces LiveKit's default 50000-60000 ICE range (10,001 ports) with a
// range one NSG rule can express. LiveKit's guidance is a mux range at least as
// wide as the VM's vCPU count, so it is derived from vmSize rather than fixed.
// The floor of 8 keeps the published port layout stable across the 4- and 8-vCPU
// SKUs, so a resize does not require a DNS-visible NSG change.
param udpMuxPortStart int = 7882

var vcpuBySize = {
  Standard_F4s_v2: 4
  Standard_F8s_v2: 8
  Standard_D4s_v5: 4
  Standard_D8s_v5: 8
}
var udpMuxPortCount = vcpuBySize[vmSize] < 8 ? 8 : vcpuBySize[vmSize]
var udpMuxPortEnd = (udpMuxPortStart + udpMuxPortCount) - 1

var shortEnvironment = environmentName == 'production' ? 'prd' : 'stg'
var suffix = uniqueString(resourceGroup().id, 'meetings')
var prefix = 'df-mtg-${shortEnvironment}-${suffix}'

var tags = {
  workload: 'meetings'
  env: environmentName
}

// ---------------------------------------------------------------------------
// Network. Separate VNet, no peering to the application VNet in
// infra/environment.bicep. The SFU is internet-facing by design; the database is
// not. Justified in docs/meetings/011-azure-infrastructure.md.
// ---------------------------------------------------------------------------

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${prefix}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.60.0.0/24'] }
    subnets: [
      {
        name: 'sfu'
        properties: {
          addressPrefix: '10.60.0.0/26'
          networkSecurityGroup: { id: nsg.id }
        }
      }
    ]
  }
}

resource sfuSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: 'sfu'
}

// Port layout derived from the current `livekit/generate` production output.
// See docs/meetings/011-azure-infrastructure.md for the generator transcript and
// why 3478/TCP and 5349/TCP are absent.
resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${prefix}-nsg'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'acme-http'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '80'
          description: 'ACME HTTP-01 certificate issuance and renewal (Caddy).'
        }
      }
      {
        name: 'https-and-turn-tls'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '443'
          description: 'HTTPS/WSS and TURN/TLS. Caddy layer4 SNI-routes 443 to localhost:7880 and localhost:5349.'
        }
      }
      {
        name: 'ice-tcp-fallback'
        properties: {
          priority: 120
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '7881'
          description: 'ICE/TCP fallback for clients that cannot use UDP.'
        }
      }
      {
        name: 'ice-udp-mux'
        properties: {
          priority: 130
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Udp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '${udpMuxPortStart}-${udpMuxPortEnd}'
          description: 'ICE/UDP mux. Replaces the generator default 50000-60000 range.'
        }
      }
      {
        name: 'turn-udp'
        properties: {
          priority: 140
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Udp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '3478'
          description: 'TURN/UDP relay.'
        }
      }
    ]
  }
}

// Standard SKU, static, and no ipTags. Absence of a RoutingPreference ipTag means
// Microsoft Premium routing (Microsoft Global Network) — the default, and the
// choice priced in docs/meetings/014-cost-model.md.
resource publicIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: '${prefix}-pip'
  location: location
  tags: tags
  sku: { name: 'Standard', tier: 'Regional' }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    idleTimeoutInMinutes: 4
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: '${prefix}-nic'
  location: location
  tags: tags
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: { id: sfuSubnet.id }
          publicIPAddress: { id: publicIp.id }
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Identity and secrets. The VM reads LIVEKIT_API_KEY and LIVEKIT_API_SECRET from
// Key Vault at boot. Neither value is a template parameter, so neither ever lands
// in ARM deployment history, in this repository, or in a VM image.
// The operator seeds them once, out of band — docs/meetings/013-secrets-and-rotation.md.
// ---------------------------------------------------------------------------

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-id'
  location: location
  tags: tags
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${prefix}-kv'
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enabledForTemplateDeployment: false
    publicNetworkAccess: 'Enabled'
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
  }
}

var keyVaultSecretsUserRole = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

resource vaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identity.id, keyVaultSecretsUserRole)
  scope: vault
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRole
  }
}

// ---------------------------------------------------------------------------
// Observability.
// ---------------------------------------------------------------------------

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  tags: tags
  properties: {
    retentionInDays: 30
    sku: { name: 'PerGB2018' }
    workspaceCapping: { dailyQuotaGb: json('0.5') }
  }
}

// ---------------------------------------------------------------------------
// The VM. cloud-init installs Docker, writes the LiveKit and Caddy configuration,
// fetches the API key pair from Key Vault, and starts the stack. No secret is
// embedded in customData — only the instructions to go and fetch one.
// ---------------------------------------------------------------------------

var vaultUri = 'https://${vault.name}${environment().suffixes.keyvaultDns}'

var cloudInit = '''#cloud-config
package_update: true
packages:
  - docker.io
  - docker-compose-v2
  - jq
  - curl

write_files:
  - path: /opt/livekit/livekit.yaml
    permissions: '0644'
    content: |
      port: 7880
      bind_addresses:
        - ""
      key_file: /opt/livekit/keys.yaml
      logging:
        json: true
        level: info
      rtc:
        use_external_ip: true
        tcp_port: 7881
        udp_port: UDP_MUX_RANGE
      turn:
        enabled: true
        domain: TURN_HOST
        external_tls: true
        tls_port: 5349
        udp_port: 3478

  - path: /opt/livekit/caddy.yaml
    permissions: '0644'
    content: |
      logging:
        logs:
          default:
            level: INFO
      storage:
        module: file_system
        root: /data
      apps:
        tls:
          certificates:
            automate:
              - MEET_HOST
              - TURN_HOST
        layer4:
          servers:
            main:
              listen: [":443"]
              routes:
                - match:
                    - tls:
                        sni:
                          - "TURN_HOST"
                  handle:
                    - handler: tls
                    - handler: proxy
                      upstreams:
                        - dial: ["localhost:5349"]
                - match:
                    - tls:
                        sni:
                          - "MEET_HOST"
                  handle:
                    - handler: tls
                      connection_policies:
                        - alpn: ["http/1.1"]
                    - handler: proxy
                      upstreams:
                        - dial: ["localhost:7880"]

  - path: /opt/livekit/docker-compose.yml
    permissions: '0644'
    content: |
      services:
        caddy:
          image: CADDY_IMAGE
          command: run --config /etc/caddy.yaml --adapter yaml
          restart: unless-stopped
          network_mode: host
          volumes:
            - /opt/livekit/caddy.yaml:/etc/caddy.yaml:ro
            - /opt/livekit/caddy_data:/data
        livekit:
          image: LIVEKIT_IMAGE
          command: --config /etc/livekit.yaml
          restart: unless-stopped
          network_mode: host
          volumes:
            - /opt/livekit/livekit.yaml:/etc/livekit.yaml:ro
            - /opt/livekit/keys.yaml:/opt/livekit/keys.yaml:ro

  - path: /opt/livekit/fetch-keys.sh
    permissions: '0700'
    content: |
      #!/usr/bin/env bash
      # Fetch the LiveKit API key pair from Key Vault using the VM's managed
      # identity and write it to a root-only key file. Runs on every boot, so a
      # rotated secret is picked up by a restart with no redeploy.
      set -euo pipefail
      imds="http://169.254.169.254/metadata/identity/oauth2/token"
      token=$(curl -sS -H Metadata:true --max-time 20 --retry 5 --retry-delay 5 \
        "$imds?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net&client_id=IDENTITY_CLIENT_ID" \
        | jq -r .access_token)
      get() {
        curl -sS --max-time 20 --retry 5 --retry-delay 5 \
          -H "Authorization: Bearer $token" \
          "VAULT_URI/secrets/$1?api-version=7.4" | jq -r .value
      }
      api_key=$(get livekit-api-key)
      api_secret=$(get livekit-api-secret)
      test -n "$api_key" -a "$api_key" != null
      test -n "$api_secret" -a "$api_secret" != null
      umask 077
      printf '%s: %s\n' "$api_key" "$api_secret" > /opt/livekit/keys.yaml
      chmod 600 /opt/livekit/keys.yaml

  - path: /etc/sysctl.d/99-livekit.conf
    permissions: '0644'
    content: |
      # LiveKit warns below 5 MB. A media server that cannot drain its UDP
      # receive buffer fast enough drops packets and blames the network.
      net.core.rmem_max = 16777216
      net.core.wmem_max = 16777216

  - path: /etc/systemd/system/livekit.service
    permissions: '0644'
    content: |
      [Unit]
      Description=DevFathom Meetings LiveKit SFU
      After=docker.service network-online.target
      Requires=docker.service

      [Service]
      Type=oneshot
      RemainAfterExit=yes
      WorkingDirectory=/opt/livekit
      ExecStartPre=/opt/livekit/fetch-keys.sh
      ExecStart=/usr/bin/docker compose up -d --wait
      ExecStop=/usr/bin/docker compose down

      [Install]
      WantedBy=multi-user.target

runcmd:
  - sysctl --system
  - systemctl enable --now docker
  - systemctl daemon-reload
  - systemctl enable --now livekit
'''

var cloudInitRendered = replace(
  replace(
    replace(
      replace(
        replace(cloudInit, 'UDP_MUX_RANGE', '${udpMuxPortStart}-${udpMuxPortEnd}'),
        'TURN_HOST',
        turnHost
      ),
      'MEET_HOST',
      meetHost
    ),
    'CADDY_IMAGE',
    caddyImage
  ),
  'LIVEKIT_IMAGE',
  livekitImage
)

var customData = replace(
  replace(cloudInitRendered, 'IDENTITY_CLIENT_ID', identity.properties.clientId),
  'VAULT_URI',
  vaultUri
)

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: '${prefix}-vm'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    hardwareProfile: { vmSize: vmSize }
    storageProfile: {
      imageReference: {
        publisher: imagePublisher
        offer: imageOffer
        sku: imageSku
        version: imageVersion
      }
      osDisk: {
        createOption: 'FromImage'
        caching: 'ReadWrite'
        deleteOption: 'Delete'
        managedDisk: { storageAccountType: 'Premium_LRS' }
        diskSizeGB: 64
      }
    }
    osProfile: {
      computerName: '${prefix}-vm'
      adminUsername: adminUsername
      customData: base64(customData)
      linuxConfiguration: {
        disablePasswordAuthentication: true
        provisionVMAgent: true
        patchSettings: {
          patchMode: 'AutomaticByPlatform'
          assessmentMode: 'AutomaticByPlatform'
        }
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: adminPublicKey
            }
          ]
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        { id: nic.id }
      ]
    }
    diagnosticsProfile: {
      bootDiagnostics: { enabled: true }
    }
  }
}

// Azure Monitor Agent plus a syslog data collection rule. Enough to see the
// LiveKit container's journal in Log Analytics without standing up a second
// logging pipeline.
resource monitorAgent 'Microsoft.Compute/virtualMachines/extensions@2024-07-01' = {
  parent: vm
  name: 'AzureMonitorLinuxAgent'
  location: location
  tags: tags
  properties: {
    publisher: 'Microsoft.Azure.Monitor'
    type: 'AzureMonitorLinuxAgent'
    typeHandlerVersion: '1.33'
    autoUpgradeMinorVersion: true
    enableAutomaticUpgrade: true
  }
}

resource dataCollection 'Microsoft.Insights/dataCollectionRules@2023-03-11' = {
  name: '${prefix}-dcr'
  location: location
  tags: tags
  properties: {
    dataSources: {
      syslog: [
        {
          name: 'sfuSyslog'
          streams: ['Microsoft-Syslog']
          facilityNames: ['daemon', 'syslog', 'user', 'auth', 'authpriv']
          logLevels: ['Info', 'Notice', 'Warning', 'Error', 'Critical', 'Alert', 'Emergency']
        }
      ]
    }
    destinations: {
      logAnalytics: [
        {
          name: 'sfuWorkspace'
          workspaceResourceId: logs.id
        }
      ]
    }
    dataFlows: [
      {
        streams: ['Microsoft-Syslog']
        destinations: ['sfuWorkspace']
      }
    ]
  }
}

resource dataCollectionAssociation 'Microsoft.Insights/dataCollectionRuleAssociations@2023-03-11' = {
  name: '${prefix}-dcra'
  scope: vm
  properties: {
    dataCollectionRuleId: dataCollection.id
  }
  dependsOn: [monitorAgent]
}

resource alertGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${prefix}-ag'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'dfmeet'
    enabled: true
    emailReceivers: [
      {
        name: 'ops'
        emailAddress: alertEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

resource availabilityAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-vm-availability'
  location: 'global'
  tags: tags
  properties: {
    description: 'LiveKit SFU VM reported unavailable.'
    severity: 1
    enabled: true
    scopes: [vm.id]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'VmAvailability'
          metricNamespace: 'Microsoft.Compute/virtualMachines'
          metricName: 'VmAvailabilityMetric'
          operator: 'LessThan'
          threshold: 1
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      { actionGroupId: alertGroup.id }
    ]
  }
}

output vmName string = vm.name
output publicIpName string = publicIp.name
output keyVaultName string = vault.name
output identityClientId string = identity.properties.clientId
output logAnalyticsName string = logs.name
output meetHostToPoint string = meetHost
output turnHostToPoint string = turnHost
output udpMuxRange string = '${udpMuxPortStart}-${udpMuxPortEnd}'
