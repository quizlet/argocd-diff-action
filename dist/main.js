"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const tc = __importStar(require("@actions/tool-cache"));
const child_process_1 = require("child_process");
const github = __importStar(require("@actions/github"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const axios_1 = __importDefault(require("axios"));
const https_1 = __importDefault(require("https"));
const ARCH = process.env.ARCH || 'linux';
const githubToken = core.getInput('github-token');
core.info(githubToken);
const ARGOCD_SERVER_URL = core.getInput('argocd-server-url');
const ARGOCD_TOKEN = core.getInput('argocd-token');
const VERSION = core.getInput('argocd-version');
const ENV = core.getInput('environment');
const PLAINTEXT = core.getInput('plaintext').toLowerCase() === 'true';
const REVISION = core.getInput('revision');
const SERVER_SIDE_GENERATE = core.getInput('server-side-generate').toLowerCase() === 'true';
const INSECURE = core.getInput('insecure').toLowerCase() === 'true';
let EXTRA_CLI_ARGS = core.getInput('argocd-extra-cli-args');
if (PLAINTEXT) {
    EXTRA_CLI_ARGS += ' --plaintext';
}
const octokit = github.getOctokit(githubToken);
async function execCommand(command, options = {}) {
    const p = new Promise(async (done, failed) => {
        (0, child_process_1.exec)(command, options, (err, stdout, stderr) => {
            const res = {
                stdout,
                stderr
            };
            if (err) {
                res.err = err;
                failed(res);
                return;
            }
            done(res);
        });
    });
    return await p;
}
function scrubSecrets(input) {
    let output = input;
    const authTokenMatches = input.match(/--auth-token=([\w.\S]+)/);
    if (authTokenMatches) {
        output = output.replace(new RegExp(authTokenMatches[1], 'g'), '***');
    }
    return output;
}
async function setupArgoCDCommand() {
    const argoBinaryPath = 'bin/argo';
    await tc.downloadTool(`https://github.com/argoproj/argo-cd/releases/download/${VERSION}/argocd-${ARCH}-amd64`, argoBinaryPath);
    fs.chmodSync(path.join(argoBinaryPath), '755');
    // core.addPath(argoBinaryPath);
    return async (params) => execCommand(`${argoBinaryPath} ${params} --auth-token=${ARGOCD_TOKEN} --server=${ARGOCD_SERVER_URL} ${EXTRA_CLI_ARGS}`);
}
async function getApps() {
    let protocol = 'https';
    if (PLAINTEXT) {
        protocol = 'http';
    }
    const url = `${protocol}://${ARGOCD_SERVER_URL}/api/v1/applications`;
    core.info(`Fetching apps from: ${url}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let responseJson;
    try {
        const response = await axios_1.default.get(url, {
            headers: { Cookie: `argocd.token=${ARGOCD_TOKEN}` },
            httpsAgent: new https_1.default.Agent({ rejectUnauthorized: !INSECURE })
        });
        responseJson = await response.data();
    }
    catch (e) {
        core.error(e);
    }
    return responseJson.items.filter(app => {
        const targetRevision = app.spec.source.targetRevision;
        const targetPrimary = targetRevision === 'master' || targetRevision === 'main' || !targetRevision;
        return (app.spec.source.repoURL.includes(`${github.context.repo.owner}/${github.context.repo.repo}`) && targetPrimary);
    });
}
async function postDiffComment(diffs) {
    let protocol = 'https';
    if (PLAINTEXT) {
        protocol = 'http';
    }
    const { owner, repo } = github.context.repo;
    const sha = github.context.payload.pull_request?.head?.sha;
    const commitLink = `https://github.com/${owner}/${repo}/pull/${github.context.issue.number}/commits/${sha}`;
    const shortCommitSha = String(sha).substring(0, 7);
    const prefixHeader = `## ArgoCD Diff on ${ENV}`;
    const diffOutput = diffs.map(({ app, diff, error }) => `
App: [\`${app.metadata.name}\`](${protocol}://${ARGOCD_SERVER_URL}/applications/${app.metadata.name})
YAML generation: ${error ? ' Error 🛑' : 'Success 🟢'}
App sync status: ${app.status.sync.status === 'Synced' ? 'Synced ✅' : 'Out of Sync ⚠️ '}
${error
        ? `
**\`stderr:\`**
\`\`\`
${error.stderr}
\`\`\`

**\`command:\`**
\`\`\`json
${JSON.stringify(error.err)}
\`\`\`
`
        : ''}

${diff
        ? `
<details>

\`\`\`diff
${diff}
\`\`\`

</details>
`
        : ''}
---
`);
    const output = scrubSecrets(`
${prefixHeader} for commit [\`${shortCommitSha}\`](${commitLink})
_Updated at ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT_
  ${diffOutput.join('\n')}

| Legend | Status |
| :---:  | :---   |
| ✅     | The app is synced in ArgoCD, and diffs you see are solely from this PR. |
| ⚠️      | The app is out-of-sync in ArgoCD, and the diffs you see include those changes plus any from this PR. |
| 🛑     | There was an error generating the ArgoCD diffs due to changes in this PR. |
`);
    const commentsResponse = await octokit.rest.issues.listComments({
        issue_number: github.context.issue.number,
        owner,
        repo
    });
    // Delete stale comments
    for (const comment of commentsResponse.data) {
        if (comment.body?.includes(prefixHeader)) {
            core.info(`deleting comment ${comment.id}`);
            octokit.rest.issues.deleteComment({
                owner,
                repo,
                comment_id: comment.id
            });
        }
    }
    // Only post a new comment when there are changes
    if (diffs.length) {
        octokit.rest.issues.createComment({
            issue_number: github.context.issue.number,
            owner,
            repo,
            body: output
        });
    }
}
async function asyncForEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array);
    }
}
async function run() {
    const argocd = await setupArgoCDCommand();
    const apps = await getApps();
    core.info(`Found apps: ${apps.map(a => a.metadata.name).join(', ')}`);
    const diffs = [];
    await asyncForEach(apps, async (app) => {
        let command = `app diff ${app.metadata.name}`;
        if (REVISION) {
            command += ` --revision=${REVISION}`;
        }
        else {
            command += ` --local=${app.spec.source.path}`;
        }
        if (SERVER_SIDE_GENERATE) {
            command += ' --server-side-generate';
        }
        try {
            core.info(`Running: argocd ${command}`);
            // ArgoCD app diff will exit 1 if there is a diff, so always catch,
            // and then consider it a success if there's a diff in stdout
            // https://github.com/argoproj/argo-cd/issues/3588
            await argocd(command);
        }
        catch (e) {
            const res = e;
            core.info(`stdout: ${res.stdout}`);
            core.info(`stderr: ${res.stderr}`);
            if (res.stdout) {
                diffs.push({ app, diff: res.stdout });
            }
            else {
                diffs.push({
                    app,
                    diff: '',
                    error: e
                });
            }
        }
    });
    await postDiffComment(diffs);
    const diffsWithErrors = diffs.filter(d => d.error);
    if (diffsWithErrors.length) {
        core.setFailed(`ArgoCD diff failed: Encountered ${diffsWithErrors.length} errors`);
    }
}
run().catch(e => core.setFailed(e.message));
