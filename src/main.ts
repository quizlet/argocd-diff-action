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
  spec: { source: { repoURL: string; path: string } };
}
const ARCH = process.env.ARCH || 'linux';
const githubToken = core.getInput('github-token');
core.info(githubToken);

const ARGOCD_SERVER_URL = core.getInput('argocd-server-url');
const ARGOCD_TOKEN = core.getInput('argocd-token');
const VERSION = core.getInput('argocd-version');

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
      `${argoBinaryPath} ${params} --grpc-web --auth-token=${ARGOCD_TOKEN} --server=${ARGOCD_SERVER_URL}`,
      2
    );
}

async function getApps(): Promise<App[]> {
  const url = `https://${ARGOCD_SERVER_URL}/api/v1/applications?fields=items.metadata.name,items.spec.source.path,items.spec.source.repoURL`;
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
    // TODO filter apps to only ones where they point to paths that have changed in this repo
    return app.spec.source.repoURL.includes(
      `${github.context.repo.owner}/${github.context.repo.repo}`
    );
  });
}
async function postDiffComment(appName: string, diff: string): Promise<void> {
  const output = `            
  ArgoCD Diff for ${appName}:
\`\`\`diff
${diff}
\`\`\``;

  octokit.issues.createComment({
    issue_number: github.context.issue.number,
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    body: output
  });
}

async function run(): Promise<void> {
  const argocd = await setupArgoCDCommand();
  const apps = await getApps();
  core.info(`Found apps: ${apps.map(a => a.metadata.name).join(', ')}`);

  // eslint-disable-next-line github/array-foreach
  apps.forEach(async app => {
    try {
      const command = `app diff ${app.metadata.name} --local=${app.spec.source.path}`;
      const res = await argocd(command);
      core.info(`Running: argocd ${command}`);
      core.info(`stdout: ${res.stdout}`);
      core.info(`stdout: ${res.stderr}`);
      if (res.stdout) {
        await postDiffComment(app.metadata.name, res.stdout);
      }
    } catch (e) {
      core.info(e);
    }
  });
}

run();
