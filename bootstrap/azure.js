const Azure = require('azure')
    , azureUtils = require("../utils/azure")
    , fs = require("fs")
    , path = require("path")
    , ResourceManagementClient = require("azure-arm-resource").ResourceManagementClient
    , fsUtils = require("@project-furnace/fsutils")
    , exec = require("child_process").exec
    , zipUtils = require("@project-furnace/ziputils")
    , azureStorage = require("azure-storage")
    ;

module.exports.ignite = (instanceName, location, subscriptionId, igniteConfig) => {

  const { templateDir, functionsDir } = igniteConfig
      , initialTemplate = path.join(templateDir, "base.json")
      , bootstrapTemplate = path.join(templateDir, "bootstrap.json")

  const resourceGroupName = `${instanceName}rg`
    , storageAccountName = `${instanceName}sa`
    , storageContainerName = `${instanceName}c`
    , initialDeploymentName = `${instanceName}Initial`
    , bootstrapDeploymentName = `${instanceName}Bootstrap`
    , artifactKey = "bootstrapFunctions"
    , initialTemplateParameters = {
      "storageAccountName": {
        "value": storageAccountName
      },
      "containerName": {
        "value": storageContainerName
      },
      "location": {
        "value": location
      }
    }
    , bootstrapTemplateParameters = {
      "storageAccountName": {
        "value": storageAccountName + "f"
      },
      "containerName": {
        "value": storageContainerName + "f"
      },
      "ApiKey": {
        "value": igniteConfig.apiKey
      },
      "GitToken": {
        "value": igniteConfig.gitToken
      },
      "GitHookSecret": {
        "value": igniteConfig.gitHookSecret
      }
    }
    ;

  let resourceClient;
  let storageClient;
  let artifactPath;

  return azureUtils.interactiveLogin().then(credentials => {
    resourceClient = new ResourceManagementClient(credentials, subscriptionId);
    storageClient = Azure.createStorageManagementClient(credentials, subscriptionId);

    return createResourceGroup(resourceClient, resourceGroupName, location);
  }).then(() => {
    return loadTemplateAndDeploy(resourceClient, resourceGroupName, initialDeploymentName, initialTemplate, initialTemplateParameters);
  }).then(() => {
    return buildFunctions(functionsDir, resourceGroupName);
  }).then((artifact) => {
    artifactPath = artifact;
    return getStorageKey(storageClient, resourceGroupName, storageAccountName);
  }).then((storageKey) => {
    return upload(storageKey, storageAccountName, storageContainerName, artifactKey, artifactPath)
  }).then((blobUrl) => {
    bootstrapTemplateParameters.blobUrl = {"value":blobUrl};
    return loadTemplateAndDeploy(resourceClient, resourceGroupName, bootstrapDeploymentName, bootstrapTemplate, bootstrapTemplateParameters);
  }).then(deployResult => {
    return deployResult;
  }).catch(error => {
    throw new Error(`got error whilst deploying azure bootstrap: ${error}`);
  })
}

function getStorageKey(storageClient, resourceGroupName, storageAccountName) {
  return new Promise((resolve, reject) => {
    storageClient.storageAccounts.listKeys(resourceGroupName, storageAccountName, (err, result) => {
      if (err) reject(err);
      else {
        if (!result.keys || !result.keys.length > 0) reject(new Error("unable to get storage key"));
        else {
          resolve(result.keys[0].value);
        }
      }
    })
  });
}

