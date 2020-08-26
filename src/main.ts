import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import { exec, ExecException } from 'child_process';
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
}
const ARCH = process.env.ARCH || 'linux';
const githubToken = core.getInput('github-token');
core.info(githubToken);

const ARGOCD_SERVER_URL = core.getInput('argocd-server-url');
const ARGOCD_TOKEN = core.getInput('argocd-token');
const VERSION = core.getInput('argocd-version');
const EXTRA_CLI_ARGS = core.getInput('argocd-extra-cli-args');

const octokit = github.getOctokit(githubToken);

async function execCommand(command: string, failingExitCode = 1): Promise<ExecResult> {
  const p = new Promise<ExecResult>(async (done, failed) => {
    exec(command, (err: ExecException | null, stdout: string, stderr: string): void => {
      const res: ExecResult = {
        stdout,
        stderr
      };
      if (err && err.code === failingExitCode) {
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
      2
    );
}

async function getApps(): Promise<App[]> {
  const url = `https://${ARGOCD_SERVER_URL}/api/v1/applications?fields=items.metadata.name,items.spec.source.path,items.spec.source.repoURL,items.spec.source.targetRevision,items.spec.source.helm,items.spec.source.kustomize`;
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
    core.info(JSON.stringify(app.spec));
    // TODO filter apps to only ones where they point to paths that have changed in this repo
    return app.spec.source.repoURL.includes(
      `${github.context.repo.owner}/${github.context.repo.repo}`
    );
  });
}

interface Diff {
  appName: string;
  diff: string;
}
async function postDiffComment(diffs: Diff[]): Promise<void> {
  const { owner, repo } = github.context.repo;

  const commitLink = `https://github.com/${owner}/${repo}/commits/${github.context.sha}`;
  const shortCommitSha = String(github.context.sha).substr(0, 7);
  const output = `
ArgoCD Diff for commit [\`${shortCommitSha}\`](${commitLink})
  ${diffs
    .map(
      ({ appName, diff }) => `    
Diff for App: [\`${appName}\`](https://${ARGOCD_SERVER_URL}/applications/${appName}) 
<details>

\`\`\`diff
${diff}
\`\`\`

</details>

`
    )
    .join('\n')}
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

async function run(): Promise<void> {
  const argocd = await setupArgoCDCommand();
  const apps = await getApps();
  core.info(`Found apps: ${apps.map(a => a.metadata.name).join(', ')}`);

  const diffPromises = apps.map(async app => {
    try {
      const command = `app diff ${app.metadata.name} --local=${app.spec.source.path}`;
      const res = await argocd(command);
      core.info(`Running: argocd ${command}`);
      core.info(`stdout: ${res.stdout}`);
      core.info(`stdout: ${res.stderr}`);
      if (res.stdout) {
        return { appName: app.metadata.name, diff: res.stdout };
      }
    } catch (e) {
      core.info(e);
    }
  });
  const diffs = (await Promise.all(diffPromises)).filter(Boolean) as Diff[];
  await postDiffComment(diffs);
}

run();
