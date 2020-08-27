import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import { exec, ExecException, ExecOptions } from 'child_process';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';
import nodeFetch from 'node-fetch';

interface ExecResult {
  err?: Error | undefined;
  stdout: string;
  stderr: string;
}

interface App {
  metadata: { name: string };
  spec: {
    source: {
      repoURL: string;
      path: string;
      targetRevision: string;
      kustomize: Object;
      helm: Object;
    };
  };
  status: {
    sync: {
      status: 'OutOfSync' | 'Synced';
    };
  };
}
const ARCH = process.env.ARCH || 'linux';
const githubToken = core.getInput('github-token');
core.info(githubToken);

const ARGOCD_SERVER_URL = core.getInput('argocd-server-url');
const ARGOCD_TOKEN = core.getInput('argocd-token');
const VERSION = core.getInput('argocd-version');
const EXTRA_CLI_ARGS = core.getInput('argocd-extra-cli-args');

const octokit = github.getOctokit(githubToken);

async function execCommand(
  command: string,
  options: { failingExitCode: number } & ExecOptions = { failingExitCode: 1 }
): Promise<ExecResult> {
  const p = new Promise<ExecResult>(async (done, failed) => {
    exec(command, (err: ExecException | null, stdout: string, stderr: string): void => {
      const res: ExecResult = {
        stdout,
        stderr
      };
      if (err && err.code === options.failingExitCode) {
        res.err = err;
        failed(res);
        return;
      }
      done(res);
    });
  });
  return await p;
}

async function setupArgoCDCommand(): Promise<(params: string) => Promise<ExecResult>> {
  const argoBinaryPath = 'bin/argo';
  await tc.downloadTool(
    `https://github.com/argoproj/argo-cd/releases/download/${VERSION}/argocd-${ARCH}-amd64`,
    argoBinaryPath
  );
  fs.chmodSync(path.join(argoBinaryPath), '755');

  core.addPath(argoBinaryPath);

  return async (params: string) =>
    execCommand(
      `${argoBinaryPath} ${params} --auth-token=${ARGOCD_TOKEN} --server=${ARGOCD_SERVER_URL} ${EXTRA_CLI_ARGS}`,
      { failingExitCode: 2 }
    );
}

async function getApps(): Promise<App[]> {
  const url = `https://${ARGOCD_SERVER_URL}/api/v1/applications?fields=items.metadata.name,items.spec.source.path,items.spec.source.repoURL,items.spec.source.targetRevision,items.spec.source.helm,items.spec.source.kustomize,items.status.sync.status`;
  core.info(`Fetching apps from: ${url}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let responseJson: any;
  try {
    const response = await nodeFetch(url, {
      method: 'GET',
      headers: { Cookie: `argocd.token=${ARGOCD_TOKEN}` }
    });
    responseJson = await response.json();
  } catch (e) {
    core.error(e);
  }

  return (responseJson.items as App[]).filter(app => {
    return (
      app.spec.source.repoURL.includes(
        `${github.context.repo.owner}/${github.context.repo.repo}`
      ) && app.spec.source.targetRevision === 'master'
    );
  });
}

interface Diff {
  app: App;
  diff: string;
}
async function postDiffComment(diffs: Diff[]): Promise<void> {
  const { owner, repo } = github.context.repo;
  const sha = github.context.payload.pull_request?.head?.sha;

  const commitLink = `https://github.com/${owner}/${repo}/pull/${github.context.issue.number}/commits/${sha}`;
  const shortCommitSha = String(sha).substr(0, 7);

  const diffOutput = diffs.map(
    ({ app, diff }) => `    
Diff for App: [\`${app.metadata.name}\`](https://${ARGOCD_SERVER_URL}/applications/${
      app.metadata.name
    }) App sync status: ${app.status.sync.status === 'Synced' ? 'Synced ✅' : 'Out of Sync ⚠️'}
<details>

\`\`\`diff
${diff}
\`\`\`

</details>

`
  );

  const output = `
ArgoCD Diff for commit [\`${shortCommitSha}\`](${commitLink})
  ${diffOutput.join('\n')}
`;

  const commentsResponse = await octokit.issues.listComments({
    issue_number: github.context.issue.number,
    owner,
    repo
  });

  const existingComment = commentsResponse.data.find(d => d.body.includes('ArgoCD Diff for'));

  if (existingComment) {
    octokit.issues.updateComment({
      owner,
      repo,
      comment_id: existingComment.id,
      body: output
    });
  } else {
    octokit.issues.createComment({
      issue_number: github.context.issue.number,
      owner,
      repo,
      body: output
    });
  }
}

async function asyncForEach<T>(
  array: T[],
  callback: (item: T, i: number, arr: T[]) => Promise<void>
): Promise<void> {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
}

async function run(): Promise<void> {
  const argocd = await setupArgoCDCommand();
  const apps = await getApps();
  core.info(`Found apps: ${apps.map(a => a.metadata.name).join(', ')}`);
  const workDir = (await execCommand('pwd')).stdout.trim();

  // await asyncForEach(apps, async app => {
  //   try {
  //     if (app.spec.source.helm) {
  //       const output1 = await execCommand(
  //         `cd ${workDir}/${app.spec.source.path} && pwd && helm dependency update`
  //       );
  //       core.info(`output: ${JSON.stringify(output1.stdout)}`);
  //       // Return to where we started
  //       await execCommand(`cd ${workDir}`);
  //     }
  //   } catch (e) {
  //     core.info(`Error: ${JSON.stringify(e)}`);
  //   }
  // });

  const diffs: Diff[] = [];

  await asyncForEach(apps, async app => {
    try {
      if (app.spec.source.helm) {
        core.info(`${workDir}/${app.spec.source.path}`);
        const output1 = await execCommand(`ls`, {
          cwd: `${workDir}/${app.spec.source.path}`,
          failingExitCode: 1
        });
        core.info(`stdout: ${JSON.stringify(output1.stdout)}`);
        core.error(`stderr: ${JSON.stringify(output1.stderr)}`);
        const output2 = await execCommand(`helm dependency update`, {
          cwd: `${workDir}/${app.spec.source.path}`,
          failingExitCode: 1
        });
        core.info(`stdout: ${JSON.stringify(output2.stdout)}`);
        core.error(`stderr: ${JSON.stringify(output2.stderr)}`);
      }
      const command = `app diff ${app.metadata.name} --local=${app.spec.source.path}`;
      const res = await argocd(command);
      core.info(`Running: argocd ${command}`);
      core.info(`stdout: ${res.stdout}`);
      core.info(`stderr: ${res.stderr}`);
      if (res.stdout) {
        diffs.push({ app, diff: res.stdout });
      }
    } catch (e) {
      core.info(JSON.stringify(e));
    }
  });
  // const diffs = (await Promise.all(diffPromises)) as Diff[];
  await postDiffComment(diffs.filter(Boolean));
}

run();
