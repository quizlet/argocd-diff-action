import * as process from 'process';
import * as cp from 'child_process';
import * as path from 'path';

// shows how the runner will run a javascript action with env / stdout protocol
test('test runs', () => {
  process.env['ARCH'] = 'darwin';
  process.env['GITHUB_REPOSITORY'] = 'quizlet/cd-infra';
  process.env['INPUT_GITHUB-TOKEN'] = '500';
  process.env['INPUT_ARGOCD-VERSION'] = 'v1.6.1';
  process.env['INPUT_ARGOCD-SERVER-URL'] = 'argocd.qzlt.io';
  process.env['INPUT_ARGOCD-TOKEN'] = 'foo';
  const ip = path.join(__dirname, '..', 'lib', 'main.js');
  const options: cp.ExecSyncOptions = {
    env: process.env
  };
  console.log(cp.execSync(`node ${ip}`, options).toString());
});

afterAll(() => {
  cp.execSync('rm -rf bin');
});
