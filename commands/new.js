const workspace = require("../utils/workspace")
    , path = require("path")
    , fsutils = require("@project-furnace/fsutils")
    , gitutils = require("@project-furnace/gitutils")
    , templateUtil = require("../utils/template")
    , inquirer = require("inquirer")
    , yaml = require("yamljs")
    , github = require("../utils/github")
    ;

module.exports = async () => {

    const currentDir = process.cwd()
        , currentDirectoryFiles = fsutils.listDirectory(currentDir)
        , config = await workspace.getConfig()
        , currentConfig = config[config.current]
        ;
    
    if (currentDirectoryFiles.length > 0) throw new Error(`furnace new must be done in an empty directory`);

    const defaultStackName = path.basename(process.cwd());
    const questions = [
        { type: 'input', name: 'template', message: "Template:", default: "starter-template" },
        { type: 'input', name: 'remoteUrl', message: "Stack Remote Git URL:", default: "" },
        { type: 'input', name: 'stateRemoteUrl', message: "State Remote Git URL:", default: getStateRemoteGitUrl },
        { type: 'input', name: 'stackName', message: "Stack Name:", default: defaultStackName },
        { type: 'confirm', name: 'createRepos', message: "Create GitHub Repositories?", when: currentConfig.gitProvider === "github" && currentConfig.gitToken },
        { type: 'confirm', name: 'privateRepo', message: "Private Repository?", when: current => current.createRepos },
        { type: 'confirm', name: 'createHook', message: "Create GitHub Webhook", when: () => currentConfig.gitProvider === "github" && currentConfig.gitToken },
        { type: 'password', name: 'hookSecret', message: "Webhook Secret:", when: current => current.createHook },
    ];

    const answers = await inquirer.prompt(questions);
    const { template, remoteUrl, stateRemoteUrl, stackName, createRepos, privateRepo, createHook, hookSecret } = answers;

    const workspaceDir = workspace.getWorkspaceDir()
        , templateDir = path.join(workspaceDir, "templates", template)
        ;

    if (!fsutils.exists(templateDir)) {
        if (template === "starter-template") {
            await templateUtil.addTemplate("starter-template", "https://github.com/ProjectFurnace/starter-template");
            console.debug("downloading starter template...")
        } else {
            throw new Error(`unable to find template ${name}, use 'furnace template add'`);
        }
    }

    const stackFile = path.join(currentDir, "stack.yaml");

    fsutils.cp(templateDir, currentDir);
    fsutils.rimraf(path.join(currentDir, ".git"));

    const modulesPath = path.join(currentDir, "modules");
    if (!fsutils.exists(modulesPath)) fsutils.mkdir(modulesPath);

    const stackConfig = yaml.load(stackFile);
    stackConfig.name = stackName;
    stackConfig.state.repo = stateRemoteUrl;
    fsutils.writeFile(stackFile, yaml.stringify(stackConfig));

    await gitutils.init(currentDir);

    git = require("simple-git/promise")(currentDir);
    await git.addRemote("origin", remoteUrl);

    if (createRepos) {
        const currentRepo = await github.getRepository(currentConfig.gitToken, remoteUrl);
        if (currentRepo) console.log(`repository ${remoteUrl} already exists.`);
        else {
            await github.createRepository(currentConfig.gitToken, remoteUrl, privateRepo);
        }

        const currentStateRepo = await github.getRepository(currentConfig.gitToken, stateRemoteUrl);
        if (currentRepo) console.log(`repository ${stateRemoteUrl} already exists.`);
        else {
            await github.createRepository(currentConfig.gitToken, stateRemoteUrl, privateRepo);
        }

        console.log(`created repositories`);

    } else {
        console.log(`please ensure you create the remote repositories.\nstack repository: ${remoteUrl}\nstate repository: ${stateRemoteUrl}`);
    }

    if (createHook) {
        github.createRepoHook(currentConfig.gitToken, remoteUrl, currentConfig.apiUrl + "/hook", hookSecret)
        console.log(`created repository hook`)
    }

    console.log(`created new furnace stack`);

}

function getStateRemoteGitUrl(current) {
    return current.remoteUrl + "-state"
}