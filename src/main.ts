import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import { exec, ExecException, ExecOptions } from 'child_process';
import * as github from '@actions/github';
import fs from 'fs';
import path from 'path';
import nodeFetch from 'node-fetch';

interface ExecResult {
  err?: Error;
  stdout: string;
  stderr: string;
}

interface Diff {
  app: App;
  diff: string;
  error?: ExecResult;
}

export interface App {
  metadata: { name: string };
  spec: {
    source: {
      repoURL: string;
      path: string;
      targetRevision: string;
      kustomize: object;
      helm: object;
    };
  };
  status: {
    sync: {
      status: 'OutOfSync' | 'Synced';
    };
  };
}

export function filterAppsByName(appsAffected: App[], appNameMatcher: string): App[] {
  if (appNameMatcher.startsWith('/') && appNameMatcher.endsWith('/')) {
    const appNameFilter = new RegExp(appNameMatcher.slice(1, -1));
    return appsAffected.filter(app => appNameFilter.test(app.metadata.name));
  } else if (appNameMatcher !== '') {
    const appNames = new Set(appNameMatcher.split(','));
    return appsAffected.filter(app => appNames.has(app.metadata.name));
  }
  return appsAffected;
}

export async function run(): Promise<void> {
  const ARCH = process.env.ARCH || 'linux';
  const githubToken = core.getInput('github-token');
  core.info(githubToken);

  const ARGOCD_SERVER_URL = core.getInput('argocd-server-url');
  const ARGOCD_TOKEN = core.getInput('argocd-token');
  const VERSION = core.getInput('argocd-version');
  const ENV = core.getInput('environment');
  const PLAINTEXT = core.getInput('plaintext').toLowerCase() === 'true';
  const APP_NAME_MATCHER = core.getInput('app-name-matcher');
  let EXTRA_CLI_ARGS = core.getInput('argocd-extra-cli-args');
  if (PLAINTEXT) {
    EXTRA_CLI_ARGS += ' --plaintext';
  }

  const octokit = github.getOctokit(githubToken);

  function execCommand(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    return new Promise<ExecResult>((done, failed) => {
      exec(command, options, (err: ExecException | null, stdout: string, stderr: string): void => {
        const res: ExecResult = {
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
  }

  function scrubSecrets(input: string): string {
    let output = input;
    const authTokenMatches = input.match(/--auth-token=([\w.\S]+)/);
    if (authTokenMatches) {
      output = output.replace(new RegExp(authTokenMatches[1], 'g'), '***');
    }
    return output;
  }

  async function setupArgoCDCommand(): Promise<(params: string) => Promise<ExecResult>> {
    const argoBinaryPath = await tc.downloadTool(
      `https://github.com/argoproj/argo-cd/releases/download/${VERSION}/argocd-${ARCH}-amd64`
    );
    fs.chmodSync(argoBinaryPath, '755');

    return async (params: string) =>
      execCommand(
        `${argoBinaryPath} ${params} --auth-token=${ARGOCD_TOKEN} --server=${ARGOCD_SERVER_URL} ${EXTRA_CLI_ARGS}`
      );
  }

  async function getApps(): Promise<App[]> {
    const protocol = PLAINTEXT ? 'http' : 'https';
    const url = `${protocol}://${ARGOCD_SERVER_URL}/api/v1/applications`;
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
      if (e instanceof Error || typeof e === 'string') {
        core.setFailed(e);
      }
      return [];
    }
    const apps = responseJson.items as App[];
    const repoApps = apps.filter(app => {
      const targetRevision = app.spec.source.targetRevision;
      const targetPrimary =
        targetRevision === 'master' || targetRevision === 'main' || !targetRevision;
      return (
        app.spec.source.repoURL.includes(
          `${github.context.repo.owner}/${github.context.repo.repo}`
        ) && targetPrimary
      );
    });

    const changedFiles = await getChangedFiles();
    core.info(`Changed files: ${changedFiles.join(', ')}`);
    const appsAffected = repoApps.filter(partOfApp.bind(null, changedFiles));
    return filterAppsByName(appsAffected, APP_NAME_MATCHER);
  }

  async function postDiffComment(diffs: Diff[]): Promise<void> {
    const protocol = PLAINTEXT ? 'http' : 'https';
    const { owner, repo } = github.context.repo;
    const sha = github.context.payload.pull_request?.head?.sha;

    const commitLink = `https://github.com/${owner}/${repo}/pull/${github.context.issue.number}/commits/${sha}`;
    const shortCommitSha = String(sha).slice(0, 7);

    const filteredDiffs = diffs
      .map(diff => {
        diff.diff = filterDiff(diff.diff);
        return diff;
      })
      .filter(d => d.diff !== '');

    const prefixHeader = `## ArgoCD Diff on ${ENV}`;
    const diffOutput = filteredDiffs.map(
      ({ app, diff, error }) => `
App: [\`${app.metadata.name}\`](${protocol}://${ARGOCD_SERVER_URL}/applications/${
        app.metadata.name
      })
YAML generation: ${error ? ' Error 🛑' : 'Success 🟢'}
App sync status: ${app.status.sync.status === 'Synced' ? 'Synced ✅' : 'Out of Sync ⚠️ '}
${
  error
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
    : ''
}

${
  diff
    ? `

\`\`\`diff
${diff}
\`\`\`

`
    : ''
}
---
`
    );

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
    if (filteredDiffs.length) {
      octokit.rest.issues.createComment({
        issue_number: github.context.issue.number,
        owner,
        repo,
        body: output
      });
    }
  }

  async function getChangedFiles(): Promise<string[]> {
    const { owner, repo } = github.context.repo;
    const pull_number = github.context.issue.number;

    const listFilesResponse = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number
    });

    return listFilesResponse.data.map(file => file.filename);
  }

  function partOfApp(changedFiles: string[], app: App): boolean {
    const sourcePath = path.normalize(app.spec.source.path);
    const appPath = getFirstTwoDirectories(sourcePath);

    return changedFiles.some(file => {
      const normalizedFilePath = path.normalize(file);
      return normalizedFilePath.startsWith(appPath);
    });
  }

  function getFirstTwoDirectories(filePath: string): string {
    const normalizedPath = path.normalize(filePath);
    const parts = normalizedPath.split(path.sep).filter(Boolean); // filter(Boolean) removes empty strings
    if (parts.length < 2) {
      return parts.join(path.sep); // Return the entire path if less than two directories
    }
    return parts.slice(0, 2).join(path.sep);
  }

  async function asyncForEach<T>(
    array: T[],
    callback: (item: T, i: number, arr: T[]) => Promise<void>
  ): Promise<void> {
    for (let index = 0; index < array.length; index++) {
      await callback(array[index], index, array);
    }
  }

  const argocd = await setupArgoCDCommand();
  const apps = await getApps();
  core.info(`Found apps: ${apps.map(a => a.metadata.name).join(', ')}`);

  const diffs: Diff[] = [];

  await asyncForEach(apps, async app => {
    const command = `app diff ${app.metadata.name} --local-repo-root=${process.cwd()} --local=${app.spec.source.path}`;
    try {
      core.info(`Running: argocd ${command}`);
      // ArgoCD app diff will exit 1 if there is a diff, so always catch,
      // and then consider it a success if there's a diff in stdout
      // https://github.com/argoproj/argo-cd/issues/3588
      await argocd(command);
    } catch (e) {
      const res = e as ExecResult;
      core.info(`stdout: ${res.stdout}`);
      core.info(`stderr: ${res.stderr}`);
      if (res.stdout) {
        diffs.push({ app, diff: res.stdout });
      } else {
        diffs.push({
          app,
          diff: '',
          error: res
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

function filterDiff(diffText: string): string {
  // Split the diff text into sections based on the headers
  const sections = diffText.split(/(?=^===== )/m);

  const filteredSection = sections
    .map(section =>
      section
        .replace(
          /(\d+(,\d+)?c\d+(,\d+)?\n)?<\s+argocd\.argoproj\.io\/instance:.*\n---\n>\s+argocd\.argoproj\.io\/instance:.*\n?/g,
          ''
        )
        .trim()
        .replace(/(\d+(,\d+)?c\d+(,\d+)?\n)?<\s+app.kubernetes.io\/part-of:.*\n?/g, '')
        .trim()
    )
    .filter(section => section !== '');

  // Remove empty strings and sections that are just headers with line numbers
  const removeEmptyHeaders = filteredSection.filter(entry => !entry.match(/^===== .*\/.* ======$/));

  // Join the filtered sections back together
  return removeEmptyHeaders.join('\n').trim();
}

// Avoid executing main automatically during tests
if (require.main === module) {
  // eslint-disable-next-line github/no-then
  run().catch(e => core.setFailed(e.message));
}