function buildFunctions(functionsDir, resourceGroupName) {
      console.log("building functions...");

      const tempDir = fsUtils.createTempDirectory()
          , uploadPackage = path.join(tempDir, "bootstrapFunctions.zip")
          , execPath = path.join(functionsDir, 'deploy-exec/function.json')
          , triggerPath = path.join(functionsDir, 'deploy-trigger/function.json');


      const triggerraw = fsUtils.readFile(triggerPath)
          , triggerjson = JSON.parse(triggerraw);

      const execraw = fsUtils.readFile(execPath)
          , execjson = JSON.parse(execraw);
    
      const triggerBindings = [{
          type: 'httpTrigger',
          direction: 'in',
          name: 'request',
          authLevel: 'anonymous',
          route: 'deploy-trigger/hook'
      },
      {
          type: 'eventHub',
          direction: 'out',
          name: 'eventOutput',
          eventHubName: resourceGroupName + '-deployHub',
          connection: 'eventPullConnectionString'
      },
      {
          type: "http",
          direction: "out",
          name: "$return"
      }];  

      const execBindings = [{
          type: 'eventHubTrigger',
          direction: 'in',
          name: 'eventInput',
          eventHubName: resourceGroupName + '-deployHub',
          connection: 'eventPullConnectionString'
      },
      {
          type: "http",
          direction: "out",
          name: "$return"
      }];      
    
      triggerjson.bindings = triggerBindings;
      execjson.bindings = execBindings;

      fsUtils.writeFile(triggerPath, JSON.stringify(triggerjson));
      fsUtils.writeFile(execPath, JSON.stringify(execjson));

      fsUtils.cp(functionsDir, tempDir);
      fsUtils.writeFile(path.join(tempDir, "host.json"), JSON.stringify({ version: "2.0" }));
      fsUtils.writeFile(path.join(tempDir, "extensions.csproj"), `
<Project Sdk="Microsoft.NET.Sdk">
<PropertyGroup>
  <TargetFramework>netstandard2.0</TargetFramework>
<WarningsAsErrors></WarningsAsErrors>
<DefaultItemExcludes>**</DefaultItemExcludes>
</PropertyGroup>
<ItemGroup>
  <PackageReference Include="Microsoft.Azure.WebJobs.Extensions.EventHubs" Version="3.0.3" />
  <PackageReference Include="Microsoft.Azure.WebJobs.Script.ExtensionsMetadataGenerator" Version="1.0.2" />
</ItemGroup>
</Project>
`
      );

      return execPromise("npm install --production", { cwd: path.join(tempDir, 'deploy-trigger/'), env: process.env }).then(() => {
        return execPromise("npm install --production", { cwd: path.join(tempDir, 'deploy-exec/'), env: process.env })
      }).then(() => {
        return execPromise("func extensions install", { cwd: tempDir, env: process.env});
      }).then(() => {
        return zipUtils.compress(tempDir, uploadPackage);
      }).then(() => {
        return Promise.resolve(uploadPackage);
      })
}

// function createStorageAccount(storageClient, resourceGroup, location, name) {
//   return new Promise((resolve, reject) => {
//     storageAccountExists(storageClient, name).then(exists => {
//       const createParameters = {
//         location,
//         sku: {
//           name: 'Standard_LRS'
//         },
//         kind: 'Storage'
//       };

//       if (exists) {
//         console.log(`storage account ${name} already exists, not creating`);
//         resolve();
//       } else {
//         console.log(`creating storage account ${name}`);
//         storageClient.storageAccounts.create(resourceGroup, name, createParameters, (err, result) => {
//           if (err) reject(err);
//           else resolve(result);
//         });
//       }
//     })
//   })
// }

// function storageAccountExists(storageClient, name) {
//   return new Promise((resolve, reject) => {
//     storageClient.storageAccounts.checkNameAvailability(name, (err, result) => {
//       if (err) reject(err);
//       else resolve(!result.nameAvailable);
//     });
//   })
// }

function createResourceGroup(resourceClient, resourceGroupName, location) {
  return new Promise((resolve, reject) => {
    const groupParameters = { location, tags: { origin: 'furnace' } };
    resourceClient.resourceGroups.createOrUpdate(resourceGroupName, groupParameters, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    })
  })
}

function loadTemplateAndDeploy(resourceClient, resourceGroupName, deploymentName, templateFile, parameters) {
  return new Promise((resolve, reject) => {
    let template;
    try {
      template = JSON.parse(fs.readFileSync(templateFile, "utf8"));
    } catch (err) { reject(err) }

    const deploymentParameters = {
      "properties": {
        "parameters": parameters,
        "template": template,
        "mode": "Incremental"
      }
    };

    console.log(`commiting template for deployment ${deploymentName}...`);
    resourceClient.deployments.createOrUpdate(resourceGroupName, deploymentName, deploymentParameters, (err, result) => {
      if (err) reject(err);
      else (resolve(result));
    });
  })
}

function upload(storageKey, storageAccountName, storageContainerName, key, artifactPath) {
  return new Promise((resolve, reject) => {
    const connectionString = `DefaultEndpointsProtocol=https;AccountName=${storageAccountName};AccountKey=${storageKey};EndpointSuffix=core.windows.net`;
    const blobService = azureStorage.createBlobService(connectionString);

    blobService.createBlockBlobFromLocalFile(storageContainerName, key, artifactPath, (error, result) => {
      if (error) reject(error);
      else {
        var startDate = new Date();
        var expiryDate = new Date(startDate);
        expiryDate.setFullYear(startDate.getFullYear() + 100);
        startDate.setMinutes(startDate.getMinutes() - 100);
  
        var sharedAccessPolicy = {
          AccessPolicy: {
            Permissions: azureStorage.BlobUtilities.SharedAccessPermissions.READ,
            Start: startDate,
            Expiry: expiryDate
          }
        };

        var token = blobService.generateSharedAccessSignature(storageContainerName, key, sharedAccessPolicy);
        var sasUrl = blobService.getUrl(storageContainerName, key, token);
        resolve(sasUrl);
      }
    });
  });
}

function execPromise(command, options) {
  return new Promise((resolve, reject) => {
    exec(command, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

module.exports.buildFunctions = buildFunctions;